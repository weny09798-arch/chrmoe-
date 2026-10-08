# 图片类型勾选与阿里云付费翻译 1.6.1 Implementation Plan

Goal: 在 1.6.0 上增加主图/详情/SKU 选择及阿里云电商图片翻译，保持采集与商品 Excel 不变。
Architecture: 管理页冻结所选图片位置与 provider；既有配对 bridge 和串行 QueueService 下载、精确去重、转换、保存；增加独立 Aliyun 适配器和 Windows DPAPI 凭证存储。

## Global Constraints
- 仅商品外广告简体转繁体；商品/包装文字数字图案保护，背景与排版默认关闭。
- 三类型默认全选，付费默认关闭；先筛选再去重，不用相似度去重，保留完整网址、顺序和 SKU。
- 原商品 Excel 不变，本地结果和独立清单保留；旧请求/旧任务默认 doubao 和三类型。
- 本批冻结配置，凭证仅本地加密存储，不出现在插件/日志/清单/交付包。
- 阿里云 TranslateImage 官方 SDK，zh -> zh-tw，Field=e-commerce，Ext.ignoreEntityRecognize='false'。
- 0.06 元/独立网址上限估算，不假定剩余免费额度；点击付费开始为调用授权，无额外预算，无自动付费回退。
- 翻译请求禁止自动重试；不确定暂停。持久化 RequestId/FinalImageUrl 后下载，恢复只下载已有结果；redo 明示可能再次计费。
- 在已有隔离 worktree 开发，保留现有未提交修改。不提交混合旧修改；使用每任务基线快照供差异审查。
- 实际付费调用仅由用户在成品页面点击发起；自动验收使用模拟云端，不使用真实账号密钥。

### Task 1: 本机阿里云后端、凭证配置与队列
Files: doubao-image-tool 下新增 aliyun_translation.py、credentials.py；修改 core.py/app.py/bridge_routes.py/web 与相应测试、requirements/build/许可证。
- 用 TDD 验证再实现真实 Windows DPAPI 凭证存储（用户 profile 根目录而非会被 reset 清除的 state，删除配置；错误不泄露 Secret/响应输入）、本机 token 与同源保护配置接口。
- 本机 UI 增加阿里云 AccessKey 表单、配置状态和删除按钮，密码字段提交后清空。配置未完成阻止付费开始，单纯配置不发起收费调用。
- 新增 GET /api/bridge/capabilities 返回 {version:'1.6.1', providers:['doubao','aliyun'], image_kinds:['main','detail','sku'], aliyun_configured:boolean, aliyun_price_per_image:0.06}；CORS preflight 支持 GET；同样状态供本机配置 UI（无 Secret）。
- POST bridge/jobs 接受 provider 和 image_kinds，旧值默认；白名单验证、空类型拒绝、按类型筛选 entries 再 build_items。aliyun 必须 paid_confirmed=true 和 configured 才可启动。
- QueueService.start_urls 增加可选 provider='doubao', image_kinds=None, paid_confirmed=False；job/snapshot 持久化 provider/image_kinds/paid_calls/estimated_cost_upper；旧 job 初始化兼容。配置通过 aliyun_factory 注入，保持原 browser_factory 签名兼容。
- 官方 alibabacloud_alimt20181012 Python SDK + Tea OpenAPI，Base64 静态 JPG/PNG/WEBP；endpoint alimt.cn-hangzhou.aliyuncs.com。SDK runtime autoretry=False，connect/read 总时限可控且小于关闭等待（用独立 helper 子进程硬时限如下载辅助进程，冻结可用），输出异常经过白名单错误分类和脱敏。10MB、双边15..8192、ratio<10，叠加已有静态格式限制；超限失败继续，不裁剪。
- aliyun_ready 提交前在锁内验证 closed/status/revision，持久化 submitting 和 paid_calls+=1（含不确定请求）；在途停止不丢弃已返回地址，恢复不重新提交。不持有队列锁进行长网络操作；凭证快照不进入 job。
- 成功先保存 RequestId/FinalImageUrl（私有状态）再取图片。新阶段 aliyun-downloading，异常恢复继续已有 URL，不打开 Chrome。结果使用既有静态验证、独立有界 HTTPS 下载，禁止内网和重定向到内网，保持签名参数。
- 明确单图云端错误标记 failed 并继续；鉴权/未开通/额度/余额/限流暂停；网络超时/不明确返回/5xx uncertain，continue 不会提交，明确 redo 可新调用。retry 用于已有结果下载，不清地址；redo 才清云端结果、使别名重用新图；停止/清空/关闭阻止新的提交和旧结果写入新任务。
- paid_confirmed 也要求在 aliyun redo 接口携带；工具 UI 和插件一致警告。后台 action 兼容现有免费请求。
- 详细测试 SDK参数、DPAPI roundtrip/delete、认证防泄漏、类型筛选、多 URL 同字节只调用一次、多商品路径与清单、无 Chrome、失败继续、鉴权暂停、unknown 不重提、下载恢复、停止中返回地址保留、清空、重启默认旧配置和超限。
- 测试报告含 RED/GREEN 命令和结果；不对真实付费服务发请求。

