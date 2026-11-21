// 恢复 Claude Desktop 到「自建网关」配置（一次性工具，跑完即退）
// 用法：双击桌面的「恢复Claude配置-双击运行.cmd」
// 职责：只把配置文件改回来，不驻留、不守护、不占用后台。
//       服务的启动与停止由「启动Claude服务.cmd」单独负责。

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execSync } = require('child_process');

const HOME = process.env.USERPROFILE || process.env.HOME;
const C3P_DIR = path.join(HOME, 'AppData', 'Local', 'Claude-3p');
const CFG_LIB = path.join(C3P_DIR, 'configLibrary');
const DESKTOP_CFG = path.join(C3P_DIR, 'claude_desktop_config.json');
const ROAM_CFG = path.join(HOME, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json');
const GW_DIR = __dirname;
const NODE_EXE = path.join(GW_DIR, 'node.exe');
const GW_SCRIPT = path.join(GW_DIR, 'gateway.js');
const MODELS_FILE = path.join(GW_DIR, 'models.json');
// Magpie 可执行文件：环境变量 → 同包 ../magpie → 同目录 magpie → 老位置
const MAGPIE_EXE = (() => {
  const cands = [
    process.env.MAGPIE_EXE,
    path.join(GW_DIR, '..', 'magpie', 'magpie.exe'),
    path.join(GW_DIR, 'magpie', 'magpie.exe'),
    'D:\\magpie\\magpie.exe'
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return cands[0] || 'magpie.exe';
})();

const BASE_URL = 'http://127.0.0.1:15722';
// 网关不校验这个 key，它只是 Claude 请求头里带的字符串。
// 打包部署时安装器会生成随机的 gw-key.txt；没有这个文件就沿用默认值（现网属于这种）。
const API_KEY = (() => {
  try {
    const k = fs.readFileSync(path.join(GW_DIR, 'gw-key.txt'), 'utf8').trim();
    if (k) return k;
  } catch (e) {}
  const key = 'sk-gw-' + require('crypto').randomBytes(24).toString('hex');
  try { fs.writeFileSync(path.join(GW_DIR, 'gw-key.txt'), key, { encoding: 'ascii', flag: 'wx' }); } catch (e) {}
  try { return fs.readFileSync(path.join(GW_DIR, 'gw-key.txt'), 'utf8').trim() || key; } catch (e) { return key; }
})();
const PORT_GW = 15722;
const PORT_MAGPIE = 3425;

// --config-only：只改配置，不负责启动进程（启动交给 cmd 里的 start）
const CONFIG_ONLY = process.argv.includes('--config-only');

const stamp = () => {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('') +
         '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + String(d.getSeconds()).padStart(2, '0');
};

function ok(msg) { console.log('  [OK]   ' + msg); }
function warn(msg) { console.log('  [!]    ' + msg); }
function fail(msg) { console.log('  [X]    ' + msg); }
function step(msg) { console.log('\n' + msg); }

function portOpen(port, timeout = 700) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = v => { try { s.destroy(); } catch (e) {} resolve(v); };
    s.setTimeout(timeout);
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.on('timeout', () => done(false));
  });
}

