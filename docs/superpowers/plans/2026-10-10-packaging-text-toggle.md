# 商品及包装文字转换开关 Implementation Plan

**Goal:** 实现用户已确认的包装文字转换勾选框，并交付1.6.5。

**Architecture:** 插件和独立工具提交 translate_product_text 布尔选项；队列持久保存本批选项，阿里云子进程及豆包提示词据此处理。旧任务默认false，新增能力防止旧工具忽略选项。

**Tech Stack:** JavaScript、Flask、Python、官方阿里云SDK、PyInstaller。

## Global Constraints

- 默认关闭；不切换翻译产品，不新增真实付费请求。
- 开始后固定本批设置；恢复及重新生成沿用。
- 保持原图含义、数字、单位及商品外观。
- 覆盖现有固定交付目录，不新增整套交付文件夹。

### Task 1: 调用参数、提示词和持久队列

Files: doubao-image-tool/{aliyun_translation,prompts,core,app,bridge_routes}.py；tests/test_product_text.py。

- [x] 先新增测试：SDK请求field='e-commerce'且ignoreEntityRecognize='true'；子进程携带bool；桥接及本地入口传递开关；任务恢复保持true，旧任务false，非法值拒绝。
- [x] 执行 `python -m pytest doubao-image-tool/tests/test_product_text.py -q`，确认因功能缺失失败。
- [x] 给 sdk_translate 和 build_prompt 添加默认false的关键词参数；队列start/start_urls保存bool并在SDK提交时传入；接口解析并报告能力。
- [x] 同命令运行至通过；无真实网络生成调用。

### Task 2: 两个界面、旧工具与恢复

Files: extension/{manager.html,conversion-ui.mjs,lib/image-conversion.mjs}；doubao-image-tool/web/{index.html,app.js}；tests/conversion-ui.test.mjs。

- [x] 新增行为测试：选中后提交true、旧工具拒绝、暂停恢复保持勾选、新批解除锁定。
- [x] 执行 `node --test tests/conversion-ui.test.mjs`，确认新测试失败。
- [x] 插入默认不勾选的输入框，绑定布尔选项，加入批次签名和开始校验，显示文字范围；本机FormData传递同字段并恢复锁定。
- [x] 同命令运行至通过。

### Task 3: 验证及交付

- [x] 全量 `python -m pytest doubao-image-tool/tests -q`、`npm test`、`npm run check`。
- [x] 更新版本1.6.5和使用说明；运行现有build.ps1重新构建到固定交付目录。
- [x] 在隔离状态目录启动便携工具并验证能力/参数，检查交付插件及ZIP内容，不使用用户密钥。
- [x] Git提交变更及版本标签，提供固定目录和ZIP路径。
