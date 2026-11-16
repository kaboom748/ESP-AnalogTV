#ifndef ESP_VIDEO_TX7_DECODER_H
#define ESP_VIDEO_TX7_DECODER_H

// Portable C++11, no Arduino headers, heap, I/O, interrupts or device access.
// Integration must stop RF on Faulted and preserve the existing PCM ring.
#include <stddef.h>
#include <stdint.h>
#if __cplusplus >= 201402L
#define ESP_TX7_CX constexpr
#else
#define ESP_TX7_CX inline
#endif

namespace esp_video_tx7 {
static const uint16_t kMaxBlock = 256;
static const uint16_t kHeaderBytes = 12;
static const uint16_t kMaxPacketBytes = 240;
static const uint16_t kResyncLimit = 512;
static const uint8_t kVersion = 1;
static constexpr uint8_t kMagic[4] = {0x54, 0x58, 0x37, 0xa7};

enum class Error : uint8_t {
  None, SyncLimit, Header, Length, Crc, Sequence, Padding, Symbol,
  RingOverflow, Truncated, Timeout, Underrun, MissingFinish, AfterFinish
};
enum class Result : uint8_t { NeedMore, BlockAccepted, Finished, Faulted };
struct Stats {
  uint32_t wireBytes, blocksAccepted, samplesAccepted, resyncBytes;
  uint32_t crcErrors, protocolErrors, sequenceErrors, overflowErrors;
  uint32_t truncatedErrors, timeoutErrors, underrunEvents;
  uint32_t zeroSubstitutions;  // Always zero: a damaged stream is stopped.
};
typedef uint32_t (*CrcByteFn)(uint32_t, uint8_t);

static ESP_TX7_CX uint32_t crc32ByteBitwise(uint32_t value, uint8_t byte) {
  value ^= byte;
  for (uint8_t bit = 0; bit < 8; ++bit)
    value = (value >> 1) ^ ((value & 1) ? 0xedb88320u : 0u);
  return value;
}
static constexpr uint32_t little32(const uint8_t* p) {
  return uint32_t(p[0]) | (uint32_t(p[1]) << 8) |
      (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24);
}
static constexpr uint8_t levelForSymbol(uint8_t symbol) {
  return symbol < 125 ? static_cast<uint8_t>(int(symbol) - 42) :
      symbol == 125 ? uint8_t(146) : symbol == 126 ? uint8_t(208) : uint8_t(88);
}

class Decoder {
 public:
  // Firmware should pass its existing DRAM-table linkCrcByte function. The
  // portable default avoids a second 1 KiB table but is not the fast RX table.
  explicit ESP_TX7_CX Decoder(CrcByteFn update = crc32ByteBitwise) :
      update_(update ? update : crc32ByteBitwise), stats_(), error_(Error::None),
      expectedIndex_(0), crc_(0xffffffffu), lastInputAt_(0), used_(0), discarded_(0),
      dataBytes_(0), packetBytes_(0), count_(0), matched_(0), finished_(false), wire_(), decoded_() {}
  ESP_TX7_CX void reset(uint32_t firstIndex = 0) {
    stats_ = Stats(); error_ = Error::None; expectedIndex_ = firstIndex;
    used_ = 0; matched_ = 0; discarded_ = 0; dataBytes_ = 0; packetBytes_ = 0;
    count_ = 0; crc_ = 0xffffffffu; lastInputAt_ = 0; finished_ = false;
  }
  constexpr const Stats& stats() const { return stats_; }
  constexpr Error error() const { return error_; }
  constexpr bool faulted() const { return error_ != Error::None; }
  constexpr bool finished() const { return finished_; }
  constexpr uint32_t expectedIndex() const { return expectedIndex_; }
  constexpr bool atBoundary() const { return used_ == 0 && matched_ == 0 && discarded_ == 0; }