function httpGetJson(url, timeout = 5000, headers) {
  return new Promise(resolve => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    const req = lib.get(url, { headers: headers || {} }, res => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.setTimeout(timeout, () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
  });
}

// 通过 wscript 启动：进程完全脱离本脚本，脚本退出后仍然存活
function launch(exe, args, cwd, hidden) {
  const inner = '"' + exe + '"' + (args && args.length ? ' ' + args.map(a => '"' + a + '"').join(' ') : '');
  const vbs = path.join(require('os').tmpdir(), 'wb-launch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.vbs');
  fs.writeFileSync(vbs,
    'Set sh = CreateObject("WScript.Shell")\r\n' +
    'sh.CurrentDirectory = "' + cwd + '"\r\n' +
    'sh.Run "' + inner.replace(/"/g, '""') + '", ' + (hidden ? 0 : 1) + ', False\r\n',
    'utf8');
  try { execSync('wscript.exe "' + vbs + '"', { windowsHide: true }); } catch (e) {}
  setTimeout(() => { try { fs.unlinkSync(vbs); } catch (e) {} }, 5000);
}

function processRunning(name) {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq ' + name + '" /NH', { encoding: 'latin1', windowsHide: true });
    return out.toLowerCase().includes(name.toLowerCase());
  } catch (e) {
    return false;
  }
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function buildModels() {
  const list = readJSON(MODELS_FILE, []);
  if (!Array.isArray(list)) throw new Error('models.json 格式不对（应该是数组）：' + MODELS_FILE);
  return list.map(m => ({
    name: m.id,
    labelOverride: m.label,
    anthropicFamilyTier: m.tier,
    isFamilyDefault: !!m.isDefault,
    supports1m: true,
    prefer1m: true
  }));
}

// 找出真正在用的那份配置（_meta.json 的 appliedId 优先，否则扫目录里非备份的 json）
function findConfigFiles() {
  const meta = readJSON(path.join(CFG_LIB, '_meta.json'), null);
  const out = [];
  if (meta && meta.appliedId) {
    const f = path.join(CFG_LIB, meta.appliedId + '.json');
    if (fs.existsSync(f)) out.push(f);
  }
  if (out.length === 0 && fs.existsSync(CFG_LIB)) {
    for (const f of fs.readdirSync(CFG_LIB)) {
      if (!f.endsWith('.json')) continue;
      if (f === '_meta.json' || f.includes('.bak')) continue;
      out.push(path.join(CFG_LIB, f));
    }
  }
  return out;
}

function fixConfigFile(file, models) {
  const dir = path.dirname(file);
  const bak = path.join(dir, path.basename(file) + '.bak-restore-' + stamp());
  if (fs.existsSync(file)) fs.copyFileSync(file, bak);

  const d = readJSON(file, {}) || {};
  d.inferenceProvider = 'gateway';
  d.inferenceGatewayBaseUrl = BASE_URL;
  d.inferenceGatewayApiKey = API_KEY;
  d.inferenceGatewayAuthScheme = 'bearer';
  d.inferenceCredentialKind = 'static';
  d.modelDiscoveryEnabled = true;
  d.inferenceModels = models;
  if (d.disableDeploymentModeChooser === undefined) d.disableDeploymentModeChooser = true;
  fs.writeFileSync(file, JSON.stringify(d, null, 2), 'utf8');
  ok('已写入 ' + path.basename(file) + '（备份 ' + path.basename(bak) + '）');
}

// 生成一个标准 uuid v4（CC Switch 建的那份是 00000000-0000-4000-8000-... 的固定 id）
function uuid4() {
  const h = require('crypto').randomBytes(16);
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const s = h.toString('hex');
  return [s.slice(0, 8), s.slice(8, 12), s.slice(12, 16), s.slice(16, 20), s.slice(20)].join('-');
}

// 写 _meta.json（改指向用），先备份
function writeMeta(metaFile, obj, backups) {
  if (fs.existsSync(metaFile)) {
    const bak = metaFile + '.bak-' + stamp();
    try { fs.copyFileSync(metaFile, bak); backups.push(path.basename(bak)); } catch (e) {}
  }
  fs.writeFileSync(metaFile, JSON.stringify(obj, null, 2), 'utf8');
}

// 当前配置档的实况（只读，不改任何东西）
function profileInfo() {
  const metaFile = path.join(CFG_LIB, '_meta.json');
  const meta = readJSON(metaFile, null);
  const entries = (meta && Array.isArray(meta.entries)) ? meta.entries : [];
  const id = (meta && meta.appliedId) || '';
  const file = id ? path.join(CFG_LIB, id + '.json') : '';
  const exists = !!(file && fs.existsSync(file));
  const cfg = exists ? (readJSON(file, {}) || {}) : {};
  const hit = entries.find(e => e && e.id === id);
  let list = [];
  try {
    list = fs.readdirSync(CFG_LIB).filter(f => f.endsWith('.json') && f !== '_meta.json' && !f.includes('.bak'));
  } catch (e) {}
  const key = typeof cfg.inferenceGatewayApiKey === 'string' ? cfg.inferenceGatewayApiKey : '';
  return {
    ok: true,
    dir: CFG_LIB,
    dirExists: fs.existsSync(CFG_LIB),
    appliedId: id,
    appliedName: (hit && hit.name) || '',
    profileExists: exists,
    profileCount: list.length,
    entries: entries.map(e => ({ id: e.id, name: e.name })),
    baseUrl: cfg.inferenceGatewayBaseUrl || '',
    provider: cfg.inferenceProvider || '',
    keyKind: key ? (key.startsWith('__sealed__') ? 'sealed' : 'plain') : 'none',
    isGateway: cfg.inferenceGatewayBaseUrl === BASE_URL,
    modelCount: Array.isArray(cfg.inferenceModels) ? cfg.inferenceModels.length : 0
  };
}

// 保证 configLibrary 里有一份能被 _meta.json 指向的配置档（只补全，不删任何文件）
//   mode = 'auto'  能接管就接管：appliedId 那份还在就直接用；_meta.json 丢了就挑最近改动的那份
//   mode = 'new'   强制新建一份并切过去，旧的原地留着
function ensureProfile(mode) {
  const wantNew = mode === 'new';
  const metaFile = path.join(CFG_LIB, '_meta.json');

  // 目录或 3p 配置文件不存在：不用再等 Claude 自己生成，直接按 3p 模式建出来
  // （全新机器上 Claude 会卡在登录页 / 地区限制，它自己永远不会生成这两个东西）
  if (!fs.existsSync(CFG_LIB) || !fs.existsSync(path.join(HOME, 'AppData', 'Local', 'Claude-3p', 'claude_desktop_config.json'))) {
    try {
      const b = require('./bootstrap');
      const r = b.bootstrap();
      return { ok: true, action: r.action, id: r.id, name: 'Claude 网关', file: r.profile, backups: [], created: true };
    } catch (e) {
      return { ok: false, action: 'none', error: '创建 3p 配置失败：' + e.message };
    }
  }

  const meta = readJSON(metaFile, null);
  const entries = (meta && Array.isArray(meta.entries)) ? meta.entries.slice() : [];
  const backups = [];

  // 1) 接管现有配置档
  if (!wantNew && meta && meta.appliedId) {
    const f = path.join(CFG_LIB, meta.appliedId + '.json');
    if (fs.existsSync(f)) {
      const hit = entries.find(e => e && e.id === meta.appliedId);
      return { ok: true, action: 'reuse', id: meta.appliedId, name: (hit && hit.name) || '', file: f, backups };
    }
  }

  // 2) _meta.json 丢了或坏了，但目录里有配置档：挑最近改动的那份接管
  if (!wantNew) {
    let cands = [];
    try {
      cands = fs.readdirSync(CFG_LIB)
        .filter(f => /^[0-9a-f-]{36}\.json$/i.test(f))
        .map(f => ({ f, t: fs.statSync(path.join(CFG_LIB, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
    } catch (e) {}
    if (cands.length) {
      const id = cands[0].f.replace(/\.json$/, '');
      const next = entries.length ? entries.slice() : [{ id, name: 'Claude 网关' }];
      if (!next.some(e => e && e.id === id)) next.push({ id, name: 'Claude 网关' });
      writeMeta(metaFile, { entries: next, appliedId: id }, backups);
      return { ok: true, action: 'adopt', id, name: 'Claude 网关', file: path.join(CFG_LIB, cands[0].f), backups };
    }
  }

  // 3) 真的没有：新建一份空的，交给 writeAllConfig 填内容
  const id = uuid4();
  const file = path.join(CFG_LIB, id + '.json');
  fs.writeFileSync(file, '{}\n', 'utf8');
  const next = entries.concat([{ id, name: 'Claude 网关' }]);
  writeMeta(metaFile, { entries: next, appliedId: id }, backups);
  return { ok: true, action: 'create', id, name: 'Claude 网关', file, backups };
}

// 把 models.json 的内容写进 Claude 的两份配置（configLibrary + 漫游目录）
// verbose=false 时安静执行（网关的 /admin 接口会复用这个函数）
function writeAllConfig(models, verbose) {
  const v = verbose !== false;
  // 空模型表不写 Claude 配置：写了会把 inferenceModels 清成空，Claude 里就一个模型都没有
  if (!Array.isArray(models) || models.length === 0) {
    return { ok: true, skipped: true, files: [], reason: '模型表是空的，没动 Claude 配置' };
  }
  let files = findConfigFiles();
  if (files.length === 0) {
    // 还没有配置档：直接按 3p 模式建一份（全新机器上 Claude 自己不会生成）
    try {
      const b = require('./bootstrap');
      b.bootstrap();
      files = findConfigFiles();
    } catch (e) {
      return { ok: false, files: [], error: '创建 3p 配置失败：' + e.message };
    }
    if (files.length === 0) {
      return { ok: false, files: [], error: '创建配置档后仍然找不到可写的文件' };
    }
  }

  for (const f of files) fixConfigFile(f, models);
  if (v) ok('共写入 ' + models.length + ' 个模型：' + models.map(m => m.labelOverride).join('、'));

  // 漫游目录那份也顺手对齐（老版本读的是它）
  if (fs.existsSync(ROAM_CFG)) {
    const bak = ROAM_CFG + '.bak-restore-' + stamp();
    const d = readJSON(ROAM_CFG, {}) || {};
    fs.copyFileSync(ROAM_CFG, bak);
    d.inferenceProvider = 'gateway';
    d.inferenceGatewayBaseUrl = BASE_URL;
    d.inferenceGatewayApiKey = API_KEY;
    d.inferenceGatewayAuthScheme = 'bearer';
    d.modelDiscoveryEnabled = true;
    d.deploymentMode = '3p';
    fs.writeFileSync(ROAM_CFG, JSON.stringify(d, null, 2), 'utf8');
    if (v) ok('已对齐漫游配置 claude_desktop_config.json');
  }

  return { ok: true, files: files.map(f => path.basename(f)) };
}

// 恢复 Claude 到网关接管前的原装配置：
//   - 优先还原最早的一份 .bak-bootstrap / .bak-restore / .bak-* 备份
//   - 没有备份、且文件明显带网关地址的，视为网关生成的配置并删除
//   - _meta.json 里指向被删配置档的条目一并清掉，保留 CC Switch 等其他条目
function isGatewayConfig(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return /inferenceGatewayBaseUrl|sk-gw-|127\.0\.0\.1:15722/.test(text);
  } catch (e) {
    return false;
  }
}

function backupNow(file, result) {
  if (!fs.existsSync(file)) return;
  const bak = file + '.bak-original-' + stamp();
  try {
    fs.copyFileSync(file, bak);
    result.backups.push(path.basename(bak));
  } catch (e) {}
}

function listBackups(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  return names
    .filter(n => !n.includes('.bak-original-') &&
      (n.startsWith(base + '.bak-bootstrap-') ||
       n.startsWith(base + '.bak-restore-') ||
       n.startsWith(base + '.bak-')))
    .map(n => {
      const p = path.join(dir, n);
      let mtime = 0;
      try { mtime = fs.statSync(p).mtimeMs; } catch (e) {}
      return { path: p, name: n, bootstrap: n.includes('.bak-bootstrap-'), mtime };
    })
    .sort((a, b) => a.mtime - b.mtime);
}

function pickOriginalBackup(file) {
  const all = listBackups(file);
  const boot = all.filter(x => x.bootstrap);
  return (boot.length ? boot : all)[0] || null;
}

function restoreOne(file, result, removeIfGateway) {
  const backup = pickOriginalBackup(file);
  if (backup) {
    backupNow(file, result);
    fs.copyFileSync(backup.path, file);
    result.restored.push(file);
    return;
  }
  if (removeIfGateway && fs.existsSync(file) && isGatewayConfig(file)) {
    backupNow(file, result);
    fs.unlinkSync(file);
    result.removed.push(file);
  }
}

function restoreOriginal() {
  const result = {
    ok: true,
    changed: false,
    restored: [],
    removed: [],
    backups: []
  };
  const metaFile = path.join(CFG_LIB, '_meta.json');
  let profiles = [];

  try {
    profiles = fs.readdirSync(CFG_LIB)
      .filter(n => /^[0-9a-f-]{36}\.json$/i.test(n))
      .map(n => path.join(CFG_LIB, n));
  } catch (e) {}

  const removedIds = [];
  for (const f of profiles) {
    const backup = pickOriginalBackup(f);
    if (backup) {
      backupNow(f, result);
      fs.copyFileSync(backup.path, f);
      result.restored.push(f);
    } else if (fs.existsSync(f) && isGatewayConfig(f)) {
      backupNow(f, result);
      fs.unlinkSync(f);
      result.removed.push(f);
      removedIds.push(path.basename(f, '.json'));
    }
  }

  restoreOne(DESKTOP_CFG, result, true);

  const metaBackup = pickOriginalBackup(metaFile);
  if (metaBackup) {
    backupNow(metaFile, result);
    fs.copyFileSync(metaBackup.path, metaFile);
    result.restored.push(metaFile);
  }

  const meta = readJSON(metaFile, null);
  if (meta && Array.isArray(meta.entries)) {
    const hasRemoved = meta.entries.some(e => e && removedIds.includes(String(e.id)));
    if (hasRemoved) {
      const entries = meta.entries.filter(e => e && !removedIds.includes(String(e.id)));
      backupNow(metaFile, result);
      if (!entries.length) {
        fs.unlinkSync(metaFile);
        result.removed.push(metaFile);
      } else {
        let appliedId = String(meta.appliedId || '');
        if (!entries.some(e => String(e.id) === appliedId)) appliedId = String(entries[0].id);
        fs.writeFileSync(metaFile, JSON.stringify({ entries, appliedId }, null, 2), 'utf8');
        result.restored.push(metaFile);
      }
    }
  } else if (removedIds.length && fs.existsSync(metaFile)) {
    backupNow(metaFile, result);
    fs.unlinkSync(metaFile);
    result.removed.push(metaFile);
  }

  restoreOne(ROAM_CFG, result, true);

  result.changed = !!(result.restored.length || result.removed.length);
  if (!result.changed) result.message = '没有找到安装前备份或网关配置，未改动。';
  return result;
}

async function main() {
  console.log('==============================================');
  console.log('  恢复 Claude Desktop 到自建网关配置');
  console.log('==============================================');

  const models = buildModels();

  // 1. CC Switch 是否还在跑
  step('[1/6] 检查 CC Switch');
  if (processRunning('cc-switch.exe')) {
    warn('CC Switch 正在运行！它可能会再把配置改回去。');
    warn('建议先把它关掉（托盘图标右键 → 退出），然后再运行一次本脚本。');
  } else {
    ok('CC Switch 未运行');
  }

  // 2. Magpie
  step('[2/6] 检查 Magpie（Magpie 上游的来源）');
  if (await portOpen(PORT_MAGPIE)) {
    ok('Magpie 已在运行（3425）');
  } else if (CONFIG_ONLY) {
    warn('Magpie 未运行 — 本程序只改配置，不启动它。需要时双击「启动Claude服务」');
  } else {
    warn('Magpie 没在运行，正在启动…');
    if (fs.existsSync(MAGPIE_EXE)) {
      launch(MAGPIE_EXE, [], path.dirname(MAGPIE_EXE), false);
      let up = false;
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 700));
        if (await portOpen(PORT_MAGPIE)) { up = true; break; }
      }
      if (up) ok('Magpie 启动成功（3425）');
      else warn('Magpie 已开始启动，但端口还没就绪，稍等几秒即可');
    } else {
      fail('找不到 ' + MAGPIE_EXE + '，请手动启动 Magpie');
    }
  }

  // 3. 云端上游（以 upstreams.json 为准，兼容老的 agnes.json）
  step('[3/6] 检查云端上游');
  const upsRaw = readJSON(path.join(GW_DIR, 'upstreams.json'), null);
  const upsList = (upsRaw && Array.isArray(upsRaw.upstreams)) ? upsRaw.upstreams : null;
  const agLegacy = readJSON(path.join(GW_DIR, 'agnes.json'), {});
  const agUp = upsList ? upsList.find(u => u.id === 'agnes') : null;
  const agBase = (process.env.AGNES_BASE_URL || (agUp && agUp.baseUrl) || agLegacy.baseUrl || 'https://api.agnes-ai.cn/v1').replace(/\/+$/, '');
  const agKey = process.env.AGNES_API_KEY || (agUp && agUp.apiKey) || agLegacy.apiKey || '';
  const agModel = agLegacy.model || 'agnes-3.0-flash';
  if (upsList && !agUp) {
    ok('没有 agnes 这个上游（可能已改名或删除），跳过它的检查');
  } else if (!agKey) {
    warn('没读到 Agnes 的 key（upstreams.json / agnes.json），Agnes 那个模型会鉴权失败');
  } else {
    const ar = await httpGetJson(agBase + '/models', 12000, {
      'accept': 'application/json',
      'authorization': 'Bearer ' + agKey,
      'x-api-key': agKey,
      'anthropic-version': '2023-06-01'
    });
    if (ar.status === 200) {
      let ids = [];
      try { ids = (JSON.parse(ar.body).data || []).map(m => m.id); } catch (e) {}
      ok('Agnes 云端可用（' + agBase + '，返回 ' + ids.length + ' 个模型）');
      if (ids.includes(agModel)) ok('模型 ' + agModel + ' 可访问');
      else warn('模型 ' + agModel + ' 不在返回列表里，可能改名了 — 检查「上游」页与模型表');
    } else if (ar.status === 401 || ar.status === 403) {
      warn('Agnes 鉴权失败（' + ar.status + '）— key 无效或没有该模型权限');
    } else {
      warn('Agnes 连不上（' + (ar.status || ar.body) + '）— 检查网络或域名 ' + agBase);
    }
  }

  // 4. 网关
  step('[4/6] 检查中转网关（15722）');
  if (await portOpen(PORT_GW)) {
    ok('网关已在运行（15722）');
  } else if (CONFIG_ONLY) {
    warn('网关未运行 — 本程序只改配置，不启动它。需要时双击「启动Claude服务」');
  } else {
    warn('网关没在运行，正在启动…');
    if (!fs.existsSync(NODE_EXE)) { fail('找不到 ' + NODE_EXE); }
    else {
      launch(NODE_EXE, [GW_SCRIPT], GW_DIR, true);
      let up = false;
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (await portOpen(PORT_GW)) { up = true; break; }
      }
      if (up) ok('网关启动成功（15722）');
      else fail('网关启动失败，请检查 gateway.js');
    }
  }

  // 5. 改配置
  step('[5/6] 把 Claude 的配置指回网关');
  const res = writeAllConfig(models, true);
  if (!res.ok) {
    fail('在 ' + CFG_LIB + ' 找不到 Claude 的配置文件');
    fail('请先打开一次 Claude Desktop，让它生成配置，再运行本脚本');
  }

  // 6. 验证网关真的在提供模型
  step('[6/6] 验证网关');
  const raw = readJSON(MODELS_FILE, []);
  const upMap = {};
  for (const m of raw) upMap[m.id] = m.upstream || '?';
  const vr = await httpGetJson(BASE_URL + '/v1/models');
  if (vr.status === 200) {
    try {
      const j = JSON.parse(vr.body);
      ok('网关返回 ' + j.data.length + ' 个模型：');
      for (const m of j.data) console.log('           · ' + m.display_name + '   [' + m.description + ' @' + (upMap[m.id] || '?') + ']');
      const cnt = {};
      for (const m of j.data) { const u = upMap[m.id] || '?'; cnt[u] = (cnt[u] || 0) + 1; }
      const parts = Object.keys(cnt).map(u => u + ' ' + cnt[u] + ' 个');
      console.log('         来源统计：' + parts.join(' / '));
      if (!cnt.agnes) warn('名单里没有 Agnes 的模型，检查 models.json 的 upstream 字段');
    } catch (e) {
      warn('网关返回内容无法解析');
    }
  } else {
    warn('网关没有响应（' + vr.status + '）—— Claude 里所有模型都会连不上');
    warn('请双击「启动Claude服务」确认服务和网关都起来了');
  }

  console.log('\n==============================================');
  console.log('  完成');
  console.log('==============================================');
  console.log('  下一步：完全退出 Claude Desktop 再重新打开');
  console.log('  （右键任务栏图标 → 退出，不是点 X）');
  console.log('');
}

module.exports = {
  buildModels, writeAllConfig, findConfigFiles, fixConfigFile,
  ensureProfile, profileInfo, uuid4, writeMeta, restoreOriginal,
  CFG_LIB, ROAM_CFG, DESKTOP_CFG, MODELS_FILE
};

if (require.main === module) {
  main().catch(e => {
    console.log('\n[X] 出错了：' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  });
}
