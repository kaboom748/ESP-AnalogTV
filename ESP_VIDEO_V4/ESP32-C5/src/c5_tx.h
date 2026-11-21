/* SPDX-License-Identifier: GPL-3.0-or-later
 * ESP_VIDEO_V3 ESP32-C5 continuous FM transmitter.
 * TXDC register layout documented by the ESPARGOS / ESPsoup C5 backend;
 * see the distribution's NOTICE and upstream source references.
 */
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define C5_TX_PCM_HZ 120000u
#define C5_TX_IQ_HZ 480000u
#define C5_TX_RING_SAMPLES 16384u

typedef struct {
    uint32_t samples;
    uint32_t underruns;
    uint32_t zero_samples;
    uint32_t timer_skips;
    uint32_t ring_drops;
    uint32_t min_queue;
    uint32_t max_queue;
    uint32_t max_late_cycles;
    uint32_t late_slots;
    uint32_t startup_cycles;
    uint32_t startup_dco_changes;
} c5_tx_stats_t;

bool c5_tx_init(void);
/* Calibrates before READY, then disables TX until run. The stock PHY
 * calibration uses a brief CW tone. Call run only after the PCM prefill. */
bool c5_tx_start(uint32_t carrier_hz, uint8_t apwr);
/* Blocks until stop/finish/fault, with interrupts masked during the RF loop.
 * pump executes once per IQ interval (500 cycles at 240 MHz), so it must be
 * bounded, allocation-free, and use direct UART polling rather than an ISR.
 * It may call feed/stage/commit/finish/stop. PHY cleanup runs after the loop.
 */
void c5_tx_run(void (*pump)(void *), void *user);
void c5_tx_stop(void);
void c5_tx_finish(void);
bool c5_tx_is_active(void);
size_t c5_tx_free_samples(void);
size_t c5_tx_queued_samples(void);
size_t c5_tx_feed(const uint8_t *samples, size_t count);
/* Reserve by checking free_samples before a block, stage each decoded sample
 * without publishing it, then commit only after CRC/sequence validation.
 * Staging offsets are relative to the current unpublished write head.
 */
bool c5_tx_stage(uint16_t offset, uint8_t sample);
bool c5_tx_commit(size_t count);
void c5_tx_set_protected(bool protected_stream);
const char *c5_tx_fault(void);
void c5_tx_get_stats(c5_tx_stats_t *stats);

#ifdef __cplusplus
}
#endif
