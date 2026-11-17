/* SPDX-License-Identifier: GPL-3.0-or-later
 * Continuous ESP_VIDEO_V3 FM on the ESP32-C5 TXDC injection path.
 *
 * Hardware register layout/initialization reference:
 * zxkmm/esp-sdr, main/targets/esp32c5/transmitter.h (ESPsoup/ESPARGOS).
 * This is a new streaming DDS, not the upstream burst/replay application.
 *
 * PCM controls frequency at 120 kHz; four phase-continuous I/Q updates are
 * emitted per PCM interval. Nothing uploads multi-Msample/s I/Q over UART.
 * The code deliberately refuses a timing failure instead of claiming that
 * compressed or skipped RF samples preserved the source timeline.
 */
#include "c5_tx.h"
#include "c5_radio.h"

#include <math.h>
#include <string.h>
#include "esp_attr.h"
#include "esp_cpu.h"
#include "esp_phy_cert_test.h"
#include "freertos/FreeRTOS.h"
#include "riscv/rv_utils.h"
#include "soc/soc.h"

#if !CONFIG_IDF_TARGET_ESP32C5
#error "This transmitter requires ESP32-C5 register definitions"
#endif
#if CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ != 240 || CONFIG_PM_ENABLE
#error "Continuous C5 FM requires a fixed 240 MHz CPU clock"
#endif

#define TXDC_REG       0x600a0c08u
#define DAC_SCALE_REG  0x600a0c04u
#define IQ_MASK        0x000fffffu
#define TXDC_ENABLE    0x04000000u
#define CPU_HZ         240000000u
#define IQ_CYCLES      (CPU_HZ / C5_TX_IQ_HZ)
#define RING_MASK      (C5_TX_RING_SAMPLES - 1u)
#define PHASE_BITS     10u
#define PHASE_SIZE     (1u << PHASE_BITS)
#define FM_DEVIATION   50000
#define IQ_AMPLITUDE   384

_Static_assert(CPU_HZ % C5_TX_IQ_HZ == 0, "Exact IQ timing is required");
_Static_assert(C5_TX_IQ_HZ == 4u * C5_TX_PCM_HZ, "Four IQ ticks per PCM slot");
_Static_assert((C5_TX_RING_SAMPLES & RING_MASK) == 0, "Power-of-two PCM ring");

extern void phy_stop_tx_tone(unsigned);
extern void phy_set_txclk_en(unsigned);
extern void phy_pbus_xpd_tx_off(void);
/* C5 libphy's phy_txcal_debuge_mode_new calls this with (39,1) in the
 * 2.4 GHz band; its other branch uses 473 for 5 GHz. This port is 2.4 GHz.
 * The signature and call site were checked in the pinned C5 libphy archive.
 */
extern void phy_pbus_xpd_tx_on(unsigned, unsigned);
extern unsigned phy_pbus_rd(unsigned, unsigned);
extern void phy_pbus_set_dco(const uint16_t *);

/* Bank 1's upper quarter is reserved for UART storage. PHY calibration
 * runs before READY; the PCM ring is empty then. No PHY calls during TX. */
static uint8_t pcm_ring[C5_TX_RING_SAMPLES]
    DRAM_ATTR __attribute__((aligned(16)));
static DRAM_ATTR uint32_t iq_table[PHASE_SIZE];
static DRAM_ATTR uint32_t phase_steps[256];
static DRAM_ATTR uint16_t calibrated_dco[4];
static DRAM_ATTR c5_tx_stats_t counters;
static volatile uint32_t write_head, read_tail;
static volatile bool armed, running, end_seen;
static bool protected_stream, initialized, hardware_owned;
static uint32_t session_hz, original_txdc, original_scale, txdc_control;
static const char *last_fault;
static portMUX_TYPE tx_mux = portMUX_INITIALIZER_UNLOCKED;

static inline __attribute__((always_inline)) void memory_fence(void) {
    __asm__ volatile("fence rw,rw" ::: "memory");
}

