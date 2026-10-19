(function () {
  "use strict";

  const elements = {
    csvInput: document.getElementById("csvInput"),
    analysisStatus: document.getElementById("analysisStatus"),
    resultsPanel: document.getElementById("resultsPanel"),
    closeResultsBtn: document.getElementById("closeResultsBtn"),
    resultsTitle: document.getElementById("resultsTitle"),
    toggleDetailsBtn: document.getElementById("toggleDetailsBtn"),
    detailsGrid: document.getElementById("detailsGrid"),
    resultSamples: document.getElementById("resultSamples"),
    resultDuration: document.getElementById("resultDuration"),
    resultAvgSpeed: document.getElementById("resultAvgSpeed"),
    resultDistance: document.getElementById("resultDistance"),
    resultAveragePoint: document.getElementById("resultAveragePoint"),
    resultScreen: document.getElementById("resultScreen"),
    resultPathCanvas: document.getElementById("resultPathCanvas"),
    playTimelineBtn: document.getElementById("playTimelineBtn"),
    playbackSpeedSelect: document.getElementById("playbackSpeedSelect"),
    timelineSlider: document.getElementById("timelineSlider"),
    timelineTime: document.getElementById("timelineTime"),
    timelinePoint: document.getElementById("timelinePoint"),
    timelinePhase: document.getElementById("timelinePhase"),
    phaseSummaryBody: document.getElementById("phaseSummaryBody")
  };

  const state = {
    samples: [],
    screen: null,
    currentIndex: 0,
    playing: false,
    playbackTimer: null,
    lastPlaybackTick: 0
  };

  async function handleCsvInput(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const rows = parseCsv(text);
      if (rows[0] && "run_id" in rows[0]) {
        throw new Error("これは的クリック課題または正確度検証のCSVです。「正確度・的クリック課題の分析」ページで session.json を読み込んでください。軌跡の確認はトラッカーの「課題結果・視線軌跡」から行えます。");
      }
      const samples = rows.map(normalizeCsvSample).filter((sample) => Number.isFinite(sample.x) && Number.isFinite(sample.y));
      if (!samples.length) throw new Error("有効な視線サンプルが見つかりません。");

      const summary = summarizeSamples(samples);
      renderAnalysis(file.name, samples, summary);
      setDetailsVisible(false);
      setupTimeline(samples, summary.screen);
      elements.analysisStatus.textContent = `${file.name} を読み込みました。`;
      elements.resultsPanel.classList.remove("is-hidden");
    } catch (error) {
      elements.analysisStatus.textContent = error.message || "CSVを読み込めませんでした。";
    }
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let value = "";
    let quoted = false;

    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      const next = text[i + 1];

      if (quoted) {
        if (char === '"' && next === '"') {
          value += '"';
          i += 1;
        } else if (char === '"') {
          quoted = false;
        } else {
          value += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === ",") {
        row.push(value);
        value = "";
      } else if (char === "\n") {
        row.push(value);
        rows.push(row);
        row = [];
        value = "";
      } else if (char !== "\r") {
        value += char;
      }
    }

    if (value || row.length) {
      row.push(value);
      rows.push(row);
    }

    if (rows.length < 2) return [];
    const headers = rows[0].map((header) => header.trim().replace(/^\uFEFF/, ""));
    return rows.slice(1).filter((cells) => cells.some((cell) => cell !== "")).map((cells) => {
      const record = {};
      headers.forEach((header, index) => {
        record[header] = cells[index] || "";
      });
      return record;
    });
  }

  function normalizeCsvSample(record) {
    return {
      elapsedMs: toNumber(record.elapsed_ms),
      phase: record.phase || "tracking",
      x: toNumber(record.x),
      y: toNumber(record.y),
      distance: toNumber(record.distance_px),
      speed: toNumber(record.speed_px_per_second),
      width: toNumber(record.screen_width),
      height: toNumber(record.screen_height)
    };
  }

  function summarizeSamples(samples) {
    const count = samples.length;
    const first = samples[0];
    const last = samples[count - 1];
    const durationMs = Math.max(0, last.elapsedMs - first.elapsedMs);
    const screen = getMostRecentScreen(samples);
    const speedThresholds = calculateSpeedThresholds(samples);
    const stableSamples = samples.filter((sample) => Number.isFinite(sample.speed) && sample.speed <= speedThresholds.fixation).length;
    const fixationRate = samples.length ? stableSamples / samples.length : 0;
    const saccadesPerSecond = durationMs > 0 ? (countSaccadeEvents(samples, speedThresholds.saccade) / (durationMs / 1000)) : 0;
    const coverage = calculateCoverage(samples, screen);
    const centerBias = calculateCenterBias(samples, screen);
    const entropy = calculateGridEntropy(samples, screen, 4, 4);
    const phases = summarizePhases(samples);

    return {
      count,
      durationMs,
      screen,
      fixationRate,
      saccadesPerSecond,
      coverage,
      centerBias,
      entropy,
      stableSamples,
      fixationThreshold: speedThresholds.fixation,
      phases
    };
  }

  function summarizePhases(samples) {
    const screen = getMostRecentScreen(samples);
    const thresholds = calculateSpeedThresholds(samples);
    const groups = new Map();
    samples.forEach((sample) => {
      const key = sample.phase || "unknown";
      if (!groups.has(key)) {
        groups.set(key, {
          phase: key,
          count: 0,
          samples: []
        });
      }

      const group = groups.get(key);
      group.count += 1;
      group.samples.push(sample);
    });

    return Array.from(groups.values()).map((group) => ({
      phase: group.phase,
      count: group.count,
      fixationRate: calculateRatio(group.samples, (sample) => Number.isFinite(sample.speed) && sample.speed <= thresholds.fixation),
      saccadeRate: calculateRatio(group.samples, (sample) => Number.isFinite(sample.speed) && sample.speed >= thresholds.saccade),
      coverage: calculateCoverage(group.samples, screen)
    }));
  }

  function renderAnalysis(filename, samples, summary) {
    elements.resultsTitle.textContent = filename;
    elements.resultSamples.textContent = `${formatInteger(summary.count)} / ${formatDuration(summary.durationMs)}`;
    elements.resultDuration.textContent = formatPercent(summary.fixationRate);
    elements.resultAvgSpeed.textContent = `${formatNumber(summary.saccadesPerSecond, 2)} /s`;
    elements.resultDistance.textContent = formatPercent(summary.coverage);
    elements.resultAveragePoint.textContent = formatPercent(summary.centerBias);
    elements.resultScreen.textContent = `${formatNumber(summary.entropy, 2)} / 1.00`;
    renderPhaseSummary(summary.phases);
    drawResultPath(samples, summary.screen, 0);
  }

  function renderPhaseSummary(phases) {
    elements.phaseSummaryBody.textContent = "";
    phases.forEach((phase) => {
      const row = document.createElement("tr");
      [
        phase.phase,
        formatInteger(phase.count),
        formatPercent(phase.fixationRate),
        formatPercent(phase.saccadeRate),
        formatPercent(phase.coverage)
      ].forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
      });
      elements.phaseSummaryBody.appendChild(row);
    });
  }

  function calculateSpeedThresholds(samples) {
    const speeds = samples.map((sample) => sample.speed).filter((speed) => Number.isFinite(speed) && speed > 0).sort((a, b) => a - b);
    if (!speeds.length) {
      return {
        fixation: 80,
        saccade: 900
      };
    }

    return {
      fixation: Math.max(60, percentile(speeds, 0.25)),
      saccade: Math.max(600, percentile(speeds, 0.75))
    };
  }

  function calculateCoverage(samples, screen) {
    if (!samples.length || !screen) return 0;
    const cells = new Set();
    samples.forEach((sample) => {
      const col = clamp(Math.floor((sample.x / screen.width) * 4), 0, 3);
      const row = clamp(Math.floor((sample.y / screen.height) * 4), 0, 3);
      cells.add(`${col}:${row}`);
    });
    return cells.size / 16;
  }

  function calculateCenterBias(samples, screen) {
    if (!samples.length || !screen) return 0;
    const left = screen.width * 0.25;
    const right = screen.width * 0.75;
    const top = screen.height * 0.25;
    const bottom = screen.height * 0.75;
    return calculateRatio(samples, (sample) => sample.x >= left && sample.x <= right && sample.y >= top && sample.y <= bottom);
  }

  function calculateGridEntropy(samples, screen, columns, rows) {
    if (!samples.length || !screen) return 0;
    const totalCells = columns * rows;
    const counts = Array(totalCells).fill(0);
    samples.forEach((sample) => {
      const col = clamp(Math.floor((sample.x / screen.width) * columns), 0, columns - 1);
      const row = clamp(Math.floor((sample.y / screen.height) * rows), 0, rows - 1);
      counts[row * columns + col] += 1;
    });

    const entropy = counts.reduce((sum, count) => {
      if (!count) return sum;
      const probability = count / samples.length;
      return sum - (probability * Math.log2(probability));
    }, 0);
    return entropy / Math.log2(totalCells);
  }

  function setupTimeline(samples, screen) {
    stopTimeline();
    state.samples = samples;
    state.screen = screen;
    state.currentIndex = 0;
    elements.timelineSlider.max = String(Math.max(0, samples.length - 1));
    elements.timelineSlider.value = "0";
    updateTimelineReadout(samples[0]);
    drawResultPath(samples, screen, 0);
  }

  function toggleTimelinePlayback() {
    if (!state.samples.length) return;
    if (state.playing) {
      stopTimeline();
      return;
    }

    state.playing = true;
    state.lastPlaybackTick = performance.now();
    elements.playTimelineBtn.textContent = "停止";
    state.playbackTimer = window.setInterval(advanceTimeline, 16);
  }

  function stopTimeline() {
    if (state.playbackTimer) window.clearInterval(state.playbackTimer);
    state.playbackTimer = null;
    state.playing = false;
    elements.playTimelineBtn.textContent = "再生";
  }

  function advanceTimeline() {
    if (!state.samples.length) return;

    const now = performance.now();
    const elapsed = now - state.lastPlaybackTick;
    state.lastPlaybackTick = now;
    const speed = Number(elements.playbackSpeedSelect.value) || 1;
    const current = state.samples[state.currentIndex];
    const targetElapsed = current.elapsedMs + (elapsed * speed);
    let nextIndex = state.currentIndex;

    while (nextIndex < state.samples.length - 1 && state.samples[nextIndex + 1].elapsedMs <= targetElapsed) {
      nextIndex += 1;
    }

    setTimelineIndex(nextIndex);
    if (nextIndex >= state.samples.length - 1) stopTimeline();
  }

  function setTimelineIndex(index) {
    if (!state.samples.length) return;
    state.currentIndex = clamp(index, 0, state.samples.length - 1);
    elements.timelineSlider.value = String(state.currentIndex);
    updateTimelineReadout(state.samples[state.currentIndex]);
    drawResultPath(state.samples, state.screen, state.currentIndex);
  }

  function updateTimelineReadout(sample) {
    if (!sample) {
      elements.timelineTime.textContent = "--";
      elements.timelinePoint.textContent = "--";
      elements.timelinePhase.textContent = "--";
      return;
    }

    elements.timelineTime.textContent = formatDuration(sample.elapsedMs);
    elements.timelinePoint.textContent = `x ${formatNumber(sample.x, 0)}, y ${formatNumber(sample.y, 0)}`;
    elements.timelinePhase.textContent = sample.phase || "tracking";
  }

  function drawResultPath(samples, screen, currentIndex) {
    const canvas = elements.resultPathCanvas;
    const ctx = canvas.getContext("2d");
    const rectWidth = canvas.width;
    const rectHeight = canvas.height;
    ctx.clearRect(0, 0, rectWidth, rectHeight);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, rectWidth, rectHeight);

    if (!samples.length) return;

    const sourceWidth = screen && screen.width ? screen.width : Math.max(...samples.map((sample) => sample.x));
    const sourceHeight = screen && screen.height ? screen.height : Math.max(...samples.map((sample) => sample.y));
    const padding = 20;
    const scale = Math.min((rectWidth - padding * 2) / sourceWidth, (rectHeight - padding * 2) / sourceHeight);
    const offsetX = (rectWidth - sourceWidth * scale) / 2;
    const offsetY = (rectHeight - sourceHeight * scale) / 2;

    ctx.strokeStyle = "#d8dee8";
    ctx.lineWidth = 1;
    ctx.strokeRect(offsetX, offsetY, sourceWidth * scale, sourceHeight * scale);

    ctx.beginPath();
    samples.forEach((sample, index) => {
      const x = offsetX + sample.x * scale;
      const y = offsetY + sample.y * scale;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "rgba(79, 70, 229, 0.72)";
    ctx.lineWidth = 2;
    ctx.stroke();

    drawRecentTrail(ctx, samples, currentIndex, offsetX, offsetY, scale);
    drawResultPoint(ctx, samples[0], offsetX, offsetY, scale, "#0b7a75");
    drawResultPoint(ctx, samples[samples.length - 1], offsetX, offsetY, scale, "#e11d48");
    drawCurrentPoint(ctx, samples[currentIndex], offsetX, offsetY, scale);
  }

  function drawRecentTrail(ctx, samples, currentIndex, offsetX, offsetY, scale) {
    const start = Math.max(0, currentIndex - 45);
    const recent = samples.slice(start, currentIndex + 1);
    if (recent.length < 2) return;

    ctx.beginPath();
    recent.forEach((sample, index) => {
      const x = offsetX + sample.x * scale;
      const y = offsetY + sample.y * scale;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "rgba(225, 29, 72, 0.88)";
    ctx.lineWidth = 4;
    ctx.stroke();
  }

  function drawCurrentPoint(ctx, sample, offsetX, offsetY, scale) {
    if (!sample) return;
    const x = offsetX + sample.x * scale;
    const y = offsetY + sample.y * scale;
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(225, 29, 72, 0.2)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#e11d48";
    ctx.fill();
  }

  function drawResultPoint(ctx, sample, offsetX, offsetY, scale, color) {
    ctx.beginPath();
    ctx.arc(offsetX + sample.x * scale, offsetY + sample.y * scale, 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  function closeAnalysis() {
    stopTimeline();
    elements.resultsPanel.classList.add("is-hidden");
  }

  function toggleDetails() {
    setDetailsVisible(elements.detailsGrid.classList.contains("is-hidden"));
  }

  function setDetailsVisible(visible) {
    elements.detailsGrid.classList.toggle("is-hidden", !visible);
    elements.toggleDetailsBtn.setAttribute("aria-expanded", String(visible));
    elements.toggleDetailsBtn.textContent = visible ? "詳細指標を隠す" : "詳細指標を表示";
  }

  function getMostRecentScreen(samples) {
    for (let i = samples.length - 1; i >= 0; i -= 1) {
      const sample = samples[i];
      if (Number.isFinite(sample.width) && Number.isFinite(sample.height) && sample.width > 0 && sample.height > 0) {
        return {
          width: Math.round(sample.width),
          height: Math.round(sample.height)
        };
      }
    }
    return null;
  }

  function calculateRatio(samples, predicate) {
    if (!samples.length) return 0;
    return samples.filter(predicate).length / samples.length;
  }

  function average(values) {
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function countSaccadeEvents(samples, threshold) {
    let count = 0;
    let inSaccade = false;
    samples.forEach((sample) => {
      const isSaccade = Number.isFinite(sample.speed) && sample.speed >= threshold;
      if (isSaccade && !inSaccade) count += 1;
      inSaccade = isSaccade;
    });
    return count;
  }

  function percentile(sortedValues, ratio) {
    if (!sortedValues.length) return 0;
    const index = (sortedValues.length - 1) * ratio;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sortedValues[lower];
    const weight = index - lower;
    return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
  }

  function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : NaN;
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms)) return "--";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${formatNumber(ms / 1000, 2)} s`;
  }

  function formatNumber(value, digits) {
    if (!Number.isFinite(value)) return "--";
    return value.toLocaleString("ja-JP", {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits
    });
  }

  function formatPercent(value) {
    if (!Number.isFinite(value)) return "--";
    return `${formatNumber(value * 100, 1)}%`;
  }

  function formatInteger(value) {
    if (!Number.isFinite(value)) return "--";
    return Math.round(value).toLocaleString("ja-JP");
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  elements.csvInput.addEventListener("change", handleCsvInput);
  elements.closeResultsBtn.addEventListener("click", closeAnalysis);
  elements.toggleDetailsBtn.addEventListener("click", toggleDetails);
  elements.playTimelineBtn.addEventListener("click", toggleTimelinePlayback);
  elements.timelineSlider.addEventListener("input", () => {
    stopTimeline();
    setTimelineIndex(Number(elements.timelineSlider.value));
  });
}());
