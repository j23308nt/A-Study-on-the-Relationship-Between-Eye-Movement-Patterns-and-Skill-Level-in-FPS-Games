(function (root) {
  "use strict";
  const CURRENT = "mediapipe-ridge", NEURAL = "gazefollower2", EYE = "pupil-roi";
  const base = { id: CURRENT, label: "現行方式", feature_count: 12, ridge_alpha: .001,
    landmark_pipeline: "MediaPipe Face Mesh", mapping: "common-nine-point-ridge-v1" };

  class NeuralFeatures {
    constructor() { this.worker = null; this.pending = new Map(); this.serial = 0; this.metadata = null; }
    request(type, data = {}, transfer = []) {
      if (!this.worker) return Promise.reject(Error("視線モデルが起動していません。"));
      const id = ++this.serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.close(); reject(Error("視線モデルの処理が時間内に完了しませんでした。方式を選び直してください。"));
        }, type === "init" ? 60000 : 10000);
        this.pending.set(id, { resolve, reject, timer });
        try { this.worker.postMessage({ id, type, ...data }, transfer); }
        catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    }
    async init() {
      this.worker = new Worker("gaze-worker.mjs", { type: "module" });
      this.worker.onmessage = ({ data }) => {
        const task = this.pending.get(data.id); if (!task) return;
        clearTimeout(task.timer); this.pending.delete(data.id);
        if (data.error) task.reject(Error(data.error)); else task.resolve(data.result);
      };
      this.worker.onerror = event => { event.preventDefault(); this.close(); };
      try { this.metadata = await this.request("init"); return this.metadata; }
      catch (error) { this.close(); throw error; }
    }
    async features(image, landmarks) {
      const bitmap = await createImageBitmap(image);
      try { return await this.request("features", { bitmap, landmarks }, [bitmap]); }
      finally { bitmap.close(); }
    }
    close() {
      this.worker?.terminate(); this.worker = null;
      for (const task of this.pending.values()) {
        clearTimeout(task.timer); task.reject(Error("視線モデルの処理を終了しました。"));
      }
      this.pending.clear();
    }
  }
  root.GazeBackends = { CURRENT, NEURAL, EYE, current: () => ({ ...base }), NeuralFeatures,
    eye(roi, threshold) { return { id: EYE, label: "目のみ・帽子固定", feature_count: 6, ridge_alpha: .001,
      landmark_pipeline: "none", detector: "dark-component-moments-v1", mapping: "quadratic-pupil-roi-v1",
      roi: roi ? { ...roi } : null, threshold, head_requirement: "fixed position and orientation relative to screen",
      head_fixed_confirmed: Boolean(roi), experimental: true }; },
    assets(id) {
      const common = ["tracker-backends.js", "gaze-worker.mjs"];
      if (id === EYE) return [...common, "pupil-core.js", "pupil-tracker.js"];
      return id === NEURAL ? [...common, "vendor/gazefollower2/manifest.json", "vendor/gazefollower2/FaceAlignment.mjs",
        "vendor/gazefollower2/GazeNet_Next.onnx", "vendor/onnxruntime/ort.wasm.min.mjs",
        "vendor/onnxruntime/ort-wasm-simd-threaded.mjs", "vendor/onnxruntime/ort-wasm-simd-threaded.wasm"] : common;
    }
  };
})(window);