bool c5_tx_init(void) {
    if (initialized) return true;
    if (c5_radio_init() != ESP_OK) return false;
    initialized = true;
    return true;
}

static uint32_t prepare_iq_levels(uint8_t apwr) {
    /* APWR controls relative quarter-dB attenuation. The tone generator's
     * backoff field does not scale injected TXDC samples. Split attenuation
     * between the documented 8-bit DAC scale fields and the I/Q table, so
     * the weakest setting retains useful phase resolution instead of
     * collapsing the constellation to one or two DAC codes.
     * Scale 15 is the conservative linear replay setting characterized by
     * the upstream C5 backend. Absolute RF power is not calibrated here.
     */
    const float factor = powf(10.0f, -(float)apwr / 80.0f);
    uint32_t scale = (uint32_t)ceilf(15.0f * factor);
    if (!scale) scale = 1u;
    const float amplitude = IQ_AMPLITUDE * 15.0f * factor / (float)scale;
    for (uint32_t n = 0; n < PHASE_SIZE; ++n) {
        const float phase = 6.2831853071795864769f * (float)n / (float)PHASE_SIZE;
        const int32_t i = (int32_t)lroundf(cosf(phase) * amplitude);
        const int32_t q = (int32_t)lroundf(sinf(phase) * amplitude);
        iq_table[n] = ((uint32_t)i & 1023u) | (((uint32_t)q & 1023u) << 10);
    }
    return (scale << 8) | (scale << 16);
}

static void release_hardware(void) {
    if (!hardware_owned) return;
    /* Remove modulation and close the physical transmitter before restoring
     * any saved injection word. Idle returns the shared PHY to RX/idle state.
     */
    REG_WRITE(TXDC_REG, txdc_control);
    memory_fence();
    phy_pbus_xpd_tx_off();
    esp_phy_wifi_tx_tone(0, (session_hz + 500000u) / 1000000u, 80);
    REG_WRITE(TXDC_REG, original_txdc);
    REG_WRITE(DAC_SCALE_REG, original_scale);
    memory_fence();
    hardware_owned = false;
    c5_radio_idle();
}

bool c5_tx_start(uint32_t carrier_hz, uint8_t apwr) {
    if (armed || running || apwr > 191u || carrier_hz < 2401000000u || carrier_hz > 2482500000u)
        return false;
    if (!c5_tx_init() || c5_radio_tune(carrier_hz) != ESP_OK) return false;
    session_hz = carrier_hz;
    original_txdc = REG_READ(TXDC_REG);
    original_scale = REG_READ(DAC_SCALE_REG);
    const uint32_t selected_scale = prepare_iq_levels(apwr);

    /* Calibrate/key the C5's TX chain before READY and before the UART starts
     * carrying PCM. APWR is applied to the injected I/Q/DAC scale above:
     * zero is strongest, 191 is weakest. The stock calibration tone uses
     * a conservative fixed 20 dB backoff, as in the upstream C5 backend.
     * Exact radiated levels differ between SoCs and require RF measurement.
     */
    esp_phy_wifi_tx_tone(1, (carrier_hz + 500000u) / 1000000u, 80);
    /* The stock calibration programs gain-specific analog DC corrections.
     * Save the actual PBUS values, not an assumption about PHY table layout.
     * xpd_tx_on later installs its generic DCO defaults; restoring these four
     * words preserves the calibrated state without a new channel calibration
     * while UART interrupts are disabled.
     * phy_pbus_set_dco uses exactly this (selector, bank) order in C5 libphy.
     */
    calibrated_dco[0] = (uint16_t)phy_pbus_rd(2u, 1u);
    calibrated_dco[1] = (uint16_t)phy_pbus_rd(3u, 1u);
    calibrated_dco[2] = (uint16_t)phy_pbus_rd(2u, 2u);
    calibrated_dco[3] = (uint16_t)phy_pbus_rd(3u, 2u);
    phy_stop_tx_tone(1);
    /* The stock stop-tone routine forces both DAC scaling bytes to 255.
     * Install our conservative/attenuated scale and keep I/Q swap intact.
     */
    REG_WRITE(DAC_SCALE_REG, (REG_READ(DAC_SCALE_REG) & 0xff0000ffu) | selected_scale);
    txdc_control = (REG_READ(TXDC_REG) & ~IQ_MASK) | TXDC_ENABLE;
    REG_WRITE(TXDC_REG, txdc_control);
    phy_set_txclk_en(0);
    phy_pbus_xpd_tx_off();
    memory_fence();
    hardware_owned = true;
    if (c5_radio_set_frequency_only(carrier_hz) != ESP_OK) {
        release_hardware();
        return false;
    }
    const int32_t lo_error = (int32_t)((int64_t)carrier_hz - c5_radio_frequency_hz());
    for (uint32_t b = 0; b < 256u; ++b) {
        const int32_t sample = b == 128u ? 0 : (int8_t)b;
        const int64_t numerator = ((int64_t)sample * FM_DEVIATION + (int64_t)lo_error * 127) * INT64_C(4294967296);
        const int64_t denominator = (int64_t)127 * C5_TX_IQ_HZ;
        const int64_t step = numerator >= 0 ? (numerator + denominator / 2) / denominator
                                             : -((-numerator + denominator / 2) / denominator);
        phase_steps[b] = (uint32_t)step;
    }
    memset(&counters, 0, sizeof(counters));
    counters.min_queue = C5_TX_RING_SAMPLES;
    write_head = read_tail = 0;
    end_seen = false;
    protected_stream = false;
    last_fault = NULL;
    armed = true;
    return true;
}

