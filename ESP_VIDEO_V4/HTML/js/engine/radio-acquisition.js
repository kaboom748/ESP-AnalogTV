/* Frequency probes use received PCM only, without rendering or audio playback. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CBRadioAcquisition = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN_SECONDS = 0.24;
  const STRONG_SECONDS = 0.32;
  const MAX_SECONDS = 0.96;
  const MIN_VALID_FRACTION = 0.90;

  function createAVProbe(C, AV) {
    let sessionId = null;
    let signature = null;
    let previousFrame = null;
    let headers = 0;
    let run = 0;
    let longestRun = 0;

    const decoder = new AV.Demuxer(C, {
      onAudio(packet) {
        if (!packet.headerValid) return;
        const {sessionId: id, plan, audioStartFrame: frame} = packet;
        if (id !== sessionId || plan.signature !== signature) {
          sessionId = id;
          signature = plan.signature;
          previousFrame = null;
          headers = run = longestRun = 0;
        }
        if (previousFrame !== null && frame <= previousFrame) return;
        run = previousFrame !== null && frame - previousFrame === plan.audioFramesPerBlock ? run + 1 : 1;
        previousFrame = frame;
        headers++;
        longestRun = Math.max(longestRun, run);
      }
    }, {dcRestoration: false});

    return {
      feed(bytes) { decoder.feedBytes(bytes); },
      gap(count) { decoder.feedMissing(count); },
      snapshot(samples) {
        const expected = Math.max(1, Math.floor(samples / AV.BLOCK_SAMPLES));
        const score = Math.min(1, headers / expected);
        return {
          score,
          qualified: headers >= 3 && longestRun >= 2,
          strong: score >= 0.80 && longestRun >= 4,
          headers,
          longestRun,
          headerCrcErrors: decoder.counters.headerCrcErrors,
          holdoverBlocks: decoder.counters.holdoverBlocks
        };
      }
    };
  }

  function createVideoProbe(C, mode) {
    const decoder = new C.Decoder({mode});
    const periods = [...new Set(C.plan(mode).rows.map(row => row.len))];
    let lastH = null;
    let run = 0;
    let longestRun = 0;
    let matchedIntervals = 0;
    let coherentSamples = 0;
    let timingError = 0;

    decoder.onHSignal = start => {
      const previous = lastH;
      lastH = start;
      if (previous === null) return;
      const interval = start - previous;
      const nearest = periods.reduce((best, period) => {
        return Math.abs(interval - period) < Math.abs(interval - best) ? period : best;
      });
      const error = Math.abs(interval - nearest);
      if (error > Math.max(13, nearest * 0.012)) {
        run = 0;
        return;
      }
      run++;
      longestRun = Math.max(longestRun, run);
      matchedIntervals++;
      coherentSamples += interval;
      timingError += error;
    };

    return {
      feed(bytes) { decoder.feedBytes(bytes); },
      gap(count) { decoder.feedMissing(count); },
      snapshot(samples) {
        const score = samples ? coherentSamples / samples : 0;
        return {
          mode,
          score,
          qualified: score >= 0.45 && longestRun >= 8 && decoder.horizontalSyncs >= 8,
          strong: score >= 0.80 && longestRun >= 10 && decoder.horizontalSyncs >= 10,
          headers: 0,
          longestRun,
          matchedIntervals,
          meanHError: matchedIntervals ? timingError / matchedIntervals : Infinity,
          horizontalSyncs: decoder.horizontalSyncs,
          verticalSyncs: decoder.verticalSyncs
        };
      }
    };
  }

  function compare(left, right) {
    const difference = Number(right.qualified) - Number(left.qualified) ||
      right.score - left.score ||
      right.longestRun - left.longestRun;
    if (difference) return difference;
    if (left.meanHError < right.meanHError) return -1;
    if (left.meanHError > right.meanHError) return 1;
    return (right.verticalSyncs || 0) - (left.verticalSyncs || 0);
  }

  function createProbe({C, AV, mode, mixed, auto320 = false}) {
    const modes = auto320 && (mode === 'bw320' || mode === 'bw320stable') ? ['bw320', 'bw320stable'] : [mode];
    const probes = mixed ? [createAVProbe(C, AV)] : modes.map(id => createVideoProbe(C, id));
    const maxSamples = Math.round(C.FS * MAX_SECONDS);
    const minSamples = Math.round(C.FS * MIN_SECONDS);
    const strongSamples = Math.round(C.FS * STRONG_SECONDS);
    let samples = 0;
    let missingSamples = 0;

    return {
      minSamples,
      maxSamples,
      feed(bytes) {
        const count = Math.min(bytes.length, maxSamples - samples);
        if (!count) return;
        const block = bytes.subarray(0, count);
        samples += count;
        for (const value of block) if (value === 0x80) missingSamples++;
        for (const probe of probes) probe.feed(block);
      },
      gap(count) {
        if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Missing sample count');
        const take = Math.min(count, maxSamples - samples);
        if (!take) return;
        samples += take;
        missingSamples += take;
        for (const probe of probes) probe.gap(take);
      },
      snapshot() {
        const validSamples = samples - missingSamples;
        const validFraction = samples ? validSamples / samples : 0;
        const evidence = probes.map(probe => probe.snapshot(samples)).sort(compare)[0];
        const enough = samples >= minSamples && validFraction >= MIN_VALID_FRACTION;
        return {
          ...evidence,
          qualified: enough && evidence.qualified,
          strong: enough && samples >= strongSamples && evidence.strong,
          samples,
          validSamples,
          missingSamples,
          validFraction
        };
      }
    };
  }

  return Object.freeze({createProbe, compare});
});
