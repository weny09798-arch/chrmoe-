# Task 1 实施报告：规范化详情数据

## 实现内容

- 新增 `extension/lib/detail.mjs`，导出冻结状态常量 `DETAIL_STATUS`、`fallbackSku(product)` 和 `normalizeDetail(raw, fallback)`。
- 按已确认契约规范化标题、描述、分类、属性、规格、SKU 和图片/视频 URL；HTTPS URL 去重，空属性/规格过滤，规格数量最多两个。
- SKU 仅接受正安全整数分或十进制价格，按 SKU ID 或无 ID 的规格/价格/图片键去重；没有有效原始 SKU 时输出搜索商品回退 SKU。
- 保留有效显式详情状态，其他状态默认为 `done`；备注 trim 后限 500 字。
- 新增 8 个 Node 测试，覆盖夹具、稳定形状、URL、属性规格、SKU 价格与去重、回退 SKU、状态和备注。

## RED

命令：`node --test tests/detail.test.mjs`

预期失败：导入模块时 `ERR_MODULE_NOT_FOUND`，提示无法找到 `extension/lib/detail.mjs`；退出码 1。失败符合预期，测试随后由新增实现满足。

## GREEN

命令：`node --test tests/detail.test.mjs`

结果：8 项通过，0 失败，退出码 0。

## 完整测试

命令：`npm test`

结果：63 项通过，0 失败，退出码 0。

## 改动文件

- `extension/lib/detail.mjs`（新增）
- `tests/detail.test.mjs`（新增）
- `.superpowers/sdd/2026-09-27-pdd-full-product-detail-export/task-1-report.md`（新增）

## 自检和关注点

- `git diff --check` 无空白错误。
- `package-lock.json` 在开始任务前已有控制器运行 `npm install` 造成的未提交修改；未编辑、未暂存、不会提交。
- 价格字符串按十进制金额乘 100 并四舍五入为分；无有效价格或超出安全整数范围的原始 SKU 会被忽略。
