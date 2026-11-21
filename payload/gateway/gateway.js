// Claude Desktop 多上游网关
// 模型清单放在 models.json，这里只负责：把 claude-* 名字翻译成上游真实模型并转发
//   magpie   -> http://127.0.0.1:3425/v1    （WorkBuddy 账号额度）
//   deepseek -> https://api.deepseek.com/anthropic （官方 key）
//   agnes    -> https://api.agnes-ai.cn/v1   （官方 key，地址与 key 见 agnes.json）
// 同时提供 /v1/models，让桌面版下拉框列出全部模型

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFile, spawn } = require('child_process');

// 版本号的唯一来源：同目录的 version.json
const VERSION_INFO = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')); }
  catch (e) { return {}; }
})();
const VERSION = String(VERSION_INFO.version || '0.0.0');
const VERSION_DATE = String(VERSION_INFO.date || '');

// 托盘模式（--quiet 或 GATEWAY_QUIET=1）：进程由托盘程序以无控制台方式启动，stdout 不可写
// 把所有控制台输出掐掉，日志照旧只进 gateway.log，避免无效句柄导致 node 报错
if (process.env.GATEWAY_QUIET === '1' || process.argv.indexOf('--quiet') > 0) {
  const noop = () => {};
  console.log = noop; console.info = noop; console.debug = noop;
  console.warn = noop; console.error = noop;
}

const PORT = 15722;
// 上游（地址 / key / 模型列表路径）全部集中在 upstreams.json
// 在控制面板里改完保存即热生效，不用改代码、不用重启网关
const UP_FILE = path.join(__dirname, 'upstreams.json');

// 内置默认值：upstreams.json 丢失或损坏时用它重建，保证网关仍能起来
// 云端上游的 key 一律留空——只在环境变量里给，绝不写死在代码里（打包分发会带走源码）
const DEFAULT_UPSTREAMS = [
  { id: 'magpie', label: 'Magpie', baseUrl: 'http://127.0.0.1:3425',
    apiKey: 'magpie', modelsPath: '/v1/models', builtin: true },
  { id: 'deepseek', label: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/anthropic',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    modelsPath: '/models', builtin: true },
  { id: 'agnes', label: 'Agnes 官方', baseUrl: 'https://api.agnes-ai.cn/v1',
    apiKey: process.env.AGNES_API_KEY || '',
    modelsPath: '/v1/models', builtin: true }
];

// Base URL -> 转发参数
// 规则：末尾的 /v1 要去掉，因为 Claude 发过来的路径本身就带 /v1/messages
//   https://api.x.com/v1        -> prefix ''        目标 /v1/messages
//   https://api.x.com/openai/v1 -> prefix '/openai' 目标 /openai/v1/messages
//   https://api.deepseek.com/anthropic -> prefix '/anthropic'
function parseBaseUrl(baseUrl) {
  const u = new URL(String(baseUrl || '').trim());
  let p = u.pathname.replace(/\/+$/, '');
  if (p.endsWith('/v1')) p = p.slice(0, -3);
  return {
    proto: u.protocol === 'http:' ? 'http' : 'https',
    host: u.hostname,
    port: Number(u.port) || (u.protocol === 'http:' ? 80 : 443),
    prefix: p
  };
}

function buildUpstreams(list) {
  const out = {};
  for (const it of list) {
    if (!it || !it.id) continue;
    try {
      out[it.id] = Object.assign(parseBaseUrl(it.baseUrl), {
        key: String(it.apiKey || ''),
        modelsPath: String(it.modelsPath || ''),
        baseUrl: String(it.baseUrl || ''),
        label: String(it.label || it.id),
        // anthropic = 上游自己说 Anthropic 协议；openai = 网关负责转换
        api: it.api === 'openai' ? 'openai' : 'anthropic',
        // 实测不可用的模型（图片/视频/额度不足等），拉列表时直接滤掉
        blockModels: Array.isArray(it.blockModels) ? it.blockModels.slice() : []
      });
    } catch (e) {
      log('[warn] 上游 ' + it.id + ' 的地址无效：' + it.baseUrl);
    }
  }
  return out;
}

let UP_LIST = [];
let UPSTREAMS = {};

function loadUpstreams() {
  let list = null;
  try {
    const j = JSON.parse(fs.readFileSync(UP_FILE, 'utf8'));
    if (Array.isArray(j.upstreams) && j.upstreams.length) {
      list = j.upstreams.map(u => {
        if (u && u.id === 'magpie' && u.label === 'Magpie · WorkBuddy') {
          return Object.assign({}, u, { label: 'Magpie' });
        }
        return u;
      });
    }
  } catch (e) {}
  if (!list) {
    list = JSON.parse(JSON.stringify(DEFAULT_UPSTREAMS));
    try {
      fs.writeFileSync(UP_FILE, JSON.stringify({ version: 1, upstreams: list }, null, 2), 'utf8');
      log('[boot] upstreams.json 不存在，已按内置默认生成');
    } catch (e) {
      log('[warn] 写入 upstreams.json 失败: ' + e.message);
    }
  }
  UP_LIST = list;
  UPSTREAMS = buildUpstreams(list);
  return list;
}

// 兼容早期写死的四个名字
const LEGACY = {
  'claude-opus-5': 'opus',
  'claude-sonnet-5': 'sonnet',
  'claude-haiku-4-5': 'haiku',
  'claude-fable-5': 'fable'
};

function loadModels() {
  const file = path.join(__dirname, 'models.json');
  let list = [];
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(j)) list = j;
  } catch (e) {
    // 读不到就按空表启动：全新部署时 models.json 就是 []
  }
  // 空模型表是合法状态（全新安装），等用户在面板里加
  return list.filter(m => m && typeof m.id === 'string' && m.id).map(m => {
    // 旧版自动填充把上游后缀写成了 WorkBuddy；现在上游显示名统一为 Magpie
    if (m.upstream === 'magpie' && typeof m.label === 'string') {
      m.label = m.label.replace(/WorkBuddy\s*$/i, 'Magpie');
    }
    return m;
  });
}

let MODELS = loadModels();

