# 모델 (사진 필터 — lib/vision.mjs)

| 파일 | 용도 | 출처 | 라이선스 |
|---|---|---|---|
| face.onnx | 얼굴 감지 (UltraFace RFB-320, 1.3MB) | onnx/models `validated/vision/body_analysis/ultraface/models/version-RFB-320.onnx` | MIT |
| mobilenet.onnx | ImageNet 분류 (MobileNetV2 int8, 3.6MB) | onnx/models `validated/vision/classification/mobilenet/model/mobilenetv2-12-int8.onnx` | Apache-2.0 |
| imagenet-labels.txt | ImageNet 1000 클래스 | onnx/models `validated/vision/classification/synset.txt` | — |

기준값은 실데이터 68장 사람 검수로 정함 (docs/photo-filter.md 참고).
