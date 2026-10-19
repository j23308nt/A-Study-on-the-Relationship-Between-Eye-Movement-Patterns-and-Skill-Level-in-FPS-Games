import { createShootingScene } from './shooting-scene.mjs';
const C = window.ShootingStudy, el = id => document.getElementById(id);
let bundle = null, scene = null, playing = false, timer = null, lastTick = 0;
const fmt = v => Number.isFinite(v) ? v.toFixed(1) : '—';
const label = s => ({ hit: '命中', unfinished: '未完了', aborted: '中断', pending: '未提示' }[s] || s);
function node(name, attributes) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) n.setAttribute(key, String(value));
  el('replayOverlay').appendChild(n); return n;
}
function stop() { playing = false; cancelAnimationFrame(timer); el('play').textContent = '再生'; }
function render() {
  if (!bundle) return;
  const m = bundle.metadata, time = Number(el('timeline').value), f = C.before(bundle.frames, time);
  el('replayOverlay').replaceChildren();
  el('playTime').textContent = `${((time - m.start_ms) / 1000).toFixed(2)} / ${((m.end_ms - m.start_ms) / 1000).toFixed(2)} 秒`;
  if (!f) { el('frameInfo').textContent = '最初の描画前です。'; return; }
  scene.replay(f);
  node('path', { d: `M${m.viewport_width / 2 - 8} ${m.viewport_height / 2}h16 M${m.viewport_width / 2} ${m.viewport_height / 2 - 8}v16`, stroke: 'white', 'stroke-width': 2 });
  if (f.target_visible && el('showAoi').checked) node('circle', { cx: f.screen_x, cy: f.screen_y, r: f.screen_radius_px + (m.quality?.p95_error_px ?? 0), fill: 'none', stroke: '#67edf2', 'stroke-width': 2, 'stroke-dasharray': '7 6' });
  const raw = el('rawGaze').checked, frames = bundle.gaze.filter(g => g.processing_start_ms >= time - 1000 && g.processing_start_ms <= time);
  let previous = null, latest = null;
  for (const g of frames) {
    const x = raw ? g.raw_x : g.x, y = raw ? g.raw_y : g.y;
    if (!g.valid || ![x, y].every(Number.isFinite)) { previous = null; latest = null; continue; }
    if (previous && g.processing_start_ms - previous.time <= 200) node('line', { x1: previous.x, y1: previous.y, x2: x, y2: y, stroke: '#ffe26a', 'stroke-width': 3, opacity: .25 + .75 * (g.processing_start_ms - (time - 1000)) / 1000 });
    previous = { x, y, time: g.processing_start_ms }; latest = previous;
  }
  if (latest && time - latest.time <= 200) node('circle', { cx: latest.x, cy: latest.y, r: 7, fill: '#ffe26a', stroke: '#473d00' });
  for (const shot of bundle.shots.filter(s => s.time_ms >= time - 100 && s.time_ms <= time && s.accepted)) node('circle', { cx: m.viewport_width / 2, cy: m.viewport_height / 2, r: 15, fill: 'none', stroke: shot.outcome === 'hit' ? '#91ffbe' : '#ff8989', 'stroke-width': 3 });
  el('frameInfo').textContent = `描画 ${f.frame_id} / 球 ${f.target_id ?? '—'} / ${f.phase === 'countdown' ? 'カウントダウン' : '課題中'}。視線は処理開始時刻で表示しています。`;
}
function load(value, name) {
  stop(); bundle = C.checkBundle(value); const m = bundle.metadata, s = bundle.summary;
  if (!s || !Number.isFinite(m.end_ms)) throw Error('終了した記録を読み込んでください。');
  el('identity').textContent = `${m.participant_id} / セッション${m.session_number} / 頭部${m.head_condition === 'fixed' ? '固定' : '非固定'} / ${m.started_at}`;
  el('summary').textContent = `${s.status === 'completed' ? '完了' : `中断（${m.stop_reason}）`}：命中 ${s.hits} / 射撃 ${s.shots}、命中率 ${s.accuracy === null ? '—' : fmt(s.accuracy * 100) + '%'}、命中まで平均 ${fmt(s.mean_hit_response_ms)} ms。視線取得 ${s.valid_gaze_frames}/${s.processed_gaze_frames}（カウントダウンを含む）。`;
  el('qualityInfo').textContent = `5位置の短時間正確度確認：位置平均の平均 ${fmt(m.quality?.mean_error_deg)}°、誤差95%点 ${fmt(m.quality?.p95_error_px)} CSS px。5点補正${m.five_point_correction_applied ? 'あり' : 'なし'}。${m.head_condition === 'free' ? '視角は開始位置・距離に基づく参考値です。' : ''}`;
  el('recordView').hidden = false;
  el('replayStage').style.aspectRatio = `${m.viewport_width} / ${m.viewport_height}`;
  scene?.dispose(); scene = createShootingScene(el('replayCanvas'), m.viewport_width, m.viewport_height);
  el('replayOverlay').setAttribute('viewBox', `0 0 ${m.viewport_width} ${m.viewport_height}`);
  Object.assign(el('timeline'), { min: m.start_ms, max: m.end_ms, value: bundle.frames[0]?.render_end_ms ?? m.start_ms });
  el('targetRows').replaceChildren();
  for (const t of bundle.targets) {
    const tr = document.createElement('tr');
    for (const v of [t.target_id, label(t.status), fmt(t.first_shot_response_ms), fmt(t.hit_response_ms), fmt(t.gaze_arrival_estimate_ms), t.miss_shots, t.valid_gaze_samples, fmt(t.gaze_distance_at_hit_px)]) { const td = document.createElement('td'); td.textContent = String(v); tr.appendChild(td); }
    el('targetRows').appendChild(tr);
  }
  el('loadStatus').textContent = `${name}を読み込みました。`; render();
}
el('recordFile').onchange = async event => {
  try { const file = event.target.files[0]; if (!file) return; if (file.size > 32 * 1024 * 1024) throw Error('JSONは32MiB以内にしてください。'); load(JSON.parse(await file.text()), file.name); }
  catch (error) { el('loadStatus').textContent = error.message; }
};
el('timeline').oninput = () => { stop(); render(); };
el('rawGaze').onchange = render; el('showAoi').onchange = render;
el('play').onclick = () => {
  if (!bundle) return; if (playing) { stop(); return; }
  if (Number(el('timeline').value) >= bundle.metadata.end_ms) el('timeline').value = bundle.metadata.start_ms;
  playing = true; lastTick = performance.now(); el('play').textContent = '停止';
  function tick(now) {
    if (!playing) return;
    el('timeline').value = Math.min(bundle.metadata.end_ms, Number(el('timeline').value) + now - lastTick); lastTick = now; render();
    if (Number(el('timeline').value) >= bundle.metadata.end_ms) stop(); else timer = requestAnimationFrame(tick);
  }
  timer = requestAnimationFrame(tick);
};
const id = new URLSearchParams(location.search).get('run');
if (id && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) {
  void fetch(`recordings/shooting/${id}/session.json`).then(r => { if (!r.ok) throw Error('自動読み込みできません。保存した全記録JSONを選択してください。'); return r.json(); })
    .then(b => load(b, id)).catch(error => { el('loadStatus').textContent = error.message; });
}
