# Claude Gateway

一个跑在 Windows 本机的 Claude Desktop 多上游网关：把 Claude Desktop 的请求转发到你自己的模型服务，
同时支持 **Anthropic 协议** 和 **OpenAI 协议** 的上游。

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

### 需要自备的东西

本仓库**不包含任何第三方二进制**，需要自己准备并放进对应目录：

| 文件 | 放到 | 从哪来 |
|---|---|---|
| `node.exe` | `payload/gateway/` | [Node.js](https://nodejs.org/) 官方 Windows 版（v22 可用） |
| `magpie.exe`（可选） | `payload/magpie/` | 你使用的本地代理工具 |
| `Claude-win-x64.msix`（可选） | `payload/claude/` | 微软商店版 Claude Desktop 的安装包 |

不放 Magpie 也能用——只要你在面板里接一个别的上游。

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
