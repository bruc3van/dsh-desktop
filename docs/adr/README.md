# 架构决策记录（ADR）

记录以后很难改的决定：当时为什么这么选，放弃了什么。新决定追加编号，旧决定被推翻时在原文里标注「已被 ADR-xxxx 取代」，不删除。

| 编号 | 决定 |
|---|---|
| [0001](0001-one-binary-enterprise-mode.md) | 同一个安装包，按企业配置切换企业模式 |
| [0002](0002-desired-state-reconciliation.md) | 期望状态文档 + 客户端对账，文件与服务端共用一套 |
| [0003](0003-signatures-and-device-proof.md) | 组织签名、密钥固定与设备证明 |
| [0004](0004-hard-and-soft-controls.md) | 硬管控在网关，软管控在客户端 |
| [0005](0005-portable-storage-tenant-id.md) | 可移植 SQL、全表 `tenant_id`、单仓库 monorepo |
| [0006](0006-open-source-apache.md) | 全部开源，Apache-2.0，不做商业版 |