// ---- 控制面板需要的东西 ----
const STARTED_AT = Date.now();
const PANEL_FILE = path.join(__dirname, 'panel.html');
const ICON_FILE = path.join(__dirname, 'gateway.ico');
const LOG_RING = [];
const LOG_MAX = 400;
// Magpie 可执行文件：环境变量 → 同包 ../magpie → 同目录 magpie → 老位置 D:\magpie
// （打包部署时 magpie 跟网关放同级，就不需要改这里的代码）
const MAGPIE_EXE = (() => {
  const cands = [
    process.env.MAGPIE_EXE,
    path.join(__dirname, '..', 'magpie', 'magpie.exe'),
    path.join(__dirname, 'magpie', 'magpie.exe'),
    'D:\\magpie\\magpie.exe'
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return cands[0] || 'magpie.exe';
})();

// 这台机器上装了**两个** Claude：
//   1) 商店/3p 版：C:\Program Files\WindowsApps\Claude_...\app\Claude.exe，数据在 %LOCALAPPDATA%\Claude-3p
//      —— 你平时用的就是这个，自定义网关配置只对它生效
//   2) 旧的 Squirrel 版：%LOCALAPPDATA%\AnthropicClaude\claude.exe，数据在 %APPDATA%\Claude
//      —— 在国内启动它必然卡在 “only available in certain regions”，看起来像被墙，其实是装错版本
// 之前面板重启时启动的是第 2 个，所以才会出现 App unavailable。
const CLAUDE_PFN = 'Claude_pzs8sxrjxfjjc';                 // 包族名，版本升级也不变
const CLAUDE_AUMID = CLAUDE_PFN + '!Claude';
const CLAUDE_DATA = path.join(process.env.LOCALAPPDATA || '', 'Claude-3p');
const CLAUDE_OLD_EXE = path.join(process.env.LOCALAPPDATA || '', 'AnthropicClaude', 'claude.exe');

const LOG_FILE = path.join(__dirname, 'gateway.log');
const LOG_STREAM = (() => {
  try {
    const st = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : null;
    if (st && st.size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, path.join(__dirname, 'gateway.1.log'));
  } catch (e) {}
  return fs.createWriteStream(LOG_FILE, { flags: 'a' });
})();

function log(...args) {
  const line = new Date().toISOString() + ' ' + args.join(' ');
  LOG_RING.push(line);
  if (LOG_RING.length > LOG_MAX) LOG_RING.shift();
  console.log(new Date().toISOString(), ...args);
  try { LOG_STREAM.write(line + '\n'); } catch (e) {}
}

// 任何漏网的异常都不要让网关直接退出——它一死，Claude 就整个用不了
process.on('uncaughtException', e => {
  log('[fatal] 未捕获异常: ' + (e && e.stack ? e.stack.split('\n')[0] : e));
});
process.on('unhandledRejection', e => {
  log('[fatal] 未处理的 Promise 拒绝: ' + (e && e.message ? e.message : e));
});

// OpenAI 兼容上游的协议转换层；文件缺失时只有 openai 上游不可用，其余照常
let BRIDGE = null;
try { BRIDGE = require('./openai-bridge.js'); } catch (e) { log('[boot] openai-bridge.js 加载失败: ' + e.message); }

loadUpstreams();
log('[boot] Claude 网关 v' + VERSION + (VERSION_DATE ? ' (' + VERSION_DATE + ')' : ''));
log('[boot] 上游 ' + UP_LIST.length + ' 个：' + UP_LIST.map(u => u.id).join(' / '));

function catalogEntry(m) {
  return {
    id: m.id,
    display_name: m.label,
    created_at: '2026-01-01T00:00:00Z',
    anthropic_family_tier: m.tier,
    is_family_default: !!m.isDefault,
    max_input_tokens: m.ctx || 1000000,
    supports_1m: true,
    description: m.target
  };
}

function byTier(tier) {
  return MODELS.find(m => m.tier === tier && m.isDefault) || MODELS.find(m => m.tier === tier);
}

function pickModel(requested) {
  const id = String(requested || '').toLowerCase();
  const exact = MODELS.find(m => m.id.toLowerCase() === id);
  if (exact) return exact;

  const legacyTier = LEGACY[id];
  if (legacyTier && byTier(legacyTier)) return byTier(legacyTier);

  if (id.includes('opus')) return byTier('opus');
  if (id.includes('haiku')) return byTier('haiku');
  if (id.includes('fable')) return byTier('fable');
  return byTier('sonnet');
}

function forward(up, url, method, headers, body, res) {
  const lib = up.proto === 'https' ? https : http;

  const h = Object.assign({}, headers);
  delete h['host'];
  delete h['content-length'];
  delete h['connection'];
  delete h['accept-encoding'];
  delete h['x-api-key'];
  delete h['authorization'];
  h['host'] = up.host;
  h['content-length'] = String(body.length);
  h['x-api-key'] = up.key;
  h['authorization'] = 'Bearer ' + up.key;

  const req = lib.request({
    host: up.host,
    port: up.port,
    path: up.prefix + url,
    method,
    headers: h
  }, upRes => {
    const out = Object.assign({}, upRes.headers);
    delete out['content-encoding'];
    delete out['transfer-encoding'];
    res.writeHead(upRes.statusCode || 502, out);
    upRes.pipe(res);
    upRes.on('end', () => {
      if (upRes.statusCode >= 400) log('[upstream] ' + upRes.statusCode + ' ' + up.prefix + url);
    });
  });

  req.on('error', err => {
    log('[error] ' + up.proto + '://' + up.host + ' ' + err.message);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.message } }));
  });

  req.setTimeout(600000, () => req.destroy(new Error('upstream timeout')));
  req.end(body);
}

// ============ 控制面板（只允许本机 127.0.0.1 访问）============

const MODELS_FILE = path.join(__dirname, 'models.json');
const CFG_LIB = path.join(process.env.USERPROFILE || process.env.HOME || '', 'AppData', 'Local', 'Claude-3p', 'configLibrary');
const TIERS = ['opus', 'sonnet', 'haiku', 'fable'];
const ID_RE = /^claude-[a-z]+-\d+(-\d{1,2})?$/; // Claude 桌面版只认这个形状，其它会被静默丢掉

let RESTORE = null;
try { RESTORE = require('./restore.js'); } catch (e) { log('[admin] restore.js 加载失败: ' + e.message); }

const stampNow = () => {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('') +
         '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + String(d.getSeconds()).padStart(2, '0');
};

// ============ 还原点：每改一次配置前先存一份，只留最近 7 份 ============
const SNAP_DIR = path.join(__dirname, 'snapshots');
const SNAP_MAX = 7;
const SNAP_ID_RE = /^snap-\d{10,}$/;

function snapDirReady() {
  try { fs.mkdirSync(SNAP_DIR, { recursive: true }); } catch (e) {}
}

function snapReadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function snapTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function snapItems() {
  snapDirReady();
  let names = [];
  try { names = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith('.json')); } catch (e) { return []; }
  const out = [];
  for (const f of names) {
    const id = f.replace(/\.json$/, '');
    if (!SNAP_ID_RE.test(id)) continue;
    const j = snapReadJson(path.join(SNAP_DIR, f));
    if (!j || !j.ts) continue;
    out.push({
      id,
      ts: j.ts,
      time: snapTime(j.ts),
      reason: j.reason || '',
      models: Array.isArray(j.models) ? j.models.length : 0,
      upstreams: (j.upstreams && Array.isArray(j.upstreams.upstreams)) ? j.upstreams.upstreams.length : 0
    });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

// 存「此刻磁盘上的真实配置」。内容和上一份完全一样就不重复存。
function snapTake(reason) {
  snapDirReady();
  const models = snapReadJson(MODELS_FILE);
  const upstreams = snapReadJson(UP_FILE);
  if (!Array.isArray(models) || !models.length) {
    log('[snap] 跳过：models.json 读不出来或为空');
    return null;
  }
  if (!upstreams || !Array.isArray(upstreams.upstreams)) {
    log('[snap] 跳过：upstreams.json 读不出来');
    return null;
  }

  const newest = snapItems()[0];
  if (newest) {
    const prev = snapReadJson(path.join(SNAP_DIR, newest.id + '.json'));
    if (prev && JSON.stringify(prev.models) === JSON.stringify(models) &&
        JSON.stringify(prev.upstreams) === JSON.stringify(upstreams)) {
      log('[snap] 内容和上一份一样（' + newest.time + '），不重复存');
      return { id: newest.id, ts: newest.ts, reason: newest.reason, skipped: true };
    }
  }

  const ts = Date.now();
  const id = 'snap-' + ts;
  const payload = {
    ts,
    reason: String(reason || '手动备份').slice(0, 80),
    app: 'claude-gateway',
    version: 1,
    models,
    upstreams
  };
  try {
    fs.writeFileSync(path.join(SNAP_DIR, id + '.json'), JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    log('[snap] 写还原点失败: ' + e.message);
    return null;
  }

  // 超出的老还原点直接扔掉
  const items = snapItems();
  items.slice(SNAP_MAX).forEach(it => {
    try { fs.unlinkSync(path.join(SNAP_DIR, it.id + '.json')); } catch (e) {}
    log('[snap] 已清理过老的还原点 ' + it.time);
  });
  log('[snap] 存了一份还原点：' + payload.reason + '（模型 ' + models.length + ' / 上游 ' + upstreams.upstreams.length + '，现有 ' + Math.min(items.length, SNAP_MAX) + '/' + SNAP_MAX + ' 份）');
  return { id, ts, reason: payload.reason };
}

function snapRestore(id) {
  const sid = String(id || '');
  if (!SNAP_ID_RE.test(sid)) return { ok: false, errors: ['还原点编号不对：' + sid] };
  const j = snapReadJson(path.join(SNAP_DIR, sid + '.json'));
  if (!j) return { ok: false, errors: ['找不到这个还原点（可能已经被 7 份上限挤掉了）'] };
  if (!Array.isArray(j.models) || !j.models.length) return { ok: false, errors: ['这个还原点里的模型表是空的，不敢写进去'] };
  if (!j.upstreams || !Array.isArray(j.upstreams.upstreams) || !j.upstreams.upstreams.length) {
    return { ok: false, errors: ['这个还原点里的上游是空的，不敢写进去'] };
  }

  // 复原动作本身也能撤销
  snapTake('复原到 ' + snapTime(j.ts) + ' 之前');

  try {
    fs.writeFileSync(MODELS_FILE, JSON.stringify(j.models, null, 2), 'utf8');
    fs.writeFileSync(UP_FILE, JSON.stringify(j.upstreams, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, errors: ['写入失败：' + e.message] };
  }

  MODELS = loadModels();
  UP_LIST = j.upstreams.upstreams;
  UPSTREAMS = buildUpstreams(UP_LIST);
  Object.keys(UP_MODEL_CACHE).forEach(k => delete UP_MODEL_CACHE[k]);

  let cfg = null;
  if (RESTORE) {
    try { cfg = RESTORE.writeAllConfig(RESTORE.buildModels(), false); }
    catch (e) { log('[snap] 写 Claude 配置失败: ' + e.message); }
  }
  log('[snap] 已复原到 ' + snapTime(j.ts) + '：模型 ' + MODELS.length + ' / 上游 ' + UP_LIST.length);
  return { ok: true, ts: j.ts, time: snapTime(j.ts), models: MODELS.length, upstreams: UP_LIST.length, config: cfg };
}

// 模型列表地址各家不一样：OpenAI 系是 {base}/models，Anthropic 系官方干脆没有。
// 配置里写了 modelsPath 就用它；没写就按候选顺序一个个试，把每个的结果都返回给面板。
const UP_MODEL_CACHE = {};

function upstreamBase(u) {
  const isDefaultPort = (u.proto === 'https' && u.port === 443) || (u.proto === 'http' && u.port === 80);
  return u.proto + '://' + u.host + (isDefaultPort ? '' : ':' + u.port);
}

function upModelsCandidates(up) {
  const origin = upstreamBase(up);
  const raw = String(up.baseUrl || '').replace(/\/+$/, '');
  const list = [];
  if (up.modelsPath) list.push(origin + up.modelsPath);
  if (raw) list.push(raw + '/models');
  if (raw && !/\/v1$/.test(raw)) list.push(raw + '/v1/models');
  list.push(origin + '/v1/models');
  list.push(origin + '/models');
  return list.filter((v, i) => v && list.indexOf(v) === i);
}

function normalizeModelList(json) {
  const arr = Array.isArray(json && json.data) ? json.data
            : Array.isArray(json && json.models) ? json.models : [];
  return arr.map(m => {
    const id = String(m.id || m.name || m.model || '').trim();
    if (!id) return null;
    return {
      id,
      label: String(m.display_name || m.magpie_label || m.name || '').trim(),
      owner: String(m.owned_by || ''),
      ctx: Number(m.context_length || m.context_window || m.max_input_tokens || 0) || null
    };
  }).filter(Boolean);
}

// 去上游拉真实模型名，给面板做下拉用。inUse 每次实时算，不缓存（模型表改了要立刻反映）
async function fetchUpstreamModels(name, force) {
  const up = UPSTREAMS[name];
  if (!up) return { ok: false, error: '没有这个上游：' + name };

  let models, ms, cached = false, usedUrl = '', tried = [];
  const t0 = Date.now();
  const hit = UP_MODEL_CACHE[name];
  if (!force && hit && Date.now() - hit.at < 60000) {
    models = hit.models; ms = hit.ms; cached = true; usedUrl = hit.url || '';
  } else {
    let ok = null;
    for (const u of upModelsCandidates(up)) {
      const r = await httpJson(u, {
        authorization: 'Bearer ' + up.key,
        'x-api-key': up.key,
        'anthropic-version': '2023-06-01'
      }, 12000);
      const list = (r.status === 200 && r.json) ? normalizeModelList(r.json) : [];
      tried.push({ url: u, status: r.status, count: list.length });
      if (r.status === 200 && r.json) { ok = { list }; usedUrl = u; break; }
    }
    if (!ok) {
      const last = tried[tried.length - 1] || {};
      return {
        ok: false,
        error: '拉不到模型列表：试了 ' + tried.length + ' 个地址都不行（最后一个 HTTP ' + (last.status || '无响应') + '）',
        tried
      };
    }
    models = ok.list;
    ms = Date.now() - t0;
    UP_MODEL_CACHE[name] = { at: Date.now(), models, ms, url: usedUrl };
    log('[admin] 拉取 ' + name + ' 模型列表：' + models.length + ' 个（' + ms + 'ms）' + usedUrl);
  }

  // 每个上游可以在 upstreams.json 里用 blockModels 屏蔽掉实测不可用的模型
  const blockedSet = new Set(up.blockModels || []);
  const visible = models.filter(m => !blockedSet.has(m.id));
  const blocked = models.filter(m => blockedSet.has(m.id)).map(m => m.id);

  const used = new Set(MODELS.filter(m => m.upstream === name).map(m => m.target));
  return {
    ok: true,
    upstream: name,
    label: up.label,
    count: visible.length,
    total: models.length,
    blocked,
    ms,
    cached,
    url: usedUrl,
    tried,
    models: visible.map(m => Object.assign({}, m, { inUse: used.has(m.id) }))
  };
}

// ============ 自动起名 / 批量接入：真实模型名 -> Claude 认的名字 ============

// Claude 桌面版只认 claude-<纯小写字母>-<数字>，所以真实模型名必须重新分配一个合规的壳。
// 每个档位准备一串候选，按顺序取没被占用的。
const ID_POOL = {
  opus:   ['claude-opus-5', 'claude-opus-4-6', 'claude-opus-4', 'claude-opus-3-9', 'claude-opus-3-7', 'claude-opus-3-5', 'claude-opus-3', 'claude-opus-2', 'claude-opus-1'],
  sonnet: ['claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-3', 'claude-sonnet-4-1', 'claude-sonnet-4', 'claude-sonnet-3-9', 'claude-sonnet-3-6', 'claude-sonnet-3-5', 'claude-sonnet-3', 'claude-sonnet-2', 'claude-sonnet-1'],
  haiku:  ['claude-haiku-5', 'claude-haiku-4-6', 'claude-haiku-4-4', 'claude-haiku-4-3', 'claude-haiku-4', 'claude-haiku-3-9', 'claude-haiku-3-7', 'claude-haiku-2', 'claude-haiku-1'],
  fable:  ['claude-fable-9', 'claude-fable-8', 'claude-fable-7', 'claude-fable-4', 'claude-fable-3', 'claude-fable-2', 'claude-fable-1']
};

// 不是对话模型（图片/视频/语音/向量），接了也只会 404
const NON_CHAT_RE = /(^|[-/_.])(image|img|video|tts|audio|speech|whisper|embed|embedding|rerank|moderation|ocr|flux|sdxl|dall)([-/_.]|$)/i;

function guessTier(modelId) {
  const s = String(modelId || '').toLowerCase();
  if (NON_CHAT_RE.test(s)) return null;
  if (/(opus|pro|max|ultra|large|reason|think|o1|o3|o4)/.test(s)) return 'opus';
  if (/(haiku|flash|mini|lite|fast|turbo|air|small|nano|tiny|instant|speed|free)/.test(s)) return 'haiku';
  return 'sonnet';
}

function allocModelId(tier, taken) {
  const pool = ID_POOL[tier] || ID_POOL.sonnet;
  for (const id of pool) if (!taken.has(id)) { taken.add(id); return id; }
  for (let n = 2; n < 95; n++) {
    const id = 'claude-' + tier + '-' + n;
    if (!taken.has(id)) { taken.add(id); return id; }
  }
  return null;
}

// 显示名后缀：取上游标签里 · 后面的部分；标签是「Magpie」时后缀就是 Magpie
function upstreamSuffix(upOrId) {
  const u = (upOrId && typeof upOrId === 'object') ? upOrId : (UP_LIST.find(x => x.id === upOrId) || {});
  const lab = String(u.label || u.id || '');
  const i = lab.lastIndexOf('·');
  const tail = i >= 0 ? lab.slice(i + 1).trim() : lab.trim();
  return tail || String(u.id || 'upstream');
}

// 上游列表里有更漂亮的显示名（magpie 的 magpie_label）就用它，没有就用真实模型名
function prettyModelName(upId, target) {
  const hit = UP_MODEL_CACHE[upId];
  if (hit && Array.isArray(hit.models)) {
    const m = hit.models.find(x => x.id === target);
    if (m && m.label) return m.label;
  }
  return target;
}

// 给一个底层模型名配一套「Claude 认的名字 + 显示名 + 档位」
async function autoName(body) {
  const target = String(body.target || '').trim();
  const upId = String(body.upstream || '');
  if (!target) return { ok: false, error: '先填或选一个底层模型名' };

  const exist = MODELS.find(m => m.target === target && (!upId || m.upstream === upId));
  if (exist) {
    return {
      ok: true, exists: true, id: exist.id, label: exist.label, tier: exist.tier,
      error: '这个模型已经接入过了，名字是 ' + exist.id
    };
  }

  const tier = guessTier(target);
  if (!tier) return { ok: false, error: '「' + target + '」看着不是对话模型（图片 / 视频 / 嵌入类）' };

  // 没缓存就去上游捞一次，这样能拿到它自己的漂亮名字（magpie_label）
  if (upId && !UP_MODEL_CACHE[upId] && UPSTREAMS[upId]) {
    try { await fetchUpstreamModels(upId, false); } catch (e) {}
  }

  const taken = new Set(MODELS.map(m => m.id));
  (Array.isArray(body.taken) ? body.taken : []).forEach(x => {
    const v = String(x || '').trim();
    if (v) taken.add(v);
  });

  return {
    ok: true,
    id: allocModelId(tier, taken),
    label: prettyModelName(upId, target) + ' · ' + upstreamSuffix(upId),
    tier
  };
}

// 把一个上游的模型列表整批转成模型表条目：自动起名、自动显示名、自动分档
// 不带 picks = 只预览；带 picks（目标模型名数组）= 真的写进 models.json
async function autoFillUpstream(body) {
  const id = String(body.id || '');
  const meta = UP_LIST.find(u => u.id === id);
  if (!meta) return { ok: false, errors: ['没有这个上游：' + id] };
  if (!UPSTREAMS[id]) return { ok: false, errors: ['这个上游的地址无效，先点「编辑」修好'] };

  const r = await fetchUpstreamModels(id, body.force === true);
  if (!r.ok) return { ok: false, errors: [r.error], tried: r.tried };

  const suffix = upstreamSuffix(meta);
  const taken = new Set(MODELS.map(m => m.id));
  const plan = [];
  for (const m of r.models) {
    const exist = MODELS.find(x => x.target === m.id && x.upstream === id);
    if (exist) {
      plan.push({ target: m.id, id: exist.id, label: exist.label, tier: exist.tier, state: 'inuse' });
      continue;
    }
    const tier = guessTier(m.id);
    if (!tier) {
      plan.push({ target: m.id, id: '', label: '', tier: '', state: 'nonchat' });
      continue;
    }
    plan.push({
      target: m.id,
      id: allocModelId(tier, taken),
      label: (m.label || m.id) + ' · ' + suffix,
      tier,
      state: 'new'
    });
  }

  const news = plan.filter(p => p.state === 'new');
  const base = {
    ok: true,
    upstream: id,
    label: meta.label || id,
    url: r.url,
    total: r.models.length,
    addable: news.length,
    plan
  };

  const picked = Array.isArray(body.picks) ? body.picks.map(String) : null;
  if (!picked) return base;
  if (!news.length) return Object.assign(base, { ok: false, errors: ['这个上游没有需要新接入的模型'] });

  const add = news.filter(p => picked.includes(p.target));
  if (!add.length) return Object.assign(base, { ok: false, errors: ['一个都没选'] });

  const added = add.map(p => ({
    id: p.id,
    target: p.target,
    upstream: id,
    label: p.label,
    tier: p.tier,
    isDefault: false,
    ctx: 1000000
  }));

  // 哪个档位还没有默认，就拿新加的第一个顶上
  for (const t of TIERS) {
    const inTier = MODELS.concat(added).filter(m => m.tier === t);
    if (!inTier.length || inTier.some(m => m.isDefault)) continue;
    const cand = added.find(m => m.tier === t);
    if (cand) cand.isDefault = true;
  }

  const v = normalizeModels(MODELS.concat(added));
  if (!v.ok) return Object.assign(base, { ok: false, errors: v.errors });
  const meta2 = saveModels(v.models);
  log('[admin] 自动接入 ' + id + '：新增 ' + added.length + ' 个（' + added.map(m => m.id + '->' + m.target).join(', ') + '）');
  return Object.assign(base, {
    ok: true,
    added,
    notes: v.notes,
    models: MODELS,
    backup: meta2.backup,
    config: meta2.config
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function tcpProbe(port, host = '127.0.0.1', timeout = 800) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    const done = v => { try { s.destroy(); } catch (e) {} resolve({ ok: v, ms: Date.now() - t0 }); };
    s.setTimeout(timeout);
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.on('timeout', () => done(false));
  });
}

function httpJson(url, headers, timeout = 10000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: Object.assign({ accept: 'application/json' }, headers || {}) }, r => {
      let d = '';
      r.setEncoding('utf8');
      r.on('data', c => d += c);
      r.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch (e) {}
        resolve({ status: r.statusCode, json: j, body: d, ms: Date.now() - t0 });
      });
    });
    req.on('error', e => resolve({ status: 0, json: null, body: e.message, ms: Date.now() - t0 }));
    req.setTimeout(timeout, () => { req.destroy(); resolve({ status: 0, json: null, body: 'timeout', ms: Date.now() - t0 }); });
  });
}

