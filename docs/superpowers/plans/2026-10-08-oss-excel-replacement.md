# 转换图片自动替换商品 Excel 实施记录

目标：本地结果上传 OSS 并验证后替换商品 Excel 图片链接，部分完成也可导出；取消独立 XLSX 清单。

任务：
1. OSS 配置、DPAPI、SDK V2 内容寻址上传与匿名校验。
2. 插件按图片位置持久化替换，导出时应用，移除清单按钮。
3. 本机队列上传阶段、重试和恢复；接口与配置界面。
4. 联合测试、文档、便携包、固定目录更新和 Git 保存。

接口约定：bridge capabilities 添加 oss_configured、image_link_replacement=true；snapshot.items[].refs 增加 sku_index（SKU原数组索引，其余null）、published_url（仅成功校验后发布）、published_revision（可选单调结果版本）。旧 refs 默认用 order-1 补 SKU索引。商品位置依 source_task_id/platform/product_id/kind/order/sku_index/url 确认。counts 添加 uploaded、upload_failed。queue action 增加 retry-upload。插件替换映射持久保存于 collection task.imageReplacements，不改源商品；新链接只接受 HTTPS OSS 对象链接。正常关闭 queue 后已有映射保留。

默认：集成新任务必须 OSS 配置完成。独立本地文件转换可保留原行为。OSSPublisher(config).publish(path) -> {url,object_key,sha256}；target_id 为非秘密Bucket/region/前缀目标摘要；重试只上传本地结果。JSON内部映射保留，停止生成XLSX清单。

验证：Node/Python全套、SDK模拟、部分替换实际XLSX/XLS解码、便携程序配置与下载恢复检查。真实OSS和货憨憨验收须已有有效OSS配置；不猜测用户Bucket、不擅自发起收费翻译。
