'use strict';

// Anthropic Messages <-> OpenAI Chat Completions 双向转换
// 网关主程序只处理 Anthropic 协议；声明了 api: 'openai' 的上游走这里。
//
// 转换边界（已知取舍）：
//   · thinking / redacted_thinking 块丢弃（OpenAI 无对应概念）
//   · cache_control 丢弃
//   · OpenAI 的 content_filter 结束原因映射成 end_turn
//   · 流式 tool_call 参数按 JSON 片段原样转成 input_json_delta

const http = require('http');
const https = require('https');

const DEFAULT_MAX_TOKENS = 8192;

function genId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function safeJson(s) {
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(String(s == null ? '{}' : s)); } catch (e) { return {}; }
}

function blocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content.filter(Boolean) : [];
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  return blocksOf(content).map(b => {
    if (b.type === 'text') return b.text || '';
    if (b.type === 'image') return '[image]';
    return '';
  }).filter(Boolean).join('\n');
}

function isReasoningModel(model) {
  return /^(o\d|gpt-[5-9])/i.test(String(model || ''));
}

// ---------- 请求：Anthropic -> OpenAI ----------

function toOpenAI(areq, model) {
  const messages = [];

  const sys = areq.system;
  if (typeof sys === 'string' && sys.trim()) {
    messages.push({ role: 'system', content: sys });
  } else if (Array.isArray(sys)) {
    const t = blocksOf(sys).filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (t.trim()) messages.push({ role: 'system', content: t });
  }

  for (const m of (areq.messages || [])) {
    const blocks = blocksOf(m.content);

    if (m.role === 'assistant') {
      let text = '';
      const calls = [];
      for (const b of blocks) {
        if (b.type === 'text') text += b.text || '';
        else if (b.type === 'tool_use') {
          calls.push({
            id: b.id || genId('call_'),
            type: 'function',
            function: { name: b.name || '', arguments: JSON.stringify(b.input || {}) }
          });
        }
      }
      const msg = { role: 'assistant', content: text || null };
      if (calls.length) msg.tool_calls = calls;
      if (text || calls.length) messages.push(msg);
      continue;
    }

    // user：文本/图片留在这条消息里，tool_result 单独转成 role:'tool'
    const parts = [];
    const toolMsgs = [];
    for (const b of blocks) {
      if (b.type === 'text') {
        if (b.text) parts.push({ type: 'text', text: b.text });
      } else if (b.type === 'image') {
        const src = b.source || {};
        if (src.type === 'base64' && src.data) {
          parts.push({ type: 'image_url', image_url: { url: 'data:' + (src.media_type || 'image/png') + ';base64,' + src.data } });
        } else if (src.type === 'url' && src.url) {
          parts.push({ type: 'image_url', image_url: { url: src.url } });
        }
      } else if (b.type === 'tool_result') {
        let txt = toolResultText(b.content);
        if (b.is_error) txt = 'ERROR: ' + txt;
        toolMsgs.push({ role: 'tool', tool_call_id: b.tool_use_id || '', content: txt || '(no output)' });
      }
    }
    // tool 消息必须紧跟在 assistant 的 tool_calls 之后，所以先于同一轮的 user 文本
    for (const t of toolMsgs) messages.push(t);
    if (parts.length) {
      const simple = parts.length === 1 && parts[0].type === 'text';
      messages.push({ role: 'user', content: simple ? parts[0].text : parts });
    }
  }

  const out = { model: model, messages: messages, stream: !!areq.stream };
  const mt = Number(areq.max_tokens) > 0 ? Number(areq.max_tokens) : DEFAULT_MAX_TOKENS;
  if (isReasoningModel(model)) {
    out.max_completion_tokens = mt;
  } else {
    out.max_tokens = mt;
    if (areq.temperature != null) out.temperature = Number(areq.temperature);
    if (areq.top_p != null) out.top_p = Number(areq.top_p);
  }
  if (Array.isArray(areq.stop_sequences) && areq.stop_sequences.length) out.stop = areq.stop_sequences;

  if (Array.isArray(areq.tools) && areq.tools.length) {
    out.tools = areq.tools.filter(t => t && t.name).map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} }
      }
    }));
  }
  const tc = areq.tool_choice;
  if (tc && out.tools) {
    if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'none') out.tool_choice = 'none';
    else if (tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
  }

  return out;
}

// ---------- 响应：OpenAI -> Anthropic ----------

function mapStop(reason, hasToolUse) {
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  if (reason === 'stop') return hasToolUse ? 'tool_use' : 'end_turn';
  return 'end_turn';
}

