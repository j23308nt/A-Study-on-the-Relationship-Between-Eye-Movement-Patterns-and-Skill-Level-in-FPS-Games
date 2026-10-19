(function () {
  "use strict";

  const elements = {
    statusDot: document.getElementById("statusDot"),
    statusText: document.getElementById("statusText"),
    hintText: document.getElementById("hintText"),
    startBtn: document.getElementById("startBtn"),
    calibrateBtn: document.getElementById("calibrateBtn"),
    correctionBtn: document.getElementById("correctionBtn"),
    pauseBtn: document.getElementById("pauseBtn"),
    resetBtn: document.getElementById("resetBtn"),
    downloadBtn: document.getElementById("downloadBtn"),
    csvInput: document.getElementById("csvInput"),
    analysisStatus: document.getElementById("analysisStatus"),
    sampleCount: document.getElementById("sampleCount"),
    accuracyValue: document.getElementById("accuracyValue"),
    xValue: document.getElementById("xValue"),
    yValue: document.getElementById("yValue"),
    trailToggle: document.getElementById("trailToggle"),
    heatmapToggle: document.getElementById("heatmapToggle"),
    videoToggle: document.getElementById("videoToggle"),
    heatmapCanvas: document.getElementById("heatmapCanvas"),
    trailSvg: document.getElementById("trailSvg"),
    gazeDot: document.getElementById("gazeDot"),
    resultsPanel: document.getElementById("resultsPanel"),
    closeResultsBtn: document.getElementById("closeResultsBtn"),
    resultsTitle: document.getElementById("resultsTitle"),
    resultSamples: document.getElementById("resultSamples"),
    resultDuration: document.getElementById("resultDuration"),
    resultAvgSpeed: document.getElementById("resultAvgSpeed"),
    resultDistance: document.getElementById("resultDistance"),
    resultAveragePoint: document.getElementById("resultAveragePoint"),
    resultScreen: document.getElementById("resultScreen"),
    resultPathCanvas: document.getElementById("resultPathCanvas"),
    phaseSummaryBody: document.getElementById("phaseSummaryBody"),
    calibrationLayer: document.getElementById("calibrationLayer"),
    calibrationModal: document.getElementById("calibrationModal"),
    modalCalibrateBtn: document.getElementById("modalCalibrateBtn"),
    emptyState: document.getElementById("emptyState")
  };

  const state = {
    running: false,
    paused: false,
    measuring: false,
    recording: false,
    recordingStartedAt: performance.now(),
    samples: [],
    trail: [],
    measurementSamples: [],
    calibrationCounts: {},
    correctionCounts: {},
    completedCalibrationPoints: 0,
    completedCorrectionPoints: 0,
    calibrationSamples: [],
    baseCalibrationSamples: [],
    correctionSamples: [],
    autoCorrection: null,
    regression: null,
    faceMesh: null,
    preview: null,
    video: null,
    landmarkCanvas: null,
    landmarkContext: null,
    stream: null,
    frameRequest: null,
    processingFrame: false,
    latestFeatures: null,
    latestLandmarks: null,
    featureHistory: [],
    detectedFrames: 0,
    smoothedGaze: null,
    measurementTimer: null,
    validationLocked: false,
    calibrationGeneration: 0,
    correctedGeneration: null,
    calibratedViewport: null,
    calibrationStartedAt: null,
    lastVideoTime: null,
    frameSerial: 0,
    currentFrame: null
  };

  const CLICKS_PER_POINT = 5;
  const CORRECTION_SAMPLE_WEIGHT = 2;
  const AUTO_CORRECTION_SETTLE_MS = 800;
  const AUTO_CORRECTION_CAPTURE_MS = 1400;
  const MEASUREMENT_TIME_MS = 5000;
  const MIN_CALIBRATION_SAMPLES = 25;
  const FEATURE_HISTORY_SIZE = 12;
  const CALIBRATION_FRAME_WINDOW = 8;
  const SMOOTHING_MIN = 0.1;
  const SMOOTHING_MAX = 0.48;
  const SMOOTHING_DEADZONE_PX = 3.5;
  const SMOOTHING_FULL_RESPONSE_PX = 180;
  const MAX_GAZE_SPEED_PX_PER_SECOND = 2600;
  const EYE_LANDMARKS = [33, 133, 159, 145, 263, 362, 386, 374, 468, 469, 470, 471, 472, 473, 474, 475, 476, 477];
  const FACE_OVAL_LANDMARKS = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
  const LANDMARK_CONNECTIONS = [
    [33, 133],
    [159, 145],
    [362, 263],
    [386, 374],
    [468, 469],
    [469, 470],
    [470, 471],
    [471, 472],
    [472, 468],
    [473, 474],
    [474, 475],
    [475, 476],
    [476, 477],
    [477, 473]
  ];
  const calibrationPoints = [
    { id: "Pt1", x: 8, y: 10, label: "1" },
    { id: "Pt2", x: 50, y: 10, label: "2" },
    { id: "Pt3", x: 92, y: 10, label: "3" },
    { id: "Pt4", x: 8, y: 50, label: "4" },
    { id: "Pt5", x: 50, y: 50, label: "5", center: true },
    { id: "Pt6", x: 92, y: 50, label: "6" },
    { id: "Pt7", x: 8, y: 90, label: "7" },
    { id: "Pt8", x: 50, y: 90, label: "8" },
    { id: "Pt9", x: 92, y: 90, label: "9" }
  ];
  const correctionPoints = [
    { id: "Cp1", x: 15, y: 15, label: "1" },
    { id: "Cp2", x: 85, y: 15, label: "2" },
    { id: "Cp3", x: 50, y: 50, label: "3" },
    { id: "Cp4", x: 15, y: 85, label: "4" },
    { id: "Cp5", x: 85, y: 85, label: "5" }
  ];

  const heatmap = elements.heatmapCanvas.getContext("2d", { alpha: true });

  function isAllowedOrigin() {
    return window.location.protocol === "https:" || window.location.hostname === "localhost";
  }

  function setStatus(kind, text, hint) {
    elements.statusDot.classList.toggle("is-active", kind === "active");
    elements.statusDot.classList.toggle("is-error", kind === "error");
    elements.statusText.textContent = text;
    elements.hintText.textContent = hint;
    window.dispatchEvent(new Event("tracker-state"));
  }

  function resizeCanvas() {
    const ratio = window.devicePixelRatio || 1;
    const rect = elements.heatmapCanvas.getBoundingClientRect();
    elements.heatmapCanvas.width = Math.round(rect.width * ratio);
    elements.heatmapCanvas.height = Math.round(rect.height * ratio);
    heatmap.setTransform(ratio, 0, 0, ratio, 0, 0);
    redrawHeatmap();
    redrawTrail();
  }

  async function startMediaPipeTracker() {
    if (!window.FaceMesh) {
      setStatus("error", "読み込み失敗", "MediaPipe Face Meshを読み込めません。ネットワーク接続、またはCDNの読み込みを確認してください。");
      return;
    }

    if (!isAllowedOrigin()) {
      setStatus("error", "localhostで開いてください", "カメラを使うため、http://localhost:8000/ またはHTTPSで開いてください。");
      return;
    }

    setStatus("active", "起動中", "ブラウザのカメラ許可を承認してください。");

    try {
      createCameraPreview();

      state.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
      state.video.srcObject = state.stream;
      await waitForVideoReady(state.video);
      await state.video.play();

      state.faceMesh = new FaceMesh({
        locateFile: (file) => `mediapipe/face_mesh/${file}`
      });
      state.faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.6
      });
      state.faceMesh.onResults(handleFaceMeshResults);
      if (typeof state.faceMesh.initialize === "function") {
        await state.faceMesh.initialize();
      }

      state.running = true;
      state.lastVideoTime = null;
      state.paused = false;
      elements.startBtn.disabled = true;
      elements.calibrateBtn.disabled = false;
      elements.correctionBtn.disabled = true;
      elements.pauseBtn.disabled = false;
      elements.resetBtn.disabled = false;
      elements.downloadBtn.disabled = false;
      elements.emptyState.classList.add("is-hidden");
      elements.gazeDot.classList.add("is-visible");
      setCameraPreview(elements.videoToggle.checked);
      setStatus("active", "顔検出中", "顔を画面中央に向けて、虹彩が検出されたらキャリブレーションしてください。");
      processVideoFrame();
    } catch (error) {
      stopCamera();
      setStatus("error", "起動できません", error.message || "カメラ権限と http://localhost:8000/ のURLを確認してください。");
    }
  }

  function waitForVideoReady(video) {
    if (video.videoWidth && video.videoHeight) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error("カメラ映像の初期化がタイムアウトしました。"));
      }, 8000);
      const onLoadedMetadata = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        window.clearTimeout(timeoutId);
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
      };

      video.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
    });
  }

  function scheduleVideoFrame() {
    if (!state.running || !state.video) return;
    state.frameRequest = typeof state.video.requestVideoFrameCallback === "function"
      ? state.video.requestVideoFrameCallback(processVideoFrame)
      : window.requestAnimationFrame(processVideoFrame);
  }

  async function processVideoFrame(_time, videoMetadata) {
    if (!state.running || !state.faceMesh || !state.video) return;
    if (typeof state.video.requestVideoFrameCallback === "function" && !videoMetadata) {
      scheduleVideoFrame();
      return;
    }
    const videoTime = videoMetadata?.mediaTime ?? state.video.currentTime;
    if (!state.paused && !state.processingFrame && state.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        Number.isFinite(videoTime) && videoTime !== state.lastVideoTime) {
      state.lastVideoTime = videoTime;
      state.processingFrame = true;
      state.currentFrame = { frame_id: ++state.frameSerial, video_time_s: videoTime,
        video_frame_number: videoMetadata?.presentedFrames ?? null,
        video_expected_display_ms: videoMetadata?.expectedDisplayTime ?? null,
        frame_source: videoMetadata ? "requestVideoFrameCallback" : "currentTime_fallback",
        processing_start_ms: performance.now(), emitted: false };
      try {
        await state.faceMesh.send({ image: state.video });
      } catch (error) {
        publishValidationFrame({ valid: false, failure_reason: "processing_error" });
        setStatus("error", "推定エラー", error.message || "Face Meshの処理に失敗しました。");
      } finally {
        publishValidationFrame({ valid: false, failure_reason: "no_result" });
        state.processingFrame = false;
        state.currentFrame = null;
      }
    }

    scheduleVideoFrame();
  }

  function handleFaceMeshResults(results) {
    const landmarks = results.multiFaceLandmarks && results.multiFaceLandmarks[0];
    if (!landmarks || state.paused) {
      publishValidationFrame({ valid: false, face_detected: Boolean(landmarks),
        failure_reason: state.paused ? "paused" : "no_face" });
      clearLandmarkOverlay();
      if (state.running && !state.paused && !isCalibrationVisible()) {
        setStatus("active", "顔を探しています", "顔全体と両目がカメラに入るようにしてください。");
      }
      return;
    }

    const features = extractEyeFeatures(landmarks);
    if (!features) {
      publishValidationFrame({ valid: false, face_detected: true, failure_reason: "no_eye_features" });
      if (!isCalibrationVisible()) {
        setStatus("active", "虹彩を探しています", "目元が明るく見えるようにして、正面に近い姿勢を保ってください。");
      }
      return;
    }

    state.latestLandmarks = landmarks;
    state.latestFeatures = features;
    rememberFeatureFrame(features);
    drawLandmarkOverlay(landmarks);
    state.detectedFrames += 1;
    updateAutoCorrection(features);

    if (!state.regression) {
      publishValidationFrame({ valid: false, face_detected: true, features_detected: true, failure_reason: "no_calibration" });
      if (!isCalibrationVisible()) {
        setStatus("active", "顔検出OK", `Face Mesh検出: ${state.detectedFrames}フレーム。キャリブレーションを開始してください。`);
      }
      return;
    }

    const raw = predictGaze(features);
    if (!raw || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) {
      publishValidationFrame({ valid: false, face_detected: true, features_detected: true, failure_reason: "nonfinite_prediction" });
      return;
    }

    const timestamp = performance.now();
    const x = clamp(raw.x, 0, window.innerWidth);
    const y = clamp(raw.y, 0, window.innerHeight);
    const smoothed = smoothGaze(x, y, timestamp);
    addSample(smoothed.x, smoothed.y, timestamp, features);
    publishValidationFrame({ valid: true, face_detected: true, features_detected: true,
      raw_x: raw.x, raw_y: raw.y, x: Math.round(smoothed.x), y: Math.round(smoothed.y) });
  }

  function publishValidationFrame(values) {
    const frame = state.currentFrame;
    if (!frame || frame.emitted) return;
    frame.emitted = true;
    const { emitted, ...timing } = frame;
    window.dispatchEvent(new CustomEvent("gaze-frame", { detail: {
      ...timing, processing_end_ms: performance.now(), raw_x: null, raw_y: null, x: null, y: null,
      face_detected: false, features_detected: false, ...values
    } }));
  }

  function createCameraPreview() {
    state.preview = document.createElement("div");
    state.preview.className = "camera-preview";

    state.video = document.createElement("video");
    state.video.className = "camera-video";
    state.video.autoplay = true;
    state.video.muted = true;
    state.video.playsInline = true;

    state.landmarkCanvas = document.createElement("canvas");
    state.landmarkCanvas.className = "camera-landmarks";
    state.landmarkContext = state.landmarkCanvas.getContext("2d");

    state.preview.appendChild(state.video);
    state.preview.appendChild(state.landmarkCanvas);
    document.body.appendChild(state.preview);
  }

  function rememberFeatureFrame(features) {
    state.featureHistory.push({
      features: features.slice(),
      timestamp: performance.now()
    });
    if (state.featureHistory.length > FEATURE_HISTORY_SIZE) state.featureHistory.shift();
  }

  function drawLandmarkOverlay(landmarks) {
    if (!state.landmarkCanvas || !state.landmarkContext || !state.video) return;

    const rect = state.landmarkCanvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));

    if (state.landmarkCanvas.width !== width || state.landmarkCanvas.height !== height) {
      state.landmarkCanvas.width = width;
      state.landmarkCanvas.height = height;
    }

    const ctx = state.landmarkContext;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = "rgba(11, 122, 117, 0.86)";
    ctx.fillStyle = "rgba(225, 29, 72, 0.92)";

    drawConnections(ctx, landmarks, LANDMARK_CONNECTIONS, rect.width, rect.height);
    drawPolyline(ctx, landmarks, FACE_OVAL_LANDMARKS, rect.width, rect.height);
    drawPoints(ctx, landmarks, EYE_LANDMARKS, rect.width, rect.height, 2.2);
    drawPoints(ctx, landmarks, [468, 473], rect.width, rect.height, 4);
  }

  function clearLandmarkOverlay() {
    if (!state.landmarkCanvas || !state.landmarkContext) return;
    state.landmarkContext.clearRect(0, 0, state.landmarkCanvas.width, state.landmarkCanvas.height);
  }

  function drawConnections(ctx, landmarks, connections, width, height) {
    ctx.beginPath();
    connections.forEach(([from, to]) => {
      if (!landmarks[from] || !landmarks[to]) return;
      ctx.moveTo(landmarks[from].x * width, landmarks[from].y * height);
      ctx.lineTo(landmarks[to].x * width, landmarks[to].y * height);
    });
    ctx.stroke();
  }

  function drawPolyline(ctx, landmarks, indices, width, height) {
    ctx.beginPath();
    indices.forEach((index, order) => {
      if (!landmarks[index]) return;
      const x = landmarks[index].x * width;
      const y = landmarks[index].y * height;
      if (order === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
  }

  function drawPoints(ctx, landmarks, indices, width, height, radius) {
    indices.forEach((index) => {
      if (!landmarks[index]) return;
      ctx.beginPath();
      ctx.arc(landmarks[index].x * width, landmarks[index].y * height, radius, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function extractEyeFeatures(landmarks) {
    const required = [33, 133, 159, 145, 263, 362, 386, 374, 1, 10, 152, 468, 469, 470, 471, 472, 473, 474, 475, 476, 477];
    if (required.some((index) => !landmarks[index])) return null;

    const leftIris = centerOf(landmarks, [468, 469, 470, 471, 472]);
    const rightIris = centerOf(landmarks, [473, 474, 475, 476, 477]);
    const leftEye = eyeMetrics(landmarks, leftIris, 33, 133, 159, 145);
    const rightEye = eyeMetrics(landmarks, rightIris, 362, 263, 386, 374);
    const faceCenterX = (landmarks[10].x + landmarks[152].x) / 2;
    const faceCenterY = (landmarks[10].y + landmarks[152].y) / 2;
    const faceScale = distance2d(landmarks[10], landmarks[152]);
    const yaw = landmarks[1].x - faceCenterX;
    const pitch = landmarks[1].y - faceCenterY;

    return [
      1,
      leftEye.x,
      leftEye.y,
      rightEye.x,
      rightEye.y,
      (leftEye.x + rightEye.x) / 2,
      (leftEye.y + rightEye.y) / 2,
      faceCenterX,
      faceCenterY,
      faceScale,
      yaw,
      pitch
    ];
  }

  function centerOf(landmarks, indices) {
    const sum = indices.reduce((acc, index) => {
      acc.x += landmarks[index].x;
      acc.y += landmarks[index].y;
      return acc;
    }, { x: 0, y: 0 });
    return {
      x: sum.x / indices.length,
      y: sum.y / indices.length
    };
  }

  function eyeMetrics(landmarks, iris, outerIndex, innerIndex, upperIndex, lowerIndex) {
    const outer = landmarks[outerIndex];
    const inner = landmarks[innerIndex];
    const upper = landmarks[upperIndex];
    const lower = landmarks[lowerIndex];
    const centerX = (outer.x + inner.x) / 2;
    const centerY = (upper.y + lower.y) / 2;
    const width = Math.max(0.0001, distance2d(outer, inner));
    const height = Math.max(0.0001, distance2d(upper, lower));
    return {
      x: (iris.x - centerX) / width,
      y: (iris.y - centerY) / height
    };
  }

  function predictGaze(features) {
    if (!state.regression) return null;
    return {
      x: dot(features, state.regression.x),
      y: dot(features, state.regression.y)
    };
  }

  function smoothGaze(x, y, timestamp) {
    if (!state.smoothedGaze) {
      state.smoothedGaze = {
        x,
        y,
        lastTimestamp: timestamp
      };
      return state.smoothedGaze;
    }

    const elapsedSeconds = Math.max(0.001, (timestamp - state.smoothedGaze.lastTimestamp) / 1000);
    let targetX = x;
    let targetY = y;
    const deltaX = targetX - state.smoothedGaze.x;
    const deltaY = targetY - state.smoothedGaze.y;
    const distance = Math.sqrt((deltaX * deltaX) + (deltaY * deltaY));

    if (distance < SMOOTHING_DEADZONE_PX) {
      state.smoothedGaze.lastTimestamp = timestamp;
      return state.smoothedGaze;
    }

    const maxStep = MAX_GAZE_SPEED_PX_PER_SECOND * elapsedSeconds;
    if (distance > maxStep) {
      const scale = maxStep / distance;
      targetX = state.smoothedGaze.x + (deltaX * scale);
      targetY = state.smoothedGaze.y + (deltaY * scale);
    }

    const limitedDeltaX = targetX - state.smoothedGaze.x;
    const limitedDeltaY = targetY - state.smoothedGaze.y;
    const limitedDistance = Math.sqrt((limitedDeltaX * limitedDeltaX) + (limitedDeltaY * limitedDeltaY));
    const smoothing = clamp(
      SMOOTHING_MIN + ((limitedDistance / SMOOTHING_FULL_RESPONSE_PX) * (SMOOTHING_MAX - SMOOTHING_MIN)),
      SMOOTHING_MIN,
      SMOOTHING_MAX
    );

    state.smoothedGaze = {
      x: state.smoothedGaze.x + (limitedDeltaX * smoothing),
      y: state.smoothedGaze.y + (limitedDeltaY * smoothing),
      lastTimestamp: timestamp
    };
    return state.smoothedGaze;
  }

  function addSample(x, y, timestamp, features) {
    const roundedX = Math.round(x);
    const roundedY = Math.round(y);
    const width = window.innerWidth;
    const height = window.innerHeight;
    const gazeSample = {
      x: roundedX,
      y: roundedY,
      width,
      height
    };

    if (state.recording) {
      const previous = state.samples[state.samples.length - 1];
      const elapsedMs = Math.round(performance.now() - state.recordingStartedAt);
      const deltaTimeMs = previous ? elapsedMs - previous.elapsedMs : 0;
      const deltaX = previous ? roundedX - previous.x : 0;
      const deltaY = previous ? roundedY - previous.y : 0;
      const distance = Math.sqrt((deltaX * deltaX) + (deltaY * deltaY));
      const sample = {
        index: state.samples.length + 1,
        timestamp: Math.round(timestamp),
        capturedAt: new Date().toISOString(),
        elapsedMs,
        phase: getRecordingPhase(),
        x: roundedX,
        y: roundedY,
        deltaTimeMs,
        deltaX,
        deltaY,
        distance: roundNumber(distance, 3),
        speedPxPerSecond: deltaTimeMs > 0 ? roundNumber(distance / (deltaTimeMs / 1000), 3) : 0,
        width,
        height,
        confidence: features ? 1 : 0
      };

      state.samples.push(sample);
      elements.sampleCount.textContent = String(state.samples.length);
    }

    state.trail.push(gazeSample);
    if (state.trail.length > 36) state.trail.shift();
    if (state.measuring) state.measurementSamples.push(gazeSample);

    elements.xValue.textContent = String(gazeSample.x);
    elements.yValue.textContent = String(gazeSample.y);
    updateGazeDot(gazeSample.x, gazeSample.y);

    if (elements.heatmapToggle.checked && !state.measuring) drawHeatPoint(gazeSample.x, gazeSample.y);
    if (elements.trailToggle.checked) redrawTrail();
  }

  function getRecordingPhase() {
    if (state.measuring) return "accuracy_measurement";
    if (isCalibrationVisible()) return "calibration";
    return "tracking";
  }

  function isCalibrationVisible() {
    return !elements.calibrationLayer.classList.contains("is-hidden");
  }

  function roundNumber(value, digits) {
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
  }

  function updateGazeDot(x, y) {
    elements.gazeDot.style.left = `${x}px`;
    elements.gazeDot.style.top = `${y}px`;
  }

  function setCameraPreview(visible) {
    if (!state.preview) return;
    state.preview.classList.toggle("is-visible", visible);
  }

  function drawHeatPoint(x, y) {
    const gradient = heatmap.createRadialGradient(x, y, 0, x, y, 72);
    gradient.addColorStop(0, "rgba(225, 29, 72, 0.22)");
    gradient.addColorStop(0.4, "rgba(245, 158, 11, 0.13)");
    gradient.addColorStop(1, "rgba(245, 158, 11, 0)");
    heatmap.fillStyle = gradient;
    heatmap.fillRect(x - 72, y - 72, 144, 144);
  }

  function redrawHeatmap() {
    heatmap.clearRect(0, 0, elements.heatmapCanvas.width, elements.heatmapCanvas.height);
    if (!elements.heatmapToggle.checked) return;
    state.samples.slice(-600).forEach((sample) => drawHeatPoint(sample.x, sample.y));
  }

  function redrawTrail() {
    elements.trailSvg.textContent = "";
    if (!elements.trailToggle.checked || state.trail.length < 2) return;

    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("points", state.trail.map((point) => `${point.x},${point.y}`).join(" "));
    elements.trailSvg.appendChild(line);
  }

  function showCalibrationInstructions() {
    if (state.validationLocked) return;
    elements.calibrationModal.classList.remove("is-hidden");
  }

  function beginCalibration() {
    if (state.validationLocked) return;
    state.calibrationGeneration += 1;
    state.correctedGeneration = null;
    state.calibrationStartedAt = new Date().toISOString();
    state.calibratedViewport = { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
    clearMeasurementTimer();
    state.calibrationCounts = {};
    state.correctionCounts = {};
    state.completedCalibrationPoints = 0;
    state.completedCorrectionPoints = 0;
    state.calibrationSamples = [];
    state.baseCalibrationSamples = [];
    state.correctionSamples = [];
    state.autoCorrection = null;
    state.featureHistory = [];
    state.regression = null;
    state.smoothedGaze = null;
    state.measurementSamples = [];
    elements.accuracyValue.textContent = "--";
    elements.correctionBtn.disabled = true;
    elements.calibrationModal.classList.add("is-hidden");
    renderCalibrationTargets(false);
    elements.calibrationLayer.classList.remove("is-hidden");
    setStatus("active", "キャリブレーション中", "各点を見ながら5回クリックしてください。クリック時の虹彩位置を記録します。");
  }

  function beginCorrectionCalibration() {
    if (state.validationLocked) return;
    if (!state.regression || !state.baseCalibrationSamples.length) {
      setStatus("error", "9点キャリブレーション未完了", "先に通常の9点キャリブレーションを完了してください。");
      return;
    }

    clearMeasurementTimer();
    state.correctionCounts = {};
    state.completedCorrectionPoints = 0;
    state.correctionSamples = [];
    state.autoCorrection = {
      index: 0,
      pointStartedAt: performance.now(),
      capturedForPoint: 0
    };
    state.featureHistory = [];
    state.smoothedGaze = null;
    elements.accuracyValue.textContent = "--";
    elements.calibrationModal.classList.add("is-hidden");
    renderAutoCorrectionTarget();
    elements.calibrationLayer.classList.remove("is-hidden");
    setStatus("active", "5点自動補正中", "表示された点を見つめてください。点は1つずつ自動で切り替わります。");
  }

  function renderCalibrationTargets(measuringCenter) {
    elements.calibrationLayer.textContent = "";

    calibrationPoints.forEach((point) => {
      if (point.center && state.completedCalibrationPoints < 8 && !measuringCenter) return;

      const count = state.calibrationCounts[point.id] || 0;
      const target = document.createElement("button");
      target.type = "button";
      target.id = point.id;
      target.className = "calibration-target";
      target.style.left = `${point.x}%`;
      target.style.top = `${point.y}%`;
      target.style.opacity = String(Math.min(1, 0.2 + count * 0.16));
      target.textContent = measuringCenter ? "" : String(Math.min(count + 1, CLICKS_PER_POINT));

      if (count >= CLICKS_PER_POINT) {
        target.classList.add("is-complete");
        target.textContent = point.label;
        target.disabled = true;
      } else {
        target.addEventListener("click", () => captureCalibrationPoint(point));
      }

      if (measuringCenter && point.center) {
        target.classList.add("is-measuring");
        target.textContent = "";
        target.disabled = true;
      }

      elements.calibrationLayer.appendChild(target);
    });
  }

  function renderCorrectionTargets(measuringCenter) {
    elements.calibrationLayer.textContent = "";

    correctionPoints.forEach((point) => {
      const count = state.correctionCounts[point.id] || 0;
      const target = document.createElement("button");
      target.type = "button";
      target.id = point.id;
      target.className = "calibration-target correction-target";
      target.style.left = `${point.x}%`;
      target.style.top = `${point.y}%`;
      target.style.opacity = String(Math.min(1, 0.25 + count * 0.22));
      target.textContent = measuringCenter ? "" : point.label;

      if (count > 0) {
        target.classList.add("is-complete");
        target.textContent = point.label;
        target.disabled = true;
      } else {
        target.disabled = true;
      }

      if (measuringCenter && point.id === "Cp3") {
        target.classList.add("is-measuring");
        target.textContent = "";
        target.disabled = true;
      }

      elements.calibrationLayer.appendChild(target);
    });
  }

  function renderAutoCorrectionTarget() {
    elements.calibrationLayer.textContent = "";
    if (!state.autoCorrection) return;

    const point = correctionPoints[state.autoCorrection.index];
    if (!point) return;

    const target = document.createElement("div");
    target.id = point.id;
    target.className = "calibration-target correction-target auto-correction-target";
    target.style.left = `${point.x}%`;
    target.style.top = `${point.y}%`;
    target.textContent = point.label;
    elements.calibrationLayer.appendChild(target);
  }

  function captureCalibrationPoint(point) {
    const stableFeatures = getStableCalibrationFeatures();
    if (!stableFeatures) {
      setStatus("error", "顔検出待ち", "顔と両目が検出されてから、もう一度クリックしてください。");
      return;
    }

    const x = window.innerWidth * (point.x / 100);
    const y = window.innerHeight * (point.y / 100);
    state.calibrationSamples.push({
      features: stableFeatures,
      x,
      y
    });

    const nextCount = (state.calibrationCounts[point.id] || 0) + 1;
    state.calibrationCounts[point.id] = nextCount;

    if (nextCount === CLICKS_PER_POINT) {
      state.completedCalibrationPoints += 1;
    }

    if (state.completedCalibrationPoints >= calibrationPoints.length) {
      state.baseCalibrationSamples = state.calibrationSamples.map(copyCalibrationSample);
      fitCalibrationModel();
      elements.correctionBtn.disabled = false;
      startAccuracyMeasurement();
      return;
    }

    renderCalibrationTargets(false);
    setStatus("active", "キャリブレーション中", `${point.label}番のサンプルを記録しました。顔を動かしすぎず、次の点を見てクリックしてください。`);
  }

  function updateAutoCorrection(features) {
    if (state.validationLocked) return;
    if (!state.autoCorrection || state.measuring || state.paused) return;

    const point = correctionPoints[state.autoCorrection.index];
    if (!point) return;

    const now = performance.now();
    const elapsed = now - state.autoCorrection.pointStartedAt;
    const captureEnd = AUTO_CORRECTION_SETTLE_MS + AUTO_CORRECTION_CAPTURE_MS;

    if (elapsed < AUTO_CORRECTION_SETTLE_MS) {
      const remaining = Math.max(1, Math.ceil((AUTO_CORRECTION_SETTLE_MS - elapsed) / 1000));
      setStatus("active", "5点自動補正中", `${point.label}番の点を見つめてください。${remaining}秒後に記録します。`);
      return;
    }

    if (elapsed <= captureEnd) {
      const x = window.innerWidth * (point.x / 100);
      const y = window.innerHeight * (point.y / 100);
      state.correctionSamples.push({
        features: features.slice(),
        x,
        y
      });
      state.autoCorrection.capturedForPoint += 1;
      setStatus("active", "5点自動補正中", `${point.label}番を記録中です。視線を点に合わせたままにしてください。`);
      return;
    }

    finishAutoCorrectionPoint(point);
  }

  function finishAutoCorrectionPoint(point) {
    state.completedCorrectionPoints += 1;
    state.correctionCounts[point.id] = state.autoCorrection.capturedForPoint;
    state.autoCorrection.index += 1;
    state.autoCorrection.pointStartedAt = performance.now();
    state.autoCorrection.capturedForPoint = 0;

    if (state.completedCorrectionPoints >= correctionPoints.length) {
      state.autoCorrection = null;
      applyCorrectionCalibration();
      startCorrectionAccuracyMeasurement();
      return;
    }

    renderAutoCorrectionTarget();
    const nextPoint = correctionPoints[state.autoCorrection.index];
    setStatus("active", "5点自動補正中", `${nextPoint.label}番の点を見つめてください。`);
  }

  function applyCorrectionCalibration() {
    const weightedCorrection = [];
    state.correctionSamples.forEach((sample) => {
      for (let i = 0; i < CORRECTION_SAMPLE_WEIGHT; i += 1) {
        weightedCorrection.push(copyCalibrationSample(sample));
      }
    });
    state.calibrationSamples = [
      ...state.baseCalibrationSamples.map(copyCalibrationSample),
      ...weightedCorrection
    ];
    fitCalibrationModel();
    state.smoothedGaze = null;
    state.correctedGeneration = state.calibrationGeneration;
  }

  function copyCalibrationSample(sample) {
    return {
      features: sample.features.slice(),
      x: sample.x,
      y: sample.y
    };
  }

  function getStableCalibrationFeatures() {
    const recent = state.featureHistory.slice(-CALIBRATION_FRAME_WINDOW);
    if (recent.length < Math.min(4, CALIBRATION_FRAME_WINDOW)) return state.latestFeatures ? state.latestFeatures.slice() : null;

    const mean = averageFeatureRows(recent.map((frame) => frame.features));
    const ranked = recent
      .map((frame) => ({
        features: frame.features,
        distance: featureDistance(frame.features, mean)
      }))
      .sort((a, b) => a.distance - b.distance);
    const keepCount = Math.max(3, Math.ceil(ranked.length * 0.75));
    return averageFeatureRows(ranked.slice(0, keepCount).map((frame) => frame.features));
  }

  function averageFeatureRows(rows) {
    const total = Array(rows[0].length).fill(0);
    rows.forEach((row) => {
      row.forEach((value, index) => {
        total[index] += value;
      });
    });
    return total.map((value) => value / rows.length);
  }

  function featureDistance(a, b) {
    const sum = a.reduce((acc, value, index) => {
      const diff = value - b[index];
      return acc + (diff * diff);
    }, 0);
    return Math.sqrt(sum);
  }

  function fitCalibrationModel() {
    if (state.calibrationSamples.length < MIN_CALIBRATION_SAMPLES) {
      state.regression = null;
      setStatus("error", "データ不足", "キャリブレーションサンプルが不足しています。もう一度実行してください。");
      return;
    }

    const matrix = state.calibrationSamples.map((sample) => sample.features);
    state.regression = {
      x: ridgeRegression(matrix, state.calibrationSamples.map((sample) => sample.x), 0.001),
      y: ridgeRegression(matrix, state.calibrationSamples.map((sample) => sample.y), 0.001)
    };
    state.smoothedGaze = null;
  }

  function ridgeRegression(matrix, targets, lambda) {
    const columns = matrix[0].length;
    const normal = Array.from({ length: columns }, () => Array(columns).fill(0));
    const rhs = Array(columns).fill(0);

    matrix.forEach((row, rowIndex) => {
      for (let i = 0; i < columns; i += 1) {
        rhs[i] += row[i] * targets[rowIndex];
        for (let j = 0; j < columns; j += 1) {
          normal[i][j] += row[i] * row[j];
        }
      }
    });

    for (let i = 1; i < columns; i += 1) {
      normal[i][i] += lambda;
    }

    return solveLinearSystem(normal, rhs);
  }

  function solveLinearSystem(matrix, vector) {
    const size = vector.length;
    const augmented = matrix.map((row, index) => [...row, vector[index]]);

    for (let pivot = 0; pivot < size; pivot += 1) {
      let bestRow = pivot;
      for (let row = pivot + 1; row < size; row += 1) {
        if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[bestRow][pivot])) bestRow = row;
      }
      [augmented[pivot], augmented[bestRow]] = [augmented[bestRow], augmented[pivot]];

      const pivotValue = augmented[pivot][pivot] || 1e-12;
      for (let col = pivot; col <= size; col += 1) {
        augmented[pivot][col] /= pivotValue;
      }

      for (let row = 0; row < size; row += 1) {
        if (row === pivot) continue;
        const factor = augmented[row][pivot];
        for (let col = pivot; col <= size; col += 1) {
          augmented[row][col] -= factor * augmented[pivot][col];
        }
      }
    }

    return augmented.map((row) => row[size]);
  }

  function startAccuracyMeasurement() {
    if (!state.regression) return;

    state.measuring = true;
    state.measurementSamples = [];
    renderCalibrationTargets(true);
    setStatus("active", "精度測定中", "マウスを動かさず、中央の点を5秒間見続けてください。");

    state.measurementTimer = window.setTimeout(() => {
      state.measuring = false;
      elements.calibrationLayer.classList.add("is-hidden");
      const precision = calculatePrecision(state.measurementSamples.slice(-50));
      elements.accuracyValue.textContent = `${precision}%`;
      setStatus("active", "キャリブレーション完了", `中央スコア（参考）は ${precision}% です。視角での正確度は「視角で正確度を検証」から測定してください。`);
    }, MEASUREMENT_TIME_MS);
  }

  function startCorrectionAccuracyMeasurement() {
    if (!state.regression) return;

    state.measuring = true;
    state.measurementSamples = [];
    renderCorrectionTargets(true);
    setStatus("active", "補正精度測定中", "マウスを動かさず、中央の点を5秒間見続けてください。");

    state.measurementTimer = window.setTimeout(() => {
      state.measuring = false;
      elements.calibrationLayer.classList.add("is-hidden");
      const precision = calculatePrecision(state.measurementSamples.slice(-50));
      elements.accuracyValue.textContent = `${precision}%`;
      setStatus("active", "5点補正完了", `中央スコア（参考）は ${precision}% です。準備済みなら「検証を開始」を押してください。`);
    }, MEASUREMENT_TIME_MS);
  }

  function calculatePrecision(samples) {
    if (!samples.length) return 0;

    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const halfWindowHeight = window.innerHeight / 2;
    const percentages = samples.map((sample) => {
      const xDiff = centerX - sample.x;
      const yDiff = centerY - sample.y;
      const distance = Math.sqrt((xDiff * xDiff) + (yDiff * yDiff));
      if (distance <= halfWindowHeight && distance > -1) {
        return 100 - ((distance / halfWindowHeight) * 100);
      }
      if (distance > halfWindowHeight) return 0;
      return 100;
    });

    const average = percentages.reduce((sum, value) => sum + value, 0) / percentages.length;
    return Math.max(0, Math.min(100, Math.round(average)));
  }

  function clearMeasurementTimer() {
    if (state.measurementTimer) {
      window.clearTimeout(state.measurementTimer);
      state.measurementTimer = null;
    }
  }

  function togglePause() {
    if (state.validationLocked) return;
    state.paused = !state.paused;
    elements.pauseBtn.textContent = state.paused ? "再開" : "一時停止";
    setStatus(
      state.paused ? "idle" : "active",
      state.paused ? "一時停止中" : "トラッキング中",
      state.paused ? "再開すると記録を続けます。" : "視線データを記録しています。"
    );
  }

  function resetSession() {
    if (state.validationLocked) return;
    state.correctedGeneration = null;
    state.calibratedViewport = null;
    clearMeasurementTimer();
    state.recordingStartedAt = performance.now();
    state.recording = false;
    state.samples = [];
    state.trail = [];
    state.measurementSamples = [];
    state.calibrationCounts = {};
    state.correctionCounts = {};
    state.completedCalibrationPoints = 0;
    state.completedCorrectionPoints = 0;
    state.calibrationSamples = [];
    state.baseCalibrationSamples = [];
    state.correctionSamples = [];
    state.autoCorrection = null;
    state.featureHistory = [];
    state.regression = null;
    state.smoothedGaze = null;
    state.measuring = false;
    elements.sampleCount.textContent = "0";
    elements.accuracyValue.textContent = "--";
    elements.xValue.textContent = "--";
    elements.yValue.textContent = "--";
    elements.downloadBtn.disabled = !state.running;
    elements.downloadBtn.textContent = "計測開始";
    elements.correctionBtn.disabled = true;
    elements.calibrationLayer.classList.add("is-hidden");
    elements.calibrationModal.classList.add("is-hidden");
    elements.trailSvg.textContent = "";
    heatmap.clearRect(0, 0, elements.heatmapCanvas.width, elements.heatmapCanvas.height);
    setStatus(state.running ? "active" : "idle", state.running ? "リセット完了" : "待機中", "新しいキャリブレーションと記録を開始できます。");
  }

  function buildCsv() {
    const headers = [
      "index",
      "captured_at",
      "elapsed_ms",
      "mediapipe_timestamp",
      "phase",
      "x",
      "y",
      "delta_time_ms",
      "delta_x",
      "delta_y",
      "distance_px",
      "speed_px_per_second",
      "screen_width",
      "screen_height",
      "face_detected"
    ];
    const rows = state.samples.map((sample) => csvRow([
      sample.index,
      sample.capturedAt,
      sample.elapsedMs,
      sample.timestamp,
      sample.phase,
      sample.x,
      sample.y,
      sample.deltaTimeMs,
      sample.deltaX,
      sample.deltaY,
      sample.distance,
      sample.speedPxPerSecond,
      sample.width,
      sample.height,
      sample.confidence
    ]));
    return [headers.join(","), ...rows].join("\n");
  }

  function createCsvFilename() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `eye-tracking-${stamp}.csv`;
  }

  async function saveCsvToFolder() {
    if (!state.samples.length) {
      setStatus("error", "保存データなし", "計測開始後に視線データが入ってから停止してください。");
      return;
    }

    const filename = createCsvFilename();
    const csv = buildCsv();

    try {
      const response = await fetch("/save-csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, csv })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "CSVを保存できませんでした。");
      setStatus("active", "CSV保存完了", `${result.path} に保存しました。`);
    } catch (error) {
      fallbackDownloadCsv(filename, csv);
      setStatus("error", "自動保存失敗", `${error.message || "サーバー保存に失敗しました。"} ダウンロードとして保存しました。`);
    }
  }

  function fallbackDownloadCsv(filename, csv) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function toggleRecording() {
    if (state.validationLocked) return;
    if (!state.regression) {
      setStatus("error", "キャリブレーション未完了", "計測前に9点キャリブレーションを完了してください。");
      return;
    }

    if (!state.recording) {
      state.samples = [];
      state.recordingStartedAt = performance.now();
      state.recording = true;
      elements.sampleCount.textContent = "0";
      elements.downloadBtn.textContent = "計測停止・保存";
      setStatus("active", "計測中", "もう一度ボタンを押すと計測を停止し、CSVを自動保存します。");
      return;
    }

    state.recording = false;
    elements.downloadBtn.disabled = true;
    elements.downloadBtn.textContent = "保存中";
    await saveCsvToFolder();
    elements.downloadBtn.disabled = false;
    elements.downloadBtn.textContent = "計測開始";
  }

  async function handleCsvInput(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const rows = parseCsv(text);
      const samples = rows.map(normalizeCsvSample).filter((sample) => Number.isFinite(sample.x) && Number.isFinite(sample.y));
      if (!samples.length) throw new Error("有効な視線サンプルが見つかりません。");

      const summary = summarizeSamples(samples);
      renderAnalysis(file.name, samples, summary);
      elements.analysisStatus.textContent = `${file.name} を読み込みました。`;
      elements.resultsPanel.classList.remove("is-hidden");
      elements.emptyState.classList.add("is-hidden");
      setStatus("active", "CSV分析完了", `${summary.count}件のサンプルを読み込みました。`);
    } catch (error) {
      elements.analysisStatus.textContent = error.message || "CSVを読み込めませんでした。";
      setStatus("error", "CSV読み込み失敗", error.message || "CSV形式を確認してください。");
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
      index: toNumber(record.index),
      capturedAt: record.captured_at || "",
      elapsedMs: toNumber(record.elapsed_ms),
      phase: record.phase || "tracking",
      x: toNumber(record.x),
      y: toNumber(record.y),
      deltaTimeMs: toNumber(record.delta_time_ms),
      distance: toNumber(record.distance_px),
      speed: toNumber(record.speed_px_per_second),
      width: toNumber(record.screen_width),
      height: toNumber(record.screen_height),
      faceDetected: toNumber(record.face_detected)
    };
  }

  function summarizeSamples(samples) {
    const count = samples.length;
    const first = samples[0];
    const last = samples[count - 1];
    const durationMs = Math.max(0, last.elapsedMs - first.elapsedMs);
    const screen = getMostRecentScreen(samples);
    const speedThresholds = calculateSpeedThresholds(samples);
    const fixationRate = calculateRatio(samples, (sample) => Number.isFinite(sample.speed) && sample.speed <= speedThresholds.fixation);
    const saccadeRate = calculateRatio(samples, (sample) => Number.isFinite(sample.speed) && sample.speed >= speedThresholds.saccade);
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
      saccadeRate,
      saccadesPerSecond,
      coverage,
      centerBias,
      entropy,
      thresholds: speedThresholds,
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
          firstElapsed: sample.elapsedMs,
          lastElapsed: sample.elapsedMs,
          samples: []
        });
      }

      const group = groups.get(key);
      group.count += 1;
      group.firstElapsed = Math.min(group.firstElapsed, sample.elapsedMs);
      group.lastElapsed = Math.max(group.lastElapsed, sample.elapsedMs);
      group.samples.push(sample);
    });

    return Array.from(groups.values()).map((group) => ({
      phase: group.phase,
      count: group.count,
      durationMs: Math.max(0, group.lastElapsed - group.firstElapsed),
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
    drawResultPath(samples, summary.screen);
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

  function calculateRatio(samples, predicate) {
    if (!samples.length) return 0;
    return samples.filter(predicate).length / samples.length;
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

  function drawResultPath(samples, screen) {
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
    const padding = 18;
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

    drawResultPoint(ctx, samples[0], offsetX, offsetY, scale, "#0b7a75");
    drawResultPoint(ctx, samples[samples.length - 1], offsetX, offsetY, scale, "#e11d48");
  }

  function drawResultPoint(ctx, sample, offsetX, offsetY, scale, color) {
    ctx.beginPath();
    ctx.arc(offsetX + sample.x * scale, offsetY + sample.y * scale, 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  function closeAnalysis() {
    elements.resultsPanel.classList.add("is-hidden");
    if (!state.running) elements.emptyState.classList.remove("is-hidden");
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

  function toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : NaN;
  }

  function average(values) {
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
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

  function stopCamera() {
    state.running = false;
    if (state.frameRequest !== null) {
      if (typeof state.video?.cancelVideoFrameCallback === "function") state.video.cancelVideoFrameCallback(state.frameRequest);
      else window.cancelAnimationFrame(state.frameRequest);
    }
    state.frameRequest = null;
    if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
    if (state.preview) state.preview.remove();
    state.preview = null;
    state.video = null;
    state.landmarkCanvas = null;
    state.landmarkContext = null;
  }

  function csvRow(values) {
    return values.map((value) => {
      const text = String(value ?? "");
      if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
      return text;
    }).join(",");
  }

  function distance2d(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt((dx * dx) + (dy * dy));
  }

  function dot(values, coefficients) {
    return values.reduce((sum, value, index) => sum + (value * coefficients[index]), 0);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  const validationControls = [elements.calibrateBtn, elements.correctionBtn, elements.pauseBtn,
    elements.resetBtn, elements.downloadBtn, elements.modalCalibrateBtn];
  let validationControlStates = null;
  window.trackerBridge = {
    async startCamera() {
      if (!state.running) await startMediaPipeTracker();
      if (!state.running || state.paused) throw new Error("カメラを開始・再開してください。");
    },
    cancelPreparation() {
      if (!state.validationLocked && !state.recording) resetSession();
    },
    stopForExternalTask() {
      const status = this.status();
      if (status.recording || status.busy || status.locked) {
        throw new Error("計測・校正・検証・課題を終了し、保存してからカメラを停止してください。");
      }
      stopCamera();
      elements.startBtn.disabled = false;
      elements.calibrateBtn.disabled = true;
      elements.correctionBtn.disabled = true;
      elements.pauseBtn.disabled = true;
      elements.downloadBtn.disabled = true;
      elements.gazeDot.classList.remove("is-visible");
      setStatus("idle", "カメラ停止", "Aim Labの専用記録アプリで9点校正を行ってください。");
    },
    status() {
      const viewport = state.calibratedViewport;
      return { running: state.running, paused: state.paused, recording: state.recording,
        busy: state.measuring || Boolean(state.autoCorrection) || isCalibrationVisible(),
        generation: state.calibrationGeneration,
        regression_signature: JSON.stringify([state.calibrationGeneration, state.regression, state.correctedGeneration === state.calibrationGeneration]),
        correctionApplied: state.correctedGeneration === state.calibrationGeneration,
        ready: Boolean(state.regression && viewport &&
          viewport.width === innerWidth && viewport.height === innerHeight && viewport.dpr === devicePixelRatio),
        locked: state.validationLocked };
    },
    prepare() {
      if (!state.running || state.paused || state.recording || state.validationLocked || state.measuring || isCalibrationVisible()) {
        throw new Error("通常計測を停止し、カメラを再開してから準備してください。");
      }
      beginCalibration();
    },
    acquire() {
      const status = this.status();
      if (!status.running || status.paused || status.recording || status.busy || !status.ready || status.locked) {
        throw new Error("同じ全画面サイズで9点校正を完了し、中央スコアの測定終了を待ってください。5点補正は任意です。");
      }
      state.validationLocked = true;
      validationControlStates = validationControls.map(control => control.disabled);
      validationControls.forEach(control => { control.disabled = true; });
      const track = state.stream?.getVideoTracks()[0];
      const { deviceId, groupId, ...cameraSettings } = track?.getSettings() || {};
      return JSON.parse(JSON.stringify({ calibration_generation: state.calibrationGeneration,
        five_point_correction_applied: status.correctionApplied,
        calibration_started_at: state.calibrationStartedAt, calibration_viewport: state.calibratedViewport,
        regression: state.regression, calibration_samples: state.calibrationSamples,
        smoothing: { minimum: SMOOTHING_MIN, maximum: SMOOTHING_MAX, deadzone_px: SMOOTHING_DEADZONE_PX,
          full_response_px: SMOOTHING_FULL_RESPONSE_PX, max_speed_px_s: MAX_GAZE_SPEED_PX_PER_SECOND,
          output: "clamped, smoothed, rounded CSS pixels" },
        camera_label: track?.label || "不明", camera_settings: cameraSettings,
        frame_clock: "requestVideoFrameCallback mediaTime/presentedFrames when supported; otherwise currentTime at send (approximate deduplication). Neither is exposure time.",
        processing_clock: "performance.now milliseconds relative to performance.timeOrigin" }));
    },
    async drain() {
      const deadline = performance.now() + 2000;
      while (state.processingFrame && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      return !state.processingFrame;
    },
    release() {
      state.validationLocked = false;
      if (validationControlStates) validationControls.forEach((control, i) => { control.disabled = validationControlStates[i]; });
      validationControlStates = null;
      window.dispatchEvent(new Event("tracker-state"));
    }
  };

  elements.startBtn.addEventListener("click", startMediaPipeTracker);
  document.getElementById("aimlabReleaseCameraBtn")?.addEventListener("click", () => {
    const status = document.getElementById("aimlabReleaseStatus");
    try {
      window.trackerBridge.stopForExternalTask();
      status.textContent = "カメラを停止しました。Aim Labの専用記録アプリを起動できます。";
    } catch (error) {
      status.textContent = error.message;
    }
  });
  elements.calibrateBtn.addEventListener("click", showCalibrationInstructions);
  elements.correctionBtn.addEventListener("click", beginCorrectionCalibration);
  elements.modalCalibrateBtn.addEventListener("click", beginCalibration);
  elements.pauseBtn.addEventListener("click", togglePause);
  elements.resetBtn.addEventListener("click", resetSession);
  elements.downloadBtn.addEventListener("click", toggleRecording);
  if (elements.csvInput) elements.csvInput.addEventListener("change", handleCsvInput);
  if (elements.closeResultsBtn) elements.closeResultsBtn.addEventListener("click", closeAnalysis);
  elements.videoToggle.addEventListener("change", () => {
    setCameraPreview(elements.videoToggle.checked);
  });
  elements.heatmapToggle.addEventListener("change", redrawHeatmap);
  elements.trailToggle.addEventListener("change", redrawTrail);
  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("pagehide", () => {
    stopCamera();
  });

  resizeCanvas();

  if (!isAllowedOrigin()) {
    setStatus("error", "起動URLを確認", "このアプリは http://localhost:8000/ またはHTTPSで開いてください。file:// ではカメラが使えません。");
  }
}());
