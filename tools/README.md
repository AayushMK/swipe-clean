# Face model conversion (iPhone)

Android runs OpenCV's YuNet + SFace ONNX models directly (ONNX Runtime).
iPhone runs SFace as Core ML (`ios/App/App/SFace.mlmodelc`), made like this:

1. `python tools/dequantize_onnx.py face_recognition_sface_2021dec_int8.onnx sface_float.onnx`
   (the int8 model's QLinear ops become ordinary float ops with the same weights)
2. onnx2torch → torch.jit.trace → `coremltools.convert(..., convert_to="mlprogram", FLOAT16)`,
   then `linear_quantize_weights` (8-bit). Checked: cosine ≥ 0.998 against the ONNX model.
3. `xcrun coremlcompiler compile SFace.mlpackage out/` → `SFace.mlmodelc`

Tools: Python 3.12, coremltools 9.0, torch 2.7.0, onnx, onnx2torch, onnxruntime.
Models: OpenCV model zoo — YuNet (MIT), SFace (Apache-2.0).
