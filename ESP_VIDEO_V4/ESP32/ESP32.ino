/* ESP_VIDEO_V4 — ESP32, stock Arduino-ESP32 3.3.12.
 * Original HTML/protocol, UART0 GPIO1/TX GPIO3/RX via USB-UART bridge.
 * Native IQ receiver and NCO transmitter for the shared analog A/V console.
 * Classic dual-core Xtensa ESP32, fixed 240 MHz.
 */
#include <Arduino.h>
#include <esp_arduino_version.h>
#include "src/arduino_runtime.h"
#if !CONFIG_IDF_TARGET_ESP32
#error "Select ESP32 Dev Module"
#endif
#if ESP_ARDUINO_VERSION != ESP_ARDUINO_VERSION_VAL(3,3,12)
#error "Use Espressif Arduino-ESP32 3.3.12"
#endif
extern "C" void esp_analogav_run();
void setup() {
    if(e32_arduino_runtime_prepare()!=ESP_OK)for(;;)delay(1000);
    esp_analogav_run();
}
void loop() {delay(1000);}
