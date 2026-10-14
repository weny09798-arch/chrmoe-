# 1.6.7 阿里云错误诊断验证记录

日期：2026-10-14。诊断实现提交：`2add15f`；版本、当前版本测试和客户说明提交：`8baf05f`。仅增加安全错误诊断，不改变超时、重试次数、付费确认或服务选择。

## 本轮自动验证与构建

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 完整 Python 回归 | 478 passed，0 failed | artifacts/aliyun-diagnostics-final-python.log |
| 完整 Node 回归 | 423 passed，0 failed、0 skipped | artifacts/aliyun-diagnostics-final-node.log |
| 插件脚本与清单检查 | 通过，退出码 0 | artifacts/aliyun-diagnostics-final-check.log |
| e47de6e 起的范围空白检查 | 通过，退出码 0 | artifacts/aliyun-diagnostics-final-diff.log |
| PyInstaller 重新构建完整运行目录 | EXE/COLLECT 完成，退出码 0 | artifacts/aliyun-diagnostics-build.log |

首轮完整 Python 回归为 477 passed、1 failed：原生后台测试桩仍硬编码当前版本 1.6.6。仅改新启动的假后台报告当前 VERSION，旧 1.6.6 描述文件样本保留；重新完整运行后 478 项通过。首轮日志保留为 artifacts/aliyun-diagnostics-version-fixture-red.log。构建有两条 pycparser.lextab/yacctab 隐藏导入未找到警告；构建成功，编译入口的实际运行结果单独记录。

27 项新诊断回归用受控 SDK/Tea 异常、辅助进程输出和离线队列验证：安全错误码、HTTP 状态和请求 ID 从 SDK 经辅助进程传到保存记录与快照；原始异常、响应、标准输出/错误、密钥及签名链接不泄露；包装超时、连接异常、无效结果、本机进程超时/协议错误/异常退出保留类别。旧辅助进程错误格式及旧不确定记录仍兼容。两张不同内容图片的回归保留第一张完成及发布关系，第二张不确定；继续和重启不重提，只有明确再次付费确认后重新生成第二张。

## 编译程序隔离验证

主任务执行以下两项脚本，均退出码 0；本发布任务读取脚本及输出后同步记录。它们使用项目 artifacts 内的临时目录，与客户已安装组件和状态分离。

- artifacts/aliyun-diagnostics-native-smoke.log：重新构建的真实 EXE 以原生消息建立两条通道，两条通道的连接码相同、复用一个后台；版本与能力为 1.6.7。配对设置、未知字段拒绝、真实 Windows DPAPI、Secret 不回显及临时卸载后配置/标记保留通过。注册表为假实现，real_registry_modified=false，paid_calls=0；进程 stderr 为空，临时就绪描述清理。
- artifacts/aliyun-diagnostics-helper-smoke.log：真实 EXE 的 --aliyun-translate 入口使用 14×32 的无效测试图，在付费 SDK Client 构造前被拒绝。进程按预期退出 1，脚本确认旧版过滤输出只有 {"error":"uncertain"}，无 stderr、无新建状态、无测试 Secret，actual_paid_calls=0。

上述编译入口验证不证明真实 SDK 的服务错误诊断或在线翻译；SDK 错误元数据传递由离线测试覆盖。本轮没有真实阿里云请求、OSS 上传或生产 Chrome 登记。

1.6.6 的真实 Chromium 原生通信、设置与 DPAPI、刷新恢复和部分 XLSX 导出属于历史基线，见 2026-10-12-unified-plugin-verification.md；没有把这些旧证据当作 1.6.7 全部浏览器功能重测。

## 交付校验

沿用固定目录 `交付包/商品采集与图片转换_1.6.1` 及同名唯一 ZIP，历史目录名不变，包内版本为 1.6.7。包含插件、完整后台运行依赖、source 源码、安装/卸载入口、许可证及客户说明。

交付目录为 **2,677 个文件**，最终 ZIP 为 **2,677 个成员**，逐成员 SHA-256 与文件夹一致，无重复、缺失或多余成员，ZIP CRC 检查通过。插件逐文件与 extension 源码一致，完整运行目录逐文件与重新构建的便携目录一致；程序 Python/web 实现先与源码核对再同步文档。EXE SHA-256：`92b8b24fd499dbd71b0180a1bb1edf39dc970f20b412648ac45a1466fd7105b7`。ZIP 的最终 SHA-256 仅记录在包外交付报告，避免包内自引用。

证据为 artifacts/aliyun-diagnostics-final-package-sync.log、artifacts/aliyun-diagnostics-final-package.log 和 artifacts/aliyun-diagnostics-final-package.json。同步前检查目标绝对路径、目录链接；仅替换既有交付内两个明确命名的程序子目录，不新建重复整包目录。交付不包含客户配置、生成的主机登记、DPAPI 密钥文件、登录、浏览器配置、任务、缓存或测试样本；不接触客户 LOCALAPPDATA。包内客户说明和本验收记录在最终逐成员校验前同步。最终分支审查、合并及标签由主任务完成，本记录不宣称已经合并或打标签。

## 当前批次与验证边界

旧第二张错误缺少诊断和结果地址，具体原因仍未知，不能通过普通继续恢复，也没有重新转换。修复只帮助后续新错误的排查，不能证明原问题已解决或该次未计费。客户批次仍暂停，第一张已发布结果保留；是否仅对第二张重新生成由客户明确操作并再次确认付费，可能再次计费。升级需用现有插件编号运行新版安装入口更新已安装后台，再刷新插件；DPAPI 配置、登录及恢复记录保留。保存配置不生成图片。

本轮真实付费调用为 **0**，没有使用客户状态、密钥、登录配置或生产 Chrome 登记。没有验收真实 OSS 上传与匿名读取、真实阿里云请求、在线商品整批采集或真实生成图文字效果。2026-10-04 的五张豆包生成属于历史独立流程证据。实际账号权限、额度、网络、账单和文字质量仍需使用时确认。
