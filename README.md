<img width="1897" height="979" alt="333" src="https://github.com/user-attachments/assets/23648d5b-0537-4ea8-a0d1-f956b442701f" />
# CB-VIDEO Analog TV V8 — ESP8266 2.4 GHz FM Video

**Experimental analog-style video transmitted over two ESP8266 radios, using a browser for video generation and display.** The system supports a webcam or built-in test pattern, progressive black-and-white and YUV color modes, automatic horizontal/vertical sync acquisition, and a live receiver picture that shows transmission defects instead of concealing them.

**This repository is the English-language edition of CB-VIDEO V8.** The accompanying **CB FM STEREO V12 firmware is the original 120 ksample/s build, unchanged**. This is **not** the later V9 USB-buffer/diagnostic firmware, nor the experimental 160K version.

> **Status: experimental.** The browser signal-processing code has been exercised in simulations. Reliable reception over real hardware, stable throughput, occupied bandwidth, legal compliance, and operation with every ESP8266 board/USB adapter have **not** been certified.

## Quick start

1. Have **two ESP8266-based boards**, two USB serial connections, and two computers running desktop **Chrome or Edge** with Web Serial support. One board is the transmitter, the other is the receiver; the RF link is **simplex**.
2. Flash the **same original V12 firmware** from [`CB_FM_STEREOv12_Arduino/`](CB_FM_STEREOv12_Arduino/) to each ESP8266. Configure the board for a **160 MHz CPU** using a compatible ESP8266 Arduino core. If both devices already run the original **120K V12** firmware, no reflash is needed.
3. Open [`CB_VIDEO_V8_EN_STANDALONE.html`](CB_VIDEO_V8_EN_STANDALONE.html) on **both computers**, or serve the repo directory locally and use `index.html`:

   ```bash
   python3 -m http.server 8000
   ```

   Then open `http://localhost:8000` in Chrome or Edge. A localhost origin is recommended for webcam permissions.
4. On both pages, select **the same video format and RF frequency** (default: **2442.3125 MHz**). Start with **160 × 120 progressive B&W** and the built-in **Analog test pattern**.
5. On the receiver page, choose **Receiver / Analog TV** and click **Connect USB serial**. On the transmitter page, choose **Transmitter / Webcam TX**, click **Connect USB serial**, select **Analog test pattern** (or **Enable webcam**), then click **Start TX**.
6. Observe the RX video and synchronization counters. **H + V locked** is the desired status. RF noise, tearing, incorrect colors, and lost samples are shown rather than corrected. When finished, click **Stop TX** before disconnecting.

> For early RF tests, use an **attenuated or shielded test setup** and comply with the local radio rules governing frequency, power, antenna, and emissions. The firmware generates experimental 2.4 GHz RF and is **not ordinary Wi-Fi or a certified analog-TV transmitter**.

## What is included

```text
CB_VIDEO_V8_EN_GITHUB/
├── README.md                          # This English guide
├── TEST_REPORT.md                     # Software tests and their limitations
├── CB_VIDEO_V8_EN_STANDALONE.html      # Complete single-file web app (recommended)
├── index.html                         # Modular web app entry point
├── app.js                             # Web Serial, camera, controls, status, stream scheduling
├── video-codec.js                     # Analog PCM8 scan generator and H/V receiver
├── build_standalone.py                # Rebuild the single-file HTML from the sources
├── CB_FM_STEREOv12_Arduino/           # Original unmodified V12 radio firmware
│   ├── CB_FM_STEREOv12_Arduino.ino
│   └── ... (9 original header files)
└── tests/                             # Source tests using Node and Python/Playwright
```

Use the **standalone HTML file** if you want a single file to open on each PC. Use **`index.html`** when you want to modify the JavaScript files independently. Both variants run the same application.

## System overview

