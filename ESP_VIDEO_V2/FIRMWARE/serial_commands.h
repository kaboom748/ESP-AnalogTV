#pragma once

// Diagnostic only: RF stays off. Payload byte n is
// ((n * 73 + 19) ^ (n >> 3) ^ (n >> 11)) & 255; signal is 0x5a3c.
// Both writers offer 129375 wire bytes/s on average. S uses the core writer
// with IRQs active; D uses the RX FIFO writer with IRQs masked, like RX.
// PACE optionally limits within-packet bursts without changing that average.
void runSerialTest(char writer, uint32_t requestedFrames) {
  receiveRequested = false;
  stopPhy();
  const uint8_t version = rxWireVersion;
  const uint16_t size = wireFrameSize(version);
  constexpr uint32_t offeredRate = 129375;
  const uint64_t scaledPeriod = static_cast<uint64_t>(cpuHz) * size;
  const uint32_t framePeriod = scaledPeriod / offeredRate;
  const uint32_t frameRemainder = scaledPeriod % offeredRate;
  uint32_t fractional = 0;
  uint32_t due = cycles();
  uint32_t completed = 0, bytes = 0;
  uint8_t packet[maxWireFrameSize];
  Serial.printf("OK TEST %c %lu WIRE %u PACE %lu\n", writer,
                static_cast<unsigned long>(requestedFrames), version,
                static_cast<unsigned long>(rxPaceBytes));
  Serial.flush();
  RxPacer pacer;
  pacer.init(rxPaceBytes);
  const bool direct = writer == 'D';
  const uint32_t savedStatus = direct ? xt_rsil(15) : 0;
  due = cycles();
  for (uint32_t frame = 0; frame < requestedFrames; ++frame) {
    // Leave a new command in the FIFO/buffer so loop() can parse it afterward.
    if (fifoCount() || Serial.available()) break;
    while (static_cast<int32_t>(cycles() - due) < 0) {
      if (!direct) delay(0);
    }
    const uint32_t index = frame * payloadSize;
    packet[0] = 'M'; packet[1] = 'P'; packet[2] = 'X';
    packet[3] = version == 4 ? '4' : '3';
    for (uint8_t byte = 0; byte < 4; ++byte) packet[4 + byte] = index >> (byte * 8);
    packet[8] = 0x3c; packet[9] = 0x5a;
    for (uint16_t sample = 0; sample < payloadSize; ++sample) {
      const uint32_t n = index + sample;
      packet[headerSize + sample] = ((n * 73u + 19u) ^ (n >> 3) ^ (n >> 11)) & 0xffu;
    }
    if (version == 4) {
      uint32_t crc = 0xffffffffu;
      for (uint16_t byte = 0; byte < frameSize; ++byte) crc = linkCrcByte(crc, packet[byte]);
      crc ^= 0xffffffffu;
      for (uint8_t byte = 0; byte < 4; ++byte) packet[frameSize + byte] = crc >> (byte * 8);
    }
    if (!direct && !rxPaceBytes) {
      const size_t written = Serial.write(packet, size);
      bytes += written;
      if (written != size) break;
    } else {
      for (uint16_t byte = 0; byte < size; ++byte) {
        uint32_t now;
        do { now = cycles(); }
        while (!pacer.ready(now) || (direct && txCount() >= 120));
        if (direct) USF(0) = packet[byte];
        else Serial.write(packet[byte]);
        ++bytes;
        pacer.sent(now);
      }
    }
    ++completed;
    if ((completed & 15u) == 0) ESP.wdtFeed();
    due += framePeriod;
    fractional += frameRemainder;
    if (fractional >= offeredRate) {
      fractional -= offeredRate;
      ++due;
    }
    if (static_cast<int32_t>(cycles() - due) > static_cast<int32_t>(framePeriod * 2)) {
      due = cycles();
      fractional = 0;
    }
  }
  if (direct) xt_wsr_ps(savedStatus);
  Serial.flush();
  Serial.printf("\nOK TEST DONE frames=%lu bytes=%lu\n",
                static_cast<unsigned long>(completed), static_cast<unsigned long>(bytes));
}

bool parseApwr(const char* text, uint8_t& value) {
  if (!text || !*text) return false;
  uint16_t parsed = 0;
  for (const char* digit = text; *digit; ++digit) {
    if (*digit < '0' || *digit > '9') return false;
    parsed = parsed * 10u + static_cast<uint8_t>(*digit - '0');
    if (parsed > maxApwr) return false;
  }
  value = static_cast<uint8_t>(parsed);
  return true;
}

