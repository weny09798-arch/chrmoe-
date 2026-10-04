# 第三方软件许可

便携包以 PyInstaller onedir 形式包含 Python 及运行依赖，保留原有许可。`licenses/dependencies.json` 记录实际构建版本，`licenses/` 中提供 Flask、Werkzeug、Jinja2、MarkupSafe、ItsDangerous、Click、Blinker、Pillow、Playwright、pyee、greenlet、typing_extensions、colorama 及 Playwright 内置 Node 驱动许可。Python 许可由运行时 `_internal` 中的文件及 licenses 中的 Python 许可保留；PyInstaller 使用 GPL 许可及其允许分发打包程序的特殊例外。Google Chrome 不随工具分发，豆包服务也不属于本软件。

完整许可优先适用各组件对应文件。源码随包提供，重新构建需使用 requirements.txt。工具源代码沿用所在仓库的许可；若仓库未授予开源许可，提供源码不构成额外许可授权。