  // Sink::enqueue(const uint8_t*, uint16_t) MUST either publish the whole block
  // once, or return false without writing any sample. There is one producer.
  // Copy with timer IRQs enabled; publish head only after all bytes are ready.
  template<class Sink>
  ESP_TX7_CX Result feed(uint8_t byte, uint32_t nowMs, Sink& sink) {
    if (faulted()) return Result::Faulted;
    if (finished_) return fail(Error::AfterFinish);
    ++stats_.wireBytes; lastInputAt_ = nowMs;
    if (used_ == 0) {
      if (byte == kMagic[matched_]) {
        if (++matched_ == 4) {
          crc_ = 0xffffffffu;
          for (uint8_t i = 0; i < 4; ++i) { wire_[i] = kMagic[i]; crc_ = update_(crc_, kMagic[i]); }
          used_ = 4; matched_ = 0;
        }
      } else {
        const uint16_t keep = byte == kMagic[0] ? 1 : 0;
        const uint16_t lost = uint16_t(matched_) + 1 - keep;
        matched_ = static_cast<uint8_t>(keep); discarded_ += lost; stats_.resyncBytes += lost;
        if (discarded_ > kResyncLimit) return fail(Error::SyncLimit);
      }
      return Result::NeedMore;
    }
    if (used_ >= kMaxPacketBytes) return fail(Error::Length);
    wire_[used_] = byte;
    if (used_ < kHeaderBytes || used_ < dataBytes_) crc_ = update_(crc_, byte);
    ++used_;
    if (used_ == kHeaderBytes) {
      if (wire_[4] != kVersion || wire_[5] > 1) return fail(Error::Header);
      count_ = uint16_t(wire_[6]) | (uint16_t(wire_[7]) << 8);
      if (wire_[5] == 1 ? count_ != 0 : (count_ == 0 || count_ > kMaxBlock)) return fail(Error::Length);
      dataBytes_ = kHeaderBytes + uint16_t((uint32_t(count_) * 7 + 7) / 8);
      packetBytes_ = dataBytes_ + 4;
    }
    if (packetBytes_ && used_ == packetBytes_) return complete(sink);
    return Result::NeedMore;
  }

  // Timeout is supplied by the firmware, usually UART_TIMEOUT_MS. No timeout
  // is invented between clean packet boundaries. Millisecond wrap is handled.
  ESP_TX7_CX bool checkTimeout(uint32_t nowMs, uint32_t timeoutMs) {
    if (!faulted() && !finished_ && !atBoundary() && uint32_t(nowMs - lastInputAt_) >= timeoutMs)
      fail(Error::Timeout);
    return !faulted();
  }
  ESP_TX7_CX bool finish() {
    if (!faulted() && !finished_) fail(atBoundary() ? Error::MissingFinish : Error::Truncated);
    return !faulted();
  }
  // Call from the main-loop fault handler, not concurrently from a timer ISR.
  ESP_TX7_CX void reportUnderrun() { if (!faulted()) fail(Error::Underrun); }

 private:
  template<class Sink>
  ESP_TX7_CX Result complete(Sink& sink) {
    if ((crc_ ^ 0xffffffffu) != little32(wire_ + dataBytes_)) return fail(Error::Crc);
    const uint32_t index = little32(wire_ + 8);
    if (index != expectedIndex_) return fail(Error::Sequence);
    if (wire_[5] == 1) {
      if (!sink.finish()) return fail(Error::RingOverflow);
      finished_ = true; used_ = 0; matched_ = 0; discarded_ = 0;
      dataBytes_ = 0; packetBytes_ = 0;
      return Result::Finished;
    }
    const uint8_t padding = uint8_t((8 - (uint32_t(count_) * 7) % 8) % 8);
    if (padding && (wire_[dataBytes_ - 1] & ((1u << padding) - 1))) return fail(Error::Padding);
    uint16_t reservoir = 0, at = kHeaderBytes;
    uint8_t bits = 0;
    for (uint16_t i = 0; i < count_; ++i) {
      while (bits < 7) { reservoir = uint16_t((reservoir << 8) | wire_[at++]); bits += 8; }
      bits -= 7;
      const uint8_t symbol = uint8_t((reservoir >> bits) & 127);
      decoded_[i] = levelForSymbol(symbol);
    }
    if (!sink.enqueue(decoded_, count_)) return fail(Error::RingOverflow);
    expectedIndex_ += count_; ++stats_.blocksAccepted; stats_.samplesAccepted += count_;
    used_ = 0; matched_ = 0; discarded_ = 0; dataBytes_ = 0; packetBytes_ = 0;
    return Result::BlockAccepted;
  }
  ESP_TX7_CX Result fail(Error code) {
    if (faulted()) return Result::Faulted;
    error_ = code;
    switch (code) {
      case Error::Crc: ++stats_.crcErrors; break;
      case Error::Sequence: ++stats_.sequenceErrors; break;
      case Error::RingOverflow: ++stats_.overflowErrors; break;
      case Error::Truncated: ++stats_.truncatedErrors; break;
      case Error::Timeout: ++stats_.timeoutErrors; break;
      case Error::Underrun: ++stats_.underrunEvents; break;
      default: ++stats_.protocolErrors; break;
    }
    return Result::Faulted;
  }
  CrcByteFn update_;
  Stats stats_;
  Error error_;
  uint32_t expectedIndex_, crc_, lastInputAt_;
  uint16_t used_, discarded_, dataBytes_, packetBytes_, count_;
  uint8_t matched_;
  bool finished_;
  uint8_t wire_[kMaxPacketBytes];
  uint8_t decoded_[kMaxBlock];
};
}  // namespace esp_video_tx7
#undef ESP_TX7_CX
#endif