size_t IRAM_ATTR c5_tx_queued_samples(void) { return write_head - read_tail; }
size_t IRAM_ATTR c5_tx_free_samples(void) { return C5_TX_RING_SAMPLES - (write_head - read_tail); }
bool IRAM_ATTR c5_tx_is_active(void) { return armed; }
void IRAM_ATTR c5_tx_set_protected(bool value) { protected_stream = value; }
const char *c5_tx_fault(void) { return last_fault; }

bool IRAM_ATTR c5_tx_stage(uint16_t offset, uint8_t sample) {
    if (!armed || end_seen || offset >= c5_tx_free_samples()) return false;
    pcm_ring[(write_head + offset) & RING_MASK] = sample == 128u ? 0 : sample;
    return true;
}

bool IRAM_ATTR c5_tx_commit(size_t count) {
    if (!armed || end_seen || count > c5_tx_free_samples()) return false;
    memory_fence();
    write_head += (uint32_t)count;
    const uint32_t queued = write_head - read_tail;
    if (queued > counters.max_queue) counters.max_queue = queued;
    return true;
}

size_t IRAM_ATTR c5_tx_feed(const uint8_t *samples, size_t count) {
    if (!armed || end_seen || !samples) return 0;
    const size_t available = c5_tx_free_samples();
    const size_t accepted = count < available ? count : available;
    for (size_t n = 0; n < accepted; ++n)
        pcm_ring[(write_head + n) & RING_MASK] = samples[n] == 128u ? 0 : samples[n];
    if (accepted < count) counters.ring_drops += (uint32_t)(count - accepted);
    (void)c5_tx_commit(accepted);
    return accepted;
}

void IRAM_ATTR c5_tx_finish(void) { end_seen = true; }

void IRAM_ATTR c5_tx_stop(void) {
    armed = false;
    /* A streaming callback must never invoke a slow PHY function. */
    if (!running) release_hardware();
}

void c5_tx_get_stats(c5_tx_stats_t *stats) {
    if (stats) *stats = counters;
}