function toAnthropic(o, model) {
  const choice = (o.choices || [])[0] || {};
  const msg = choice.message || {};
  const content = [];

  if (typeof msg.content === 'string' && msg.content) {
    content.push({ type: 'text', text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const p of msg.content) if (p && p.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
  }
  for (const tc of (msg.tool_calls || [])) {
    content.push({
      type: 'tool_use',
      id: tc.id || genId('toolu_'),
      name: (tc.function && tc.function.name) || '',
      input: safeJson(tc.function && tc.function.arguments)
    });
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  const usage = o.usage || {};
  return {
    id: genId('msg_'),
    type: 'message',
    role: 'assistant',
    model: model,
    content: content,
    stop_reason: mapStop(choice.finish_reason, content.some(c => c.type === 'tool_use')),
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens) || 0,
      output_tokens: Number(usage.completion_tokens) || 0
    }
  };
}

// ---------- 转发 ----------

function sendErr(res, status, type, message) {
  if (res.headersSent) { try { res.end(); } catch (e) {} return; }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ type: 'error', error: { type: type, message: message } }));
}

function forward(up, entry, areq, res, log) {
  const target = entry.target;
  let payload;
  try {
    payload = toOpenAI(areq, target);
  } catch (e) {
    log('[openai] 请求转换失败: ' + e.message);
    return sendErr(res, 400, 'invalid_request_error', '请求转换失败：' + e.message);
  }

  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const lib = up.proto === 'https' ? https : http;
  const headers = {
    'content-type': 'application/json',
    'content-length': String(body.length),
    accept: payload.stream ? 'text/event-stream' : 'application/json',
    authorization: 'Bearer ' + up.key
  };

  const ureq = lib.request({
    host: up.host,
    port: up.port,
    path: (up.prefix || '') + '/v1/chat/completions',
    method: 'POST',
    headers: headers
  }, upRes => {
    if (upRes.statusCode >= 400) {
      let d = '';
      upRes.setEncoding('utf8');
      upRes.on('data', c => d += c);
      upRes.on('end', () => {
        let msg = d;
        try {
          const j = JSON.parse(d);
          msg = (j.error && (j.error.message || j.error.msg)) || j.message || d;
        } catch (e) {}
        log('[openai] 上游 ' + upRes.statusCode + ' ' + String(msg).slice(0, 200));
        sendErr(res, upRes.statusCode, 'api_error', '上游返回 ' + upRes.statusCode + '：' + String(msg).slice(0, 500));
      });
      return;
    }

    if (!payload.stream) {
      let d = '';
      upRes.setEncoding('utf8');
      upRes.on('data', c => d += c);
      upRes.on('end', () => {
        let j;
        try { j = JSON.parse(d); } catch (e) {
          return sendErr(res, 502, 'api_error', '上游返回的不是 JSON：' + d.slice(0, 200));
        }
        const out = toAnthropic(j, areq.model);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out));
      });
      return;
    }

    streamConvert(upRes, res, areq.model, log);
  });

  ureq.on('error', err => {
    log('[openai] ' + up.proto + '://' + up.host + ' ' + err.message);
    sendErr(res, 502, 'api_error', err.message);
  });
  ureq.setTimeout(600000, () => ureq.destroy(new Error('upstream timeout')));
  ureq.end(body);
}

// ---------- 流式：OpenAI SSE -> Anthropic SSE ----------

function sse(res, type, obj) {
  res.write('event: ' + type + '\n');
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

function streamConvert(upRes, res, model, log) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });

  const messageId = genId('msg_');
  let started = false;
  let textBlock = -1;
  let textOpen = false;
  const tools = {};
  let nextBlock = 0;
  let stopReason = 'end_turn';
  let outChars = 0;
  let finished = false;

  function startMessage() {
    if (started) return;
    started = true;
    sse(res, 'message_start', {
      type: 'message_start',
      message: {
        id: messageId, type: 'message', role: 'assistant', model: model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  }

  function closeText() {
    if (!textOpen) return;
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: textBlock });
    textOpen = false;
  }

  function onText(txt) {
    if (!txt) return;
    startMessage();
    outChars += txt.length;
    if (!textOpen) {
      textBlock = nextBlock++;
      textOpen = true;
      sse(res, 'content_block_start', {
        type: 'content_block_start', index: textBlock,
        content_block: { type: 'text', text: '' }
      });
    }
    sse(res, 'content_block_delta', {
      type: 'content_block_delta', index: textBlock,
      delta: { type: 'text_delta', text: txt }
    });
  }

  function onToolDelta(tc) {
    startMessage();
    const k = (tc.index == null) ? 0 : tc.index;
    let t = tools[k];
    if (!t) {
      closeText();
      t = tools[k] = {
        idx: nextBlock++,
        id: tc.id || genId('toolu_'),
        name: (tc.function && tc.function.name) || '',
        open: true
      };
      sse(res, 'content_block_start', {
        type: 'content_block_start', index: t.idx,
        content_block: { type: 'tool_use', id: t.id, name: t.name, input: {} }
      });
    } else {
      if (!t.name && tc.function && tc.function.name) t.name = tc.function.name;
      if (!t.id && tc.id) t.id = tc.id;
    }
    const args = tc.function && tc.function.arguments;
    if (typeof args === 'string' && args.length) {
      outChars += args.length;
      sse(res, 'content_block_delta', {
        type: 'content_block_delta', index: t.idx,
        delta: { type: 'input_json_delta', partial_json: args }
      });
    }
  }

  function handleChunk(j) {
    const choice = (j.choices || [])[0] || {};
    const d = choice.delta || {};
    if (typeof d.content === 'string') onText(d.content);
    else if (Array.isArray(d.content)) for (const p of d.content) if (p && p.type === 'text') onText(p.text);
    if (Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) onToolDelta(tc);
    if (choice.finish_reason) stopReason = mapStop(choice.finish_reason, Object.keys(tools).length > 0);
  }

  function finish() {
    if (finished) return;
    finished = true;
    startMessage();
    // 按 index 顺序关闭所有还开着的块：文本和工具可能交替出现，
    // 不能只先关文本，否则 content_block_stop 的顺序会和 start 不一致
    const open = [];
    if (textOpen) open.push({ idx: textBlock, isText: true });
    for (const k of Object.keys(tools)) {
      const t = tools[k];
      if (t.open) open.push({ idx: t.idx, t: t });
    }
    open.sort((a, b) => a.idx - b.idx);
    for (const o of open) {
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: o.idx });
      if (o.isText) textOpen = false; else o.t.open = false;
    }
    sse(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: Math.ceil(outChars / 4) }
    });
    sse(res, 'message_stop', { type: 'message_stop' });
    try { res.end(); } catch (e) {}
  }

  let buf = '';
  upRes.setEncoding('utf8');
  upRes.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      line = line.replace(/\r$/, '');
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === '[DONE]') { finish(); return; }
      let j;
      try { j = JSON.parse(data); } catch (e) { continue; }
      try { handleChunk(j); } catch (e) { log('[openai] 流解析失败: ' + e.message); }
    }
  });
  upRes.on('end', finish);
  upRes.on('error', e => { log('[openai] 流读取失败: ' + e.message); finish(); });
  // 上游socket直接断开时既没有 end 也没有 error，靠 close 兜底，否则连接会一直挂着
  upRes.on('close', () => { if (!finished) { log('[openai] 上游连接提前关闭'); finish(); } });
  res.on('close', () => { finished = true; try { upRes.destroy(); } catch (e) {} });
}

