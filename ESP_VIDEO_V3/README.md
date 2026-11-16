# ESP AnalogAV

Analog video, analog audio, or continuous analog audio with synchronized video. The project builds on ESP AnalogTV MAX and [ESP_VIDEO_V2](https://github.com/kaboom748/ESP-AnalogTV/tree/99f36c3a2c1ab76dd2ffde0fdc3730af4f310c05/ESP_VIDEO_V2).

**Release 1.5: EASY setup with the full ADVANCED interface retained.** The English interface provides 57 interactive controls: 17 EASY controls and the original 40 advanced controls. All 329 transmission choices remain available. The DSP, radio protocol and firmware are unchanged from release 1.4, including its control-reference audio restoration, RF clock tracking and paced TX priming. No new browser or physical device tests were performed.

ESP hardware testing remains paused after a reported BSOD 0x139 whose cause is unresolved. This release does not install or change Windows or CH340 drivers. The supplied MAX firmware has been compiled, but has not been flashed or newly tested on hardware.

## Open the page

With Python 3 available, run this from the project folder:

    python TOOLS/serve.py

On Windows, `py -3 TOOLS/serve.py` is an alternative when using the Python launcher. Open the printed local address in a browser supporting Web Serial and microphone/camera access. Chrome and Edge are the intended targets; actual browser rendering and device permissions remain outside this offline qualification.

The server serves project files on 127.0.0.1 and does not control hardware. The HTML can also be opened directly. If AudioWorklet cannot load, the audio engine attempts a ScriptProcessor fallback and reports it. Localhost is preferable for audio modules and Web Serial.

The main page is [HTML/ESP_ANALOG_AV.html](HTML/ESP_ANALOG_AV.html). The previous HTML filename is kept as an identical copy.

## EASY and ADVANCED

The page opens in **EASY**, initially set to Receive and Video only. Choose Transmit or Receive, then Audio + video, Video only or Audio only. **Choose ESP** opens the browser's serial-port picker; selecting a port does not start transmission. Loading the page, refreshing sources and changing tabs do not request camera/microphone access or open a serial connection.

EASY offers four video presets: 128 × 96 B&W, 320 × 240 B&W, 640 × 480 B&W and 256 × 192 color. Audio presets are 8, 16, 24 and 48 kHz mono. **Custom · Advanced** opens the complete controls without replacing a custom value. ADVANCED retains all 21 video profiles, all 14 audio choices, the minimum-FPS policy, picture controls, RF settings and diagnostics. Tab changes preserve settings and a running stream.

The summary uses the actual bandwidth planner: FPS includes A/V overhead and block rounding, and the displayed synchronization delay is a buffer target rather than measured latency. USB connection and RF acquisition are shown separately; a connected ESP does not prove a received signal.

## Available modes

- **Video only:** all 21 existing video profiles, using the unchanged classic video path without A/V overhead.
- **Audio + video:** each of those profiles with 8, 12, 16, 24, 32, 44.1 or 48 kHz audio, in mono or stereo.
- **Audio only:** the same 14 audio choices, without a webcam or video frame.

Choose automatic FPS or a minimum FPS. The page displays the planned FPS and synchronization delay before TX. An impossible request is rejected; resolution, color detail and audio sample rate are not silently reduced.

The [CSV catalogue](VALIDATION/modes.csv) lists all 329 combinations. For example, 640 × 480 B&W with 16 kHz mono audio has **0.272 planned FPS**, or 3.68 seconds per image. Its planned receive synchronization delay is **3.92 seconds**: one image duration plus 240 ms. Headers and guards consume 11,200 slots/s, and image starts are aligned to 40 ms blocks. Displayed FPS includes these costs and block rounding.

The radio remains at **120,000 PCM slots/s**, with **1,500,000 baud, 8N1** serial transport. Each audio sample in each channel consumes a slot. Headers are digital and protected; audio and video payloads remain analog amplitudes without content CRC, file coding, retransmission or audio FEC. An audio rate in kHz does not imply 16-bit resolution or CD fidelity. Video retains the classic 117 transmitted amplitude levels and its original pixel/chroma samples.

Stereo channel isolation is not qualified. The current interleaved L/R layout puts the channel difference near the HQ filter's attenuation band; sampled-phase models show substantial channel leakage, sometimes approaching mono. Use mono when channel isolation is required. The mode catalogue and cadence tests do not establish stereo fidelity.

## Transmitter

1. In EASY, choose **Transmit** and the content type, then **Choose ESP** and select the transmitter's port.
2. Refresh sources if necessary. Select the webcam or **Test pattern**, and select the microphone independently when sending audio. Audio only needs no webcam.
3. Choose video/audio quality and check the planned FPS and delay. Use **Custom · Advanced** for a mode outside the EASY presets; returning to EASY preserves that choice.
4. Click **Start broadcasting**. This explicit action connects the selected ESP, requests only the required media permissions and starts TX. Video-only test-pattern transmission requests neither a camera nor a microphone. Check the microphone meter when sending audio.
5. Click **Stop broadcasting** to stop TX and disconnect. EASY releases sources that it enabled; camera/microphone sources already enabled in ADVANCED are preserved. **Cancel** stops a pending startup. If the browser is still completing a native port-open operation, the page shows closing/cleanup and prevents another connection until it finishes.

Capacity settings are locked during TX; live level controls remain available. ADVANCED retains the separate Connect, webcam/microphone enable, Start TX and Stop TX actions. A mono microphone does not become a true stereo source: duplication is reported. When using the ADVANCED controls, re-enable the microphone after changing its device, sample rate or channel count. Capture uses anti-aliasing resampling.

A/V writes are driven by audio capture events, including while the page is in the background. A detected capture interruption or source gap stops TX with an explicit error. Browser or system suspension cannot guarantee continuous transmission. Video-only transmission retains its stop-on-hidden-tab behavior.

## Receiver

In EASY, choose **Receive**, select the matching content type, then **Choose ESP** and select the receiver's port. For Video only, set the same video format as the transmitter; use **Custom · Advanced** when needed. Click **Start receiving**. For an audio transmission, this also arms listening without requesting a microphone or webcam. Adjust the receive volume and use **Stop receiving** to stop and disconnect.

For Audio + video or Audio only, the receiver identifies the format from CRC-validated A/V headers. EASY displays the received format and cadence rather than treating local TX quality settings as received evidence. Until acquisition, it shows **Waiting for signal**. ADVANCED retains separate connection, Listen and Pause controls. Classic video-only reception still requires matching format support at both ends.

Audio is reconstructed continuously, independently of image duration. For synchronized complete images, the planned receive delay is one image duration plus 240 ms. This displayed buffer target is not a measured antenna-to-speaker latency. Image presentation follows the scheduled audio playhead. A new transmission re-primes playback, including when its format is unchanged.

After lock, a bad header CRC does not mute an otherwise available analog payload: the receiver maintains the known timeline and slot layout. Actual missing samples remain explicit holes: red video pixels and brief audio concealment while the playback clock continues.

### Receiver correction in release 1.2

The installed HQ firmware continuously removes frequency DC with a slow estimator. Its memory spans the 40 ms audio/video slices. A single offset measured at the beginning of each slice was insufficient: even a silent audio source could acquire a 25 Hz buzz depending on the picture.

The receiver now learns the known high-pass response from CRC-validated control samples and reverses it before separating the payloads. It preserves the actual received analog noise and missing samples. A flat channel stays unchanged; unsupported or uncertain observations keep the normal path. After acquisition, damaged metadata uses the established correction with pilot or predicted baseline holdover. Restored video retains a continuous reference level to avoid a new brightness step when correction starts. Audio is not filtered with a bass-cut or a 25 Hz notch.

Short scan lines already have frequent black/white reference porches. Their original video bytes and clamp are preserved when a line spans at most 10% of the DC time constant. Audio restoration still applies in these modes. The five longer-line profiles (B&W 320 stable, B&W 640, B&W 640 stable, color 256 stable and color 640) also receive video DC restoration. The 16 remaining video profiles retain their original video path. This conservative policy avoids the image regressions found when applying the inverse to shorter lines in the integer model.

Select **Video + continuous analog audio on both stations** for a mixed transmission. The RF diagnostics now show metadata CRC failures, holdover and phase corrections separately from USB CRC counters. The same panel reports whether DC restoration is active or still gathering evidence. An armed audio player no longer implies an RF lock.

The correction does not change TX, firmware, waveform framing, resolution, sample-rate choices or predicted FPS. No flash is needed. Its numerical tests include the documented integer-Q12 firmware DC stage and HQ FIR. Actual over-the-air behavior still requires verification.

### Clock recovery and diagnostic capture in release 1.3

A delay of 780 RF samples (6.5 ms) reproduced a persistent audio/video mix-up in the previous receiver, even with intact USB packets. Its local header search covered only 512 samples. After a larger shift, holdover could continue indefinitely at the wrong slot position. Raw-mode firmware underruns can insert held or zero output without a corresponding USB packet gap, so the serial CRC and missing-sample counters alone cannot exclude this failure.

The receiver now searches for CRC-validated A/V headers outside that local window and reanchors the slot layout. Damaged metadata can still use holdover while the receiver seeks verified alignment. Clock recovery is distinct from amplitude restoration; the RF panel reports both.

DC calibration also fits the fractional sampling phase between the two ESP clocks. Flat-channel and high-pass hypotheses learn their phases separately from known control samples. This addresses cases where valid metadata was received but release 1.2 never enabled restoration. The tests cover sampled RF phase and idealized PWM trajectories; nonlinear I/Q-DC removal and undocumented hardware AGC/PLL behavior remain outside the linear correction's qualification.

In the diagnostics section, **Save RX diagnostic capture** saves a bounded rolling window of received samples and packet indices, together with selected settings and counters. The file contains the received audio/video signal. Saving is manual and local; it does not upload data or open a serial port. The capture can be replayed offline to investigate an actual failing reception.

    node TOOLS/replay-rx-capture.js capture.json --output replay.json

Replay starts with fresh decoder state at the beginning of the retained window. The report keeps the original live counters separate from replay counters; it does not recreate DSP or playback state from before the window.

### Audio corrections in release 1.4

The real RX capture exposed two distinct failures. The prior DC restoration never activated because its linear HQ response did not fit the actual control-symbol transitions. Some RF blocks also arrived compressed in time, which could move video samples into the fixed audio window despite an intact receiver USB stream.

An additional audio restoration model learns a bounded dynamic response from known control symbols. Flat and high-pass hypotheses are compared on held-out control samples. TV sound is not a calibration target: no audio centering, 25 Hz notch or bass-cut filter is applied. The new fallback restores audio only and preserves the previous video path. The legacy restoration remains available for channels it already fits.

RF clock recovery verifies candidate timing against control CRC and coherent source metadata before accepting a resampled block. Ordinary stable blocks retain their existing path. Actual unreceived source samples remain unrecoverable; playback concealment does not make them exact audio.

TX priming accounts for the serial wire duration of the prebuffer, because a completed browser write can mean bytes are queued rather than transmitted. This prevents a modeled startup RAM overflow without changing the steady sample rate or video waveform. It is a separate preventative fix, not proof of the source of every timing fault in the captured RF signal.

Private received audio/video and the input diagnostic JSON are excluded from the release archive. Portable tests use generated signals; replay measurements record only input hashes and derived statistics.

On the supplied capture, the new control model reduced the coherent 25 Hz component by 37.3 dB across the same 333 stable blocks, while leaving video bytes identical with clock recovery disabled to isolate that comparison. Clock recovery separately restored 11 rejected headers and confirmed five more blocks with a following CRC. Offline playback of the complete retained source interval had no missing output frames, compared with 2,014 before correction. See [real RX replay measurements](VALIDATION/real-rx-replay.json). These results do not establish removal of all high-frequency analog hiss or a universal RF-quality guarantee.

**Compatibility:** video-only reception follows the MAX classic signal and needs a peer supporting the chosen format. AV1 audio multiplexing requires this new page at both ends. A compatible installed firmware can transport the unchanged 120 kHz PCM stream; no automatic flashing is performed. TX7 is negotiated when supported, with the existing raw-PCM fallback for older firmware.

## Sources and tests

Source modules are in LIB; the audio worklet processor is in AUDIO. Verify that the standalone HTML contains the current source modules with:

    python TOOLS/build-standalone.py --check

Without `--check`, the tool rebuilds the page. The Node.js tests in TESTS require no npm packages and do not open a browser or device. Release 1.5 has 21/21 EASY tests and 20/20 interface-qualification tests passing, covering all 57 controls and preservation of all 329 choices with simulated browser/device APIs. This is software evidence, not a new browser, USB or radio certification. See [VALIDATION.md](VALIDATION.md), [TESTS/PORTABLE-TESTS.txt](TESTS/PORTABLE-TESTS.txt), and their JSON reports. Original licenses and attributions are retained.
