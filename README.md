# Claude Gateway

一个跑在 Windows 本机的 Claude Desktop 多上游网关：把 Claude Desktop 的请求转发到你自己的模型服务，
同时支持 **Anthropic 协议** 和 **OpenAI 协议** 的上游，简单的说可以同时有好几个供应商，比如workbuddy账号模型，某个中转站，deepseek等同时在claude上，值得一提的是claudedesktop只支持10个模型接入。

> 个人项目，非官方。Claude Desktop 是 Anthropic 的商标，本项目与 Anthropic 无关。

## 它解决什么问题

Claude Desktop 的「第三方网关」模式（3p）原本只对企业开放，而且它的两个配置文件
**只在登录成功之后才会生成**。全新机器上第一次启动会卡在登录页 / 地区限制，永远走不到下一步。

这个项目做三件事：

1. **提前生成 3p 配置**，让 Claude Desktop 首次启动就直接进入主界面，不再卡登录页
2. **在本地做一个模型网关**，把 Claude 认的模型名（`claude-opus-5` 这类）翻译成你上游的真实模型名
3. **兼容两种上游协议**，只有 OpenAI 接口的中转站也能接进来

```
Claude Desktop
      │  POST /v1/messages（Anthropic 协议）
      ▼
127.0.0.1:15722  ← 本项目
      │
      ├── Anthropic 兼容上游：原样转发
      │     DeepSeek /anthropic、自建服务、Claude 兼容中转
      │
      └── OpenAI 兼容上游：协议转换后转发
            GPT 系列、大多数中转站
```

## 特性

- **协议自动识别**：保存上游时探一次 `/v1/messages`，403 / 404 判定为 OpenAI 兼容，自动切换转换逻辑，不用手选
- **双向协议转换**：system、多模态图片、`tool_use` / `tool_result`、流式 SSE 全部换算；推理模型自动改用 `max_completion_tokens`
- **多上游并存**：每个模型条目指定走哪个上游，面板里改完热生效
- **模型自动命名**：上游模型名自动分配 Claude 认的 `claude-<档位>-<数字>` 名字，四个档位 opus / sonnet / haiku / fable
- **控制面板**：模型表、上游管理、还原点、请求日志
- **托盘程序**：无窗口守护网关，掉线自动拉起
- **一键恢复**：把 Claude 的配置恢复成原装状态，可回退

## 目录

```
claude-gateway/
├── payload/gateway/        网关源码（Node.js，无第三方依赖）
│   ├── gateway.js          主程序：HTTP 服务、模型路由、管理面板接口
│   ├── openai-bridge.js    Anthropic ↔ OpenAI 协议转换
│   ├── restore.js          读写 Claude 的 3p 配置
│   ├── bootstrap.js        首次安装时生成 3p 配置
│   ├── panel.html          控制面板
│   ├── tray.ps1            托盘守护
│   └── version.json        版本号（唯一来源）
├── payload/magpie/         可选：本地代理，自行放入
├── payload/claude/         可选：Claude Desktop 安装包，自行放入
├── install.ps1             网关 + 托盘安装
├── install-claude.ps1      Claude Desktop 安装 + 3p 配置
├── uninstall.ps1           卸载
└── examples/               配置样例
```

## 快速开始

### 三种使用方式，先选对

| 场景 | 用什么 | 桌面上会出现 |
|---|---|---|
| 只想用网关卡（自己接上游） | 源码仓库 + `install.ps1` | `Claude 网关` |
| 要 Magpie 的 WorkBuddy 额度 | **完整部署包**（Release 里的 ZIP） | `Claude 网关` + `Magpie` |
| 还要装 Claude Desktop | 再加 `install-claude.ps1` | 再加 `Claude` |

**桌面图标一共三个：**

| 图标 | 谁创建 | 指向 |
|---|---|---|
| `Claude 网关.url` | `install.ps1` | 控制面板 `http://127.0.0.1:15722/admin` |
| `Magpie.lnk` | `install.ps1`（需要 `magpie.exe`） | `%LOCALAPPDATA%\ClaudeGateway\magpie\magpie.exe` |
| `Claude.lnk` | `install-claude.ps1` | 商店版 Claude Desktop |

`install.ps1` 装完会自检，最后一行会打印：

```text
桌面图标检查：网关 + Magpie 都在
```

只显示「只有网关，Magpie 缺失」，说明你用的是源码仓库——它没有 `magpie.exe`，换完整部署包即可。

### 依赖与下载

本仓库**不提交任何第三方二进制**。安装顺序是「本地优先，网络兜底」：

| 依赖 | 大小 | 从哪来 |
|---|---|---|
| `node.exe` | 83 MB | 先找 `payload/gateway/node.exe`；没有则从 npmmirror / nodejs.org 下载，**支持断点续传** |
| `Claude-win-x64.msix` | 285 MB | 先找同目录/相邻的 `Claude网关部署包`；没有才从本项目 Release 下载，`curl` 断点续传 + SHA256 校验 |
| `magpie.exe` | 98 MB | 只在完整部署包里有，源码仓库没有 |

也可以手动指定本地文件，完全不走网络：

```powershell
$env:CLAUDE_NODE_EXE = 'D:\somewhere\node.exe'
$env:CLAUDE_MSIX_PATH = 'D:\somewhere\Claude-win-x64.msix'
.\install.ps1
.\install-claude.ps1
```

**下载慢怎么办**：GitHub Release 在国内可能很慢。直接用 Release 里的**完整部署包 ZIP**（359 MB，含全部二进制），
解压后本地安装，全程零下载。

### 安装

```powershell
# 1. 安装网关（会申请管理员权限）
.\install.ps1

# 2. 安装 Claude Desktop 并写入 3p 配置（如果还没装）
.\install-claude.ps1
```

或者双击对应的 `.cmd`。

### 配置模型

1. 打开面板 `http://127.0.0.1:15722/admin`
2. 上游页 → 添加，填 Base URL 和 API Key
3. 点「自动填充」，它会拉模型列表、自动起名、自动分档
4. 模型页 → 保存并应用 → 重启 Claude

## 配置

### `payload/gateway/upstreams.json`

```json
{
  "version": 2,
  "upstreams": [
    {
      "id": "relay",
      "label": "某个中转",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "sk-...",
      "modelsPath": "/v1/models",
      "api": "openai"
    }
  ]
}
```

`api` 字段可以省略，安装后第一次保存时会自动识别。取值 `anthropic` 或 `openai`。

### `payload/gateway/models.json`

```json
[
  {
    "id": "claude-sonnet-5",
    "target": "gpt-6.2-sol",
    "upstream": "relay",
    "label": "GPT-6.2 Sol",
    "tier": "sonnet",
    "isDefault": true
  }
]
```

- `id` 必须是 `claude-<小写字母>-<数字>`，否则 Claude 会静默丢弃
- `target` 是上游的真实模型名
- 每个档位只能有一个 `isDefault`

## 已知限制

- 只支持 Windows，且只支持 **微软商店 MSIX 版** Claude Desktop
- 协议转换是有损的：OpenAI 协议没有 `thinking` 块，这部分会被丢弃
- 流式响应的 `input_tokens` 恒为 0（`message_start` 时上游还没给出用量）
- 不做故障转移，上游挂了直接报错
- 与 CC Switch 等修改同一份配置的工具不能同时使用

## 免责声明

本项目仅用于个人学习和本地环境实验。使用第三方模型服务请遵守对应服务商的条款。
Claude Desktop 的「第三方网关」是它的正式功能，但本项目对配置的写入方式属于自动化操作，
请自行评估风险。

## License

MIT，见 [LICENSE](LICENSE)。
