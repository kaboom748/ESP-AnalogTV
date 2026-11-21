/* ESP_VIDEO_V4 firmware for ESP32-C6, Arduino-ESP32 3.3.12.
 * UART0 GPIO16/TX and GPIO17/RX via the USB-UART bridge.
 */
#include <Arduino.h>
#include <esp_arduino_version.h>
#include "src/arduino_runtime.h"

#if !CONFIG_IDF_TARGET_ESP32C6
#error "Select ESP32C6 Dev Module"
#endif
#if ESP_ARDUINO_VERSION != ESP_ARDUINO_VERSION_VAL(3,3,12)
#error "Use Espressif Arduino-ESP32 3.3.12"
#endif

extern "C" void esp_analogav_run();

void setup() {
    if (c6_arduino_runtime_prepare() != ESP_OK) {
        for (;;) delay(1000);
    }
    esp_analogav_run();
}

void loop() { delay(1000); }
