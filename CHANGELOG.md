# 变更记录

版本号的唯一来源是 `payload/gateway/version.json`，安装脚本、控制面板和 `/health` 都读它。

## 0.3.4 — 2026-11-21

- `install-claude.ps1` 优先使用本地/共享目录里的 MSIX，避免从 GitHub 下载 285 MB
- 新增 `vm-install-offline`：完全离线安装脚本，不发任何网络请求

## 0.3.3 — 2026-11-21

- 安装脚本支持把 `magpie.exe` 直接放在 `install.ps1` 同目录
- 安装结束自检：桌面网关图标和 Magpie 图标是否都创建成功
- 缺少 `magpie.exe` 时提示改用完整部署包，不再静默跳过

## 0.3.2 — 2026-11-21

- 安装脚本自动下载 Node 运行时（nodejs.org，失败回退 npmmirror）
- `magpie.exe` 改为可选：没有就跳过，不再因缺文件中止安装
- 补齐 `VERSION.txt`、`省空间说明.txt`

## 0.3.1 — 2026-11-21

- `install-claude.ps1` 自动下载 Claude MSIX 并校验 SHA256

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
