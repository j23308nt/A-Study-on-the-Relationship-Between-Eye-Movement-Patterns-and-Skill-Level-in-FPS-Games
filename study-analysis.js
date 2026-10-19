(function () {
  "use strict";
  const S = window.StudyAnalysis, V = window.GazeValidation;
  const el = id => document.getElementById(id), text = (id, value) => { el(id).textContent = value; };
  const fmt = (v, digits = 2) => Number.isFinite(v) ? v.toFixed(digits) : "—";
  const pct = v => Number.isFinite(v) ? `${fmt(v * 100, 1)}%` : "—";
  const kindLabel = k => k === "validation" ? "正確度検証" : "的クリック課題";
  const headLabel = h => ({ fixed: "固定", free: "非固定", unknown: "不明" }[h]);
  const correction = r => typeof r.metadata.tracker?.five_point_correction_applied === "boolean" ? String(r.metadata.tracker.five_point_correction_applied) : "unknown";
  const correctionLabel = r => ({ true: "あり", false: "なし", unknown: "不明" }[correction(r)]);
  const statusLabel = r => r.complete ? "完了" : r.status === "completed" ? "完了・欠測" : "中断";
  let runs = [], visible = [], grouped = [], selected = null, loading = false;
  const codes = new Map();
  function conditionCode(r) {
    const key = r.conditionKnown ? r.signature : `${r.signature}:${r.id}`;
    if (!codes.has(key)) codes.set(key, `C${String(codes.size + 1).padStart(2, "0")}`);
    return codes.get(key);
  }
  const cell = value => { const n = document.createElement("td"); n.textContent = String(value); return n; };
  function row(body, values) { const tr = document.createElement("tr"); values.forEach(v => tr.appendChild(cell(v))); body.appendChild(tr); return tr; }
  function cards(id, values) {
    const root = el(id); root.replaceChildren();
    for (const [name, value] of values) { const div = document.createElement("div"), span = document.createElement("span"), strong = document.createElement("strong"); span.textContent = name; strong.textContent = value; div.append(span, strong); root.appendChild(div); }
  }
  function download(name, rows) {
    if (!rows.length) return;
    const csv = V.csv(rows, [...new Set(rows.flatMap(Object.keys))]);
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  el("studyFiles").addEventListener("change", async event => {
    if (loading) return;
    loading = true; el("studyFiles").disabled = true; el("studyClear").disabled = true;
    text("studyLoadStatus", "記録を確認・再集計しています…"); el("studyLoadErrors").replaceChildren();
    let added = 0, duplicates = 0;
    const errors = [];
    try {
      for (const file of Array.from(event.target.files)) {
        try {
          if (file.size > 32 * 1024 * 1024) throw new Error("1ファイル32 MiBを超えています。");
          if (runs.reduce((n, r) => n + r.fileSize, 0) + file.size > 128 * 1024 * 1024) throw new Error("読込合計が128 MiBを超えます。不要な記録を一覧から外してください。");
          const data = JSON.parse((await file.text()).replace(/^\uFEFF/, ""));
          const bytes = new TextEncoder().encode(S.stable(data));
          const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(v => v.toString(16).padStart(2, "0")).join("");
          const old = runs.find(r => r.id === data?.metadata?.run_id);
          if (old) {
            if (old.fileHash !== hash) throw new Error("同じ実行IDで内容が異なります。既存記録を保持し、このファイルは読み込みません。");
            duplicates++; continue;
          }
          const run = S.normalize(data);
          runs.push({ ...run, fileHash: hash, fileSize: file.size, fileName: file.name }); added++;
        } catch (error) { errors.push(`${file.name}：${error.message || "読み込めませんでした。"}`); }
        // Let the page paint between large files.
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } finally {
      loading = false; el("studyFiles").disabled = false; el("studyClear").disabled = false; event.target.value = "";
      errors.forEach(message => { const li = document.createElement("li"); li.textContent = message; el("studyLoadErrors").appendChild(li); });
      text("studyLoadStatus", `${added}件追加、同一記録${duplicates}件を重複除外、読込失敗${errors.length}件。現在${runs.length}実行。`);
      refreshParticipants(); render();
    }
  });
  function refreshParticipants() {
    const select = el("studyParticipant"), previous = select.value;
    select.replaceChildren(new Option("全員", "all"));
    [...new Set(runs.map(r => r.participant))].sort().forEach(id => select.appendChild(new Option(id, id)));
    if ([...select.options].some(o => o.value === previous)) select.value = previous;
  }
  for (const id of ["studyKind", "studyParticipant", "studyHead", "studyCorrection", "studyState"]) el(id).addEventListener("change", render);
  el("studyClear").addEventListener("click", () => {
    runs = []; selected = null; codes.clear(); refreshParticipants();
    for (const id of ["studyKind", "studyHead", "studyCorrection", "studyState"]) el(id).value = "all";
    render();
    text("studyLoadStatus", "読込一覧をクリアしました。元ファイルは変更していません。"); el("studyLoadErrors").replaceChildren();
  });
  function render() {
    el("studyWorkspace").hidden = !runs.length;
    visible = runs.filter(r => (el("studyKind").value === "all" || r.kind === el("studyKind").value) &&
      (el("studyParticipant").value === "all" || r.participant === el("studyParticipant").value) &&
      (el("studyHead").value === "all" || r.head === el("studyHead").value) &&
      (el("studyCorrection").value === "all" || correction(r) === el("studyCorrection").value) &&
      (el("studyState").value === "all" || r.complete === (el("studyState").value === "complete")))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.participant.localeCompare(b.participant) || a.head.localeCompare(b.head) || a.session - b.session);
    grouped = S.groups(visible);
    cards("studyCounts", [["表示中 / 読込実行", `${visible.length} / ${runs.length}`], ["参加者", new Set(visible.map(r => r.participant)).size],
      ["完了・必要データあり", visible.filter(r => r.complete).length], ["中断・欠測", visible.filter(r => !r.complete).length]]);
    const body = el("studyRunRows"); body.replaceChildren();
    for (const r of visible) {
      const tr = row(body, [kindLabel(r.kind), r.participant, headLabel(r.head), correctionLabel(r), r.session,
        conditionCode(r), statusLabel(r), `${fmt(r.primary)} ${r.kind === "validation" ? "°" : "ms"}`, pct(r.invalid_fraction), r.valid_samples]);
      const actions = cell("");
      const details = document.createElement("button"); details.type = "button"; details.textContent = "詳細";
      details.addEventListener("click", () => { selected = r.id; el("studyDetailSelect").value = r.id; renderDetail(); el("detailTitle").scrollIntoView({ block: "start" }); });
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "除外";
      remove.setAttribute("aria-label", `${r.participant} セッション${r.session} ${r.id}を読込一覧から除外`);
      remove.addEventListener("click", () => { runs = runs.filter(run => run.id !== r.id); refreshParticipants(); render(); text("studyLoadStatus", `現在${runs.length}実行。元ファイルは変更していません。`); });
      actions.append(details, remove); tr.appendChild(actions);
    }
    if (!visible.length) row(body, ["該当する記録がありません。フィルターを変更してください。"]);
    const gb = el("studyGroupRows"); gb.replaceChildren();
    grouped.forEach(g => row(gb, [g.kind === "validation" ? "正確度 / °" : "クリック / ms", g.participant, headLabel(g.head), conditionCode(g.runs[0]),
      `${g.eligible} / ${g.runs.length}`, g.primary.n, fmt(g.primary.mean), fmt(g.primary.median), fmt(g.primary.sd),
      `${fmt(g.primary.min)}–${fmt(g.primary.max)}`, g.note]));
    groupBars("studyValidationBars", grouped.filter(g => g.kind === "validation"), "°");
    groupBars("studyAimBars", grouped.filter(g => g.kind === "aim"), "ms");
    const conditions = el("studyConditions"); conditions.replaceChildren(); const seen = new Set();
    visible.forEach(r => {
      const code = conditionCode(r); if (seen.has(code)) return; seen.add(code);
      const details = document.createElement("details"), summary = document.createElement("summary"), pre = document.createElement("pre");
      summary.textContent = `${code}：${kindLabel(r.kind)} / 頭部${headLabel(r.head)} / 5点補正${correctionLabel(r)}${r.conditionKnown ? "" : " / 条件情報不足"}`;
      pre.textContent = JSON.stringify(r.conditions, null, 2); details.append(summary, pre); conditions.appendChild(details);
    });
    const select = el("studyDetailSelect"); select.replaceChildren();
    visible.forEach(r => select.appendChild(new Option(`${kindLabel(r.kind)} / ${r.participant} / ${headLabel(r.head)} / S${r.session} / ${r.id.slice(0, 8)}`, r.id)));
    if (!visible.some(r => r.id === selected)) selected = visible[0]?.id ?? null;
    if (selected) select.value = selected;
    el("studyRunExport").disabled = !visible.length; el("studyGroupExport").disabled = !grouped.length;
    renderDetail();
  }
  function groupBars(id, groups, unit) {
    const root = el(id); root.replaceChildren(); const drawable = groups.filter(g => g.primary.n > 0);
    const maximum = drawable.reduce((m, g) => Math.max(m, g.primary.mean), 0);
    if (!drawable.length) { const p = document.createElement("p"); p.textContent = "集計可能なセッションがありません。"; root.appendChild(p); return; }
    for (const g of drawable) {
      const div = document.createElement("div"), label = document.createElement("div"), track = document.createElement("div"), bar = document.createElement("div");
      label.className = "study-bar-label"; label.textContent = `${g.participant}・${headLabel(g.head)}・${conditionCode(g.runs[0])}　${fmt(g.primary.mean)} ${unit}（n=${g.primary.n}）`;
      track.className = "study-bar-track"; bar.className = "study-bar-fill"; bar.style.width = `${maximum ? g.primary.mean / maximum * 100 : 0}%`;
      track.appendChild(bar); div.append(label, track); root.appendChild(div);
    }
  }
  const svgNode = (svg, tag, attrs, content = "") => {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, String(v))); if (content) n.textContent = content; svg.appendChild(n); return n;
  };
  function chartBase(id, max, unit) {
    const svg = el(id); svg.replaceChildren(); svg.setAttribute("viewBox", "0 0 560 280");
    const scale = Math.max(1, max);
    for (let i = 0; i <= 4; i++) {
      const y = 230 - i * 48;
      svgNode(svg, "line", { x1: 58, y1: y, x2: 538, y2: y, stroke: "#dbe3e8" });
      svgNode(svg, "text", { x: 50, y: y + 4, "text-anchor": "end", "font-size": 11, fill: "#526372" }, fmt(scale * i / 4, 1));
    }
    svgNode(svg, "text", { x: 14, y: 20, "font-size": 12, fill: "#526372" }, unit);
    return { svg, y: value => 230 - value / scale * 192 };
  }
  function trend(points, unit) {
    const { svg, y } = chartBase("studyTrend", points.reduce((m, p) => Number.isFinite(p.value) ? Math.max(m, p.value) : m, 0), unit);
    if (!points.length) { svgNode(svg, "text", { x: 160, y: 120, "font-size": 14 }, "提示された試行はありません"); return; }
    points.forEach((p, i) => {
      const x = 68 + i / Math.max(1, points.length - 1) * 460;
      if (Number.isFinite(p.value)) {
        const dot = svgNode(svg, "circle", { cx: x, cy: y(p.value), r: 4, fill: "#0b7a75" });
        svgNode(dot, "title", {}, `試行 ${p.id}: ${fmt(p.value)} ${unit}`);
      } else {
        const marker = svgNode(svg, "path", { d: `M ${x - 4} 237 l 8 8 M ${x + 4} 237 l -8 8`, stroke: "#a32438", "stroke-width": 2 });
        svgNode(marker, "title", {}, `試行 ${p.id}: ${p.status}（算出値なし）`);
      }
      if (i === 0 || i === points.length - 1 || (i + 1) % Math.ceil(points.length / 8) === 0)
        svgNode(svg, "text", { x, y: 260, "text-anchor": "middle", "font-size": 11 }, String(p.id));
    });
    svgNode(svg, "text", { x: 495, y: 277, "font-size": 11 }, "試行番号");
  }
  function histogram(values, unit) {
    const bins = S.histogram(values), maximum = bins.reduce((m, b) => Math.max(m, b.count), 0);
    const { svg, y } = chartBase("studyHistogram", maximum, "件数");
    if (!bins.length) { svgNode(svg, "text", { x: 165, y: 120, "font-size": 14 }, "分布を計算できる値がありません"); return; }
    bins.forEach((b, i) => {
      const width = 470 / bins.length, x = 63 + i * width;
      const rect = svgNode(svg, "rect", { x, y: y(b.count), width: Math.max(1, width - 3), height: 230 - y(b.count), fill: "#376fa5" });
      svgNode(rect, "title", {}, `${fmt(b.low)}–${fmt(b.high)} ${unit}: ${b.count}件`);
      if (i % 2 === 0) svgNode(svg, "text", { x, y: 254, "font-size": 10 }, fmt(b.low, 1));
    });
    svgNode(svg, "text", { x: 530, y: 275, "text-anchor": "end", "font-size": 11 }, unit);
  }
  function renderDetail() {
    const r = visible.find(r => r.id === selected);
    window.studyReplay.load(r?.kind === "aim" ? r.data : null);
    el("studyTrialExport").disabled = !r; el("studyValidationDetail").hidden = !r || r.kind !== "validation"; el("studyAimDetail").hidden = !r || r.kind !== "aim";
    if (!r) { text("studyDetailSummary", "表示する記録を選んでください。"); text("studyDetailWarning", ""); text("studyMetadata", "");
      text("studyTrendTitle", "試行ごとの値"); text("studyHistogramTitle", "分布"); text("studyTrendNote", ""); text("studyHistogramNote", "");
      el("studyTrialRows").replaceChildren(); el("studyTrialHead").replaceChildren(); trend([], ""); histogram([], ""); return; }
    const s = r.data.summary;
    text("studyDetailSummary", `${kindLabel(r.kind)} / ${r.participant} / 頭部${headLabel(r.head)} / 5点補正${correctionLabel(r)} / セッション${r.session} / ${conditionCode(r)} / ${statusLabel(r)}`);
    const warnings = [];
    if (!r.complete) warnings.push("中断・欠測の記録です。表示される部分的な値は条件別平均には使いません。");
    if (r.head === "free" && r.kind === "validation") warnings.push("頭部非固定の角度は、開始時の目の位置・入力距離に基づく参考値です。");
    if (!r.conditionKnown) warnings.push("頭部条件・5点補正・コード版の情報が不足しているため、他のセッションと自動集計しません。");
    if (r.kind === "aim") warnings.push("時間切れ・中断を応答時間0 msとは扱いません。命中した試行だけの時間と失敗数を併せて確認してください。");
    text("studyDetailWarning", warnings.join(" ")); text("studyMetadata", JSON.stringify(r.metadata, null, 2));
    const body = el("studyTrialRows"), head = el("studyTrialHead"); body.replaceChildren(); head.replaceChildren();
    const headers = r.kind === "validation" ? ["試行", "位置", "状態", "平均 (°)", "95%点 (°)", "未加工平均 (°)", "有効サンプル", "失敗率", "有効/秒", "最大空白 (ms)"] :
      ["試行", "状態", "最初のクリック (ms)", "命中まで (ms)", "外れ", "有効視線", "的X (px)", "的Y (px)"];
    const hr = document.createElement("tr"); headers.forEach(v => { const th = document.createElement("th"); th.textContent = v; th.scope = "col"; hr.appendChild(th); }); head.appendChild(hr);
    if (r.kind === "validation") {
      const pbody = el("studyPositionRows"), grid = el("studyPositions"); pbody.replaceChildren(); grid.replaceChildren();
      const maximum = s.positions.reduce((m, p) => Math.max(m, p.mean_error_deg || 0), 0);
      s.positions.forEach(p => {
        row(pbody, [p.point_id, `${p.trials_with_data}/3`, fmt(p.mean_error_deg), fmt(p.p95_error_deg), fmt(p.raw_mean_error_deg), pct(p.invalid_fraction), p.valid_samples]);
        const tile = document.createElement("div"), title = document.createElement("span"), value = document.createElement("strong"), count = document.createElement("span");
        tile.className = "study-position"; tile.style.background = Number.isFinite(p.mean_error_deg) ? `hsl(175 35% ${96 - (maximum ? p.mean_error_deg / maximum : 0) * 32}%)` : "#f0f1f2";
        title.textContent = p.point_id; value.textContent = `${fmt(p.mean_error_deg)}°`; count.textContent = `データあり ${p.trials_with_data}/3`;
        tile.append(title, value, count); grid.appendChild(tile);
      });
      s.trials.forEach(t => row(body, [t.trial_id, t.point_id, t.status === "completed" ? "完了" : "中断", fmt(t.mean_error_deg), fmt(t.p95_error_deg), fmt(t.raw_mean_error_deg), t.valid_samples, pct(t.invalid_fraction), fmt(t.valid_samples_per_second), fmt(t.max_valid_gap_ms, 0)]));
      trend(s.trials.map(t => ({ id: t.trial_id, value: t.mean_error_deg, status: t.status })), "°");
      const values = r.data.frames.filter(f => f.included_in_analysis).map(f => f.error_deg);
      histogram(values, "°"); text("studyTrendTitle", "試行ごとの平均誤差"); text("studyHistogramTitle", "有効フレームの誤差分布");
      text("studyTrendNote", "各点は1試行の平均です。赤い×は中断・有効データなし（0°ではありません）。");
      text("studyHistogramNote", `${values.length}有効フレームをまとめた分布です。サンプルの多い試行の影響が大きく、試行を等重みにする全体平均とは集計単位が違います。`);
    } else {
      const times = r.data.trials.filter(t => t.status === "hit").map(t => t.hit_response_ms), st = S.stats(times);
      cards("studyAimMetrics", [["命中 / 予定", `${s.hits} / ${s.planned_trials}`], ["時間切れ / 中断試行", `${s.timeouts} / ${s.aborted_trials}`],
        ["外れクリック", s.miss_clicks], ["クリック命中率", pct(s.click_hit_fraction)], ["命中応答の中央値", `${fmt(st.median, 1)} ms`], ["命中応答の95%点", `${fmt(st.p95, 1)} ms`]]);
      r.data.trials.forEach(t => row(body, [t.trial_id, ({ hit: "命中", timeout: "時間切れ", aborted: "中断" })[t.status], fmt(t.first_click_ms, 1), fmt(t.hit_response_ms, 1), t.miss_clicks, t.valid_gaze_samples, fmt(t.target_x, 1), fmt(t.target_y, 1)]));
      trend(r.data.trials.map(t => ({ id: t.trial_id, value: t.hit_response_ms, status: t.status })), "ms"); histogram(times, "ms");
      text("studyTrendTitle", "試行ごとの命中応答時間"); text("studyHistogramTitle", "命中応答時間の分布");
      text("studyTrendNote", "赤い×は時間切れ・中断（0 msではありません）。的の位置・マウス移動距離も試行ごとに異なります。");
      text("studyHistogramNote", `命中した${st.n}試行のみ。平均 ${fmt(st.mean, 1)} ms、標本SD ${fmt(st.sd, 1)} ms。提示前・間の空白・期限後のクリックは${s.outside_window_clicks}回でした。`);
    }
  }
  el("studyDetailSelect").addEventListener("change", event => { selected = event.target.value; renderDetail(); });
  el("studyRunExport").addEventListener("click", () => download("measurement-runs.csv", S.exportRows(visible).map((r, i) => ({ ...r, condition_code: conditionCode(visible[i]) }))));
  el("studyGroupExport").addEventListener("click", () => download("measurement-groups.csv", grouped.map(g => ({ task_type: g.kind, participant_id: g.participant,
    head_condition: g.head, condition_code: conditionCode(g.runs[0]), unit: g.kind === "validation" ? "deg" : "ms", loaded_runs: g.runs.length,
    complete_runs: g.eligible, contributing_runs: g.primary.n, mean: g.primary.mean, median: g.primary.median, sample_sd: g.primary.sd,
    min: g.primary.min, max: g.primary.max, note: g.note, run_ids: g.runs.map(r => r.id).join(";"), condition_signature: g.runs[0].signature }))));
  el("studyTrialExport").addEventListener("click", () => {
    const r = visible.find(r => r.id === selected); if (!r) return;
    download(`measurement-trials-${r.id.replace(/[^A-Za-z0-9_-]/g, "_")}.csv`, (r.kind === "validation" ? r.data.summary.trials : r.data.trials).map(t => ({ run_id: r.id, task_type: r.kind, participant_id: r.participant, session_number: r.session, head_condition: r.head, ...t })));
  });
  render();
}());