let CLOUD_CACHE = { at: 0, ups: {}, deepseek: null };

// 每个上游探测一次：本地端口就直接探 TCP，云端就用它的模型列表接口探活
async function probeStatus(force) {
  const now = Date.now();
  const fresh = force || (now - CLOUD_CACHE.at > 20000);

  if (fresh) {
    const ups = {};
    await Promise.all(UP_LIST.map(async it => {
      const up = UPSTREAMS[it.id];
      const label = it.label || it.id;
      if (!up) { ups[it.id] = { ok: false, status: 0, error: '地址无效', label }; return; }

      if (up.host === '127.0.0.1' || up.host === 'localhost' || up.host === '::1') {
        const p = await tcpProbe(up.port, up.host);
        ups[it.id] = { ok: p.ok, ms: p.ms, local: true, port: up.port, label };
        return;
      }

      const r = await httpJson(upModelsCandidates(up)[0], {
        authorization: 'Bearer ' + up.key,
        'x-api-key': up.key,
        'anthropic-version': '2023-06-01'
      }, 8000);
      const list = (r.status === 200 && r.json) ? normalizeModelList(r.json) : [];
      const blocked = new Set(Array.isArray(it.blockModels) ? it.blockModels : []);
      const shown = list.filter(x => !blocked.has(x.id));
      const mine = MODELS.find(m => m.upstream === it.id);
      ups[it.id] = {
        ok: r.status === 200,
        status: r.status,
        ms: r.ms,
        count: shown.length,
        total: list.length,
        blocked: list.length - shown.length,
        label,
        base: up.baseUrl,
        hasModel: mine ? shown.some(x => x.id === mine.target) : null,
        model: mine ? mine.target : null
      };
    }));

    const ds = (async () => {
      const up = UPSTREAMS.deepseek;
      if (!up) return null;
      const r = await httpJson('https://api.deepseek.com/user/balance', { authorization: 'Bearer ' + up.key }, 8000);
      const info = (r.json && r.json.balance_infos && r.json.balance_infos[0]) || null;
      return { ok: r.status === 200, status: r.status, balance: info ? info.total_balance : null, currency: info ? info.currency : 'CNY' };
    })();

    CLOUD_CACHE = { at: now, ups, deepseek: await ds };
  }

  return {
    gateway: { ok: true, version: VERSION, versionDate: VERSION_DATE, port: PORT, pid: process.pid, uptime: Date.now() - STARTED_AT, models: MODELS.length },
    upstreams: CLOUD_CACHE.ups,
    deepseek: CLOUD_CACHE.deepseek,
    at: Date.now()
  };
}

