import { createShootingScene } from './shooting-scene.mjs';
import { recovery } from './shooting-storage.mjs';

const C = window.ShootingStudy, V = window.GazeValidation, bridge = window.trackerBridge;
const el = id => document.getElementById(id);
const set = (id, value) => { el(id).textContent = value; };
const fmt = v => Number.isFinite(v) ? v.toFixed(2) : '—';
if (new URLSearchParams(location.search).get('study') === 'shooting') document.body.classList.add('shooting-home');
let phase = 'idle', prepared = null, quality = null, qualityTracker = null, qualityFrames = [], qualityPoints = [];
let scene = null, run = null, bundle = null, output = null, saved = true, saving = false, usedGeneration = null;
let animation = 0, lastPaint = 0, qualityIndex = 0, gameAt = 0, random = null, sound = null;
let qualityDraining = false, lastCheckpoint = 0, checkpointPending = false, recovered = null;
let checkpointTask = Promise.resolve();
const backgroundInert = new Map();
let shootingClickPending = false;
function isolateShootingInput(active) {
  if (active) {
    for (const node of document.body.children) {
      if (node === el('shootingStage') || backgroundInert.has(node)) continue;
      backgroundInert.set(node, node.inert); node.inert = true;
    }
  } else {
    for (const [node, inert] of backgroundInert) node.inert = inert;
    backgroundInert.clear();
  }
  document.body.classList.toggle('shooting-playing', active);
}
const sameView = () => prepared && prepared.viewport_width === innerWidth && prepared.viewport_height === innerHeight && prepared.device_pixel_ratio === devicePixelRatio;
const signature = snapshot => JSON.stringify([snapshot.calibration_generation, snapshot.regression, snapshot.five_point_correction_applied]);
const modalBusy = () => ['preparing', 'calibrating', 'checking', 'starting', 'running', 'finishing'].includes(phase) || saving;

