(function () {
  "use strict";
  const el = id => document.getElementById(id), text = (id, value) => { el(id).textContent = value; };
  let model = null, range = null, time = 0, playing = false, animation = null, previousTick = null;
  const svg = el("studyReplayStage");
  function node(tag, attrs, content) {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, String(v))); if (content) n.textContent = content; svg.appendChild(n); return n;
  }
  function stop() { playing = false; cancelAnimationFrame(animation); previousTick = null; text("studyReplayPlay", "再生"); el("studyReplayPlay").setAttribute("aria-pressed", "false"); }
  function draw() {
    if (!model) return;
    const state = model.at(time, { raw: el("studyReplayRaw").checked, rangeStart: range.start });
    svg.replaceChildren(); svg.setAttribute("viewBox", `0 0 ${model.width} ${model.height}`);
    if (state.target) node("circle", { cx: state.target.target_x, cy: state.target.target_y, r: state.target.target_radius_px, fill: "#57dfed", class: "replay-target" });
    const trails = (segments, color, kind, dashed = false) => {
      for (const points of segments) {
        // Native SVG line/path styling avoids the tracker stylesheet's generic polyline rule.
        if (points.length > 1) node("path", { d: points.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" "),
          stroke: color, "stroke-width": 3, "stroke-dasharray": dashed ? "8 5" : "none", fill: "none", opacity: .65, class: kind });
        else node("circle", { cx: points[0].x, cy: points[0].y, r: 2, fill: color, opacity: .65, class: kind });
      }
    };
    if (el("studyReplayGaze").checked) {
      trails(state.gaze_trail, "#ffe06b", "replay-gaze-trail");
      if (state.gaze) node("circle", { cx: state.gaze.x, cy: state.gaze.y, r: 9, stroke: "#ffe06b", "stroke-width": 3, fill: "none", class: "replay-gaze" });
    }
    if (el("studyReplayCursor").checked) {
      trails(state.cursor_trail, "#fb923c", "replay-cursor-trail", true);
      if (state.cursor) {
        const p = state.cursor;
        node("path", { d: `M${p.x - 10},${p.y} h20 M${p.x},${p.y - 10} v20`, stroke: "#fb923c", "stroke-width": 3, fill: "none", class: "replay-cursor" });
      }
    }
    state.clicks.forEach(c => {
      const color = c.outcome === "hit" ? "#65f5a5" : c.outcome === "miss" ? "#ff7d83" : "#c4b5fd";
      node("circle", { cx: c.x, cy: c.y, r: 16, fill: "none", stroke: color, "stroke-width": 4, class: "replay-click" });
    });
    text("studyReplayTime", `課題開始から ${(state.elapsed_ms / 1000).toFixed(3)} 秒 / ${((model.end - model.start) / 1000).toFixed(3)} 秒 · ${state.phase}`);
    el("studyReplaySeek").value = String(time - range.start);
    el("studyReplaySeek").setAttribute("aria-valuetext", `選択範囲の開始から ${(time - range.start).toFixed(0)} ms`);
    const xy = p => p ? `X ${p.x.toFixed(1)}, Y ${p.y.toFixed(1)}（${p.age_ms.toFixed(0)}ms前の記録）` : "位置なし";
    text("studyReplayReadout", `マウス：${model.hasCursor ? xy(state.cursor) : "この記録には移動データがありません"}。視線：${state.gaze ? xy(state.gaze) : state.gaze_status}。`);
  }
  function tick(now) {
    if (!playing || !model) return;
    if (previousTick !== null) time = Math.min(range.end, time + (now - previousTick) * Number(el("studyReplaySpeed").value));
    previousTick = now; draw();
    if (time >= range.end) stop(); else animation = requestAnimationFrame(tick);
  }
  function chooseScope() {
    stop(); range = model.range(el("studyReplayScope").value === "all" ? null : Number(el("studyReplayScope").value)); time = range.start;
    el("studyReplaySeek").max = String(Math.max(0, range.end - range.start));
    el("studyReplaySeek").disabled = range.end <= range.start; el("studyReplayPlay").disabled = range.end <= range.start; draw();
  }
  window.studyReplay = {
    load(bundle) {
      stop(); model = null; svg.replaceChildren(); el("studyReplay").hidden = !bundle;
      if (!bundle) return;
      model = new window.AimReplay.Replay(bundle);
      const select = el("studyReplayScope"); select.replaceChildren(new Option("課題全体（提示前・空白を含む）", "all"));
      model.trials.forEach(t => select.appendChild(new Option(`試行 ${t.trial_id}：${({ hit: "命中", timeout: "時間切れ", aborted: "中断" })[t.status]}`, String(t.trial_id))));
      el("studyReplayCursor").disabled = !model.hasCursor;
      text("studyReplayLegacy", model.hasCursor ? "" : "この古い記録にはマウス移動がありません。クリック位置と視線のみ再生します。マウス軌跡をクリック間から補間して生成することはありません。");
      chooseScope();
    }
  };
  el("studyReplayPlay").addEventListener("click", () => {
    if (!model) return; if (playing) { stop(); return; }
    if (time >= range.end) time = range.start;
    playing = true; previousTick = null; text("studyReplayPlay", "一時停止"); el("studyReplayPlay").setAttribute("aria-pressed", "true"); animation = requestAnimationFrame(tick);
  });
  el("studyReplayScope").addEventListener("change", () => { if (model) chooseScope(); });
  el("studyReplaySeek").addEventListener("input", event => { if (!model) return; stop(); time = Math.max(range.start, Math.min(range.end, range.start + Number(event.target.value))); draw(); });
  el("studyReplayReset").addEventListener("click", () => { if (!model) return; stop(); time = range.start; draw(); });
  for (const [id, delta] of [["studyReplayBack", -100], ["studyReplayNext", 100]]) el(id).addEventListener("click", () => {
    if (!model) return; stop(); time = Math.max(range.start, Math.min(range.end, time + delta)); draw();
  });
  for (const id of ["studyReplayRaw", "studyReplayGaze", "studyReplayCursor"]) el(id).addEventListener("change", draw);
  el("studyReplaySpeed").addEventListener("change", () => { previousTick = null; });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
  window.addEventListener("pagehide", stop);
}());