// ============ 上游管理的辅助函数 ============

function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  if (s.length <= 10) return s.slice(0, 2) + '***';
  return s.slice(0, 6) + '***' + s.slice(-4);
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9_\-]/g, '').slice(0, 24);
}

function checkBaseUrl(baseUrl) {
  const s = String(baseUrl || '').trim();
  if (!s) return 'Base URL 不能为空';
  if (/\s/.test(s)) return 'Base URL 里不能有空格';
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Base URL 必须以 http:// 或 https:// 开头';
    if (!u.hostname) return 'Base URL 里缺少主机名';
    return '';
  } catch (e) {
    return 'Base URL 格式不对：' + s.slice(0, 60);
  }
}

function saveUpstreams() {
  snapTake('修改上游');
  const bak = UP_FILE + '.bak-' + stampNow();
  try { if (fs.existsSync(UP_FILE)) fs.copyFileSync(UP_FILE, bak); } catch (e) {}
  fs.writeFileSync(UP_FILE, JSON.stringify({ version: 2, upstreams: UP_LIST }, null, 2), 'utf8');
  UPSTREAMS = buildUpstreams(UP_LIST);
  log('[admin] upstreams.json 已更新（' + UP_LIST.length + ' 个上游）');
  return bak;
}

// 没有显式指定协议时：地址和 key 都没变就沿用旧值，否则现场探一次
async function resolveApi(body) {
  const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
  const cur = body.id ? UP_LIST.find(x => x.id === body.id) : null;
  if (cur && cur.api && cur.baseUrl === baseUrl && (!body.apiKey || body.apiKey === cur.apiKey)) {
    return cur.api;
  }
  if (!BRIDGE || checkBaseUrl(baseUrl) !== '') return 'anthropic';
  const key = String(body.apiKey || (cur && cur.apiKey) || '');
  if (!key) return 'anthropic';
  try {
    const d = await BRIDGE.detect(parseBaseUrl(baseUrl), key, log);
    log('[admin] 协议识别 ' + baseUrl + ' -> ' + d.api + '（' + d.reason + '）');
    // 探不出结论时不要覆盖已有判定（比如 key 填错了一时探到 401）
    if (!d.confident && cur && cur.api) return cur.api;
    return d.api;
  } catch (e) {
    log('[admin] 协议识别失败: ' + e.message);
    return 'anthropic';
  }
}

function upsertUpstream(body) {
  const label = String(body.label || '').trim().slice(0, 40);
  const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
  let apiKey = String(body.apiKey || '').trim();
  const rawPath = String(body.modelsPath || '').trim();
  const modelsPath = rawPath && !rawPath.startsWith('/') ? '/' + rawPath : rawPath;
  const api = String(body.api || '').toLowerCase() === 'openai' ? 'openai' : 'anthropic';

  const err = checkBaseUrl(baseUrl);
  if (err) return { ok: false, errors: [err] };

  let id = String(body.id || '').trim();
  const isEdit = !!id;

  // 编辑时 key 留空 = 沿用原来的（页面上只显示掩码，不能回填明文）
  if (isEdit) {
    const cur = UP_LIST.find(x => x.id === id);
    if (!cur) return { ok: false, errors: ['找不到上游「' + id + '」'] };
    if (!apiKey) apiKey = cur.apiKey || '';
  }
  if (!apiKey) return { ok: false, errors: ['API Key 不能为空'] };

  if (isEdit) {
    const i = UP_LIST.findIndex(x => x.id === id);
    UP_LIST[i] = Object.assign({}, UP_LIST[i], {
      label: label || UP_LIST[i].label || id,
      baseUrl,
      apiKey,
      modelsPath,
      api
    });
  } else {
    id = slugify(body.id || label);
    if (!id) {
      // 只填了中文名时自动给个 up1 / up2 的标识，不影响显示名
      let n = UP_LIST.length + 1;
      while (UP_LIST.some(x => x.id === 'up' + n)) n++;
      id = 'up' + n;
    }
    if (UP_LIST.some(x => x.id === id)) return { ok: false, errors: ['标识「' + id + '」已经存在了'] };
    UP_LIST.push({ id, label: label || id, baseUrl, apiKey, modelsPath, api, builtin: false });
  }

  const bak = saveUpstreams();
  delete UP_MODEL_CACHE[id];
  log('[admin] 上游已保存：' + id + ' -> ' + baseUrl + '（协议 ' + api + '）');
  return { ok: true, id, backup: bak, api: api };
}

function deleteUpstream(id) {
  const i = UP_LIST.findIndex(x => x.id === id);
  if (i < 0) return { ok: false, errors: ['找不到上游「' + id + '」'] };
  const used = MODELS.filter(m => m.upstream === id);
  if (used.length) {
    return {
      ok: false,
      errors: ['还有 ' + used.length + ' 个模型在用这个上游：' + used.map(m => m.id).join('、') +
                '。先到「模型」页把它们改到别的上游，再删除。']
    };
  }
  UP_LIST.splice(i, 1);
  const bak = saveUpstreams();
  delete UP_MODEL_CACHE[id];
  log('[admin] 上游已删除：' + id);
  return { ok: true, id, backup: bak };
}

