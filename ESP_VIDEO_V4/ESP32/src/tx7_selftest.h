#pragma once
#include <stdint.h>
// RF-free comparison against fixtures from the unchanged browser TX7 codec.
// Zero is success; other values are a failing-case bitmap.
uint32_t tx7_selftest(const uint32_t *crc_table);
