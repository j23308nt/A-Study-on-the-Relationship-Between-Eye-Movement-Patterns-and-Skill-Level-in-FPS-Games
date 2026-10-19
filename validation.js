(function () {
  "use strict";
  const V = window.GazeValidation;
  const bridge = window.trackerBridge;
  const el = id => document.getElementById(id);
  let prepared = null, run = null, bundle = null, files = null;
  let active = false, finishing = false, saving = false, saved = true, sealed = true, preparing = false, starting = false;
  let usedGeneration = null, animation = null, countdownEnd = 0, lastPaint = 0;
  const number = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : "—";
  const text = (id, value) => { el(id).textContent = value; };
  const headLabel = condition => ({ fixed: "頭部固定", free: "頭部非固定（角度は参考値）" }[condition] || "頭部条件不明");
  const freeAngleNote = "頭部非固定の視角誤差は、開始時の目の位置と入力距離に基づく参考値です。移動後の目の位置・距離は測定していないため、その時点の実際の視角誤差ではありません。";

  function readiness() {
    const s = bridge.status();
    const usable = prepared && s.generation === prepared.generation && s.generation !== usedGeneration &&
      s.ready && sameViewport() && s.running && !s.paused && !s.busy && !s.recording && !s.locked && document.fullscreenElement;
    const blocked = active || finishing || saving || preparing || starting || s.locked;
    // Missing preparation/fullscreen is recoverable via the Start button, not a dead end.
    el("validationRunBtn").disabled = blocked || !s.running || s.paused || s.busy || s.recording;
    el("validationSetupBtn").disabled = blocked;
    el("validationResultsBtn").disabled = active || finishing || preparing || starting || s.locked;
    if (active || finishing || preparing || starting) return;
    if (!s.running) text("validationStatus", "先に「開始」でカメラを起動してください。");
    else if (s.locked) text("validationStatus", "別の課題を実行中です。課題と終了処理が終わるまで待ってください。");
    else if (saving) text("validationStatus", "結果を保存中です。保存処理が終わるまで待ってください。");
    else if (s.paused) text("validationStatus", "トラッキングが一時停止中です。上の「再開」を押してください。");
    else if (s.recording) text("validationStatus", "通常のCSV計測中です。「計測停止・保存」を押してから検証してください。");
    else if (s.busy) text("validationStatus", "校正または中央スコアの測定中です。9点校正と中央の5秒測定が終わると操作できます。5点補正は任意です。");
    else if (usable) text("validationStatus", `${prepared.participant_id} / ${headLabel(prepared.head_condition)} / セッション${prepared.session_number}：準備完了（5点補正${s.correctionApplied ? "あり" : "なし"}）。検証を開始できます。`);
    else if (!prepared) text("validationStatus", "検証用の条件入力が必要です。「検証を開始」を押すと準備画面を開きます。");
    else if (usedGeneration === s.generation) text("validationStatus", "この校正での検証は終了しました。「検証を開始」から次のセッションを準備できます。");
    else if (prepared.generation !== s.generation) text("validationStatus", "別の校正に切り替わっています。「検証を開始」から検証用の条件と校正を準備し直してください。");
    else if (!document.fullscreenElement) text("validationStatus", "全画面が解除されています。「検証を開始」で全画面に戻して表示条件を確認します。");
    else text("validationStatus", "校正または表示条件を確認する必要があります。「検証を開始」から準備し直してください。");
  }

  async function hashes() {
    const result = {};
    for (const name of ["app.js", "validation-core.js", "validation.js", "index.html", "styles.css"]) {
      const response = await fetch(name, { cache: "no-store" });
      if (!response.ok) throw new Error(`コード版を確認できません: ${name}`);
      const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
      result[name] = Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, "0")).join("");
    }
    return result;
  }

  function openSetup(message = "") {
    text("validationSetupError", message);
    el("vPositionConfirmed").checked = false;
    if (!el("validationSetup").open) el("validationSetup").showModal();
  }
  el("validationSetupBtn").addEventListener("click", () => openSetup());
  el("validationSetupClose").addEventListener("click", () => { if (!preparing) el("validationSetup").close(); });
  el("validationSetup").addEventListener("cancel", event => { if (preparing) event.preventDefault(); });
  el("vHeadCondition").addEventListener("change", () => {
    el("vPositionConfirmed").checked = false;
    text("validationHeadNote", el("vHeadCondition").value === "free"
      ? `校正から検証終了まで固定具を使わず、自然な姿勢で点を見てください。${freeAngleNote}`
      : "校正から検証終了まで頭部を固定してください。固定方法は特記事項に記録してください。");
  });
  el("vParticipant").addEventListener("change", () => {
    const mapping = { P01: "unaided", P02: "glasses", P03: "contacts" };
    if (mapping[el("vParticipant").value]) el("vVision").value = mapping[el("vParticipant").value];
  });
  el("validationForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (preparing || !el("validationForm").reportValidity()) return;
    preparing = true;
    readiness();
    el("validationPrepareBtn").disabled = true;
    text("validationSetupError", "");
    try {
      const s = bridge.status();
      if (!s.running || s.paused || s.recording || s.busy || s.locked) throw new Error("カメラを開始・再開し、通常計測や校正・別の課題を終えてから準備してください。");
      if (bundle && !saved) throw new Error("前回の全記録JSONを保存してから、次のセッションを準備してください。");
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      if (document.fullscreenElement !== document.documentElement) throw new Error("ページ全体を全画面表示にしてください。");
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const config = {
        participant_id: el("vParticipant").value.trim(), session_number: Number(el("vSession").value),
        vision: el("vVision").value, geometry: { width_cm: Number(el("vWidth").value), height_cm: Number(el("vHeight").value),
          distance_cm: Number(el("vDistance").value), viewport_width: innerWidth, viewport_height: innerHeight },
        declared_screen_pixels: { width: Number(el("vScreenWidth").value), height: Number(el("vScreenHeight").value) },
        os_scale_note: el("vOsScale").value, browser_zoom_note: el("vZoom").value, environment_notes: el("vNotes").value,
        head_condition: el("vHeadCondition").value,
        angular_error_reference: "initial_centered_eye_position_and_declared_distance",
        head_position_confirmed: el("vPositionConfirmed").checked, device_pixel_ratio: devicePixelRatio,
        browser_screen_css: { width: screen.width, height: screen.height }, user_agent: navigator.userAgent,
        source_sha256: await hashes()
      };
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(config.participant_id)) throw new Error("参加者IDは英数字・ハイフン・アンダースコアで入力してください。");
      if (!["fixed", "free"].includes(config.head_condition)) throw new Error("頭部条件を選択してください。");
      if (!document.fullscreenElement || document.hidden) throw new Error("全画面表示のまま準備してください。");
      // Hash fetches can span fullscreen resize events. Snapshot the actual calibration viewport now.
      config.geometry.viewport_width = innerWidth;
      config.geometry.viewport_height = innerHeight;
      config.device_pixel_ratio = devicePixelRatio;
      bridge.prepare();
      config.generation = bridge.status().generation;
      prepared = config;
      el("validationSetup").close();
      readiness();
    } catch (error) {
      text("validationSetupError", error.message || "準備できませんでした。");
    } finally {
      preparing = false;
      el("validationPrepareBtn").disabled = false;
      readiness();
    }
  });

  function sameViewport() {
    return prepared && prepared.geometry.viewport_width === innerWidth && prepared.geometry.viewport_height === innerHeight &&
      prepared.device_pixel_ratio === devicePixelRatio;
  }
  function showTrial(now) {
    const trial = run.startTrial(now);
    el("validationCountdown").hidden = true;
    const target = el("validationTarget");
    target.hidden = false;
    target.style.left = `${trial.target_x_ratio * 100}%`;
    target.style.top = `${trial.target_y_ratio * 100}%`;
    run.events.push({ time_ms: now, type: "target_presented", trial_id: trial.trial_id });
  }
  function tick() {
    if (!active) return;
    const now = performance.now();
    if (!document.fullscreenElement || !sameViewport() || document.hidden) {
      void finish("display_changed");
      return;
    }
    if (run.trials.length && now - lastPaint > 250) {
      run.events.push({ type: "render_gap", time_ms: now, gap_ms: now - lastPaint });
      void finish("render_stall_over_250ms");
      return;
    }
    lastPaint = now;
    if (now < countdownEnd) text("validationCountdown", String(Math.max(1, Math.ceil((countdownEnd - now) / 1000))));
    else if (!run.trials.length) showTrial(now);
    else if (now >= run.trials[run.trials.length - 1].analysis_end_ms) {
      run.endTrial(now);
      if (run.trials.length === 27) { void finish(); return; }
      showTrial(now);
    }
    animation = requestAnimationFrame(tick);
  }

  el("validationRunBtn").addEventListener("click", async () => {
    if (active || finishing || saving || preparing || starting) return;
    const s = bridge.status();
    if (!s.running || s.paused || s.recording || s.busy || s.locked) { readiness(); return; }
    if (!prepared || prepared.generation === usedGeneration || prepared.generation !== s.generation || (bundle && !saved)) {
      openSetup(bundle && !saved ? "前回の全記録JSONを保存してから次の検証を準備してください。" : "参加者・表示条件を確認し、検証用の9点校正を行ってください。");
      return;
    }
    starting = true; readiness();
    let acquired = false;
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      if (document.fullscreenElement !== document.documentElement || document.hidden) throw new Error("ページ全体の全画面表示が必要です。もう一度「検証を開始」を押してください。");
      if (!sameViewport() || !bridge.status().ready || prepared.generation !== bridge.status().generation) {
        openSetup("校正時と表示サイズまたは校正が異なります。条件を確認して9点校正をやり直してください。");
        return;
      }
      const snapshot = bridge.acquire(); acquired = true;
      usedGeneration = prepared.generation;
      const g = prepared.geometry;
      const diameter = degrees => 2 * g.distance_cm * Math.tan(degrees * Math.PI / 360);
      const targetSize = { width_css: diameter(0.5) / g.width_cm * g.viewport_width,
        height_css: diameter(0.5) / g.height_cm * g.viewport_height,
        center_width_css: diameter(0.1) / g.width_cm * g.viewport_width,
        center_height_css: diameter(0.1) / g.height_cm * g.viewport_height, nominal_center_degrees: 0.5 };
      run = new V.Session({ ...prepared, tracker: snapshot, target_size: targetSize, run_id: crypto.randomUUID(),
        seed: crypto.getRandomValues(new Uint32Array(1))[0], started_at: new Date().toISOString(),
        performance_time_origin: performance.timeOrigin, start_ms: performance.now(),
        target_clock: "performance.now at target CSS update inside requestAnimationFrame; not measured photon onset",
        render_gap_abort_ms: 250 });
      bundle = null; files = null; saved = false; sealed = false; active = true;
      document.body.classList.add("validation-active");
      el("validationOverlay").hidden = false;
      el("validationOverlay").focus();
      el("validationCountdown").hidden = false;
      el("validationTarget").hidden = true;
      const target = el("validationTarget");
      target.style.width = `${targetSize.width_css}px`;
      target.style.height = `${targetSize.height_css}px`;
      target.style.setProperty("--center-width", `${targetSize.center_width_css}px`);
      target.style.setProperty("--center-height", `${targetSize.center_height_css}px`);
      countdownEnd = performance.now() + 3000;
      lastPaint = performance.now();
      readiness();
      text("validationStatus", "検証中：Escで中断できます。");
      animation = requestAnimationFrame(tick);
    } catch (error) {
      if (acquired) bridge.release();
      text("validationStatus", error.message || "検証を開始できませんでした。");
    } finally {
      starting = false;
      // Refresh controls without replacing an actionable start error.
      const message = el("validationStatus").textContent;
      readiness();
      if (!active) text("validationStatus", message);
    }
  });
  window.addEventListener("gaze-frame", event => {
    if (run && !sealed) run.recordFrame(event.detail);
  });
  async function finish(reason = "") {
    if (!active || finishing) return;
    active = false; finishing = true;
    cancelAnimationFrame(animation);
    run.finish(performance.now(), reason);
    el("validationOverlay").hidden = true;
    document.body.classList.remove("validation-active");
    text("validationStatus", "終了処理・保存中です。");
    try {
      if (!await bridge.drain()) run.events.push({ time_ms: performance.now(), type: "processing_drain_timeout" });
      sealed = true;
      bundle = run.export();
      files = V.exportFiles(bundle);
      await leaveFullscreen();
      renderResults();
      if (!el("validationResults").open) el("validationResults").showModal();
      await save();
      el("vSession").value = String(Math.min(3, prepared.session_number + 1));
    } catch (error) {
      text("validationStatus", `終了処理に失敗しました：${error.message}。ページを閉じず結果保存を確認してください。`);
    } finally {
      sealed = true;
      bridge.release();
      finishing = false;
      readiness();
    }
  }

  function renderResults() {
    const s = bundle.summary;
    const reasons = { display_changed: "画面の表示条件が変わりました", viewport_changed: "画面サイズが変わりました",
      window_blur: "別のウィンドウに切り替わりました", fullscreen_exit: "全画面表示が解除されました",
      document_hidden: "ページが非表示になりました", user_escape: "Escで終了しました",
      render_stall_over_250ms: "描画が250ms以上停止しました" };
    const stateLabel = s.status === "completed" ? (s.data_complete ? "完了" : "完了・欠測あり")
      : `中断：${reasons[bundle.metadata.stop_reason] || "検証が途中で終了しました"}`;
    text("validationSummary", `${bundle.metadata.participant_id} / ${headLabel(bundle.metadata.head_condition)} / セッション${bundle.metadata.session_number} — ${stateLabel}。全位置・全試行が揃った平均誤差：${number(s.mean_error_deg)}°。完了試行 ${s.trials.filter(t => t.status === "completed").length}/27。`);
    text("validationAngleNote", bundle.metadata.head_condition === "free" ? freeAngleNote : "角度は入力距離と画面中央正面の目の位置を前提に計算しています。");
    const body = el("validationPositionRows"); body.replaceChildren();
    s.positions.forEach(p => {
      const row = document.createElement("tr");
      [p.point_id, `${p.trials_with_data}/3`, number(p.mean_error_deg), number(p.p95_error_deg), number(p.raw_mean_error_deg),
        p.invalid_fraction === null ? "—" : `${number(p.invalid_fraction * 100, 1)}%`, p.valid_samples].forEach(value => {
        const cell = document.createElement("td"); cell.textContent = String(value); row.appendChild(cell);
      });
      body.appendChild(row);
    });
    ["validationSaveBtn", "validationJsonBtn", "validationCsvBtn", "validationPositionsBtn", "validationTrialsBtn"].forEach(id => { el(id).disabled = false; });
  }
  async function save() {
    if (!bundle || !files || saving) return;
    saving = true;
    el("validationSaveBtn").disabled = true;
    text("validationSaveStatus", "recordings/validation に保存しています…");
    try {
      const response = await fetch("/save-validation", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: bundle.metadata.run_id, files }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "保存エラー");
      saved = true;
      text("validationSaveStatus", `保存済み：${result.path}（JSON・フレームCSV・試行別CSV・位置別CSV）`);
    } catch (error) {
      text("validationSaveStatus", `自動保存できませんでした：${error.message}。再試行するか、全記録JSONをダウンロードしてください。`);
    } finally {
      saving = false;
      el("validationSaveBtn").disabled = false;
      readiness();
    }
  }
  function download(name) {
    if (!files) return;
    const blob = new Blob([name.endsWith(".csv") ? "\uFEFF" : "", files[name]],
      { type: name.endsWith(".json") ? "application/json;charset=utf-8" : "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${bundle.metadata.participant_id}-S${bundle.metadata.session_number}-${bundle.metadata.run_id}-${name}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (name === "session.json") {
      saved = true;
      text("validationSaveStatus", "全記録JSONのダウンロードを開始しました。保存先でファイルを確認してください。");
    }
  }
  el("validationSaveBtn").addEventListener("click", save);
  el("validationJsonBtn").addEventListener("click", () => download("session.json"));
  el("validationCsvBtn").addEventListener("click", () => download("samples.csv"));
  el("validationPositionsBtn").addEventListener("click", () => download("positions.csv"));
  el("validationTrialsBtn").addEventListener("click", () => download("trials.csv"));
  el("validationResultsBtn").addEventListener("click", () => el("validationResults").showModal());
  el("validationResultsClose").addEventListener("click", () => el("validationResults").close());

  el("validationCompareInput").addEventListener("change", async event => {
    const rows = [], seen = new Set(), errors = [];
    for (const file of event.target.files) {
      try {
        const data = JSON.parse(await file.text());
        if (data.schema !== V.VERSION || !data.metadata?.participant_id || !data.summary || !data.metadata.run_id) throw new Error("検証JSONではありません");
        if (seen.has(data.metadata.run_id)) continue;
        seen.add(data.metadata.run_id);
        rows.push(data);
      } catch (error) { errors.push(`${file.name}: ${error.message}`); }
    }
    rows.sort((a, b) => String(a.metadata.participant_id).localeCompare(String(b.metadata.participant_id)) || a.metadata.session_number - b.metadata.session_number);
    const body = el("validationCompareRows"); body.replaceChildren();
    rows.forEach(data => {
      const tr = document.createElement("tr");
      [data.metadata.participant_id, headLabel(data.metadata.head_condition), data.metadata.session_number, data.summary.data_complete ? "完了" : "不完全・中断",
        number(data.summary.mean_error_deg), data.metadata.run_id].forEach(value => {
        const td = document.createElement("td"); td.textContent = String(value); tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    const groupKey = r => JSON.stringify([r.metadata.participant_id, r.metadata.head_condition ?? null]);
    const reports = [...new Set(rows.map(groupKey))].map(key => {
      const participant = rows.filter(r => groupKey(r) === key);
      const id = `${participant[0].metadata.participant_id} / ${headLabel(participant[0].metadata.head_condition)}`;
      const sessionIds = participant.map(r => r.metadata.session_number);
      if (new Set(sessionIds).size !== sessionIds.length) return `${id}: 同じ回の複数実行があります。自動統合しません`;
      const conditions = participant.map(r => JSON.stringify({ geometry: r.metadata.geometry, vision: r.metadata.vision,
        angular_error_reference: r.metadata.angular_error_reference,
        dpr: r.metadata.device_pixel_ratio, camera: r.metadata.tracker?.camera_label, camera_settings: r.metadata.tracker?.camera_settings,
        five_point_correction_applied: r.metadata.tracker?.five_point_correction_applied,
        smoothing: r.metadata.tracker?.smoothing, source: r.metadata.source_sha256, os_scale: r.metadata.os_scale_note,
        zoom: r.metadata.browser_zoom_note, environment: r.metadata.environment_notes }));
      if (new Set(conditions).size !== 1) return `${id}: 条件またはコード版が異なるため、範囲を集計しません`;
      const values = participant.filter(r => r.summary.data_complete).map(r => r.summary.mean_error_deg).filter(Number.isFinite);
      return `${id}: 完全な${values.length}セッション、平均誤差の範囲 ${values.length ? `${number(Math.min(...values))}–${number(Math.max(...values))}°` : "—"}`;
    });
    text("validationCompareStatus", [...reports, ...errors, "異なる条件・コード版の結果は同条件の再現性として解釈しないでください。", ...(rows.some(r => r.metadata.head_condition === "free") ? [freeAngleNote] : [])].join("。"));
  });
  for (const name of ["resize", "blur"]) window.addEventListener(name, () => {
    if (active) void finish(name === "resize" ? "viewport_changed" : "window_blur");
    readiness();
  });
  document.addEventListener("fullscreenchange", () => {
    if (active && !document.fullscreenElement) void finish("fullscreen_exit");
    readiness();
  });
  document.addEventListener("visibilitychange", () => {
    if (active && document.hidden) void finish("document_hidden");
  });
  async function leaveFullscreen() {
    if (!document.fullscreenElement) return;
    try { await document.exitFullscreen(); }
    catch { text("validationStatus", "全画面を解除できませんでした。Escで再試行してください。"); }
  }
  window.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if (preparing) { event.preventDefault(); return; }
    if (!active && !document.fullscreenElement && !el("validationResults").open && !el("validationSetup").open) return;
    event.preventDefault();
    if (active) { void finish("user_escape"); return; }
    for (const id of ["validationResults", "validationSetup"]) {
      if (el(id).open) el(id).close();
    }
    void leaveFullscreen();
  });
  // Native dialog cancellation can consume Escape before a window key event.
  for (const id of ["validationResults", "validationSetup"]) {
    el(id).addEventListener("cancel", () => { void leaveFullscreen(); });
  }
  window.addEventListener("beforeunload", event => {
    if (active || finishing || (bundle && !saved)) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("tracker-state", readiness);
  readiness();
}());