// 不保存，直接拿界面里填的地址 + key 试拉一次模型
async function testUpstream(body) {
  const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
  let apiKey = String(body.apiKey || '').trim();
  const rawPath = String(body.modelsPath || '').trim();
  const modelsPath = rawPath && !rawPath.startsWith('/') ? '/' + rawPath : rawPath;

  // 编辑已有上游时 key 可以留空，用存着的那把测
  if (!apiKey && body.id) {
    const cur = UP_LIST.find(x => x.id === body.id);
    if (cur) apiKey = cur.apiKey || '';
  }

  const err = checkBaseUrl(baseUrl);
  if (err) return { ok: false, errors: [err] };
  if (!apiKey) return { ok: false, errors: ['API Key 不能为空'] };

  let tmp;
  try {
    tmp = Object.assign(parseBaseUrl(baseUrl), { baseUrl, modelsPath, key: apiKey });
  } catch (e) {
    return { ok: false, errors: ['解析 Base URL 失败：' + e.message] };
  }

  const t0 = Date.now();
  const tried = [];
  for (const u of upModelsCandidates(tmp)) {
    const r = await httpJson(u, {
      authorization: 'Bearer ' + apiKey,
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }, 12000);
    const list = (r.status === 200 && r.json) ? normalizeModelList(r.json) : [];
    tried.push({ url: u, status: r.status, count: list.length });
    if (r.status === 200 && r.json) {
      return { ok: true, url: u, ms: Date.now() - t0, count: list.length, tried, models: list };
    }
  }
  const last = tried[tried.length - 1] || {};
  return {
    ok: false,
    errors: ['这些地址都拉不到模型列表（最后一个 HTTP ' + (last.status || '无响应') + '）'],
    tried,
    ms: Date.now() - t0
  };
}

function normalizeModels(input) {
  const errors = [];
  if (!Array.isArray(input) || input.length === 0) return { ok: false, errors: ['模型列表为空'] };
  if (input.length > 24) errors.push('最多 24 个模型');

  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const id = String(raw.id || '').trim().toLowerCase();
    const target = String(raw.target || '').trim();
    const upstream = String(raw.upstream || '').trim().toLowerCase();
    const tier = String(raw.tier || 'sonnet').trim().toLowerCase();
    const label = String(raw.label || target || id).trim().slice(0, 48);

    if (!ID_RE.test(id)) { errors.push('「' + id + '」名字不合规：必须是 claude-小写字母-数字（可再加一段数字），例如 claude-opus-4-5'); continue; }
    if (seen.has(id)) { errors.push('名字重复：' + id); continue; }
    if (!target) { errors.push(id + ' 没填上游模型名'); continue; }
    if (!/^[A-Za-z0-9._\-\/:]+$/.test(target)) { errors.push(id + ' 的上游模型名含非法字符'); continue; }
    if (!UPSTREAMS[upstream]) { errors.push(id + ' 的上游「' + upstream + '」不存在'); continue; }
    if (!TIERS.includes(tier)) { errors.push(id + ' 的档位「' + tier + '」不对'); continue; }

    seen.add(id);
    out.push({
      id, target, upstream, label, tier,
      isDefault: !!raw.isDefault,
      ctx: Number(raw.ctx) > 0 ? Number(raw.ctx) : 1000000
    });
  }

  // 每个档位只留一个默认，多余的自动取消
  const notes = [];
  for (const t of TIERS) {
    const inTier = out.filter(m => m.tier === t && m.isDefault);
    if (inTier.length > 1) {
      inTier.slice(1).forEach(m => { m.isDefault = false; });
      notes.push(t + ' 档位有多个默认，已只保留第一个');
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, models: out, notes };
}

function saveModels(models) {
  snapTake('保存模型表');
  const bak = MODELS_FILE + '.bak-' + stampNow();
  if (fs.existsSync(MODELS_FILE)) fs.copyFileSync(MODELS_FILE, bak);
  fs.writeFileSync(MODELS_FILE, JSON.stringify(models, null, 2), 'utf8');
  MODELS = loadModels();
  let cfg = null;
  if (RESTORE) {
    try { cfg = RESTORE.writeAllConfig(RESTORE.buildModels(), false); }
    catch (e) { log('[admin] 写 Claude 配置失败: ' + e.message); }
  }
  log('[admin] 模型表已保存，共 ' + models.length + ' 个（备份 ' + path.basename(bak) + '）');
  return { backup: path.basename(bak), config: cfg };
}

function readBody(req, limit = 1024 * 512) {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function run(cmd, args) {
  execFile(cmd, args, { windowsHide: true }, (err, stdout) => {
    if (err) log('[admin] ' + cmd + ' 失败: ' + err.message);
  });
}

// 跑一段 PowerShell，拿回 stdout（用来按路径找 Claude 进程，taskkill 按名字会误杀旧版）
function ps(script) {
  return new Promise(resolve => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20000 },
      (err, stdout) => resolve({ err, out: String(stdout || '').trim() }));
  });
}

// 只杀商店版（数据在 Claude-3p 的那个），顺带清掉会卡地区限制的旧版残留
function killClaude() {
  return ps(
    "$a = Get-Process claude -ErrorAction SilentlyContinue; " +
    "foreach ($p in $a) { $x = ''; try { $x = $p.Path } catch {} ; " +
    "if ($x -like '*WindowsApps*' -or $x -like '*AnthropicClaude*' -or $x -eq '') " +
    "{ try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch {} } }; 'done'"
  );
}

function launchClaude() {
  // explorer 走 AppsFolder 激活，等于你在开始菜单点一下，包身份才对；
  // 直接 CreateProcess 跑 WindowsApps 里的 exe 会丢包身份，可能又变成“未登录/地区受限”
  spawn('explorer.exe', ['shell:AppsFolder\\' + CLAUDE_AUMID], {
    windowsHide: true, detached: true, stdio: 'ignore'
  }).unref();
}

function claudeRunning() {
  return ps("$n = (Get-Process claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*WindowsApps*' }).Count; if ($n -eq $null) { $n = 0 }; $n")
    .then(r => Number(r.out) || 0);
}

async function restartClaude() {
  await killClaude();
  await new Promise(r => setTimeout(r, 1200));
  launchClaude();
  log('[admin] 已关闭 Claude，正在通过开始菜单方式重新启动商店版');
  setTimeout(async () => {
    const n = await claudeRunning();
    if (n === 0) log('[admin] 警告：8 秒内没检测到 Claude 进程，可能没装上商店版');
    else log('[admin] Claude 已起来（' + n + ' 个进程）');
  }, 8000);
  return true;
}

