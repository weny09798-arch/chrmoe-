# 拼多多漏采与删除恢复修复计划

**Goal:** 修复规格提示文字导致的 SKU 漏采，持久排除用户删除的商品，按货憨憨实际导入行为处理描述。

**Architecture:** 规格身份使用按钮的 aria-label，正文只是兜底；继续等待实际选中状态、价格和图片稳定。删除记录以平台和规范商品 ID 保存到任务，其他名称的补采也检查记录。现有模板 H 列由货憨憨复制到两个描述区域，因此是否留空等待用户选择，不添加未经验证的模板列。

**Tech Stack:** Chrome MV3、JavaScript、Node test、Linkedom。

## Constraints
- 不点击规格弹窗“确定”，不提交订单。
- 不重新引入主图自动去重，不伪造 SKU 价格或库存。
- 保留 22 列模板，保留用户原 Excel，不修改其他项目。

## Task 1: SKU 标签
- [x] 在 tests/detail-content.test.mjs 增加商品 1007998908733 的 6 组规格回归：按钮带“马上卖完”，选中后其他按钮提示改变，仍须导出 6 个正确名称、价格及图片。
- [x] 运行 `node --test tests/detail-content.test.mjs` 确认当前实现漏行。
- [x] 修改 extension/detail-pdd-ui.js：`optionText(n) = n.getAttribute('aria-label')?.trim() || text(n)`，发现、点击、已选匹配统一使用该身份。
- [x] 通过回归；在用户已打开网页核对漏掉的 2.60 元规格。

## Task 2: 删除持久排除
- [x] 在 tests/products.test.mjs 验证数字/字符串 ID 等价、恢复后补采及另一个名称排除同平台同 ID；不同平台同数字不误删。
- [x] 运行回归，确认当前类型或跨名称检查失败。
- [x] 修改 products/core/runner/manager：删除记录同时写入任务，以 `String(id).trim()` 对比；搜索加入候选前检查任务记录，移除同平台其他名称已存在的同 ID，保留并补齐其他商品。
- [x] 通过测试；现有同图不同 ID 继续允许。

## Task 3: 描述及发布
- [x] 用户选择 H 留空时，先更新 tests/xlsx.test.mjs 预期，确认失败，再修改导出 H 为空，K 保留参数、I 仅图片；否则维持描述并说明平台限制。
- [x] 运行 `npm test`、`npm run check`、`git diff --check`。
- [x] 审查变更，同步交付目录、版本和说明，合并并保存 GitHub，打包；明确自动测试与实际浏览器验证的范围。