// ---------- 协议自动识别 ----------

function probeRequest(up, path, headers, body, timeout) {
  return new Promise(resolve => {
    const lib = up.proto === 'https' ? https : http;
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const h = Object.assign({ accept: 'application/json' }, headers || {});
    if (payload) { h['content-type'] = 'application/json'; h['content-length'] = String(payload.length); }
    let done = false;
    const fin = v => { if (done) return; done = true; resolve(v); };
    const req = lib.request({
      host: up.host, port: up.port, path: path,
      method: payload ? 'POST' : 'GET', headers: h
    }, res => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => fin({ status: res.statusCode || 0, body: d }));
    });
    req.on('error', e => fin({ status: 0, body: e.message }));
    // 探测只是用来分协议，不能让面板卡太久：8 秒足够，两次最坏 16 秒
    req.setTimeout(timeout || 8000, () => req.destroy(new Error('timeout')));
    req.end(payload || undefined);
  });
}

// 判断上游说哪种协议：
//   2xx           -> Anthropic 端点存在
//   400 且提到 model -> 端点存在，只是模型名不对 -> Anthropic
//   404           -> 没有 /v1/messages，用 chat 再确认一次
//   403           -> 端点存在但该 key 无权调用 -> 按 OpenAI 处理（真实案例就是这种）
//   401/其他      -> 无法判断，保持 Anthropic，让用户先解决 key
async function detect(up, key, log) {
  const base = up.prefix || '';
  const h = {
    authorization: 'Bearer ' + key,
    'x-api-key': key,
    'anthropic-version': '2023-06-01'
  };

  const a = await probeRequest(up, base + '/v1/messages', h, {
    model: 'probe', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }]
  });
  const low = String(a.body || '').toLowerCase();

  if (a.status >= 200 && a.status < 300) return { api: 'anthropic', confident: true, status: a.status, reason: 'messages ok' };
  if (a.status === 400 && low.indexOf('model') >= 0) return { api: 'anthropic', confident: true, status: a.status, reason: 'messages 400 model' };
  if (a.status === 403) return { api: 'openai', confident: true, status: a.status, reason: 'messages 403 forbidden' };
  if (a.status === 401) return { api: 'anthropic', confident: false, status: a.status, reason: 'unauthorized, check key' };

  if (a.status === 404) {
    const o = await probeRequest(up, base + '/v1/chat/completions', { authorization: 'Bearer ' + key }, {
      model: 'probe',
      messages: [{ role: 'user', content: 'hi' }],
      max_completion_tokens: 1
    });
    if (o.status >= 200 && o.status < 300) return { api: 'openai', confident: true, status: o.status, reason: 'messages 404, chat ok' };
    if (o.status === 400) return { api: 'openai', confident: true, status: o.status, reason: 'messages 404, chat 400' };
    return { api: 'anthropic', confident: false, status: a.status, reason: 'inconclusive (messages 404, chat ' + o.status + ')' };
  }

  return { api: 'anthropic', confident: false, status: a.status, reason: 'inconclusive ' + a.status };
}

module.exports = { forward: forward, toOpenAI: toOpenAI, toAnthropic: toAnthropic, mapStop: mapStop, detect: detect };
