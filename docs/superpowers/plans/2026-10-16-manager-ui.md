# 插件管理界面改版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 实现用户已批准的蓝白左侧折叠菜单和四个独立功能页。

**Architecture:** 复用同一管理页面和所有业务控件，新增只负责视图切换的导航模块；将配置表单移到设置页。后台和运行器不因导航销毁，原导出入口移到公共顶栏。

**Tech Stack:** Chrome MV3、HTML/CSS、原生 JavaScript Modules、Node test/linkedom、Playwright Chromium。

## Global Constraints

- 用户已批准 `docs/superpowers/specs/2026-10-16-manager-ui-design.md`。
- 当前分支就地工作，沿用现有固定交付目录与单一压缩包。
- 所有业务字段 ID、任务存储、运行器、付费确认和结果替换语义保留。
- 导航状态仅保存功能页标识，不存密钥或商品数据。
- 不新增真实付费调用；后台程序继续使用可兼容的 1.6.9，插件 UI 版本为 1.6.10。

### Task 1: 导航、页面分区与状态保留

**Files:** Create `extension/manager-navigation.mjs`, `tests/manager-navigation.test.mjs`; Modify `extension/manager.html`, `extension/manager.mjs`.

**Interfaces:** `createManagerNavigation({document, storage})` 返回 `select(view, {target, focus})`；四个视图标识 `collection/conversion/selling/settings`。只改变 hidden、aria-current、标题和导航状态；保留所有业务节点。

- [x] 写测试覆盖默认入口、四页唯一可见、折叠、输入值及节点引用保留、非法恢复状态、禁用存储和跳转目标。
- [x] 运行 `node --test tests/manager-navigation.test.mjs`，确认缺少导航时失败。
- [x] 实现菜单及导航，通过 `createManagerNavigation({document})` 接入 manager；公共顶栏承载原导出控件。
- [x] 移动既有转换配置及百炼配置到设置页；百炼配置反馈显示在设置页，连接时读取配置不依赖卖点图开关。
- [x] 运行导航、manager、settings、conversion、selling 相关测试。

### Task 2: 视觉统一与浏览器检查

**Files:** Modify `extension/manager.css`, `extension/conversion-ui.mjs`, `extension/selling-point-ui.mjs`; Create offline browser acceptance artifact under ignored `artifacts/`.

- [x] 补齐全局排版、表单、按钮、卡片、表格、空状态和蓝白导航；窄窗口菜单可收起，表格内部滚动。
- [x] 更新转换提示，将缺少密钥时的指引链接到服务设置。
- [x] 在实际 Chromium 检查四页、折叠、窄窗、刷新恢复、隐藏区键盘不可进入及配置反馈。
- [x] 使用模拟后台确认转换中切换页面不停止轮询，不增加生成请求；模拟采集确认页面切换不终止当前运行。
- [x] 运行 `npm test`、`npm run check` 和 `git diff --check`，修复本次引入的问题。

### Task 3: 说明、交付与 Git

**Files:** Modify `extension/manifest.json`, `README.md`; Create `docs/插件新版界面使用说明.md`.

- [x] 插件版本更新 1.6.10，文档说明四个入口、设置位置和刷新扩展步骤；后台不需要重新安装。
- [x] 检查改动与批准设计一致，使用本地 Git 保存代码和验证记录。
- [x] 只覆盖固定交付目录中的插件与说明，保留现有后台程序；重建同一个压缩包并核对文件哈希。
- [x] 交付压缩包、操作说明和界面截图，明确验证范围。
