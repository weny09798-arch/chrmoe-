# 1.6.8 单张商品卖点图验收记录

日期：2026-10-14。原基线085b96f；后台实现5d5f2d2、审查修复e07c8ee；插件实现0b70a87、预览恢复修复db5e441。

## 自动验证

| 项目 | 实际结果 | 证据 |
| --- | --- | --- |
| 完整 Python 回归 | 512 passed、1 skipped、0 failed | artifacts/selling-point-full-python.log |
| 完整 Node 回归 | 441 passed、0 failed、0 skipped | artifacts/selling-point-full-node.log |
| 单图界面重点测试 | 18 passed | tests/selling-point*.test.mjs |
| 新后台重点测试 | 34 passed、1 skipped | doubao-image-tool/tests/test_selling_points.py |
| 插件脚本与清单 | npm run check通过 | scripts/check.mjs |
| 源码空白检查 | git diff 085b96f --check通过 | Git范围检查 |
| 真实便携程序重新构建 | PyInstaller EXE及COLLECT退出0 | artifacts/selling-point-build.log |

Python唯一跳过项是当前Windows没有创建符号链接的权限；另有不跳过的模拟链接和junction拒绝测试，不能把它们宣称为真实符号链接完整验收。原基线完整Python曾有一次既有queue_drain别名并发测试间歇失败，立即重跑该文件20项通过；新版本最终完整512项通过，未为该基线现象修改采集队列。

测试先验证缺失行为再实现；六个插件边界回归在初版代码下失败，修复后通过。独立代码审查发现并修复后台worker清理误删后继上传缓存、文件异常泄露绝对路径、原图预览失败无法重试三个问题，各有确定性回归及复审。升级版本的三个旧能力断言先失败，再统一至1.6.8并验证135项通过。

## 真实程序与浏览器的隔离验收

`artifacts/selling_points_portable_smoke.py` 使用重新构建的真实 EXE、独立临时状态目录，无Chrome用户资料、注册表或客户配置。真实Windows DPAPI保存/删除虚构配置，不回显密钥；真实上传图片、手工草稿、中文字体/OpenCC排字、未配置OSS时保留PNG、下载、仅上传重试、独立清空通过。原图区域逐像素核对相同，PNG可完整解码。**实际模型调用0、OSS网络调用0**。日志为 artifacts/selling-point-portable-smoke.log，排版样本为 artifacts/selling-point-portable-preview.png。

`artifacts/selling_points_chrome_smoke.py` 在临时Chrome配置中加载真实MV3插件界面，使用真实本机HTTP服务，自动连接边界由临时背景脚本提供。视觉理解及OSS发布边界使用模拟对象：一轮模拟文案调用、首次模拟上传失败及一次模拟上传重试。完成真实PNG下载和原图像素比较；刷新恢复名称、参数和草稿；清空不改变采集任务；页面JavaScript错误为空。**实际模型调用0、实际OSS调用0**。日志 artifacts/selling-point-chrome-smoke.log，截图 artifacts/selling-point-plugin-preview.png。没有将模拟成功链接描述为已通过真实匿名读取。

本次UI验收初次遇到测试脚本假定EXE中文输出为UTF-8、以及Chrome CSP禁止wait_for_function内部eval；仅修正隔离验收脚本读取ASCII网址和轮询方式，产品未放宽CSP。完整验收重跑通过。原生自动启动/登记仍沿用旧版实现，未重复修改或验收客户机器上的实际登记。

## 交付与使用

包内插件及后台版本1.6.8，固定目录仍为 `交付包/商品采集与图片转换_1.6.1` 及同名唯一ZIP。包含完整运行依赖、源码、中文字体与OFL许可、OpenCC许可、安装/卸载入口、百炼教程和OSS教程，不包含客户密钥、登录、浏览器配置、测试图片或临时任务。最终目录/ZIP成员与源码及已验证便携目录逐文件核对，详情在包外 artifacts/selling-point-final-package.json；压缩包摘要放在包外避免自引用。

升级须同时刷新原插件加载目录并运行新版后台安装入口；仅刷新插件不能更新已安装后台副本。未合并月度授权分支，旧翻译渠道保持豆包/阿里云，Google/GPT图片编辑未加入。

## 真实验收边界

本次没有使用真实百炼API Key、付费生成卖点、真实OSS上传或读取、客户电脑后台安装、在线整批商品采集及货憨憨导入。实际账号权限、价格、网络、卖点准确性和真实OSS链接由用户配置并点击付费按钮后用少量样图验收。程序保持原图像素；模型是否准确理解商品资料仍需人工确认。