void IRAM_ATTR c5_tx_run(void (*pump)(void *), void *user) {
    if (!armed || running || !pump || !hardware_owned) return;
    if (write_head == read_tail) {
        if (!end_seen) last_fault = protected_stream ? "TX7_UNDERRUN" : "TX_UNDERRUN";
        armed = false;
        release_hardware();
        return;
    }
    running = true;
    uint32_t increment = phase_steps[pcm_ring[read_tail & RING_MASK]];
    ++read_tail;
    uint32_t phase = increment, subslot = 0;
    uint32_t next_word = txdc_control | iq_table[phase >> (32u - PHASE_BITS)];
    counters.samples = 1;
    bool stop_at_deadline = false;
    taskENTER_CRITICAL(&tx_mux);
    const unsigned irq_state = RV_CLEAR_CSR(mstatus, MSTATUS_MIE);
    /* Re-open the previously calibrated 2.4 GHz TX path. Unlike starting the
     * stock tone again, this does not retune or perform channel calibration
     * while PCM bytes are arriving in the hardware UART FIFO.
     */
    const uint32_t startup_begin = esp_cpu_get_cycle_count();
    phy_pbus_xpd_tx_on(39u, 1u);
    const uint16_t reopened_dco[4] = {
        (uint16_t)phy_pbus_rd(2u, 1u), (uint16_t)phy_pbus_rd(3u, 1u),
        (uint16_t)phy_pbus_rd(2u, 2u), (uint16_t)phy_pbus_rd(3u, 2u)
    };
    for (unsigned n = 0; n < 4u; ++n)
        if (reopened_dco[n] != calibrated_dco[n]) ++counters.startup_dco_changes;
    phy_pbus_set_dco(calibrated_dco);
    phy_set_txclk_en(1);
    memory_fence();
    counters.startup_cycles = esp_cpu_get_cycle_count() - startup_begin;
    uint32_t target = esp_cpu_get_cycle_count() + IQ_CYCLES;
    while (armed) {
        uint32_t now;
        do { now = esp_cpu_get_cycle_count(); } while ((int32_t)(now - target) < 0);
        const uint32_t late = now - target;
        if (stop_at_deadline) break;
        /* Write the word prepared in the preceding interval before doing any
         * data-dependent ring, statistics or UART work. This keeps PCM-slot
         * boundaries from moving the RF update within its 500-cycle period.
         */
        REG_WRITE(TXDC_REG, next_word);
        if (late > counters.max_late_cycles) counters.max_late_cycles = late;
        if (late > IQ_CYCLES / 4u) ++counters.late_slots;
        /* An entire missed I/Q slot is an RF timeline failure. Do not emit
         * a burst of catch-up samples or silently lower the sample rate.
         */
        if (late >= IQ_CYCLES) {
            last_fault = "TX_TIMING";
            armed = false;
            break;
        }
        target += IQ_CYCLES;
        subslot = (subslot + 1u) & 3u;
        pump(user);
        if (!armed) break;
        if (subslot == 0u) {
            const uint32_t queued = write_head - read_tail;
            if (queued < counters.min_queue) counters.min_queue = queued;
            if (!queued) {
                if (end_seen) { stop_at_deadline = true; continue; }
                ++counters.underruns;
                if (protected_stream) {
                    last_fault = "TX7_UNDERRUN";
                    stop_at_deadline = true;
                    continue;
                }
                ++counters.zero_samples;
                increment = phase_steps[0];
            } else {
                increment = phase_steps[pcm_ring[read_tail & RING_MASK]];
                ++read_tail;
            }
            ++counters.samples;
        }
        phase += increment;
        next_word = txdc_control | iq_table[phase >> (32u - PHASE_BITS)];
    }
    REG_WRITE(TXDC_REG, txdc_control);
    phy_set_txclk_en(0);
    phy_pbus_xpd_tx_off();
    memory_fence();
    RV_SET_CSR(mstatus, irq_state & MSTATUS_MIE);
    taskEXIT_CRITICAL(&tx_mux);
    running = false;
    armed = false;
    release_hardware();
}
