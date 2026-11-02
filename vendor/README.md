# Bundled gaze estimation dependencies

These assets are served locally. Inference does not upload camera images. The app does not run the upstream demo or its fine-tuning server.

## GazeFollower2

- Authors: GazeFollower Team / Gancheng Zhu and contributors.
- Upstream: https://github.com/GanchengZhu/GazeFollower2
- Pinned commit: `106b4012bb2b3f2ca7e473e034fc3ad0a4ceb5a0`.
- License for the model and upstream code: **CC BY-NC-SA 4.0**, see [LICENSE](gazefollower2/LICENSE). Non-commercial academic/research use is allowed under its terms; commercial use requires a separate agreement.
- `FaceAlignment.mjs` is an unchanged copy of upstream `src/FaceAlignment.js` (filename extension changed).
- `GazeNet_Next.onnx` is the upstream full-precision model, not a personalized model trained with this app's participants.
- SHA-256 and file sizes: [manifest.json](gazefollower2/manifest.json).

Integration differences: the app uses its existing MediaPipe Face Mesh landmarks, the upstream cropper and neural model in an OffscreenCanvas/WASM worker, and the app's common nine-point calibration procedure. The 258 model outputs are prefixed with a constant bias feature, and mapped to CSS pixels by ridge regression with alpha 2. This is not the full upstream SDK, its calibration UI, its personalized fine-tuning procedure, or its heuristic filter. The common app filter runs after prediction; raw predictions are preserved in research records. The upstream SDK's reported accuracy must not be presented as measured accuracy of this integration.

## ONNX Runtime Web

- Microsoft and ONNX Runtime contributors.
- Version **1.22.0**, npm distribution `onnxruntime-web@1.22.0`.
- Source: https://github.com/microsoft/onnxruntime/tree/v1.22.0
- License: MIT, see [LICENSE](onnxruntime/LICENSE) and [ThirdPartyNotices.txt](onnxruntime/ThirdPartyNotices.txt).
- Bundled WASM-only ES module and matching WASM loader/binary. Runs with one thread in a dedicated worker; no cross-origin isolation is required.

Do not replace only one of the runtime files. Update the manifest and re-run `tests/tracker-model-browser.cjs` after dependency changes.
