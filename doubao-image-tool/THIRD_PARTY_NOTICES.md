# 第三方软件许可

便携包以 PyInstaller onedir 形式包含 Python 及运行依赖，保留原有许可。`licenses/dependencies.json` 记录实际构建版本，`licenses/` 中提供 Flask、Werkzeug、Jinja2、MarkupSafe、ItsDangerous、Click、Blinker、Pillow、Playwright、pyee、greenlet、typing_extensions、colorama 及 Playwright 内置 Node 驱动许可。Python 许可由运行时 `_internal` 中的文件及 licenses 中的 Python 许可保留；PyInstaller 使用 GPL 许可及其允许分发打包程序的特殊例外。Google Chrome 不随工具分发，豆包服务也不属于本软件。

完整许可优先适用各组件对应文件。源码随包提供，重新构建需使用 requirements.txt。工具源代码沿用所在仓库的许可；若仓库未授予开源许可，提供源码不构成额外许可授权。

阿里云接口使用官方 alibabacloud-alimt20181012、Tea OpenAPI 与 Tea Util Python SDK。便携包同时收集 SDK 及其传递依赖（包括 credentials、Tea、requests、aiohttp、cryptography、Darabonba 等）的实际版本和许可文件；完整列表以 licenses/dependencies.json 为准。阿里云在线服务不随工具分发，服务收费及使用条款独立适用。

OSS 上传使用阿里云官方 alibabacloud-oss-v2 1.4.0，并附带 crcmod-plus 与 PyCryptodome 运行依赖。各许可证见 licenses 目录。