function readiness() {
  const s = bridge.status(), busy = modalBusy();
  if (!busy && quality?.complete && quality.tracker_signature !== s.regression_signature) {
    quality = null; el('shootingPrecisionAccepted').checked = false; el('shootingPrecisionAccepted').disabled = true;
    set('shootingStatus', '校正・5点補正が変更されました。正確度を再確認してください。');
  }
  el('shootingSetupBtn').disabled = busy || s.locked;
  el('shootingCheckBtn').disabled = busy || !prepared || !sameView() || !s.running || s.paused || !s.ready || s.busy || s.locked || s.recording || s.generation !== prepared.generation || s.generation === usedGeneration || document.fullscreenElement !== document.documentElement;
  el('shootingRunBtn').disabled = el('shootingCheckBtn').disabled || !quality?.complete || !el('shootingPrecisionAccepted').checked;
  el('shootingResultsBtn').disabled = busy || !bundle || s.locked;
  if (phase === 'calibrating' && prepared && s.ready && !s.busy && s.generation === prepared.generation) {
    phase = 'prepared'; void startQuality();
  }
}
async function hashes() {
  const names = ['app.js', 'validation-core.js', 'shooting-core.js', 'shooting.mjs', 'shooting-scene.mjs', 'index.html', 'shooting.css',
    'sites/pistol-range/dist/vendor/three.module.js', 'sites/pistol-range/dist/vendor/three.core.js',
    'shooting-storage.mjs', 'mediapipe/face_mesh/face_mesh.js', 'mediapipe/face_mesh/face_mesh_solution_simd_wasm_bin.data'];
  const entries = await Promise.all(names.map(async name => {
    const response = await fetch(name, { cache: 'no-store' });
    if (!response.ok) throw Error(`コード版を取得できません：${name}`);
    const bytes = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
    return [name, [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('')];
  }));
  return Object.fromEntries(entries);
}
el('shootingSetupBtn').onclick = () => { set('shootingSetupError', ''); el('sConfirmed').checked = false; el('shootingSetup').showModal(); };
el('shootingSetupClose').onclick = () => { if (phase !== 'preparing') el('shootingSetup').close(); };
el('sHead').onchange = () => { el('sConfirmed').checked = false; };
el('shootingSetup').addEventListener('cancel', e => { if (phase === 'preparing') e.preventDefault(); });
el('shootingForm').onsubmit = async event => {
  event.preventDefault();
  if (modalBusy() || !el('shootingForm').reportValidity()) return;
  if (recovered) { set('shootingSetupError', '未保存記録を復元して保存してから、新しい測定を始めてください。'); return; }
  if (bundle && !saved) { set('shootingSetupError', '前回の記録をサーバー保存するか全記録JSONを保存してください。'); return; }
  const s = bridge.status();
  if (s.locked || s.busy || s.recording || s.paused) { set('shootingSetupError', 'ほかの計測・校正を終了し、カメラを再開してください。'); return; }
  phase = 'preparing'; el('shootingPrepareBtn').disabled = true; readiness();
  try {
    if (document.fullscreenElement !== document.documentElement) await document.documentElement.requestFullscreen();
    await bridge.startCamera();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const config = { participant_id: el('sParticipant').value.trim(), session_number: Number(el('sSession').value), head_condition: el('sHead').value,
      vision: el('sVision').value, width_cm: Number(el('sWidth').value), height_cm: Number(el('sHeight').value), distance_cm: Number(el('sDistance').value),
      mouse_dpi: Number(el('sDpi').value), sensitivity_rad_per_mouse_px: Number(el('sSensitivity').value), seed: Number(el('sSeed').value), notes: el('sNotes').value,
      viewport_width: innerWidth, viewport_height: innerHeight, device_pixel_ratio: devicePixelRatio,
      source_sha256: await hashes(), user_agent: navigator.userAgent, duration_ms: C.DURATION, target_radius_world: .42, fov_vertical_deg: 65,
      placement_policy: 'seeded camera-relative visible candidates, constrained to the room; realized world positions depend on camera pose',
      coordinate_space: 'CSS pixels in the fullscreen viewport; game world coordinates are separate',
      clocks: 'all software event and render timestamps use performance.now; camera video time is retained separately; no exposure/photon synchronization',
      target_onset_definition: 'first renderer.render return time (CPU submission end); not measured photon onset',
      gaze_association: 'last submitted render at gaze processing start; exclude >200ms stale render and gaze processing crossing target end',
      render_stall_abort_ms: 250, head_position_confirmed: true };
    if (document.fullscreenElement !== document.documentElement || document.hidden) throw Error('全画面にして準備し直してください。');
    bridge.prepare(); config.generation = bridge.status().generation;
    prepared = config; quality = null; qualityTracker = null;
    el('shootingPrecisionAccepted').checked = false; el('shootingPrecisionAccepted').disabled = true;
    el('shootingSetup').close(); phase = 'calibrating';
    set('shootingStatus', '9点を各5回クリックしてください。中央の5秒測定後に正確度確認へ進みます。');
  } catch (error) { phase = 'idle'; set('shootingSetupError', error.message); }
  finally { el('shootingPrepareBtn').disabled = false; readiness(); }
};

function showQualityPoint(now) {
  const point = qualityPoints[qualityIndex]; point.onset_ms = now;
  el('shootingQualityDot').style.left = `${point.x}px`;
  el('shootingQualityDot').style.top = `${point.y}px`;
  set('shootingQualityProgress', `${qualityIndex + 1} / 5`);
}
async function startQuality() {
  if (!prepared || phase !== 'prepared') return;
  try {
    if (!sameView() || document.fullscreenElement !== document.documentElement) throw Error('同じ全画面で準備してください。');
    qualityTracker = bridge.acquire();
    phase = 'checking'; quality = null; qualityFrames = []; qualityIndex = 0;
    el('shootingPrecisionAccepted').checked = false; el('shootingPrecisionAccepted').disabled = true;
    qualityPoints = [[.12, .12], [.88, .12], [.5, .5], [.12, .88], [.88, .88]].map(([x, y], i) => ({ point_id: i + 1, x: x * innerWidth, y: y * innerHeight }));
    document.body.classList.add('shooting-measuring'); el('shootingQuality').hidden = false;
    lastPaint = performance.now(); showQualityPoint(lastPaint);
    animation = requestAnimationFrame(checkTick); readiness();
  } catch (error) { phase = 'prepared'; set('shootingStatus', error.message); readiness(); }
}
function checkTick() {
  if (phase !== 'checking') return;
  const now = performance.now();
  if (!sameView() || document.hidden || document.fullscreenElement !== document.documentElement || now - lastPaint > 250) { void finishQuality('display_or_render_interruption'); return; }
  lastPaint = now;
  const point = qualityPoints[qualityIndex];
  if (now >= point.onset_ms + 1800) {
    point.end_ms = now; qualityIndex++;
    if (qualityIndex === 5) { void finishQuality(); return; }
    showQualityPoint(now);
  }
  animation = requestAnimationFrame(checkTick);
}
async function finishQuality(reason = '') {
  if (phase !== 'checking') return;
  phase = 'finishing'; cancelAnimationFrame(animation); el('shootingQuality').hidden = true;
  qualityDraining = true;
  try {
    await bridge.drain();
    const samples = qualityFrames.map(f => {
      const p = qualityPoints.find(p => p.onset_ms !== undefined && f.processing_start_ms >= p.onset_ms && f.processing_start_ms < (p.end_ms ?? Infinity));
      const valid = Boolean(!reason && p && p.end_ms && f.valid && [f.x, f.y, f.raw_x, f.raw_y].every(Number.isFinite) &&
        f.processing_start_ms >= p.onset_ms + 600 && f.processing_end_ms < p.onset_ms + 1800);
      return { ...f, point_id: p?.point_id ?? null, analysis_valid: valid,
        error_px: valid ? Math.hypot(f.x - p.x, f.y - p.y) : null,
        error_deg: valid ? V.angularError(p, f, prepared) : null };
    });
    const points = qualityPoints.map(p => {
      const frames = samples.filter(f => f.point_id === p.point_id && f.analysis_valid);
      return { ...p, valid_samples: frames.length, mean_error_deg: C.mean(frames.map(f => f.error_deg)), mean_error_px: C.mean(frames.map(f => f.error_px)) };
    });
    quality = { complete: !reason && points.every(p => p.valid_samples >= 3), reason,
      definition: '5-point brief check, 1800ms each; analyze 600..1800ms; >=3 valid samples per point; no accuracy pass threshold is implied',
      mean_error_deg: C.mean(points.map(p => p.mean_error_deg).filter(Number.isFinite)),
      p95_error_px: C.percentile(samples.filter(f => f.analysis_valid).map(f => f.error_px)), points, samples,
      tracker_signature: signature(qualityTracker) };
    el('shootingPrecisionAccepted').disabled = !quality.complete;
    set('shootingStatus', quality.complete ? `正確度確認：位置平均の平均 ${fmt(quality.mean_error_deg)}°、誤差95%点 ${fmt(quality.p95_error_px)} CSS px。研究条件として適切か確認してください。` : '正確度確認が中断、またはサンプル不足でした。正確度を再確認してください。');
  } finally {
    qualityDraining = false; bridge.release(); document.body.classList.remove('shooting-measuring'); phase = 'prepared'; readiness();
  }
}
el('shootingCheckBtn').onclick = () => { void startQuality(); };
el('shootingPrecisionAccepted').onchange = readiness;

function playSound() {
  try {
    if (!sound) sound = new AudioContext();
    void sound.resume();
    const buffer = sound.createBuffer(1, Math.floor(sound.sampleRate * .05), sound.sampleRate), data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sound.sampleRate * .009));
    const source = sound.createBufferSource(), gain = sound.createGain(); source.buffer = buffer; gain.gain.value = .12;
    source.connect(gain).connect(sound.destination); source.onended = () => { source.disconnect(); gain.disconnect(); }; source.start();
  } catch { /* Audio is optional and uses a different random source than target placement. */ }
}
el('shootingRunBtn').onclick = async () => {
  if (el('shootingRunBtn').disabled || phase !== 'prepared') return;
  phase = 'starting'; readiness(); let acquired = false;
  try {
    if (!sameView() || document.fullscreenElement !== document.documentElement || !quality?.complete) throw Error('同じ全画面で校正と正確度確認を行ってください。');
    el('shootingStage').hidden = false; document.body.classList.add('shooting-measuring');
    isolateShootingInput(true);
    if (!scene) scene = createShootingScene(el('shootingCanvas'), innerWidth, innerHeight);
    else scene.resize(innerWidth, innerHeight);
    scene.reset(); scene.draw(performance.now());
    await el('shootingCanvas').requestPointerLock();
    if (document.pointerLockElement !== el('shootingCanvas')) throw Error('マウス操作の許可が必要です。');
    if (!sameView()) throw Error('表示サイズが変わりました。再校正してください。');
    const tracker = bridge.acquire(); acquired = true;
    if (signature(tracker) !== quality.tracker_signature) throw Error('校正・5点補正が変更されました。正確度を再確認してください。');
    const now = performance.now();
    run = new C.Session({ ...prepared, tracker, quality, run_id: crypto.randomUUID(), start_ms: now,
      started_at: new Date().toISOString(), performance_time_origin: performance.timeOrigin,
      five_point_correction_applied: tracker.five_point_correction_applied });
    random = C.random(prepared.seed); usedGeneration = prepared.generation;
    bundle = null; output = null; saved = false; phase = 'running'; gameAt = now + 3000; lastPaint = now;
    set('shootingHits', '0'); set('shootingTime', '60'); set('shootingAccuracy', '—');
    set('shootingCountdown', '3'); el('shootingStage').focus();
    set('shootingStatus', '射撃・視線を計測中です。');
    window.dispatchEvent(new Event('tracker-state')); animation = requestAnimationFrame(gameTick);
  } catch (error) {
    if (acquired) bridge.release(); phase = 'prepared'; el('shootingStage').hidden = true;
    isolateShootingInput(false);
    document.body.classList.remove('shooting-measuring'); if (document.pointerLockElement) document.exitPointerLock();
    set('shootingStatus', error.message); readiness();
  }
};
function spawn(now, first = false) { const point = scene.newTarget(random, first); run.spawn(now, point, .42); }
function gameTick() {
  if (phase !== 'running') return;
  const now = performance.now(), dt = (now - lastPaint) / 1000;
  if (!sameView() || document.hidden || document.fullscreenElement !== document.documentElement) { void finish('display_changed'); return; }
  if (now - lastPaint > 250) { run.event('render_gap', now, { gap_ms: now - lastPaint }); void finish('render_stall_over_250ms'); return; }
  lastPaint = now;
  if (run.metadata.game_start_ms === undefined && now >= gameAt) { run.startGame(now); spawn(now, true); set('shootingCountdown', ''); }
  if (run.metadata.deadline_ms !== undefined && now >= run.metadata.deadline_ms) { void finish(); return; }
  if (run.metadata.game_start_ms === undefined) set('shootingCountdown', String(Math.max(1, Math.ceil((gameAt - now) / 1000))));
  else set('shootingTime', String(Math.ceil((run.metadata.deadline_ms - now) / 1000)));
  const begin = performance.now(), pose = scene.draw(now, dt), end = performance.now();
  run.render(begin, end, pose, run.metadata.game_start_ms !== undefined);
  if (now - lastCheckpoint > 5000 && !checkpointPending) {
    lastCheckpoint = now; checkpointPending = true;
    checkpointTask = recovery('put', { kind: 'raw', checkpoint_ms: end,
      data: structuredClone({ metadata: run.metadata, frames: run.frames, gaze: run.gaze, targets: run.targets, shots: run.shots, events: run.events }) })
      .catch(() => { run.event('recovery_checkpoint_unavailable', now); }).finally(() => { checkpointPending = false; });
  }
  animation = requestAnimationFrame(gameTick);
}
document.addEventListener('mousemove', event => {
  if (phase === 'running' && run.metadata.game_start_ms !== undefined && document.pointerLockElement === el('shootingCanvas')) scene.look(event.movementX, event.movementY, prepared.sensitivity_rad_per_mouse_px);
});
function shoot(event) {
  if (phase !== 'running' || event.button !== 0 || event.pointerType !== 'mouse' || document.pointerLockElement !== el('shootingCanvas')) return;
  const now = performance.now(), shot = run.shoot(now, scene.pose(), scene.hit(), event.timeStamp);
  if (shot.accepted) {
    scene.shot(now); playSound();
    if (shot.outcome === 'hit') spawn(now);
    const accepted = run.shots.filter(s => s.accepted), hits = accepted.filter(s => s.outcome === 'hit').length;
    set('shootingHits', String(hits)); set('shootingAccuracy', `${Math.round(hits / accepted.length * 100)}%`);
  }
  if (run.metadata.deadline_ms !== undefined && now >= run.metadata.deadline_ms) void finish();
}
// Pointer lock can retarget mouse events. Consume the entire sequence before
// it reaches any controls, including a release/click delivered after ending.
for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']) {
  window.addEventListener(type, event => {
    const active = ['starting', 'running', 'finishing'].includes(phase);
    if (!active && (type === 'pointerdown' || type === 'mousedown')) shootingClickPending = false;
    if (!active && !shootingClickPending) return;
    if (type === 'pointerdown' || type === 'mousedown') shootingClickPending = true;
    event.preventDefault(); event.stopImmediatePropagation();
    if (type === 'pointerdown') shoot(event);
    if (type === 'click' || type === 'auxclick' || type === 'contextmenu') shootingClickPending = false;
  }, { capture: true, passive: false });
}
window.addEventListener('gaze-frame', event => {
  if (phase === 'checking' || qualityDraining) qualityFrames.push({ ...event.detail });
  if (run && !qualityDraining && ['running', 'finishing'].includes(phase)) run.gazeFrame(event.detail);
});
async function finish(reason = '') {
  if (phase !== 'running') return;
  phase = 'finishing'; cancelAnimationFrame(animation); run.finish(performance.now(), reason);
  if (document.pointerLockElement) document.exitPointerLock();
  el('shootingStage').hidden = true; document.body.classList.remove('shooting-measuring');
  isolateShootingInput(false);
  set('shootingStatus', '終了・保存中です。');
  try {
    if (!await bridge.drain()) run.event('gaze_drain_timeout', performance.now());
    bundle = run.export(); output = C.files(bundle);
    await checkpointTask;
    await recovery('put', { kind: 'final', bundle }).catch(() => {});
    renderResult();
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    el('shootingResults').showModal(); await save();
    set('shootingStatus', '計測終了。次のセッションは条件入力から再校正してください。');
    el('sSession').value = String(Math.min(999, prepared.session_number + 1));
  } catch (error) { set('shootingStatus', `終了処理エラー：${error.message}。ページを閉じないでください。`); }
  finally { bridge.release(); phase = 'finished'; readiness(); window.dispatchEvent(new Event('tracker-state')); }
}
function renderResult() {
  const s = bundle.summary;
  set('shootingSummary', `${s.status === 'completed' ? '完了' : `中断：${bundle.metadata.stop_reason}`}。命中 ${s.hits} / 射撃 ${s.shots}、命中率 ${s.accuracy === null ? '—' : fmt(s.accuracy * 100) + '%'}。命中まで平均 ${fmt(s.mean_hit_response_ms)} ms。視線取得 ${s.valid_gaze_frames}/${s.processed_gaze_frames}、最大処理間隔 ${fmt(s.max_gaze_gap_ms)} ms。`);
  el('shootingAnalysisLink').href = `shooting-analysis.html?run=${encodeURIComponent(bundle.metadata.run_id)}`;
}
async function save() {
  if (!bundle || !output || saving) return;
  saving = true; el('shootingSaveBtn').disabled = true; readiness();
  set('shootingSaveStatus', 'recordings/shooting に保存しています…');
  try {
    const response = await fetch('/save-shooting', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run_id: bundle.metadata.run_id, files: output }) });
    if (response.status === 404) throw Error('保存APIがありません。ローカルサーバーを再起動してください。');
    const result = await response.json(); if (!response.ok || !result.ok) throw Error(result.error || '保存失敗');
    saved = true; await recovery('delete').catch(() => {}); recovered = null;
    el('shootingRecoveryBtn').hidden = true; set('shootingSaveStatus', `保存済み：${result.path}`);
  } catch (error) { set('shootingSaveStatus', `自動保存できません：${error.message}。保存を再試行するか全記録JSONを保存してください。`); }
  finally { saving = false; el('shootingSaveBtn').disabled = false; readiness(); }
}
function download(name) {
  if (!output) return;
  const url = URL.createObjectURL(new Blob([name.endsWith('.csv') ? '\uFEFF' : '', output[name]], { type: name.endsWith('.csv') ? 'text/csv;charset=utf-8' : 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `${bundle.metadata.participant_id}-S${bundle.metadata.session_number}-${bundle.metadata.run_id}-${name}`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  if (name === 'session.json') { saved = true; recovered = null; el('shootingRecoveryBtn').hidden = true; void recovery('delete').catch(() => {}); set('shootingSaveStatus', '全記録JSONのダウンロードを開始しました。保存先を確認してください。'); }
}
el('shootingSaveBtn').onclick = () => { void save(); };
el('shootingJsonBtn').onclick = () => download('session.json');
el('shootingCsvBtn').onclick = () => Object.keys(output || {}).filter(n => n.endsWith('.csv')).forEach((name, i) => setTimeout(() => download(name), i * 180));
el('shootingResultsBtn').onclick = () => el('shootingResults').showModal();
el('shootingResultsClose').onclick = () => el('shootingResults').close();
function interrupt(reason) {
  if (phase === 'running') void finish(reason);
  else if (phase === 'checking') void finishQuality(reason);
  else if (phase === 'calibrating') { bridge.cancelPreparation(); phase = 'idle'; set('shootingStatus', '校正を中断しました。条件入力からやり直してください。'); readiness(); }
}
document.addEventListener('pointerlockchange', () => { if (phase === 'running' && document.pointerLockElement !== el('shootingCanvas')) interrupt('pointer_lock_lost'); });
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) interrupt('fullscreen_lost'); readiness(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) interrupt('document_hidden'); });
window.addEventListener('blur', () => { if (['running', 'checking'].includes(phase)) interrupt('window_blur'); });
window.addEventListener('resize', () => { if (['running', 'checking'].includes(phase) && !sameView()) interrupt('viewport_changed'); readiness(); });
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && ['running', 'checking', 'calibrating'].includes(phase)) {
    event.preventDefault(); event.stopImmediatePropagation(); interrupt('user_escape');
  }
}, true);
el('shootingCanvas').addEventListener('webglcontextlost', event => { event.preventDefault(); interrupt('webgl_context_lost'); });
window.addEventListener('beforeunload', event => { if (modalBusy() || (bundle && !saved)) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('tracker-state', readiness);
void recovery('get').then(value => { if (value) { recovered = value; el('shootingRecoveryBtn').hidden = false; set('shootingStatus', '未保存の記録が見つかりました。「未保存記録を復元」から保存してください。'); } }).catch(() => {});
el('shootingRecoveryBtn').onclick = async () => {
  if (!recovered || modalBusy()) return;
  try {
    if (recovered.kind === 'final') bundle = C.checkBundle(recovered.bundle);
    else {
      const record = new C.Session(recovered.data.metadata);
      Object.assign(record, recovered.data);
      record.finish(recovered.checkpoint_ms, 'browser_recovery_checkpoint'); bundle = record.export();
    }
    output = C.files(bundle); saved = false; phase = 'finished'; renderResult();
    el('shootingResults').showModal(); await save(); readiness();
  } catch (error) { set('shootingStatus', `記録を復元できません：${error.message}`); }
};
setInterval(readiness, 250); readiness();
