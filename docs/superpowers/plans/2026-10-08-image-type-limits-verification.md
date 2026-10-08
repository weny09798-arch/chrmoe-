# 1.6.4 分类图片数量限制验收记录

验收日期：2026-10-08。版本为 1.6.4；固定交付目录仍沿用 `商品采集与图片转换_1.6.1` 的名称，不代表程序版本。本文记录源码集成验收，交付目录替换、ZIP 校验及 Git 标签另由交付步骤完成。

## 行为与使用说明

主图、详情图、SKU 图分别填写“前多少张”，留空表示该类全部，选中类型必须填写正整数或留空。限制按本批所有商品中该类型的图片位置累计，按商品和图片顺序先取前 N 个位置，再做网址和内容去重；重复、下载失败或生成失败不会从后面补足。费用预览与实际提交共用选择清单。运行、暂停和恢复沿用本批配置；修改限制用于新批次。

从采集插件发起的豆包和阿里云任务均上传 OSS；只有上传并公开读取校验成功的链接参与商品 Excel 替换。上传失败可仅重试上传，不重新生成。工具独立选择本地图片的入口仍保存本地文件。本机工具页面中“转换图继续保存本地”的误导文案已改正，使用说明和版本说明同步更新。

## 自动化与便携程序

- 完整 Node 测试：`npm test`，395 passed、0 failed，退出码 0；日志为 `artifacts/task3-node-tests.log`。
- 静态检查：`npm run check`，退出码 0，所有 manifest 资源和扩展 JavaScript 模块通过检查，日志为 `artifacts/task3-check.log`；补丁空白检查：`git diff --check`，退出码 0。
- 完整 Python 测试已有本轮日志 `artifacts/python-tests-164.log`：351 passed，17.37 秒。
- Windows 便携构建已有本轮日志 `artifacts/build-164.log`：EXE、COLLECT 构建成功，构建命令退出码 0。
- 重新执行 `python artifacts/verify_oss_portable.py artifacts/oss-portable/DoubaoImageTool`，退出码 0，日志为 `artifacts/task3-portable-smoke.log`。使用临时隔离状态目录，验证 1.6.4 能力、连接配对、OSS 配置门禁、DPAPI、分类限制持久化、下载失败、JSON 映射、旧 XLSX 端点关闭、配置保留和正常退出；没有调用翻译或 OSS 服务，没有使用用户任务或凭证。

## 真实免费豆包与 OSS

真实单图验收记录为 `artifacts/accept-doubao-164/verification.json`。通过实际专用 Chrome 中的豆包免费网页完成一张主图生成，限制为主图 1 张。首次 OSS 公开读取校验遇到临时 fakeDNS 网络故障；网络恢复后通过正常生产 `OSSPublisher` 仅重试上传，最终 uploaded=1、upload_failed=0、failed=0，phase=done、retry_phase=done，regenerated=false、paid_calls=0。JSON 的 initial_phase=upload-failed 记录首次失败。

人工查看结果：商品外广告文字由简体转换为繁体，商品展示的数字“120”保留，免费网页 AI 水印保留。单图观察不保证其他图片均能完整保护包装细节，仍需逐张核对。原有已停止的付费批次文件逐字节保持不变。本轮没有新增付费翻译请求。

`node artifacts/verify_real_oss_export_164.mjs` 退出码 0：将上述真实已完成队列快照通过模拟桥接传输交给实际控制器，再生成并解码实际 XLSX 和 BIFF8 XLS。选中的主图位置 1 使用真实 OSS 链接；超出限制的主图位置 2 即使原网址相同也保持原链接，源商品数据不变。此检查没有网络请求或费用，仍不等同于真实安装扩展或 hhn 导入验收。

## Chromium（Codex 内置浏览器）中的模拟插件界面

在 Chromium（Codex 内置浏览器）中加载了模拟接口和状态的插件页面，使用真实原生数字输入控件，验证主图 20 张设置限制 10、取消详情图和 SKU 后显示选中 10 张及 ¥0.60；输入 0 禁止开始；原生数字输入 `1e` 对应空 value 与 badInput=true，也禁止开始。未勾选类型的非法输入忽略，重新勾选后禁止开始，改正为 10 后恢复。`artifacts/ui-164.png` 只记录模拟界面，不是实时付费任务截图。

上述浏览器检查没有覆盖真实安装扩展与本机工具的完整联动，也没有覆盖 hhn 网站导入或实际付费阿里云翻译。真实免费单图验证覆盖工具队列、生成及 OSS 发布，不能等同于这些未执行的端到端流程。