void command(char* line) {
  const char* name = strtok(line, " \t");
  if (!name) return;
  const char* value = strtok(nullptr, " \t");
  if (!value && strcmp(name, "STATUS") == 0) {
    if (ESP.getCpuFreqMHz() == 160) Serial.println("OK STATUS CB_FM_STEREO 4");
    else Serial.println("ERR CPU160");
    return;
  }
  if (!value && strcmp(name, "STOP") == 0) {
    receiveRequested = false;
    stopPhy();
    rxWireVersion = 3;
    rxPaceBytes = defaultRxPace;
    Serial.println("OK STOP");
    return;
  }
  if (!value && strcmp(name, "INFO") == 0) {
    Serial.printf("OK INFO LINK 1 BAUD %lu WIRE %u PACE %lu CRC32 IEEE\n",
                  static_cast<unsigned long>(Serial.baudRate()), rxWireVersion,
                  static_cast<unsigned long>(rxPaceBytes));
    return;
  }
  if (!value && strcmp(name, "DIAG") == 0) {
    if (receiveRequested) {
      Serial.println("ERR STOP_FIRST");
      return;
    }
    Serial.printf("OK DIAG RX n=%lu inv=%lu skip=%lu tout=%lu drop=%lu late=%lu\n",
                  static_cast<unsigned long>(lastRxStats.samples),
                  static_cast<unsigned long>(lastRxStats.invalid),
                  static_cast<unsigned long>(lastRxStats.skipped),
                  static_cast<unsigned long>(lastRxStats.timeouts),
                  static_cast<unsigned long>(lastRxStats.queueDrops),
                  static_cast<unsigned long>(lastRxStats.maxLate));
    Serial.printf("OK DIAG UART bytes=%lu frames=%lu fifo=%lu wire=%u pace=%lu valid=%u\n",
                  static_cast<unsigned long>(lastRxStats.bytes),
                  static_cast<unsigned long>(lastRxStats.frames),
                  static_cast<unsigned long>(lastRxStats.maxFifo), lastRxWire,
                  static_cast<unsigned long>(lastRxPace), lastRxStatsValid ? 1 : 0);
    Serial.println("OK DIAG END");
    return;
  }
  if (ESP.getCpuFreqMHz() != 160) {
    Serial.println("ERR CPU160");
    return;
  }
  if (strcmp(name, "WIRE") == 0) {
    if (!value || (strcmp(value, "3") != 0 && strcmp(value, "4") != 0) || strtok(nullptr, " \t")) {
      Serial.println("ERR WIRE");
      return;
    }
    if (receiveRequested) { Serial.println("ERR STOP_FIRST"); return; }
    rxWireVersion = value[0] - '0';
    Serial.printf("OK WIRE %u\n", rxWireVersion);
    return;
  }
  if (strcmp(name, "PACE") == 0) {
    if (!value || (strcmp(value, "0") != 0 && strcmp(value, "150000") != 0 && strcmp(value, "160000") != 0) || strtok(nullptr, " \t")) {
      Serial.println("ERR PACE");
      return;
    }
    if (receiveRequested) { Serial.println("ERR STOP_FIRST"); return; }
    rxPaceBytes = strtoul(value, nullptr, 10);
    Serial.printf("OK PACE %lu\n", static_cast<unsigned long>(rxPaceBytes));
    return;
  }
  if (strcmp(name, "TEST") == 0) {
    const char* count = strtok(nullptr, " \t");
    char* end = nullptr;
    const uint32_t frames = count ? strtoul(count, &end, 10) : 0;
    if (!value || (strcmp(value, "S") != 0 && strcmp(value, "D") != 0) || !count ||
        *count < '0' || *count > '9' || *end || frames < 1 || frames > 30000 || strtok(nullptr, " \t")) {
      Serial.println("ERR TEST_ARGS");
      return;
    }
    if (receiveRequested) { Serial.println("ERR STOP_FIRST"); return; }
    runSerialTest(value[0], frames);
    return;
  }
  if (strcmp(name, "TX") == 0) {
    uint8_t selectedApwr;
    if (!parseApwr(value, selectedApwr) || strtok(nullptr, " \t")) {
      Serial.println("ERR TX_APWR");
      return;
    }
    // La consigne et le démarrage sont atomiques pour toutes les sources audio.
    beginTx(selectedApwr);
    return;
  }
  if (strcmp(name, "RX") != 0 || !value) {
    Serial.println("ERR COMMAND");
    return;
  }

  char* end;
  uint32_t selected = strtoul(value, &end, 10);
  if (*value < '0' || *value > '9' || *end) selected = 0;
  if (selected >= 1 && selected <= 13) selected = (2407UL + 5UL * selected) * 1000000UL + toneOffsetHz;
  if (selected < minFrequencyHz || selected > maxFrequencyHz) {
    Serial.println("ERR FREQUENCY");
    return;
  }

  const char* mode = strtok(nullptr, " \t");
  const Profile* selectedProfile = nullptr;
  for (const auto& candidate : profiles) {
    if (mode && strcmp(mode, candidate.name) == 0) selectedProfile = &candidate;
  }
  if (!selectedProfile) {
    Serial.println("ERR MODE");
    return;
  }

  const char* fine = strtok(nullptr, " \t");
  const int32_t offset = fine ? strtol(fine, &end, 10) : 0;
  if ((fine && (*end || end == fine)) || offset < -maxRxFineHz || offset > maxRxFineHz || strtok(nullptr, " \t")) {
    Serial.println("ERR FINE");
    return;
  }

  frequencyHz = selected;
  rxFineHz = offset;
  profile = selectedProfile;
  receiveRequested = true;
}
