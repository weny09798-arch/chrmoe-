# 拼多多完整商品详情与 SKU 导出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留主图去重和每个名称最多 20 个商品规则的基础上，从拼多多详情页采集商品图片、描述、属性和真实 SKU，并按货憨憨 22 列模板导出。

**Architecture:** 搜索页读取器继续只负责快速选品。选满后，Runner 调用浏览器端口在独立非活动标签页中逐个补全详情；详情内容脚本返回一个规范化商品对象，Excel 导出器再把一个商品展开为一个或多个 SKU 行。任务数据保存每个商品的详情状态，因此暂停后可以继续。

**Tech Stack:** Chrome Extension Manifest V3、JavaScript ES modules、Chrome tabs/scripting/storage/downloads API、Node.js `node:test`、LinkeDOM、SheetJS BIFF8 导出。

## Global Constraints

- 每个商品名称最多保留 20 个主图组，达到 20 个后停止继续扫描。
- 同主图商品只保留展示价格最低的一条。
- 商品详情必须来自拼多多当前页面；页面没有的数据保持空白。
- 一个 SKU 输出一行，同一商品的所有行使用 `PDD${goodsId}` 作为产品主编号。
- 第一 SKU 行填写商品公共字段，后续 SKU 行只填写产品主编号和 SKU 字段。
- 详情采集使用独立非活动标签页，不改变搜索结果页。
- 登录、验证码或访问频繁时暂停并保留进度，不绕过平台限制。
- 保留用户模板的 22 列、表头、说明、样式、合并区域和列宽。
- 当前工作目录没有 `.git`，因此各任务以测试通过作为检查点，不执行 Git 提交。

---

### Task 1: 规范化详情数据

**Files:**
- Create: `extension/lib/detail.mjs`
- Create: `tests/detail.test.mjs`

**Interfaces:**
- Consumes: 页面读取器返回的原始对象和搜索结果商品对象。
- Produces: `normalizeDetail(raw, fallback)`、`fallbackSku(product)`、`DETAIL_STATUS`。

- [ ] **Step 1: 写规范化失败测试**

测试使用完整字面量夹具，验证 URL 去重、价格转分、最多两个规格、重复 SKU ID 去重、缺失字段为空，以及无 SKU 时生成单行默认 SKU：

```js
const detail = normalizeDetail({
  title: '运动鞋', galleryImages: ['https://img/1.jpg', 'https://img/1.jpg'],
  attributes: [{ name: '品牌', value: '测试牌' }], specNames: ['颜色', '尺码'],
  skus: [{ id: 'sku-1', specs: ['黑色', '42'], price: '29.90', stock: '8' }]
}, { id: '123', title: '鞋', cents: 3500, image: 'https://img/search.jpg' });
assert.equal(detail.skus[0].cents, 2990);
assert.deepEqual(detail.galleryImages, ['https://img/1.jpg']);
```

- [ ] **Step 2: 运行测试确认因模块不存在而失败**

Run: `node --test tests/detail.test.mjs`

Expected: FAIL，提示无法导入 `extension/lib/detail.mjs`。

- [ ] **Step 3: 实现最小规范化模块**

实现以下稳定数据结构：

```js
{
  title: '', galleryImages: [], descriptionText: '', detailImages: [],
  category: '', attributes: [], videoUrl: '', certificateImages: [],
  sizeChartImages: [], specNames: [],
  skus: [{ id: '', specs: [], cents: 0, image: '', stock: '', weightKg: '', sizeCm: '' }],
  detailStatus: 'done', detailNote: ''
}
```

所有图片和视频必须是 `https:` URL；SKU 价格必须转换为正整数分；空属性、空规格和重复 SKU 不能输出。

- [ ] **Step 4: 运行详情模块测试**

Run: `node --test tests/detail.test.mjs`

Expected: PASS。

---

### Task 2: 从拼多多详情页读取商品和 SKU

**Files:**
- Create: `extension/detail-content.js`
- Create: `tests/detail-content.test.mjs`
- Modify: `scripts/check.mjs`

**Interfaces:**
- Consumes: 拼多多 `goods.html?goods_id=...` 的 DOM、JSON 脚本和当前 URL。
- Produces: 消息 `PDD_DETAIL_SNAPSHOT` 的响应 `{ url, goodsId, blocked, reason, detail }`。

- [ ] **Step 1: 写详情内容脚本失败测试**

在 LinkeDOM 中构造一个包含标题、主图、详情图、属性、视频和两维 SKU JSON 的商品页，执行内容脚本并发送 `PDD_DETAIL_SNAPSHOT`。断言返回 2 个规格名称和页面实际存在的 SKU 组合；再构造验证码页面并断言 `blocked: true`。

