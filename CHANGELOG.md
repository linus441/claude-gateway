# 变更记录

版本号的唯一来源是 `payload/gateway/version.json`，安装脚本、控制面板和 `/health` 都读它。

## 0.3.0 — 2026-11-21

- 上游协议改为自动识别：保存时探一次 `/v1/messages`，403 / 404 判定为 OpenAI 兼容
- 移除「上游协议」下拉，避免选错导致 `403 This group does not allow /v1/messages dispatch`
- 识别结果存进 `upstreams.json`，改显示名不会重新探测
- 推理模型判断从 `gpt-5` 扩展到 `gpt-5` ~ `gpt-9`
- 修复模型指向的上游不存在时连接永久挂死
- 修复流式上游 socket 断开时连接永久挂死
- 修复流式 `content_block_stop` 顺序可能和 `content_block_start` 不一致

## 0.2.0 — 2026-11-21

- 新增 `openai-bridge.js`：Anthropic ↔ OpenAI Chat Completions 双向转换
- Claude Desktop 安装从一键部署中拆出，改为独立安装器
- 桌面分别创建 Magpie 和 Claude 图标
- 托盘与面板文案改为「重启/打开」
- 「一键恢复配置」改为「恢复原装 Claude 设置」

## 0.1.0 — 2026-11-20

- 首个可用版本：网关、托盘、控制面板、3p 配置生成
