/* CLEAN VIEW presentation. Called by the existing console refresh; no timer,
 * video pixels, playback, media sources or receiver settings are changed. */
(function (root) {
  'use strict';
  const $ = id => document.getElementById(id);
  const write = (id, value) => { const node = $(id); if (node.textContent !== value) node.textContent = value; };
  const phases = {BW: 'B&W', Y: 'LUMA', U: 'COLOR U', V: 'COLOR V'};
  function refresh({tx, hasVideo, localTest, connected, receiving=connected}) {
    const visible = !tx && hasVideo && !localTest;
    $('rxProgress').hidden = !visible;
    $('rxEdgeTrack').hidden = !visible;
    $('monitorViewport').classList.toggle('has-receiving-feedback', visible);
    if (!visible) return;
    const snapshot = receiving ? root.CBReceiverProgress?.snapshot() : null;
    const s = snapshot || {state: receiving ? 'searching' : 'idle', row: 0, totalRows: 0, progress: 0};
    const row = Math.max(0, Math.trunc(Number(s.row) || 0));
    const total = Math.max(0, Math.trunc(Number(s.totalRows) || 0));
    const hasPosition = row > 0 && total > 0;
    const progress = hasPosition ? Math.max(0, Math.min(1, Number(s.progress) || 0)) : 0;
    const position = row + ' / ' + total;
    const phase = phases[s.plane];
    write('rxProgressLabel', 'INCOMING FRAME' + (hasPosition && phase ? ' · ' + phase : ''));
    let caption;
    if (s.state === 'paused' && hasPosition) caption = 'Paused · last row ' + position;
    else if (s.state === 'complete' && hasPosition) caption = 'End of scan · row ' + position;
    else if (s.state === 'receiving' && hasPosition) caption = 'Receiving row ' + position;
    else caption = receiving ? 'Waiting for video sync' : connected ? 'RX stopped' : 'Not connected';
    write('rxReceivingRow', caption);
    const percent = (progress * 100).toFixed(2) + '%';
    $('rxProgressBar').style.setProperty('--rx-progress', percent);
    $('rxEdgeTrack').style.setProperty('--rx-progress', percent);
    $('rxEdgeCursor').hidden = !hasPosition;
    $('rxProgress').dataset.state = s.state;
    $('rxEdgeTrack').dataset.state = s.state;
    $('rxProgressBar').setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    $('rxProgressBar').setAttribute('aria-valuetext', 'Incoming frame: ' + caption);
  }
  root.CBCleanView = Object.freeze({refresh});
})(globalThis);