function handleAdmin(req, res, pathOnly, query) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip !== '127.0.0.1' && ip !== '::1') {
    return sendJson(res, 403, { ok: false, error: '管理页面只允许本机访问' });
  }

  if (pathOnly === '/admin' || pathOnly === '/admin/' || pathOnly === '/admin/index.html') {
    fs.readFile(PANEL_FILE, (err, buf) => {
      if (err) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('panel.html 读不到：' + err.message); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(buf);
    });
    return;
  }

  if (pathOnly === '/admin/api/status' && req.method === 'GET') {
    probeStatus(query.get('force') === '1').then(s => sendJson(res, 200, s)).catch(e => sendJson(res, 500, { ok: false, error: e.message }));
    return;
  }

  if (pathOnly === '/admin/api/models' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, models: MODELS, upstreams: Object.keys(UPSTREAMS), tiers: TIERS });
  }

  // ---- 上游管理：列表 / 保存 / 删除 / 试拉 ----
  if (pathOnly === '/admin/api/upstreams/list' && req.method === 'GET') {
    const list = UP_LIST.map(it => {
      const up = UPSTREAMS[it.id] || null;
      return {
        id: it.id,
        label: it.label || it.id,
        baseUrl: it.baseUrl,
        keyMask: maskKey(it.apiKey),
        hasKey: !!it.apiKey,
        modelsPath: it.modelsPath || '',
        api: it.api === 'openai' ? 'openai' : 'anthropic',
        builtin: !!it.builtin,
        used: MODELS.filter(m => m.upstream === it.id).length,
        forwardPath: up ? (upstreamBase(up) + (up.prefix || '') + (it.api === 'openai' ? '/v1/chat/completions' : '/v1/messages')) : '',
        valid: !!up
      };
    });
    return sendJson(res, 200, { ok: true, upstreams: list, modelsPathHint: '/models 或 /v1/models' });
  }

  if (pathOnly === '/admin/api/upstreams/save' && req.method === 'POST') {
    readBody(req).then(async body => {
      body = body || {};
      if (!body.api) body.api = await resolveApi(body);
      const r = upsertUpstream(body);
      sendJson(res, r.ok ? 200 : 400, r);
    }).catch(e => sendJson(res, 500, { ok: false, errors: [e.message] }));
    return;
  }

  if (pathOnly === '/admin/api/upstreams/delete' && req.method === 'POST') {
    readBody(req).then(body => {
      const r = deleteUpstream(String((body && body.id) || ''));
      sendJson(res, r.ok ? 200 : 400, r);
    }).catch(e => sendJson(res, 500, { ok: false, errors: [e.message] }));
    return;
  }

  if (pathOnly === '/admin/api/upstreams/test' && req.method === 'POST') {
    readBody(req).then(async body => {
      const r = await testUpstream(body || {});
      sendJson(res, r.ok ? 200 : 400, r);
    }).catch(e => sendJson(res, 500, { ok: false, errors: [e.message] }));
    return;
  }

  // ---- 自动填名字：给一个底层模型名配 Claude 认的名字 ----
  if (pathOnly === '/admin/api/autoname' && req.method === 'POST') {
    readBody(req).then(async body => {
      const r = await autoName(body || {});
      sendJson(res, r.ok ? 200 : 400, r);
    }).catch(e => sendJson(res, 500, { ok: false, error: e.message }));
    return;
  }

  // ---- 自动接入：把一个上游的模型整批起名并写进模型表 ----
  if (pathOnly === '/admin/api/upstreams/autofill' && req.method === 'POST') {
    readBody(req).then(async body => {
      const r = await autoFillUpstream(body || {});
      sendJson(res, r.ok ? 200 : 400, r);
    }).catch(e => sendJson(res, 500, { ok: false, errors: [e.message] }));
    return;
  }

  if (pathOnly === '/admin/api/upstreams' && req.method === 'GET') {
    const name = query.get('name') || '';
    fetchUpstreamModels(name, query.get('force') === '1')
      .then(r => sendJson(res, r.ok ? 200 : 502, r))
      .catch(e => sendJson(res, 500, { ok: false, error: e.message }));
    return;
  }

  if (pathOnly === '/admin/api/models' && req.method === 'POST') {
    readBody(req).then(body => {
      if (!body) return sendJson(res, 400, { ok: false, errors: ['请求内容不是合法 JSON'] });
      const v = normalizeModels(body.models);
      if (!v.ok) return sendJson(res, 400, { ok: false, errors: v.errors });
      console.log('\n' + (v.notes || []).map(n => '  [!] ' + n).join('\n'));
      const meta = saveModels(v.models);
      sendJson(res, 200, { ok: true, models: MODELS, notes: v.notes, backup: meta.backup, config: meta.config });
    }).catch(e => sendJson(res, 500, { ok: false, errors: [e.message] }));
    return;
  }

  // ---- 配置档（Claude 的 3p profile）：查看现状 / 自建一份 ----
  if (pathOnly === '/admin/api/profile/info' && req.method === 'GET') {
    if (!RESTORE) return sendJson(res, 500, { ok: false, error: 'restore.js 未加载' });
    try { return sendJson(res, 200, RESTORE.profileInfo()); }
    catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
  }

  if (pathOnly === '/admin/api/profile/ensure' && req.method === 'POST') {
    if (!RESTORE) return sendJson(res, 500, { ok: false, error: 'restore.js 未加载' });
    readBody(req).then(body => {
      try {
        const p = RESTORE.ensureProfile((body && body.mode) || 'auto');
        if (!p.ok) return sendJson(res, 400, p);
        if (p.backups && p.backups.length) log('[admin] 配置档 _meta.json 已备份：' + p.backups.join('、'));
        const cfg = RESTORE.writeAllConfig(RESTORE.buildModels(), false);
        log('[admin] 配置档 ' + p.action + ' → ' + p.id + '（' + (cfg.ok ? '模型表已写入' : '模型表写入失败') + '）');
        sendJson(res, 200, { ok: !!cfg.ok, profile: p, config: cfg });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message });
      }
    }).catch(e => sendJson(res, 500, { ok: false, error: e.message }));
    return;
  }

  if (pathOnly === '/admin/api/action' && req.method === 'POST') {
    readBody(req).then(body => {
      const act = (body && body.do) || '';
      switch (act) {
        case 'reload': {
          MODELS = loadModels();
          let cfg = null;
          if (RESTORE) { try { cfg = RESTORE.writeAllConfig(RESTORE.buildModels(), false); } catch (e) {} }
          return sendJson(res, 200, { ok: true, models: MODELS.length, config: cfg });
        }
        case 'restore': {
          if (!RESTORE) return sendJson(res, 500, { ok: false, error: 'restore.js 未加载' });
          const cfg = RESTORE.writeAllConfig(RESTORE.buildModels(), false);
          return sendJson(res, 200, { ok: !!cfg.ok, config: cfg });
        }
        case 'restore-original': {
          if (!RESTORE) return sendJson(res, 500, { ok: false, error: 'restore.js 未加载' });
          snapTake('恢复原装 Claude 设置前');
          try {
            const r = RESTORE.restoreOriginal();
            log('[admin] 恢复原装 Claude 设置：恢复 ' + r.restored.length + ' 个，删除 ' + r.removed.length + ' 个');
            return sendJson(res, 200, r);
          } catch (e) {
            log('[admin] 恢复原装 Claude 设置失败: ' + e.message);
            return sendJson(res, 500, { ok: false, error: e.message });
          }
        }
        case 'start-magpie': {
          if (!fs.existsSync(MAGPIE_EXE)) return sendJson(res, 500, { ok: false, error: '找不到 ' + MAGPIE_EXE });
          tcpProbe(3425).then(p => {
            if (p.ok) return sendJson(res, 200, { ok: true, already: true });
            spawn(MAGPIE_EXE, [], { cwd: path.dirname(MAGPIE_EXE), detached: true, stdio: 'ignore' }).unref();
            log('[admin] 正在启动 Magpie');
            sendJson(res, 200, { ok: true, started: true });
          });
          return;
        }
        case 'restart-magpie': {
          run('taskkill', ['/IM', 'magpie.exe', '/F', '/T']);
          setTimeout(() => {
            if (fs.existsSync(MAGPIE_EXE)) spawn(MAGPIE_EXE, [], { cwd: path.dirname(MAGPIE_EXE), detached: true, stdio: 'ignore' }).unref();
            log('[admin] Magpie 已重启');
          }, 1800);
          return sendJson(res, 200, { ok: true });
        }
        case 'restart-claude': {
          restartClaude()
            .then(() => sendJson(res, 200, { ok: true }))
            .catch(e => sendJson(res, 500, { ok: false, error: e.message }));
          return;
        }
        case 'open-config': {
          run('explorer.exe', [CFG_LIB]);
          return sendJson(res, 200, { ok: true });
        }
        case 'open-models': {
          run('notepad.exe', [MODELS_FILE]);
          return sendJson(res, 200, { ok: true });
        }
        default:
          return sendJson(res, 400, { ok: false, error: '不认识的动作：' + act });
      }
    }).catch(e => sendJson(res, 500, { ok: false, error: e.message }));
    return;
  }

  // ---- 还原点：列表 / 手动存 / 复原 ----
  if (pathOnly === '/admin/api/snapshots' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, max: SNAP_MAX, dir: SNAP_DIR, items: snapItems() });
  }

  if (pathOnly === '/admin/api/snapshots' && req.method === 'POST') {
    readBody(req).then(body => {
      const r = snapTake((body && body.reason) || '手动备份');
      if (!r) return sendJson(res, 500, { ok: false, errors: ['存还原点失败，看日志'] });
      sendJson(res, 200, { ok: true, snap: r, items: snapItems() });
    }).catch(e => sendJson(res, 500, { ok: false, errors: [e.message] }));
    return;
  }

  if (pathOnly === '/admin/api/snapshots/restore' && req.method === 'POST') {
    readBody(req).then(body => {
      const r = snapRestore(body && body.id);
      sendJson(res, r.ok ? 200 : 400, r);
    }).catch(e => sendJson(res, 500, { ok: false, errors: [e.message] }));
    return;
  }

  if (pathOnly === '/admin/api/log' && req.method === 'GET') {
    const n = Math.min(Number(query.get('n')) || 120, 400);
    return sendJson(res, 200, { ok: true, lines: LOG_RING.slice(-n) });
  }

  sendJson(res, 404, { ok: false, error: '没有这个接口：' + pathOnly });
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  // 因为监听 0.0.0.0，只放行本机与私有网段（沙箱 VM 走 172.16.x），拒绝公网来源
  const srcIp = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const isPrivate = srcIp === '127.0.0.1' || srcIp === '::1' || /^172\.(1[6-9]|2\d|3[01])\./.test(srcIp) ||
                    /^10\./.test(srcIp) || /^192\.168\./.test(srcIp) || /^169\.254\./.test(srcIp) ||
                    /^26\./.test(srcIp); // Radmin VPN 虚拟网段
  if (!isPrivate) {
    log('[deny] 拒绝来自 ' + srcIp + ' 的请求 ' + url);
    res.writeHead(403, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { type: 'forbidden', message: 'local access only' } }));
  }
  if (srcIp !== '127.0.0.1' && url !== '/health') log('[req] from ' + srcIp + ' ' + req.method + ' ' + url);

  const pathOnly = url.split('?')[0];
  if (pathOnly === '/favicon.ico') {
    fs.readFile(ICON_FILE, (err, buf) => {
      if (err) { res.writeHead(204); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/x-icon', 'cache-control': 'max-age=86400' });
      res.end(buf);
    });
    return;
  }

  if (pathOnly === '/admin' || pathOnly.startsWith('/admin/')) {
    return handleAdmin(req, res, pathOnly, new URLSearchParams(url.split('?')[1] || ''));
  }

  if (url === '/' || url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, version: VERSION, port: PORT, count: MODELS.length, models: MODELS.map(m => m.id) }));
  }

  if (req.method === 'GET' && url.split('?')[0].replace(/\/+$/, '').endsWith('/v1/models')) {
    log('[models] 返回 ' + MODELS.length + ' 个模型');
    const data = MODELS.map(catalogEntry);
    res.writeHead(200, { 'content-type': 'application/json' });
    // 空模型表要能正常返回空列表，否则 Claude 那边会一直等（first_id 取不到会抛异常）
    if (!data.length) {
      return res.end(JSON.stringify({ object: 'list', data: [], has_more: false, first_id: null, last_id: null }));
    }
    return res.end(JSON.stringify({
      object: 'list',
      data,
      has_more: false,
      first_id: data[0].id,
      last_id: data[data.length - 1].id
    }));
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    let entry = byTier('sonnet') || MODELS[0];
    let route = null;

    if (req.method === 'POST' && url.includes('/v1/messages') && body.length) {
      try {
        const json = JSON.parse(body.toString('utf8'));
        const original = json.model;
        entry = pickModel(original);
        if (!entry) throw new Error('模型表里找不到 ' + original);
        const up = UPSTREAMS[entry.upstream];
        if (up && up.api === 'openai') {
          // 上游说 OpenAI 协议：交给转换层，body 原样保留给 Anthropic 分支
          route = { up: up, json: json, original: original };
        } else {
          json.model = entry.target;
          body = Buffer.from(JSON.stringify(json), 'utf8');
          log('[messages] ' + original + ' -> ' + entry.target + ' @' + entry.upstream + ' stream=' + !!json.stream);
        }
      } catch (e) {
        log('[messages] 解析失败: ' + e.message);
      }
    }

    // 模型表为空（全新部署还没配）：直接说清楚，别让它挂住连接
    if (!entry) {
      log('[refuse] 没有可用模型，拒绝 ' + url);
      return sendJson(res, 400, {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: '网关里还没有配置任何模型。先打开控制面板（127.0.0.1:15722/admin），在「上游」页添加供应商并自动填充模型。'
        }
      });
    }

    if (route) {
      if (!BRIDGE) {
        return sendJson(res, 500, {
          type: 'error',
          error: { type: 'api_error', message: 'openai-bridge.js 没有加载，OpenAI 兼容上游暂时不可用' }
        });
      }
      if (url.split('?')[0].replace(/\/+$/, '').endsWith('/count_tokens')) {
        return sendJson(res, 200, { input_tokens: Math.ceil(body.length / 4) });
      }
      log('[messages] ' + route.original + ' -> ' + entry.target + ' @' + entry.upstream + ' (openai) stream=' + !!route.json.stream);
      return BRIDGE.forward(route.up, entry, route.json, res, log);
    }

    // 模型条目指向的上游可能已经被删掉（手改 upstreams.json、还原点回退都会造成）
    // 不拦下来就会在 forward 里抛 TypeError，连接一直挂着，Claude 那边表现为没有任何响应
    const target = UPSTREAMS[entry.upstream];
    if (!target) {
      log('[refuse] 模型 ' + entry.id + ' 指向的上游不存在：' + entry.upstream);
      return sendJson(res, 500, {
        type: 'error',
        error: {
          type: 'api_error',
          message: '模型「' + entry.id + '」指向的上游「' + entry.upstream + '」不存在。打开控制面板，在模型页把它改到别的上游，或重新添加这个上游。'
        }
      });
    }

    forward(target, url, req.method, req.headers, body, res);
  });
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
server.on('error', e => {
  if (e && e.code === 'EADDRINUSE') {
    log('[boot] 15722 已被占用（另一个网关在跑），本进程退出');
    process.exit(0);
  }
  log('[error] 监听失败: ' + (e && e.message));
});
// 绑 0.0.0.0：Claude 的沙箱 VM 通过 vsock 桥接访问宿主机，源地址不是 loopback
server.listen(PORT, '0.0.0.0', () => {
  log('gateway listening on http://0.0.0.0:' + PORT);
  log('models: ' + MODELS.length + ' 个');
});
