#ifndef ESP_VIDEO_RX_SHARED_RING_H
#define ESP_VIDEO_RX_SHARED_RING_H
#include <stddef.h>
#include <stdint.h>

// Byte views into existing half-duplex TX storage, with no power-of-two waste.
// Caller indices are closed under next(); no modulo/division on the hot path.
namespace esp_video_rx_ring {
template<size_t StorageBytes, size_t FrameBytes>
struct Layout {
  static_assert(FrameBytes > 0, "RX frame size must be positive");
  static constexpr size_t slots = StorageBytes / FrameBytes;
  static_assert(slots >= 2 && slots <= 255, "RX indices must fit uint8_t with one reserved slot");
  static constexpr size_t usedBytes = slots * FrameBytes;
  static constexpr size_t remainingBytes = StorageBytes - usedBytes;
  static constexpr uint8_t capacity = static_cast<uint8_t>(slots - 1);
  static constexpr uint8_t next(uint8_t index) {
    return index + 1 == slots ? uint8_t(0) : static_cast<uint8_t>(index + 1);
  }
  static constexpr uint8_t depth(uint8_t write, uint8_t read) {
    return write >= read ? static_cast<uint8_t>(write - read) :
        static_cast<uint8_t>(slots - read + write);
  }
  static constexpr size_t offset(uint8_t index) { return size_t(index) * FrameBytes; }
};
}
#endif
