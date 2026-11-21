// 从零生成 Claude Desktop 的「第三方网关」配置档（3p）
// 用途：全新机器上 Claude 被登录页/地区限制卡住时，直接把配置写进去，让它一启动就是 3p 模式。
// 用法：node bootstrap.js [--quiet]
// 只写这几个文件，不删任何东西，改前都备份：
//   %LOCALAPPDATA%\Claude-3p\claude_desktop_config.json   （deploymentMode = 3p）
//   %LOCALAPPDATA%\Claude-3p\configLibrary\<uuid>.json    （网关地址 + 模型表）
//   %LOCALAPPDATA%\Claude-3p\configLibrary\_meta.json     （指向上面那份）

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GW = __dirname;
const HOME = process.env.USERPROFILE || process.env.HOME;
const APPDATA_LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const ROOT = path.join(APPDATA_LOCAL, 'Claude-3p');
const LIB = path.join(ROOT, 'configLibrary');
const DC = path.join(ROOT, 'claude_desktop_config.json');
const BASE = 'http://127.0.0.1:15722';
const QUIET = process.argv.includes('--quiet');

const out = [];
function say(s) { out.push(s); if (!QUIET) console.log(s); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } }
function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
function backup(f) {
  if (!fs.existsSync(f)) return '';
  const b = f + '.bak-bootstrap-' + stamp();
  try { fs.copyFileSync(f, b); return path.basename(b); } catch (e) { return ''; }
}
function uuid4() {
  const h = crypto.randomBytes(16);
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const s = h.toString('hex');
  return [s.slice(0, 8), s.slice(8, 12), s.slice(12, 16), s.slice(16, 20), s.slice(20)].join('-');
}

function readKey() {
  const file = path.join(GW, 'gw-key.txt');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  } catch (e) {}
  const key = 'sk-gw-' + crypto.randomBytes(24).toString('hex');
  try { fs.writeFileSync(file, key, { encoding: 'ascii', flag: 'wx' }); } catch (e) {}
  try { return fs.readFileSync(file, 'utf8').trim() || key; } catch (e) { return key; }
}

function buildModels() {
  const list = readJson(path.join(GW, 'models.json'), []);
  if (!Array.isArray(list)) return [];
  return list.filter(m => m && m.id).map(m => ({
    name: m.id,
    labelOverride: m.label || m.id,
    anthropicFamilyTier: m.tier || 'sonnet',
    isFamilyDefault: !!m.isDefault,
    supports1m: true,
    prefer1m: true
  }));
}

function main() {
  const key = readKey();
  const models = buildModels();

  // 1) Claude-3p 根目录 + configLibrary
  fs.mkdirSync(LIB, { recursive: true });
  say('目录就绪：' + ROOT);

  // 2) claude_desktop_config.json：deploymentMode = 3p
  const dcBak = backup(DC);
  const dc = readJson(DC, {}) || {};
  dc.deploymentMode = '3p';
  if (!dc.coworkUserFilesPath) dc.coworkUserFilesPath = path.join(HOME, 'Claude');
  fs.writeFileSync(DC, JSON.stringify(dc, null, 2), 'utf8');
  say('  deploymentMode = 3p' + (dcBak ? '（备份 ' + dcBak + '）' : ''));

  // 3) 选一份配置档：_meta.json 指的那份在就用，否则新建
  const metaFile = path.join(LIB, '_meta.json');
  const metaBak = backup(metaFile);
  const meta = readJson(metaFile, null) || {};
  let entries = Array.isArray(meta.entries) ? meta.entries.slice() : [];
  let id = typeof meta.appliedId === 'string' && /^[0-9a-f-]{36}$/i.test(meta.appliedId) ? meta.appliedId : '';
  if (id && !fs.existsSync(path.join(LIB, id + '.json'))) id = '';
  let action = 'reuse';
  if (!id) {
    const cands = fs.readdirSync(LIB).filter(f => /^[0-9a-f-]{36}\.json$/i.test(f));
    if (cands.length) {
      id = cands[0].replace(/\.json$/, '');
      action = 'adopt';
    } else {
      id = uuid4();
      action = 'create';
    }
  }
  if (!entries.some(e => e && e.id === id)) entries.push({ id, name: 'Claude 网关' });
  entries = entries.filter(e => e && typeof e.id === 'string');
  fs.writeFileSync(metaFile, JSON.stringify({ entries, appliedId: id }, null, 2), 'utf8');
  say('  配置档 ' + action + '：' + id + (metaBak ? '（备份 ' + metaBak + '）' : ''));

  // 4) 写那份配置档本体
  const profFile = path.join(LIB, id + '.json');
  const profBak = backup(profFile);
  const p = readJson(profFile, {}) || {};
  p.inferenceProvider = 'gateway';
  p.inferenceGatewayBaseUrl = BASE;
  if (!p.inferenceGatewayApiKey || !String(p.inferenceGatewayApiKey).trim()) p.inferenceGatewayApiKey = key;
  p.inferenceGatewayAuthScheme = 'bearer';
  p.inferenceCredentialKind = 'static';
  p.modelDiscoveryEnabled = true;
  p.disableDeploymentModeChooser = true;
  p.coworkEgressAllowedHosts = ['*'];
  if (models.length) p.inferenceModels = models;
  else if (!Array.isArray(p.inferenceModels)) p.inferenceModels = [];
  fs.writeFileSync(profFile, JSON.stringify(p, null, 2), 'utf8');
  say('  写入网关地址 ' + BASE + '，模型 ' + p.inferenceModels.length + ' 个' + (profBak ? '（备份 ' + profBak + '）' : ''));

  const res = {
    ok: true,
    action,
    id,
    root: ROOT,
    profile: profFile,
    deploymentMode: '3p',
    models: p.inferenceModels.length,
    keyKind: String(p.inferenceGatewayApiKey).startsWith('__sealed__') ? 'sealed' : 'plain',
    log: out
  };
  return res;
}

module.exports = { bootstrap: main, ROOT, LIB, DC, BASE };

if (require.main === module) {
  try {
    const r = main();
    if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(r));
    else console.log('\n完成。下一步：完全退出 Claude（任务栏右键 → 退出），再重新打开。');
    process.exit(0);
  } catch (e) {
    if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ ok: false, error: e.message }));
    else { console.error('失败：' + e.message); }
    process.exit(1);
  }
}
