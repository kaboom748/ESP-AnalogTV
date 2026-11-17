/* ESP AnalogAV — ESP32-C5 / Arduino-ESP32 3.3.12.
 * Board: ESP32C5 Dev Module. USB CDC On Boot: Disabled (default).
 * UART0 GPIO11/TX, GPIO12/RX, CP210x; original HTML at 1500000 baud.
 * Native ADC10 I/Q estimator: HQ240kIQ/s, unchanged120kPCM/s wire format.
 * See LICENSE and NOTICE for source attribution.
 */
#include <Arduino.h>
#include <esp_arduino_version.h>
#include "src/arduino_runtime.h"

#if !CONFIG_IDF_TARGET_ESP32C5
#error "Select ESP32C5 Dev Module in the Espressif board manager"
#endif
#if ESP_ARDUINO_VERSION != ESP_ARDUINO_VERSION_VAL(3, 3, 12)
#error "This project is validated with Espressif Arduino-ESP32 3.3.12"
#endif

extern "C" void esp_analogav_run(void);

void setup() {
    if (c5_arduino_runtime_prepare() != ESP_OK) {
        for (;;) delay(1000);
    }
    // This owns the UART and serves the original HTML protocol continuously.
    esp_analogav_run();
}

void loop() {
    delay(1000);
}
