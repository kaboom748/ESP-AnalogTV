/* AudioWorklet adapters for the upstream AnalogAV audio engine.
 * DSP remains in js/engine/analog-audio.js: both processors reuse its existing
 * StreamingResampler, interleave and PlaybackState implementations.
 * The parent page owns permissions, gain, volume and all hardware connections.
 */
import '../js/engine/analog-audio.js';

const Audio = globalThis.CBAnalogAudio;
if (!Audio) throw Error('The AnalogAV audio engine could not be loaded.');

class AnalogAVCapture extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const config = options.processorOptions || {};
    this.channels = config.channels || 1;
    this.resampler = new Audio.StreamingResampler(sampleRate, config.rate || 16000, this.channels);
    this.inFlight = 0;
    this.maximumInFlight = 8;
    this.droppedFrames = 0;
    this.port.onmessage = event => {
      if (event.data?.type === 'captureAck') this.inFlight = Math.max(0, this.inFlight - 1);
    };
  }

  process(inputs, outputs) {
    for (const bus of outputs) for (const channel of bus) channel.fill(0);
    const input = inputs[0];
    if (!input?.length || !input[0]?.length) return true;
    try {
      const samples = this.resampler.push(Audio.interleave(input, this.channels));
      const frames = samples.length / this.channels;
      if (!frames) return true;
      const startFrame = this.resampler.outputFrames - frames;
      if (this.inFlight >= this.maximumInFlight) {
        this.droppedFrames += frames;
        return true;
      }
      this.inFlight++;
      this.port.postMessage({
        type: 'capture', samples, startFrame,
        inputChannels: input.length, droppedFrames: this.droppedFrames,
      }, [samples.buffer]);
    } catch (error) {
      this.port.postMessage({ type: 'error', message: error.message || String(error) });
    }
    return true;
  }
}

class AnalogAVPlayback extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    this.state = new Audio.PlaybackState({ ...(options.processorOptions || {}), outputRate: sampleRate });
    this.reportedFrames = 0;
    this.reportInterval = Math.max(128, Math.round(sampleRate / 40));
    this.port.onmessage = event => {
      const message = event.data;
      if (message?.type !== 'push') return;
      const packet = message.packet;
      const frames = packet?.samples?.length / this.state.channels || 0;
      let accepted = false;
      try {
        accepted = this.state.push(packet);
      } catch (error) {
        this.port.postMessage({ type: 'error', message: error.message || String(error) });
      } finally {
        this.port.postMessage({ type: 'ack', frames, accepted });
      }
    };
  }

  process(_inputs, outputs) {
    const bus = outputs[0];
    const frames = bus?.[0]?.length || 128;
    try {
      const audio = this.state.render(frames);
      if (bus) for (let channel = 0; channel < bus.length; channel++) {
        bus[channel].set(audio[channel] || audio[0]);
      }
      this.reportedFrames += frames;
      if (this.reportedFrames >= this.reportInterval) {
        this.reportedFrames = 0;
        this.port.postMessage({
          type: 'playhead', stats: this.state.stats(),
          contextTime: currentTime + frames / sampleRate,
        });
      }
    } catch (error) {
      if (bus) for (const channel of bus) channel.fill(0);
      this.port.postMessage({ type: 'error', message: error.message || String(error) });
    }
    return true;
  }
}

registerProcessor('analog-av-capture', AnalogAVCapture);
registerProcessor('analog-av-playback', AnalogAVPlayback);
