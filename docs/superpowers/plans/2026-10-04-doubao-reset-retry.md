# 豆包重试与清空实施计划

**Goal:** 关闭清空任务，重做能新提交，暂停可清空开始其他图片。

**Architecture:** QueueService 先取消并等待工作线程，随后清理 state_dir 中自己创建的 UUID 缓存目录和任务 JSON；Flask reset 创建新队列。浏览器上传前清空未发送草稿；UI 提供明确区分的继续与重做按钮。

**Tech Stack:** Python、Flask、Playwright、pytest、JavaScript、PyInstaller。

- [x] 先添加关闭清空/保留登录结果、线程等待清理、reset API、真实浏览器草稿清理与 UI 按钮回归测试，观察失败；队列/API/浏览器初次 5 failed，UI 初次 1 failed，重做旧结果初次 1 failed。
- [x] 实现 QueueService.close(clear_state=True) 安全清理及 reset、退出接口；修改 launcher 正常退出清空。
- [x] 清除新对话保留的输入和附件，确认后再上传，维持发送前取消检查。真实本机 Chrome 夹具验证草稿、两个附件删除与历史内容保留；未提交远程生成。
- [x] 更新按钮名称、说明与文档；重做提交新请求，继续保持原请求；重做时旧结果不显示为新结果。
- [x] 完整测试 121 passed（3.92 秒），PyInstaller 构建成功。冻结程序从暂停任务启动，reset 返回 idle 并删除缓存；退出再清缓存、保留登录标记与输出文件、进程退出 0。交付副本重复通过相同验收。

已同步两个交付目录：`豆包图片繁体转换工具_2026-10-04`、`豆包图片繁体转换工具_保留商品文字版`。获取当前单实例锁后清除当前旧任务，验证状态 JSON 已删除、配置目录保留。本次没有自动重发用户图片，真实豆包生成需由用户启动验证。