### Task 2: 插件图片选择、付费预览与模式联动
Files: extension/lib/image-conversion.mjs、conversion-ui.mjs、manager.html/css；tests/image-conversion.test.mjs、conversion-ui.test.mjs。
- TDD 所有7种非空勾选组合、空选择禁用/拒绝、同URL跨类、主图轮播顺序、多 SKU；buildImageManifest(task,imageKinds=all) 先筛类型，源 task 不变。
- 增加三 checkbox 默认全选和 paid checkbox 默认false，显示各类位置数、选中数和独立URL数。选择偏好可当前页保存，不改变运行中批次。
- Controller.start 增加第四参 options={imageKinds,provider,paidConfirmed}，旧签名默认免费全选；请求 wire image_kinds/provider/paid_confirmed。
- 连接及需要付费启动时读取 capabilities，404 支持免费旧工具，付费显示需升级；未 configured 显示本机配置入口（仅打开本机首页，带既有连接片段供UI token）。capabilities 查询无收费，不泄露密钥。
- 付费按钮显示独立URL *0.06 的上限金额及实际账单说明；用户直接点击清晰的付费开始即 paidConfirmed=true，不额外预算。清单内容与费用在同一同步时刻冻结后 start；provider/types/output 控件在未终结批次禁用，刷新通过 snapshot 恢复本批配置。
- 本批状态显示provider/imageKinds/paid_calls；阿里云模式隐藏豆包登录按钮，旧工具仅免费可用。成功返回 snapshots 校验 owned source。
- continue/retry 只恢复同批；redo 弹 confirm 可能再次计费并携带 paid_confirmed，未知提交不能用普通 retry 静默新付费。
- 清空/删除/晚到响应/刷新恢复现有防护保持，旧句柄免费全选兼容；原Excel函数不变。
- 运行 focused Node 红绿以及全套 Node/check；报告 RED/GREEN 与差异。

### Task 3: 联动验收、说明与 1.6.1 交付
- Node/Python 完整测试、资源语法检查、新SDK真实构造（不网络请求）及 Windows DPAPI实际往返；独立 Chrome for Testing 加载MV3，用mock云端验证勾选、费预览、点击付费、文件/清单与原商品数据不变。
- 冻结Windows便携工具，验证配置接口、SDK/依赖导入、配对、免费/付费任务、输出中文目录和恢复；mock服务调用不接真实账户。
- 更新阿里云开通/最小RAM授权 alimt:TranslateImage、配置、100张月免费但不自动扣预估、可能重复计费redo、长详情图超限、手工检查与交付说明。
- 本地工具和插件1.6.1发布目录 D:/Desktop/chrome插件/交付包/商品采集与图片转换_1.6.1，保留1.6.0，新增zip。排除用户配置、登录、密钥、验收状态/图片与临时文件。
- 逐任务与整体独立审查，修复所有重要问题；记录准确测试与实付验收未执行的边界。新源文件安全同步回主工作区，不覆盖无关修改。