- [ ] **Step 2: 运行测试确认消息处理器不存在**

Run: `node --test tests/detail-content.test.mjs`

Expected: FAIL，详情消息没有响应。

- [ ] **Step 3: 实现详情读取器**

内容脚本应：

```js
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === 'PDD_DETAIL_SNAPSHOT') respond(detailSnapshot());
});
```

读取器先检查登录和验证码文本，再读取页面内 JSON 脚本和可见 DOM。递归候选对象必须同时关联当前 `goods_id` 或位于当前商品根数据中；不得把推荐商品的数据合并进当前商品。图片按页面角色分类为主图、详情图、SKU 图、证书图和尺寸图。

- [ ] **Step 4: 将详情脚本加入静态检查**

`scripts/check.mjs` 必须解析 `extension/detail-content.js`，并验证消息名称只在详情脚本与浏览器端口中使用。

- [ ] **Step 5: 运行内容脚本和静态检查**

Run: `node --test tests/detail-content.test.mjs && npm run check`

Expected: PASS。

---

### Task 3: 独立标签页详情端口

**Files:**
- Modify: `extension/lib/browser.mjs`
- Modify: `tests/browser.test.mjs`

**Interfaces:**
- Consumes: `browserPorts()` 当前搜索标签页、商品 `{ id, url }`。
- Produces: `ports.enrich(item)`，返回 Task 1 定义的规范化详情；`ports.close()` 清理残留详情标签页。

- [ ] **Step 1: 写后台详情标签页失败测试**

模拟 Chrome tabs/scripting API，断言 `enrich()` 创建 `active: false` 的详情标签页，注入 `detail-content.js`，读取当前商品 ID 的快照，最后关闭该标签页；验证码响应必须抛出带 `blocked: true` 的错误。

- [ ] **Step 2: 运行浏览器端口测试确认失败**

Run: `node --test tests/browser.test.mjs`

Expected: FAIL，`ports.enrich` 不存在。

- [ ] **Step 3: 实现 `enrich()`**

详情 URL 固定规范化为：