```text
TRANSMITTER PC                  2.4 GHz RF LINK                  RECEIVER PC
Webcam / test pattern                                              
        |                                                            ^
RGB -> Y or YUV 4:2:0                                               | Scanline display
        |                                                            | Brightness/color adjustment
Analog raster + H/V sync                                             | Automatic H/V sync acquisition
        |                                                            |
PCM8 @ 120,000 samples/s          TX --> RX           PCM8 @ 120,000 samples/s
        |                                                            ^
Web Serial @ 2,000,000 baud                                          | Web Serial MPX3
        |                                                            ^
ESP8266 / original V12 firmware ====== experimental FM ======> ESP8266 / original V12
```

The HTML generates a sequence of signed **8-bit PCM values**. The V12 firmware converts the sequence to a frequency-modulated RF signal. The receiving firmware demodulates the signal and sends recovered PCM samples in **MPX3 frames** to the browser. The browser reconstructs a scanning display in real time.

There are **no JPEG frames, no video CRC, no forward error correction, no per-line validity checks, and no retransmission of damaged pixels**. Some serial framing and timing metadata still exist, because they are necessary to place samples on the raster; that is **not** video error correction.

### Analog sync and signal levels

The waveform reserves signal levels outside the normal picture range for synchronization. Nominal signed PCM values are:

| Component | Signed PCM8 level or duration |
|---|---|
| H-sync pulse | **−110** for **24 samples**, once per scanline |
| Black porch/reference | **−48**, 12 samples |
| White reference | **+88**, 12 samples |
| Front porch | 8 samples |
| Video luminance/chroma payload | Nominal levels **−38 to +78** |
| Back porch | 12 samples |
| V-sync marker | **168 samples:** 48 low / 12 high / 48 low / 12 high / 48 low |
| Vertical porch | 24 samples |

The browser's horizontal-sync separator evaluates the **pulse shape relative to its neighboring references** rather than requiring a fixed received PCM amplitude. The horizontal scan can acquire lock before vertical sync appears. Vertical sync starts a frame, while the receiver keeps its H lock across frame boundaries when possible. A missed sync pulse does not cause the video pixels themselves to be rejected.

The **Automatic black/white level restoration** checkbox adjusts received picture levels using the porch references. This is an analog-style level adjustment, **not** a video correction algorithm.

## Video formats and calculated frame rates

All modes below use the same **120,000 PCM8 samples/s**. FPS values are **nominal calculations**, including the format's sync/porch overhead. Actual displayed rate and sharpness depend on RF reception, browser scheduling, and hardware bandwidth.

| Mode | Resolution | Approx. frames/s | Notes |
|---|---|---:|---|
| Progressive B&W | 64 × 48 | 18.38 | 2, 16, or 256 gray levels |
| Progressive B&W | 80 × 60 | 13.23 | 2, 16, or 256 gray levels |
| Progressive B&W | 96 × 72 | 10.00 | 2, 16, or 256 gray levels |
| Progressive B&W | 128 × 96 | 6.31 | 2, 16, or 256 gray levels |
| Progressive B&W | 160 × 120 | 4.36 | Good initial RF test mode |
| Progressive B&W | 192 × 144 | 3.19 | Lower motion rate |
| Progressive B&W | 256 × 192 | 1.92 | Higher detail |
| Progressive B&W | 320 × 240 | 1.29 | 1 sample/pixel (Fast) |
| Progressive B&W Stable | 320 × 240 | 0.71 | 2 samples/pixel |
| Progressive YUV 4:2:0 | 64 × 48 | 10.59 | Color, lower-rate chroma |
| Progressive YUV 4:2:0 | 80 × 60 | 7.72 | Color, lower-rate chroma |
| Progressive YUV 4:2:0 | 96 × 72 | 5.90 | Color, lower-rate chroma |
| Progressive YUV 4:2:0 | 128 × 96 | 3.79 | Color, lower-rate chroma |
| Progressive YUV 4:2:0 | 160 × 120 | 2.65 | Suggested first color test |
| Progressive YUV 4:2:0 | 192 × 144 | 1.96 | Color, lower frame rate |
| Progressive YUV 4:2:0 | 256 × 192 | 1.20 | Largest available color mode |

