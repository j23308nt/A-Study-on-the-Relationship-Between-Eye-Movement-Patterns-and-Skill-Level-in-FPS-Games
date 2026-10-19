(function () {
  "use strict";
  const A = window.AimTaskCore, bridge = window.trackerBridge;
  const el = id => document.getElementById(id), text = (id, s) => { el(id).textContent = s; };
  const fmt = v => Number.isFinite(v) ? v.toFixed(1) : "—";
  const label = s => ({ hit: "命中", timeout: "時間切れ", aborted: "中断" }[s] || s);
  let prepared = null, usedGeneration = null, run = null, bundle = null, files = null;
  let active = false, finishing = false, preparing = false, saving = false, saved = true, sealed = true;
  let animation = null, nextAt = 0, lastPaint = 0;
  function readiness() {
    const s = bridge.status();
    const busy = active || finishing || preparing || saving;
    el("aimSetupBtn").disabled = busy || s.locked;
    el("aimResultsBtn").disabled = busy || s.locked;
    el("aimRunBtn").disabled = busy || !prepared || s.generation !== prepared.generation ||
      s.generation === usedGeneration || !s.ready || !s.running || s.paused || s.recording || s.busy || s.locked ||
      document.fullscreenElement !== document.documentElement;
    if (busy) return;
    if (!el("aimRunBtn").disabled) text("aimStatus", `${prepared.participant_id}：準備完了。${prepared.trial_count}個の的をクリックします（5点補正${s.correctionApplied ? "あり" : "なし"}）。`);
    else if (prepared && prepared.generation === usedGeneration) text("aimStatus", "課題は終了しました。次の課題は設定から再校正してください。");
    else if (prepared) text("aimStatus", "課題と同じ全画面で9点校正・中央の5秒測定を完了してください。表示や校正を変更した場合は課題設定からやり直してください。");
  }
  async function hashes() {
    const result = {};
    for (const name of ["app.js", "aim-core.js", "aim.js", "validation-core.js", "validation.js", "index.html", "styles.css"]) {
      const response = await fetch(name, { cache: "no-store" });
      if (!response.ok) throw new Error(`コード版を取得できません: ${name}`);
      const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
      result[name] = [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, "0")).join("");
    }
    return result;
  }
  el("aimSetupBtn").addEventListener("click", () => {
    text("aimSetupError", ""); el("aConfirmed").checked = false; el("aimSetup").showModal();
  });
  el("aHead").addEventListener("change", () => { el("aConfirmed").checked = false; });
  el("aimSetupClose").addEventListener("click", () => { if (!preparing) el("aimSetup").close(); });
  el("aimSetup").addEventListener("cancel", event => { if (preparing) event.preventDefault(); });
  el("aimForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (preparing || !el("aimForm").reportValidity()) return;
    preparing = true; el("aimPrepareBtn").disabled = true; text("aimSetupError", "");
    try {
      const s = bridge.status();
      if (!s.running || s.paused || s.recording || s.busy || s.locked) throw new Error("先にカメラを開始・再開し、通常計測・校正・検証を終了してください。");
      if (bundle && !saved) throw new Error("前回の課題の全記録JSONを保存してから準備してください。");
      const config = {
        participant_id: el("aParticipant").value.trim(), session_number: Number(el("aSession").value),
        vision: el("aVision").value, head_condition: el("aHead").value,
        width_cm: Number(el("aWidth").value), height_cm: Number(el("aHeight").value), distance_cm: Number(el("aDistance").value),
        environment_notes: el("aNotes").value, head_position_confirmed: el("aConfirmed").checked,
        trial_count: Number(el("aCount").value), target_diameter_px: Number(el("aDiameter").value), timeout_ms: Number(el("aTimeout").value),
        seed: el("aSeed").value === "" ? crypto.getRandomValues(new Uint32Array(1))[0] : Number(el("aSeed").value)
      };
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      Object.assign(config, { viewport_width: innerWidth, viewport_height: innerHeight, device_pixel_ratio: devicePixelRatio,
        browser_screen_css: { width: screen.width, height: screen.height }, user_agent: navigator.userAgent,
        source_sha256: await hashes(), task: "single_static_target_mouse", inter_target_gap_ms: [500, 1000],
        response_clock: "performance.now at CSS target update in requestAnimationFrame to primary mouse pointerdown handler; not photon onset or device event time",
        gaze_clock: "processing_start_ms / processing_end_ms on the same performance.now clock; camera exposure and gaze latency are not measured",
        cursor_recording: { version: 1, source: "mouse pointermove and primary pointerdown",
          minimum_move_interval_ms: A.CURSOR_INTERVAL_MS, coordinate_unit: "CSS px (clientX/clientY)",
          clock: "performance.now at event handler; event.timeStamp retained separately", stationary_samples: false,
          primary_button_down_always_recorded: true },
        render_gap_abort_ms: 250 });
      A.checkConfig(config);
      if (document.fullscreenElement !== document.documentElement || document.hidden) throw new Error("ページ全体を全画面表示したまま準備してください。");
      bridge.prepare(); config.generation = bridge.status().generation; prepared = config;
      el("aimSetup").close();
    } catch (error) { text("aimSetupError", error.message || "準備できませんでした。"); }
    finally { preparing = false; el("aimPrepareBtn").disabled = false; readiness(); }
  });
  function sameViewport() {
    return prepared && prepared.viewport_width === innerWidth && prepared.viewport_height === innerHeight && prepared.device_pixel_ratio === devicePixelRatio;
  }
  function hideTarget(now) {
    const t = run.trials[run.trials.length - 1];
    el("aimTarget").hidden = true;
    nextAt = now + t.gap_after_ms;
  }
  function tick() {
    if (!active) return;
    const now = performance.now();
    if (!sameViewport() || !document.fullscreenElement || document.hidden) { void finish("display_changed"); return; }
    if (now - lastPaint > 250) {
      run.events.push({ type: "render_gap", time_ms: now, gap_ms: now - lastPaint });
      void finish("render_stall_over_250ms"); return;
    }
    lastPaint = now;
    if (run.expire(now)) hideTarget(now);
    if (!run.current() && run.trials.length === prepared.trial_count) { void finish(); return; }
    if (!run.current() && now >= nextAt) {
      const t = run.present(now), target = el("aimTarget");
      target.style.left = `${t.target_x}px`; target.style.top = `${t.target_y}px`;
      target.hidden = false; el("aimCountdown").hidden = true;
      text("aimProgress", `${t.trial_id} / ${prepared.trial_count}　Escで中断`);
    } else if (!run.trials.length) text("aimCountdown", String(Math.max(1, Math.ceil((nextAt - now) / 1000))));
    animation = requestAnimationFrame(tick);
  }
  el("aimRunBtn").addEventListener("click", () => {
    if (active || finishing || saving || !prepared) return;
    let acquired = false;
    try {
      if (!sameViewport() || document.fullscreenElement !== document.documentElement ||
          prepared.generation === usedGeneration || prepared.generation !== bridge.status().generation) throw new Error("課題設定から全画面で校正をやり直してください。");
      const tracker = bridge.acquire(); acquired = true;
      run = new A.Session({ ...prepared, tracker, run_id: crypto.randomUUID(), started_at: new Date().toISOString(),
        performance_time_origin: performance.timeOrigin, start_ms: performance.now() });
      usedGeneration = prepared.generation; bundle = null; files = null; saved = false; sealed = false; active = true;
      document.body.classList.add("aim-active"); el("aimOverlay").hidden = false; el("aimOverlay").focus();
      el("aimCountdown").hidden = false; el("aimTarget").hidden = true;
      el("aimTarget").style.width = `${prepared.target_diameter_px}px`;
      el("aimTarget").style.height = `${prepared.target_diameter_px}px`;
      text("aimCountdown", "3"); text("aimProgress", "準備してください　Escで中断");
      lastPaint = performance.now(); nextAt = lastPaint + 3000;
      window.dispatchEvent(new Event("tracker-state"));
      text("aimStatus", "的クリック課題を記録中です。");
      animation = requestAnimationFrame(tick);
    } catch (error) {
      if (acquired) bridge.release();
      text("aimStatus", error.message || "課題を開始できませんでした。");
    }
  });
  el("aimOverlay").addEventListener("pointerdown", event => {
    if (!active || event.button !== 0 || event.pointerType !== "mouse") return;
    event.preventDefault();
    const now = performance.now();
    run.recordCursor({ time_ms: now, event_timestamp_ms: event.timeStamp, x: event.clientX, y: event.clientY,
      buttons: event.buttons, sample_kind: "button_down" });
    run.click(now, event.clientX, event.clientY, event.timeStamp);
    if (!run.current() && !el("aimTarget").hidden) hideTarget(now);
  });
  el("aimOverlay").addEventListener("pointermove", event => {
    if (!active || event.pointerType !== "mouse") return;
    run.recordCursor({ time_ms: performance.now(), event_timestamp_ms: event.timeStamp,
      x: event.clientX, y: event.clientY, buttons: event.buttons, sample_kind: "move" });
  });
  el("aimOverlay").addEventListener("contextmenu", event => event.preventDefault());
  window.addEventListener("gaze-frame", event => { if (run && !sealed) run.recordFrame(event.detail); });
  async function finish(reason = "") {
    if (!active || finishing) return;
    active = false; finishing = true; cancelAnimationFrame(animation);
    run.finish(performance.now(), reason); el("aimOverlay").hidden = true; document.body.classList.remove("aim-active");
    text("aimStatus", "課題終了・保存中です。");
    try {
      if (!await bridge.drain()) run.events.push({ type: "processing_drain_timeout", time_ms: performance.now() });
      sealed = true; bundle = run.export(); files = A.exportFiles(bundle, window.GazeValidation.csv);
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      renderResults(); el("aimResults").showModal();
      await save(); el("aSession").value = String(Math.min(999, prepared.session_number + 1));
    } catch (error) { text("aimStatus", `終了処理に失敗しました：${error.message}。ページを閉じないでください。`); }
    finally {
      sealed = true; bridge.release(); finishing = false; readiness();
      window.dispatchEvent(new Event("tracker-state"));
    }
  }
  async function save() {
    if (!bundle || !files || saving) return;
    saving = true; el("aimSaveBtn").disabled = true; el("aimImport").disabled = true;
    text("aimSaveStatus", "recordings/aim に保存しています…"); readiness();
    try {
      const response = await fetch("/save-aim", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: bundle.metadata.run_id, files }) });
      if (response.status === 404) throw new Error("新しい保存APIがありません。Pythonサーバーを再起動してから再試行してください。");
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "保存エラー");
      saved = true; text("aimSaveStatus", `保存済み：${result.path}`);
    } catch (error) { text("aimSaveStatus", `自動保存できませんでした：${error.message} 全記録JSONをダウンロードするか再試行してください。`); }
    finally { saving = false; el("aimSaveBtn").disabled = false; el("aimImport").disabled = false; readiness(); }
  }
  function download(name) {
    if (!files) return;
    const url = URL.createObjectURL(new Blob([name.endsWith(".csv") ? "\uFEFF" : "", files[name]], { type: name.endsWith(".csv") ? "text/csv;charset=utf-8" : "application/json" }));
    const link = document.createElement("a"); link.href = url;
    link.download = `${bundle.metadata.participant_id}-aim-S${bundle.metadata.session_number}-${bundle.metadata.run_id}-${name}`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (name === "session.json") { saved = true; text("aimSaveStatus", "全記録JSONのダウンロードを開始しました。保存先を確認してください。"); }
  }
  function renderResults() {
    const s = bundle.summary;
    text("aimSummary", `${bundle.metadata.participant_id} / セッション${bundle.metadata.session_number} / 頭部${bundle.metadata.head_condition === "fixed" ? "固定" : "非固定"} — ${s.status === "completed" ? "完了" : `中断（${bundle.metadata.stop_reason || "途中終了"}）`}。命中 ${s.hits}/${s.planned_trials}、時間切れ ${s.timeouts}、外れ ${s.miss_clicks}、的の受付時間外クリック ${s.outside_window_clicks}。命中までの平均 ${fmt(s.mean_hit_response_ms)} ms、中央値 ${fmt(s.median_hit_response_ms)} ms。クリック命中率 ${fmt(s.click_hit_fraction === null ? null : s.click_hit_fraction * 100)}%。視線取得 ${s.valid_gaze_frames}/${s.processed_gaze_frames} フレーム。`);
    const body = el("aimTrialRows"), select = el("aimTrialSelect"); body.replaceChildren(); select.replaceChildren();
    bundle.trials.forEach(t => {
      const row = document.createElement("tr");
      [t.trial_id, label(t.status), fmt(t.first_click_ms), fmt(t.hit_response_ms), t.miss_clicks, t.valid_gaze_samples].forEach(value => {
        const cell = document.createElement("td"); cell.textContent = String(value); row.appendChild(cell);
      }); body.appendChild(row);
      const option = document.createElement("option"); option.value = t.trial_id; option.textContent = `試行 ${t.trial_id}：${label(t.status)}`; select.appendChild(option);
    });
    ["aimSaveBtn", "aimJsonBtn", "aimTrialsBtn", "aimGazeBtn", "aimClicksBtn"].forEach(id => { el(id).disabled = false; });
    el("aimCursorBtn").disabled = !Array.isArray(bundle.cursor);
    drawTrajectory();
  }
  function drawTrajectory() {
    const svg = el("aimTrajectory"); svg.replaceChildren();
    if (!bundle) return;
    const m = bundle.metadata, t = bundle.trials.find(t => t.trial_id === Number(el("aimTrialSelect").value));
    svg.setAttribute("viewBox", `0 0 ${m.viewport_width} ${m.viewport_height}`);
    if (!t) { text("aimTrialInfo", "的の提示前に終了したため、試行の軌跡はありません。"); return; }
    const node = (tag, attrs) => {
      const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, String(value));
      svg.appendChild(n); return n;
    };
    node("circle", { cx: t.target_x, cy: t.target_y, r: t.target_radius_px, fill: "#57dfed", opacity: 0.5 });
    const frames = bundle.gaze.filter(f => f.trial_id === t.trial_id).sort((a, b) => a.processing_start_ms - b.processing_start_ms);
    const raw = el("aimRawToggle").checked; let previous = null, shown = 0;
    frames.forEach((f, i) => {
      const x = raw ? f.raw_x : f.x, y = raw ? f.raw_y : f.y;
      if (!f.valid || f.crosses_target_end || ![x, y].every(Number.isFinite)) { previous = null; return; }
      const opacity = 0.25 + 0.75 * (i + 1) / Math.max(1, frames.length);
      if (previous && f.processing_start_ms - previous.time <= 200) node("line", { x1: previous.x, y1: previous.y, x2: x, y2: y, stroke: "#ffe06b", "stroke-width": 3, opacity });
      node("circle", { cx: x, cy: y, r: 3, fill: "#ffe06b", opacity });
      previous = { x, y, time: f.processing_start_ms }; shown++;
    });
    const cursor = (bundle.cursor || []).filter(p => p.trial_id === t.trial_id);
    if (el("aimCursorToggle").checked) {
      let previousCursor = null;
      cursor.forEach(p => {
        if (previousCursor && p.time_ms - previousCursor.time_ms <= 200) node("line", {
          x1: previousCursor.x, y1: previousCursor.y, x2: p.x, y2: p.y, stroke: "#fb923c",
          "stroke-width": 3, "stroke-dasharray": "7 5", class: "cursor-path" });
        node("circle", { cx: p.x, cy: p.y, r: 2, fill: "#fb923c", class: "cursor-point" });
        previousCursor = p;
      });
    }
    bundle.clicks.filter(c => c.trial_id === t.trial_id).forEach(c => {
      node("path", { d: `M ${c.x - 7} ${c.y - 7} l 14 14 M ${c.x + 7} ${c.y - 7} l -14 14`,
        stroke: c.outcome === "hit" ? "#65f5a5" : "#ff7d83", "stroke-width": 3, fill: "none" });
    });
    text("aimTrialInfo", `試行 ${t.trial_id}：${label(t.status)}。命中まで ${fmt(t.hit_response_ms)} ms。表示対象の視線 ${shown} 件。${raw ? "未加工" : "最終出力"}座標（CSS px、画面外の座標は図の外に出ます）。${Array.isArray(bundle.cursor) ? `カーソル記録 ${cursor.length} 件。` : "この記録にはカーソル移動データがありません。"}`);
  }
  el("aimTrialSelect").addEventListener("change", drawTrajectory);
  el("aimRawToggle").addEventListener("change", drawTrajectory);
  el("aimCursorToggle").addEventListener("change", drawTrajectory);
  el("aimSaveBtn").addEventListener("click", save);
  for (const [id, name] of [["aimJsonBtn", "session.json"], ["aimTrialsBtn", "trials.csv"], ["aimGazeBtn", "gaze.csv"], ["aimClicksBtn", "clicks.csv"], ["aimCursorBtn", "cursor.csv"]]) el(id).addEventListener("click", () => download(name));
  el("aimResultsBtn").addEventListener("click", () => el("aimResults").showModal());
  el("aimResultsClose").addEventListener("click", () => el("aimResults").close());
  el("aimImport").addEventListener("change", async event => {
    text("aimImportError", "");
    try {
      if (active || finishing || saving || (bundle && !saved)) throw new Error("現在の記録を保存してから読み込んでください。");
      const file = event.target.files[0]; if (!file) return;
      if (file.size > 32 * 1024 * 1024) throw new Error("JSONは32 MiB以内にしてください。");
      const data = JSON.parse(await file.text());
      if (data.schema !== A.VERSION || !data.metadata?.run_id || !data.summary ||
          !Array.isArray(data.trials) || data.trials.length > 100 || !Array.isArray(data.gaze) || !Array.isArray(data.clicks)) throw new Error("的クリック課題のJSONではありません。");
      A.checkConfig(data.metadata);
      A.checkCursor(data.cursor, data.metadata, data.trials);
      if (data.trials.some(t => ![t.trial_id, t.target_x, t.target_y, t.target_radius_px].every(Number.isFinite)) ||
          data.gaze.some(f => !f || !Number.isFinite(f.processing_start_ms)) || data.clicks.some(c => !c || ![c.x, c.y].every(Number.isFinite))) throw new Error("記録の座標・時刻形式が不正です。");
      const importedFiles = A.exportFiles(data, window.GazeValidation.csv);
      bundle = data; files = importedFiles; saved = true; renderResults();
      text("aimSaveStatus", `${file.name} を読み込みました。`);
    } catch (error) { text("aimImportError", error.message || "読み込めませんでした。"); }
    finally { event.target.value = ""; }
  });
  for (const name of ["resize", "blur"]) window.addEventListener(name, () => {
    if (active) void finish(name === "resize" ? "viewport_changed" : "window_blur"); readiness();
  });
  document.addEventListener("fullscreenchange", () => {
    if (active && !document.fullscreenElement) void finish("fullscreen_exit"); readiness();
  });
  document.addEventListener("visibilitychange", () => { if (active && document.hidden) void finish("document_hidden"); });
  // Capture first so the validation module cannot consume Escape for this task.
  window.addEventListener("keydown", event => {
    if (event.key !== "Escape" || (!active && !el("aimResults").open && !el("aimSetup").open)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (active) { void finish("user_escape"); return; }
    if (preparing) return;
    if (el("aimResults").open) el("aimResults").close();
    if (el("aimSetup").open) el("aimSetup").close();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, true);
  window.addEventListener("beforeunload", event => {
    if (active || finishing || (bundle && !saved)) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("tracker-state", readiness);
  readiness();
}());
