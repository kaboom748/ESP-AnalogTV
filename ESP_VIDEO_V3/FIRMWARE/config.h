#pragma once

constexpr uint32_t cpuHz = 160000000;
constexpr uint32_t baud = 1500000;
// STOP restores the baseline wire format and the validated RX pacing.
constexpr uint32_t defaultRxPace = 150000;
uint32_t rxPaceBytes = defaultRxPace;
uint8_t rxWireVersion = 3;
constexpr uint32_t FM_FS = 120000;
static_assert(baud == 1500000, "Strict 1.5 Mbaud transport ceiling");
static_assert(FM_FS == 120000, "RF PCM cadence must remain 120 kHz");
constexpr uint32_t RAM_SIZE = 16384;
constexpr uint32_t RING_MASK = RAM_SIZE - 1;
constexpr uint32_t START_LEVEL = 8192;
static_assert((RAM_SIZE & RING_MASK) == 0, "La taille du tampon doit etre une puissance de deux");
static_assert(START_LEVEL < RAM_SIZE, "Seuil de demarrage TX invalide");
constexpr uint32_t UART_TIMEOUT_MS = 150;
constexpr uint32_t TX_ARM_TIMEOUT_MS = 1200;
constexpr uint32_t TX_FAULT_DRAIN_MS = 120;
constexpr uint32_t READY_REPEAT_MS = 25;
constexpr uint8_t cmdPtt = 0xa5;
constexpr uint8_t streamReady = 0xef;
// APWR : 0 = émission maximale, 191 = émission minimale.
constexpr uint8_t maxApwr = 191;
uint8_t currentApwr = 63;
constexpr int32_t deviationHz = 50000;
constexpr int32_t FM_K_OFFSET_STEPS = 4;
constexpr int32_t toneOffsetHz = FM_K_OFFSET_STEPS * 78125;
constexpr uint32_t defaultFrequencyHz = 2442312500UL;
constexpr uint32_t minFrequencyHz = 2401000000UL;
constexpr uint32_t maxFrequencyHz = 2482500000UL;
constexpr int32_t maxRxFineHz = 50000;

// Active TX format is fixed before Timer1 starts. Statistics stay in RAM;
// no UART logs or parser calls are made from the sample interrupt.
static volatile bool tx7Active = false;
static volatile bool tx7EndSeen = false;
struct TxStats {
  volatile uint32_t wireBytes = 0, pcmAccepted = 0, uartOverflows = 0;
  volatile uint32_t uartFrameErrors = 0, uartParityErrors = 0, ringDrops = 0;
  volatile uint32_t underruns = 0, zeroSamples = 0, reservedZeroSubs = 0;
  volatile uint32_t timerSkips = 0, minQueue = 0xffffffffu, maxQueue = 0;
};
static TxStats txStats, lastTxStats;
static bool lastTxStatsValid = false, lastTxUsed7 = false;

