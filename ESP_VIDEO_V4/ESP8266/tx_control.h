#pragma once

static esp_video_tx7::Decoder tx7Decoder(linkCrcByte);
static esp_video_tx7::Stats lastTx7Stats = {};
static esp_video_tx7::Error lastTx7Error = esp_video_tx7::Error::None;
struct Tx7Sink {
  bool enqueue(const uint8_t* samples, uint16_t count) {
    const uint32_t position = head;
    if (position - tail > RAM_SIZE - count) { txStats.ringDrops += count; return false; }
    for (uint16_t i = 0; i < count; ++i) audioRing[(position + i) & RING_MASK] = samples[i];
    memw();head = position + count;txStats.pcmAccepted += count;
    return true;
  }
  bool finish() { memw();tx7EndSeen = true;return true; }
};
static Tx7Sink tx7Sink;

static const char* tx7FaultName(esp_video_tx7::Error error) {
  using esp_video_tx7::Error;
  switch (error) {
    case Error::Crc: return "TX7_CRC";
    case Error::Sequence: return "TX7_SEQUENCE";
    case Error::RingOverflow: return "TX7_RING_FULL";
    case Error::Timeout: return "TX7_TIMEOUT";
    case Error::Truncated: return "TX7_TRUNCATED";
    case Error::MissingFinish: return "TX7_NO_FIN";
    case Error::AfterFinish: return "TX7_AFTER_FIN";
    case Error::Underrun: return "TX7_UNDERRUN";
    case Error::SyncLimit: return "TX7_SYNC";
    default: return "TX7_PACKET";
  }
}

bool prepareTxRf(uint8_t apwr) {
  // La porte RF reste fermée tant que le tampon audio ne déclenche pas Timer1.
  if (!tune(frequencyHz - toneOffsetHz)) return false;
  saveRfState();
  enterManual();
  if (!txPathOn()) return false;
  set_ana_scale(apwr);
  toneProgramOff();
  set_txclk(1);
  return true;
}

void beginTx(uint8_t requestedApwr, bool useTx7 = false) {
  if (requestedApwr > maxApwr) {
    Serial.println("ERR TX_APWR");
    return;
  }
  if (!receiveRequested) {
    Serial.println("ERR SELECT_RX");
    return;
  }
  if (!prepareTxRf(requestedApwr)) {
    if (!releaseTxRf()) stopPhy();
    Serial.println("ERR TX_RF");
    return;
  }
  currentApwr = requestedApwr;
  tx7Active = useTx7;tx7EndSeen = false;txStats = TxStats();
  tx7Decoder.reset();
  head = tail = 0;
  receivedAudio = streamStarted = false;
  // Une trame tronquée ne doit pas absorber READY dans le lecteur série.
  static const uint8_t rxBoundary[maxWireFrameSize] = {};
  Serial.write(rxBoundary, wireFrameSize(rxWireVersion));
  Serial.flush();
  uartEnterStream();
  transmitting = true;
  lastAudioAt = millis();
  lastReadyAt = lastAudioAt - READY_REPEAT_MS;
}

void endTx(const char* error) {
  stopFM();
  if (tx7Active && txStats.underruns && !tx7Decoder.faulted()) tx7Decoder.reportUnderrun();
  lastTxStats = txStats;lastTxStatsValid = true;lastTxUsed7 = tx7Active;
  lastTx7Stats = tx7Decoder.stats();lastTx7Error = tx7Decoder.error();
  tx7Active = false;tx7EndSeen = false;
  transmitting = false;
  if (!releaseTxRf()) {
    stopPhy();
    error = "TX_RF";
  }
  uartReturnCommands();
  if (error) {
    Serial.printf("ERR %s\n", error);
    // Les derniers octets audio en vol appartiennent à l'ancienne session.
    const uint32_t drainAt = millis();
    do {
      while (Serial.available() > 0) Serial.read();
      delay(0);
    } while (millis() - drainAt < TX_FAULT_DRAIN_MS);
  }
}

void pollTx() {
  const uint32_t raw = rd32(UART_INT_RAW);
  const uint32_t errors = raw & (UART_RX_OVERFLOW_RAW | UART_RX_FRAME_RAW | UART_RX_PARITY_RAW);
  if (errors) {
    if (errors & UART_RX_OVERFLOW_RAW) ++txStats.uartOverflows;
    if (errors & UART_RX_FRAME_RAW) ++txStats.uartFrameErrors;
    if (errors & UART_RX_PARITY_RAW) ++txStats.uartParityErrors;
    wr32(UART_INT_CLR, errors);
    if (tx7Active) { endTx("TX7_UART");return; }
  }
  if (timerFinished) {
    endTx(tx7Active && tx7EndSeen && !timerError ? nullptr : (timerError ? timerError : "TX_TIMING"));
    return;
  }

  const uint32_t now = millis();
  // Bound one poll's UART work; Timer1 remains enabled during block validation.
  const uint32_t available = fifoCount();
  const uint32_t count = available > 64 ? 64 : available;
  if (count) {
    receivedAudio = true;
    lastAudioAt = now;
  }
  for (uint32_t n = 0; n < count; ++n) {
    const uint8_t sample = rd32(UART_FIFO) & 0xffu;
    ++txStats.wireBytes;
    if (tx7Active) {
      if (tx7Decoder.feed(sample, now, tx7Sink) == esp_video_tx7::Result::Faulted) {
        endTx(tx7FaultName(tx7Decoder.error()));return;
      }
      continue;
    }
    const uint32_t position = head;
    if (position - tail >= RAM_SIZE) { ++txStats.ringDrops;continue; }
    if (sample == 0x80) ++txStats.reservedZeroSubs;
    audioRing[position & RING_MASK] = sample == 0x80 ? 0 : sample;
    memw();
    head = position + 1u;
    ++txStats.pcmAccepted;
  }

  const uint32_t occupancy = occupancyBytes();
  if (occupancy > txStats.maxQueue) txStats.maxQueue = occupancy;
  if (streamStarted && occupancy < txStats.minQueue) txStats.minQueue = occupancy;
  if (tx7Active && tx7EndSeen && !streamStarted && occupancy == 0) { endTx(nullptr);return; }
  if (!streamStarted && (occupancy >= START_LEVEL || (tx7Active && tx7EndSeen && occupancy))) {
    startFM();
    streamStarted = true;
  }
  if (now - lastAudioAt >= (receivedAudio ? UART_TIMEOUT_MS : TX_ARM_TIMEOUT_MS)) {
    if (tx7Active && !tx7Decoder.finish()) { endTx(tx7FaultName(tx7Decoder.error()));return; }
    endTx(nullptr);
    return;
  }
  if (tx7Active && !tx7Decoder.checkTimeout(now, UART_TIMEOUT_MS)) {
    endTx(tx7FaultName(tx7Decoder.error()));return;
  }
  if (!receivedAudio && now - lastReadyAt >= READY_REPEAT_MS && txCount() <= 123) {
    for (uint8_t i = 0; i < 4; ++i) uartSend(streamReady);
    lastReadyAt = now;
  }
}

// Valider avant toute conversion en uint8_t : ni signe, ni décimale, ni débordement.
