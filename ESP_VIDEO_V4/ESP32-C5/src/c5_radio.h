/* SPDX-License-Identifier: GPL-3.0-or-later */
#pragma once
#include <stdint.h>
#include "esp_err.h"
#ifdef __cplusplus
extern "C" {
#endif

esp_err_t c5_radio_init(void);
/* The characterized C5 PHY tuning function has 1 kHz resolution. */
esp_err_t c5_radio_tune(uint32_t carrier_hz);
/* Retune an already calibrated/keyed chain without re-entering a channel. */
esp_err_t c5_radio_set_frequency_only(uint32_t carrier_hz);
uint32_t c5_radio_frequency_hz(void);
esp_err_t c5_radio_receive(uint32_t carrier_hz, int32_t fine_hz);
void c5_radio_idle(void);
#ifdef __cplusplus
}
#endif
