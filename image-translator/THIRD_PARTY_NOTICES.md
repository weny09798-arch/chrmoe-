# Third-party components

This tool uses local RapidOCR ONNX models, OpenCC conversion dictionaries, Flask/Werkzeug, Pillow, NumPy, OpenCV, and ONNX Runtime. Distribution licenses and installed version inventory are included in the `licenses` folder by the build script. PyInstaller bundles the Python runtime and dependencies; its license permits distributing generated applications under its bootloader exception.

RapidOCR's installed package supplies its model files and configuration, included with this distribution. OpenCC's installed package supplies its dictionaries and conversion configurations. The application does not download model files at runtime. Component names and licenses do not imply endorsement.

Windows font files are not included. Text rendering uses the recipient's installed Microsoft JhengHei or MingLiU font. User images and sample results are not included in the software archive.