```js
const detailUrl = `https://mobile.pinduoduo.com/goods.html?goods_id=${item.id}`;
```

等待标签页完成后注入详情脚本，轮询快照直至得到详情、遇到阻断页或超时。正常、解析失败和停止流程都必须关闭详情标签页；搜索标签页保持原 URL 和滚动位置。

- [ ] **Step 4: 运行浏览器端口测试**

Run: `node --test tests/browser.test.mjs`

Expected: PASS，原有同标签页链接解析测试也保持通过。

---

### Task 4: Runner 详情补全、暂停和恢复

**Files:**
- Modify: `extension/lib/runner.mjs`
- Modify: `extension/lib/core.mjs`
- Modify: `tests/runner.test.mjs`
- Modify: `tests/core.test.mjs`

**Interfaces:**
- Consumes: `ports.enrich(item)` 和现有 `selected(job)`。
- Produces: `job.phase`、`job.detailDone`，以及每个 `group.best.detailStatus/detailNote`。

- [ ] **Step 1: 写 Runner 失败测试**

断言搜索达到 20 组后不再调用 `read()`，随后按顺序调用 20 次 `enrich()`；单个商品解析失败被标记为 `error` 后继续下一个；阻断错误把任务设为 `blocked`；恢复后只处理未完成的商品。

- [ ] **Step 2: 运行 Runner 和 core 测试确认失败**

Run: `node --test tests/runner.test.mjs tests/core.test.mjs`

Expected: FAIL，任务没有详情阶段和详情恢复逻辑。

- [ ] **Step 3: 实现详情阶段**

`collect(job)` 完成选品后调用 `enrich(job)`。每处理一个商品都执行 `checkpoint()`。普通详情错误写入 `detailStatus: 'error'` 和原因并继续；带 `blocked` 的错误沿用现有暂停机制。商品详情部分字段为空但 SKU 或基本字段有效时使用 `partial`，不把商品从导出结果移除。

- [ ] **Step 4: 迁移旧任务数据**

`recoverTask()` 为旧商品补充 `detailStatus: 'pending'`，并从已有详情字段推断完成状态；不得清空 `groups`、`seen`、`scanned` 或已完成的详情。

- [ ] **Step 5: 运行 Runner 和 core 测试**

Run: `node --test tests/runner.test.mjs tests/core.test.mjs`

Expected: PASS。

---

### Task 5: 管理页显示详情采集进度

**Files:**
- Modify: `extension/manager.mjs`
- Modify: `extension/manager.html`
- Modify: `tests/manager.test.mjs`

**Interfaces:**
- Consumes: `job.phase`、`job.detailDone`、商品详情状态。
- Produces: 搜索与详情两阶段的可读进度和失败数量。

- [ ] **Step 1: 写管理页失败测试**

构造 `phase: 'detail'`、`detailDone: 7`、20 个已选商品的任务，断言界面显示“正在补全详情 7 / 20”；含详情失败时显示失败数量，导出按钮仍可用。

- [ ] **Step 2: 运行管理页测试确认失败**

Run: `node --test tests/manager.test.mjs`

Expected: FAIL，当前页面只显示搜索扫描进度。

- [ ] **Step 3: 更新管理页渲染**

搜索阶段保留“已扫描 / 主图组 / 保留数”，详情阶段显示“已补全 / 总数 / 失败数”。暂停、继续、停止和清空按钮沿用现有行为。

- [ ] **Step 4: 运行管理页测试**

Run: `node --test tests/manager.test.mjs`

Expected: PASS。

---

### Task 6: 将完整详情展开为模板 SKU 行

**Files:**
- Modify: `extension/lib/xlsx.mjs`
- Modify: `tests/xlsx.test.mjs`
- Modify: `tests/xls.test.mjs`

**Interfaces:**
- Consumes: 规范化商品详情对象。
- Produces: `taskSheets(task)` 中符合模板的 22 列商品与 SKU 行。

- [ ] **Step 1: 写多 SKU 导出失败测试**

使用一个包含两维规格、3 个实际 SKU、多个主图和详情图的字面量商品。断言导出新增 3 行；三行产品主编号相同；第一行填满公共字段；后两行公共字段为空；各行 SKU 规格、价格、图片和库存对应正确。再测试无重量和尺寸时两列为空。

- [ ] **Step 2: 运行导出测试确认失败**

Run: `node --test tests/xlsx.test.mjs tests/xls.test.mjs`

Expected: FAIL，当前每个商品只输出一行并忽略详情。

- [ ] **Step 3: 实现商品到 SKU 行的映射**

增加纯函数 `productRows(item)`。公共字段使用中文逗号和中文分号连接；第一行写列 A 到 N 与 SKU 列 O 到 V；后续行只写列 A 与 O 到 V。没有 SKU 时使用规范化模块生成的默认 SKU。

- [ ] **Step 4: 验证 BIFF8 模板兼容**

Run: `node --test tests/xlsx.test.mjs tests/xls.test.mjs && python scripts/verify-xls.py`

Expected: PASS；模板仍为 22 列，样式、合并区域和列宽匹配。

---

### Task 7: 完整验证、版本更新和交付包

**Files:**
- Modify: `extension/manifest.json`
- Modify: `README.md`
- Modify: `拼多多主图选品助手-模板版/extension/**`
- Rebuild: `拼多多主图选品助手-模板版.zip`

**Interfaces:**
- Consumes: Tasks 1–6 的最终扩展目录。
- Produces: 可加载的解压目录、ZIP 包、测试导出文件。

- [ ] **Step 1: 运行完整测试和静态检查**

Run: `npm test && npm run check && python scripts/verify-xls.py && python scripts/verify-xlsx.py`

Expected: 所有命令退出码为 0，没有警告或失败。

- [ ] **Step 2: 用真实商品做只读详情验证**

在用户已登录的 Chrome 中读取一个含多规格商品和一个缺少部分字段的商品。检查商品 ID、主图、详情图、属性、规格名称、SKU 组合和价格；不得修改拼多多或货憨憨数据。

- [ ] **Step 3: 生成测试 Excel 并独立读取验证**

用采集结果生成 `.xls`，再用独立 BIFF8 读取器检查 22 列、商品数、SKU 行数、重复产品主编号和必填列。测试文件保存在工作目录中，正式扩展不内置测试商品。

- [ ] **Step 4: 更新版本和说明**

将 manifest 版本从 `1.1.3` 提升到 `1.2.0`。README 说明完整详情采集、SKU 多行、缺失字段留空和详情阶段可能需要更长时间。

- [ ] **Step 5: 同步加载目录并重新打包**

将 `extension` 内容同步到 `拼多多主图选品助手-模板版/extension`，重新生成 `拼多多主图选品助手-模板版.zip`，验证 ZIP CRC、manifest 版本以及包内文件与源目录一致。

- [ ] **Step 6: 最终浏览器验收**

在 `chrome://extensions` 刷新插件，输入一个商品名称，确认搜索满 20 条后进入详情补全；导出 Excel 并核对货憨憨能识别一个多 SKU 商品。上传到货憨憨会新增账号数据，执行前使用用户已有明确授权或由用户自行上传。