**Total: 16 progressive formats. Interlaced 640 × 480 modes are intentionally excluded.** In B&W, changing from 256 to 16 or 2 gray levels does **not** change the number of samples per pixel or the nominal FPS. In color, Y is transmitted at full resolution, followed by half-width/half-height U and V planes; color corruption may be more visible after a sample loss.

### Receiver controls

The picture controls are located **directly below the RX display**:

| Control | Purpose |
|---|---|
| H-POSITION | Circular horizontal picture offset; columns wrap instead of disappearing |
| H-HOLD | Fine adjustment of horizontal scan timing |
| V-HOLD | Fine adjustment of vertical frame timing |
| H sync lock strength | How strongly detected H pulses pull the horizontal raster into alignment |
| Brightness / RX contrast | Adjust displayed luminance |
| Automatic black/white level restoration | Restore video amplitude references from the porches |
| Color saturation | Adjust displayed U/V chroma strength |
| Reset H/V position | Restore default H/V picture adjustments |
| Auto-detect 320×240 | Distinguish **Fast** (388 samples/line) from **Stable** (708 samples/line) in B&W RX |

**Automatic detection is limited to the two 320 × 240 B&W modes.** Other modes must be selected identically on both computers.

## Serial transport and hardware requirements

- **Radio hardware:** one ESP8266 device per station, running the original V12 sketch at **160 MHz CPU**. This is a specialized firmware using ESP8266-specific RF internals, not a general ESP32, Wi-Fi, or conventional analog-TV application.
- **USB transport:** **2,000,000 baud, 8 data bits, no parity, 1 stop bit (8N1)**. Verify that your USB-to-serial adapter, cable, and host driver can sustain this rate.
- **Sample transport:** PCM8 at **120 ksample/s**. The receiver provides **MPX3** frames consisting of **128 sample bytes plus a 10-byte header**, including the sample timeline index. That index allows the browser to keep scanning when a serial frame is missing.
- **RF link:** V12 experimental FM in the firmware's supported 2.4 GHz tuning range, with matching TX/RX tuning (plus RX fine frequency correction when necessary). The UI defaults to **2442.3125 MHz**.
- **Power setting:** APWR ranges from **0 to 191** in the firmware; **smaller values mean stronger output**. APWR is **not** a calibrated dBm readout. Begin with conservative settings in a controlled RF test arrangement.
- **Browsers:** desktop Chrome or Edge supporting `navigator.serial`; camera access additionally requires browser permission and a suitable secure context such as `http://localhost`.

The firmware is **simplex**: the transmitter and receiver cannot both send video simultaneously over this single link. **One ESP8266 per PC** is the intended setup.

## Building and testing

To regenerate the English standalone page from the modular files:

```bash
python3 build_standalone.py
```

The output is `CB_VIDEO_V8_EN_STANDALONE.html`. No framework, bundler, or npm dependencies are needed for the application itself.

The simulation tests require **Node.js** for the JavaScript codec checks. Browser integration tests additionally require **Python 3**, **Playwright**, and **Chromium**. For example:

```bash
node tests/test_video.cjs
node tests/test_reserved_markers_v8.cjs
node tests/test_sync_adversarial.cjs
python3 tests/test_serial_mock.py
python3 tests/test_end_to_end_browser.py
```

For Playwright tests, adjust the Chromium executable path in the test scripts if `/usr/bin/chromium` is unavailable on your computer. Read [`TEST_REPORT.md`](TEST_REPORT.md) for the test scope and limitations. **Passing software tests does not establish reliable RF operation.**

## Troubleshooting

