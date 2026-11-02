// GazeFollower2 feature extraction runs separately from 3D rendering.
import * as ort from './vendor/onnxruntime/ort.wasm.min.mjs';
import { FaceAlignment } from './vendor/gazefollower2/FaceAlignment.mjs';

let session, alignment, canvas;
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(v => v.toString(16).padStart(2, '0')).join('');
async function initialize() {
  const response = await fetch('vendor/gazefollower2/manifest.json');
  if (!response.ok) throw Error('視線モデルの情報を読み込めません。');
  const manifest = await response.json();
  const modelPath = 'vendor/gazefollower2/GazeNet_Next.onnx';
  const modelResponse = await fetch(modelPath);
  if (!modelResponse.ok) throw Error('視線モデルが見つかりません。');
  const bytes = await modelResponse.arrayBuffer(), modelHash = await digest(bytes);
  if (modelHash !== manifest.files.find(f => f.path === modelPath)?.sha256) throw Error('視線モデルの内容を確認できません。');
  ort.env.wasm.numThreads = 1; // Works on localhost without cross-origin isolation.
  ort.env.wasm.wasmPaths = new URL('vendor/onnxruntime/', self.location.href).href;
  session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  // The upstream cropper uses the Canvas API; OffscreenCanvas keeps this work in the worker.
  self.document = { createElement: () => new OffscreenCanvas(1, 1) };
  alignment = new FaceAlignment();
  return { id: 'gazefollower2', label: 'GazeFollower2', feature_count: 259, ridge_alpha: 2,
    landmark_pipeline: 'MediaPipe Face Mesh', mapping: 'common-nine-point-ridge-v1',
    upstream_commit: manifest.commit, model_sha256: modelHash, model: 'GazeNet_Next.onnx',
    runtime: `ONNX Runtime Web ${manifest.onnxruntime_web_version}, WASM worker, 1 thread`,
    upstream_filter: false, license: manifest.license,
    integration: 'GazeFollower2 neural features and FaceAlignment with common app calibration; not the full upstream SDK' };
}
async function features(bitmap, landmarks) {
  try {
    if (!session || !alignment) throw Error('視線モデルが未準備です。');
    if (landmarks.length < 478 || !landmarks.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) throw Error('顔特徴が不正です。');
    if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.videoWidth = bitmap.width; canvas.videoHeight = bitmap.height;
    }
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const tensors = alignment.process(canvas, landmarks);
    const feeds = {};
    for (const name of session.inputNames) {
      if (name === 'face') feeds[name] = new ort.Tensor('float32', tensors.faceTensor, [1, 3, 224, 224]);
      else if (name === 'left' || name === 'left_eye') feeds[name] = new ort.Tensor('float32', tensors.leftTensor, [1, 3, 112, 112]);
      else if (name === 'right' || name === 'right_eye') feeds[name] = new ort.Tensor('float32', tensors.rightTensor, [1, 3, 112, 112]);
      else if (name === 'rect') feeds[name] = new ort.Tensor('float32', tensors.rectTensor, [1, 12]);
      else throw Error(`未対応のモデル入力：${name}`);
    }
    let outputs;
    try {
      outputs = await session.run(feeds);
      const values = Array.from(outputs[session.outputNames[0]].data);
      if (values.length !== 258 || !values.every(Number.isFinite)) throw Error('視線モデルの出力が不正です。');
      return [1, ...values];
    } finally {
      Object.values(feeds).forEach(t => t.dispose());
      if (outputs) Object.values(outputs).forEach(t => t.dispose());
    }
  } finally { bitmap.close(); }
}
self.onmessage = async ({ data }) => {
  try {
    const result = data.type === 'init' ? await initialize() : await features(data.bitmap, data.landmarks);
    self.postMessage({ id: data.id, result });
  } catch (error) { self.postMessage({ id: data.id, error: error.message || String(error) }); }
};
