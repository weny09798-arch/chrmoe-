# 拼多多商品收集 Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 一个可加载的 Chrome 插件，保存关键词、搜索并按图片保留最低价、每词最多导出 20 个链接，并显示进度。

**Architecture:** 独立管理页持有任务执行循环；service worker 打开单例管理页；注入页面的适配器只读取可见商品信息并滚动加载。可测试的纯模块负责价格、分组、检查点和 XLSX 打包。

**Tech Stack:** Manifest V3、原生 ES modules、Canvas、Chrome storage、无运行时第三方依赖、Node 内置测试。

## Global Constraints

- 每个名称默认最多扫描 200 个结果卡片，最多输出 20 组。
- 分组按首次出现排序；同组保留最低展示价格；同价先出现者优先。
- 只操作 mobile.pinduoduo.com；图片权限按实际需要申请。
- 登录/验证暂停；故障不能伪装正常完成；检查点可恢复。
- 当前目录没有仓库，直接在用户指定的独立目录开发，不创建 Git 仓库。
- 用户已确认设计，直接在当前会话执行，不再询问执行模式。

## Task 1：纯逻辑和回归测试

Files: extension/lib/core.mjs, extension/lib/fingerprint.mjs, tests/core.test.mjs

- [ ] 编写价格歧义、同图异链接最低价、同 ID 去重、20 组上限和恢复测试。
- [ ] 运行 `node --test tests/core.test.mjs`，确认缺少模块导致失败。
- [ ] 实现 `parsePrice(text): number|null`、`createTask(keywords): object`、`addCandidate(job, candidate): boolean`、`selected(job): object[]`，价格统一为整数分。
- [ ] 实现 `fingerprint(rgba, size=32): object`、`similar(a,b): boolean`；使用亮度感知哈希与色彩差异，拒绝低信息图误合并。
- [ ] 重跑测试并修复边界。

## Task 2：Excel 导出

Files: extension/lib/xlsx.mjs, tests/xlsx.test.mjs

- [ ] 先测试 ZIP 文件头、XML 转义、中文、公式样式文本保持字符串。
- [ ] 实现 `workbookBytes(sheets): Uint8Array` 和 `taskSheets(task): object[]`，生成标准 OOXML；文本使用 inlineStr，不使用公式。
- [ ] 用 Python 标准库 ZIP/XML 和已安装的只读解析器验证两张表及样例低价结果。

## Task 3：页面适配

Files: extension/content.js, tests/content.test.mjs

- [ ] 以受控 DOM 样本测试商品卡片、分段价格、相同卡片重复渲染和验证页；外部 Chrome API 在消息边界替身。
- [ ] 内容脚本提供 `snapshot`、`scroll` 操作；仅读取可见商品卡片和明确的 goods_id，不读取网页内部框架状态。
- [ ] 不依赖混淆 class 名；优先商品链接/data 属性，无法识别时报告适配失败。

## Task 4：任务执行与保存

Files: extension/lib/runner.mjs, extension/lib/browser.mjs, tests/runner.test.mjs

- [ ] 用受控网页端口测试暂停、继续、失败、上限和检查点恢复，断言真实任务状态。
- [ ] 实现 `Runner(task, ports)`，端口为 navigation/read/scroll/hash/save/update；每条采集后保存。
- [ ] 打开专用采集标签页并复用同一 Chrome 登录状态；将选中搜索词编码在搜索 URL 中；验证页面仍对应本词后采集。
- [ ] 连续无新增但没有结束标记时报告加载停滞，保留已有结果；不声称完整搜索结束。

## Task 5：管理界面和安装包

Files: extension/manifest.json, extension/background.js, extension/manager.html, extension/manager.css, extension/manager.mjs, README.md

- [ ] 创建中文管理界面，名称列表、本地保存、进度、任务表、暂停继续停止、Excel 导出。
- [ ] 单管理页及执行锁防止重复操作；浏览器重启后恢复为暂停。
- [ ] 请求实际图片源域名权限，不申请全站访问；拒绝权限时给出明确操作提示。
- [ ] 添加安装说明、采集页保持打开要求、已知适配限制。

## Task 6：验收与审查

- [ ] 运行全部 Node 测试、所有 JS 语法检查、manifest 文件引用检查。
- [ ] 在可用浏览器预览管理界面，并以样例数据检查导出表结构。
- [ ] 根据 requesting-code-review 技能请独立审查代理检查实际文件；处理重要问题。
- [ ] 打包 extension 目录，交付可加载目录和 ZIP；清楚说明用户 Chrome 的实站测试是否完成。