| Symptom | What to check |
|---|---|
| **Connect USB serial** unavailable | Use a supported desktop browser; close Arduino Serial Monitor or other software holding the COM port |
| Webcam unavailable | Grant camera permission or serve from `http://localhost`; select the test pattern for debugging |
| Firmware rejected | Confirm original **120K V12** on both ESP8266 devices, not 160K or V9 |
| Black/snow-only RX | Check connection, common RF channel, TX active state, frequency offset, and RX sample rate; start with a shielded/attenuated link |
| **H = 0 / V = 0** with recognizable picture | Check matching HTML versions, sync reference levels, RX PCM rate, sample discontinuities, and filter/overload behavior |
| Horizontal tearing or line shifts | Check the missing-sample counter and maximum TX scheduling delay before compensating with H-POSITION |
| Correct picture but displaced horizontally | Start at H-POSITION = 0, then adjust slightly; large offsets suggest frame/line misalignment |
| Correct B&W but unstable colors | Verify matching color format; U and V are transmitted after Y and are vulnerable to lost samples |
| Fast and Stable modes mixed up | Enable **Auto-detect 320×240** on RX, or explicitly select the same 320×240 mode on both ends |
| TX picture freezes or acquires horizontal bands | Keep TX browser tab in the foreground; check for host USB stalls, buffer starvation, and RF/IQ overrun |

The **local format test** simulates signal imperfections but cannot verify actual RF power, frequency deviation, USB driver performance, or error-free over-the-air picture transmission.

## Known limitations

1. **Low video frame rate.** The highest 320 × 240 B&W mode achieves only about **1.29 FPS nominally** (Fast) or **0.71 FPS** (Stable). This is not full-motion broadcast television.
2. **No guaranteed picture resolution.** The nominal pixel grid is not equivalent to measured analog RF video bandwidth. Fine horizontal details may blur or distort.
3. **Best-effort browser timing.** Web Serial and JavaScript timers are not a hard real-time link. The transmitter firmware has a **16,384-byte PCM buffer** (about **136 ms** at 120 ksample/s). A host stall can cause underflow, turning part of the waveform into zero-valued PCM; no sync algorithm can recover samples never sent.
4. **RX processing limits.** The V12 HQ receiver performs approximately **240,000 I/Q acquisitions per second**. Estimator delays, radio noise, invalid samples, and buffering can disrupt video.
5. **No error concealment.** No CRC-based video acceptance, FEC, per-line validity filtering, retransmissions, or pixel repair. Missing PCM samples may be displayed as synthetic snow. Video defects are intentional and visible.
6. **Color is especially fragile.** Sequential Y/U/V planes can develop misplaced chroma or dramatic color errors if sync or samples are lost.
7. **Automatic sync is not infallible.** It can recover from certain missing markers and gain/DC shifts but cannot guarantee stable lock with arbitrary interference, clipping, severe fading, or discontinuous TX.
8. **Not an interoperable TV standard.** It is **not PAL, NTSC, analog broadcast VHF/UHF video, DVB, or Wi-Fi streaming**. A conventional television or SDR will not automatically decode it.
9. **No hardware certification.** Frequency accuracy, occupied bandwidth, harmonic emissions, power, and regulatory eligibility require independent measurement. Operate only where authorized.
10. **Hardware results are pending.** Existing tests are software simulations and browser serial mocks. Field screenshots may show successful partial reception, but they do not prove an error-free, stable link.

## Credits, sources, and licensing

- Original ESP8266 radio work references **ESP-AnalogRadio / FMStereoHQv3**, **FMStereoRX**, and RF/phase-estimator work by **SP8ESA**. See the original attribution and MIT notice at the top of [`CB_FM_STEREOv12_Arduino.ino`](CB_FM_STEREOv12_Arduino/CB_FM_STEREOv12_Arduino.ino). **That file and its companion firmware files are unmodified in this edition.**
- The HTML analog video generator and decoder are an experimental project layered above the V12 serial PCM interface. It uses Web Serial and the browser camera/canvas APIs.
- Background reading: [Analog Devices — Basics of Analog Video](https://www.analog.com/en/resources/technical-articles/basics-of-analog-video.html), [Analog Devices — Clamps, Bias and AC-Coupled Video Signals](https://www.analog.com/en/resources/technical-articles/get-a-grip-on-clamps-bias-and-accoupled-video-signals.html), and the [Web Serial specification](https://serial.spec.whatwg.org/).

**Licensing note:** The original firmware contains an MIT license notice and attribution that must be preserved. This packaging does not invent or assign a new license to the entire web project. If you publish the repository, review the ownership and upstream notices and add an appropriate project-level `LICENSE` for the portions you have the right to license.
