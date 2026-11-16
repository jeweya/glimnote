#!/usr/bin/env node
/**
 * glimnote MCP 服务
 *
 * 用法：
 *   node server.mjs --stdio [--root <仓库目录>]
 *   node server.mjs --http [--port 8765] [--host 127.0.0.1] [--token <token>] [--root <仓库目录>]
 *
 * stdio：按行分隔的 JSON-RPC 2.0；HTTP：Streamable HTTP（POST /mcp）+ 旧版 SSE（GET /sse）。
 * 操作 notes/、tasks/、ideas/、apps/、home/ 与 .trash/，路径全部限制在仓库根目录内。
 */

import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { createStore, StoreError } from './lib/store.mjs';
import { callTool, toolDescriptors } from './lib/tools.mjs';

// 与应用 package.json 的 version 保持一致；打包后 mcp 目录独立分发，读不到应用的 package.json
const VERSION = '0.1.9';
const SERVER_NAME = 'glimnote';
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const LATEST_PROTOCOL = '2025-06-18';
const MAX_BODY = 16 * 1024 * 1024;
const DEBUG = process.env.GLIMNOTE_MCP_DEBUG === '1';

function log(...args) {
  console.error('[glimnote-mcp]', ...args);
}

function debug(...args) {
  if (DEBUG) log(...args);
}

/* ---------------- 参数与根目录 ---------------- */

function parseArgs(argv) {
  const out = { stdio: false, http: false, host: '127.0.0.1', port: 8765, root: '', token: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} 缺少参数值`);
      i += 1;
      return argv[i];
    };
    switch (arg) {
      case '--stdio':
        out.stdio = true;
        break;
      case '--http':
        out.http = true;
        break;
      case '--port':
        out.port = Number(next());
        out.http = true;
        break;
      case '--host':
        out.host = next();
        break;
      case '--root':
        out.root = next();
        break;
      case '--token':
        out.token = next();
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--version':
      case '-v':
        out.help = false;
        out.version = true;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
    }
  }
  return out;
}

function usage() {
  return [
    '萤光笔记 MCP 服务',
    '',
    '用法：',
    '  node server.mjs --stdio [--root <仓库目录>]',
    '  node server.mjs --http [--port 8765] [--host 127.0.0.1] [--token <token>] [--root <仓库目录>]',
    '',
    '说明：',
    '  --stdio         通过标准输入输出提供 MCP（推荐，客户端自动拉起）',
    '  --http          监听回环地址，提供 POST /mcp、GET /sse、GET /health',
    '  --root          笔记仓库根目录；不传时自动发现「文档/glimnote」',
    '  --token         可选，HTTP 模式要求 Authorization: Bearer <token>',
    '',
  ].join('\n');
}

function appDataDirs() {
  const dirs = [];
  if (process.env.APPDATA) {
    dirs.push(path.join(process.env.APPDATA, 'glimnote'));
  }
  dirs.push(path.join(os.homedir(), '.config', 'glimnote'));
  dirs.push(path.join(os.homedir(), 'Library', 'Application Support', 'glimnote'));
  return dirs;
}

async function locateRoot(cliRoot) {
  if (cliRoot) return path.resolve(cliRoot);
  if (process.env.GLIMNOTE_ROOT) return path.resolve(process.env.GLIMNOTE_ROOT);

  for (const dir of appDataDirs()) {
    try {
      const pointer = (await fsp.readFile(path.join(dir, 'mcp-root.txt'), 'utf8')).trim();
      if (pointer) return path.resolve(pointer);
    } catch {
      /* next */
    }
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, 'Documents', 'glimnote'),
    path.join(home, 'OneDrive', 'Documents', 'glimnote'),
    path.join(home, 'OneDrive', '文档', 'glimnote'),
    path.join(home, '文档', 'glimnote'),
    path.join(home, 'glimnote'),
  ];
  for (const candidate of candidates) {
    try {
      const st = await fsp.stat(candidate);
      if (st.isDirectory()) return candidate;
    } catch {
      /* next */
    }
  }
  return candidates[0];
}

/* ---------------- JSON-RPC ---------------- */

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message, ...(data ? { data } : {}) } };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function negotiateProtocol(requested) {
  if (typeof requested === 'string' && SUPPORTED_PROTOCOLS.includes(requested)) return requested;
  return LATEST_PROTOCOL;
}

function makeInitializeResult(msg, root) {
  const requested = msg && msg.params ? msg.params.protocolVersion : undefined;
  const protocolVersion = negotiateProtocol(requested);
  return {
    protocolVersion,
    capabilities: {
      tools: { listChanged: false },
      logging: {},
    },
    serverInfo: {
      name: SERVER_NAME,
      title: '萤光笔记',
      version: VERSION,
    },
    instructions: [
      '这是本机萤光笔记仓库的 MCP 服务。',
      `仓库根目录：${root}`,
      '笔记是 notes/ 下的 Markdown 文件，待办是 tasks/ 下的 Markdown 文件，灵感是 ideas/ 下一条一个文件，删除的笔记/待办在 .trash/。',
      'AI 小应用在 apps/<id>/，是一个自包含 HTML + app.json + 可选 data.json；首页配置在 home/。',
      'MCP 服务不调用仓库里配置的 AI：生成小应用时由你按 get_app_guide 的规范写完整 HTML，再调用 create_app 保存。',
      '删除笔记/待办默认进回收站，可恢复；purge_*、empty_*、delete_app、delete_idea、clear_app_data 与 delete_home_* 是不可撤销操作，执行前先向用户确认。',
      '灵感可直接记录与整理：convert_ideas 生成笔记或待办后原文锁定为「已转化」；当天日记用 get_daily_note / append_daily_note。',
      '修改后用户切回萤光笔记窗口即可看到最新内容。',
    ].join('\n'),
  };
}

async function handleRpc(msg, ctx) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return rpcError(null, -32600, '无效的 JSON-RPC 消息');
  }
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
  const id = hasId ? msg.id : undefined;
  const method = typeof msg.method === 'string' ? msg.method : '';
  if (!method) {
    return hasId ? rpcError(id, -32600, '缺少 method') : undefined;
  }
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  const isNotification = !hasId;
  const respond = (payload) => (isNotification ? undefined : payload);

  try {
    switch (method) {
      case 'initialize': {
        ctx.initialized = true;
        ctx.protocol = negotiateProtocol(params.protocolVersion);
        return respond(rpcResult(id, makeInitializeResult(msg, ctx.store.root)));
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/roots/list_changed':
        return undefined;
      case 'ping':
        return respond(rpcResult(id, {}));
      case 'tools/list':
        return respond(rpcResult(id, { tools: toolDescriptors() }));
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        if (!name) return respond(rpcError(id, -32602, '缺少工具名 name'));
        const started = Date.now();
        try {
          const data = await callTool(name, params.arguments, ctx.store);
          debug(`tools/call ${name} ok ${Date.now() - started}ms`);
          return respond(
            rpcResult(id, {
              content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
              structuredContent: data,
            }),
          );
        } catch (error) {
          if (error && error.code === -32602) return respond(rpcError(id, -32602, error.message));
          const message =
            error instanceof StoreError ? error.message : error && error.message ? error.message : String(error);
          debug(`tools/call ${name} failed: ${message}`);
          return respond(
            rpcResult(id, {
              content: [{ type: 'text', text: `操作失败：${message}` }],
              isError: true,
              structuredContent: { error: message, code: error && error.code ? String(error.code) : 'ERROR' },
            }),
          );
        }
      }
      case 'logging/setLevel':
        return respond(rpcResult(id, {}));
      case 'resources/list':
        return respond(rpcResult(id, { resources: [] }));
      case 'prompts/list':
        return respond(rpcResult(id, { prompts: [] }));
      default:
        return respond(rpcError(id, -32601, `不支持的方法：${method}`));
    }
  } catch (error) {
    log('handleRpc error', error && error.message ? error.message : error);
    return respond(rpcError(id, -32603, '内部错误', error && error.message ? String(error.message) : undefined));
  }
}

/* ---------------- stdio ---------------- */

async function runStdio(store) {
  const ctx = { store, initialized: false, protocol: LATEST_PROTOCOL };
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();

  const write = (payload) => {
    if (payload === undefined) return;
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      write(rpcError(null, -32700, 'JSON 解析失败'));
      return;
    }
    // 串行处理，避免同一条笔记被两个请求并发改写
    chain = chain
      .then(() => handleRpc(msg, ctx))
      .then(write)
      .catch((error) => {
        log('stdio handler error', error && error.message ? error.message : error);
        write(rpcError(msg && msg.id, -32603, '内部错误'));
      });
  });

  await new Promise((resolve) => {
    rl.on('close', resolve);
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await chain.catch(() => {});
  log('stdio 通道已关闭，退出');
}

/* ---------------- HTTP ---------------- */

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Max-Age': '600',
    ...extra,
  };
}

function sendJson(res, status, payload, extra = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(extra),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        const error = new Error('请求体超过 16 MB');
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function tokenOf(req, url) {
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (m) return m[1].trim();
  return url.searchParams.get('token') || '';
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function runHttp(store, host, port, token) {
  const ctx = { store, initialized: false, protocol: LATEST_PROTOCOL };
  const sessions = new Map();
  const sseSessions = new Map();

  const unauthorized = (res) => sendJson(res, 401, { error: 'unauthorized' });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        name: SERVER_NAME,
        version: VERSION,
        root: store.root,
        transport: 'http',
        tools: toolDescriptors().length,
        sessions: sessions.size,
        sseSessions: sseSessions.size,
      });
      return;
    }

    if (token && !safeEqual(tokenOf(req, url), token)) {
      unauthorized(res);
      return;
    }

    try {
      if (req.method === 'GET' && url.pathname === '/sse') {
        const sessionId = crypto.randomUUID();
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          ...corsHeaders(),
        });
        sseSessions.set(sessionId, { res, createdAt: Date.now() });
        res.write(`event: endpoint\ndata: /messages?sessionId=${encodeURIComponent(sessionId)}\n\n`);
        const heartbeat = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            /* closed */
          }
        }, 25000);
        req.on('close', () => {
          clearInterval(heartbeat);
          sseSessions.delete(sessionId);
        });
        log(`SSE 会话建立 ${sessionId}`);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/messages') {
        const sessionId = url.searchParams.get('sessionId') || '';
        const session = sseSessions.get(sessionId);
        if (!session) {
          sendJson(res, 404, { error: 'session not found' });
          return;
        }
        const text = await readBody(req);
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          sendJson(res, 400, { error: 'invalid json' });
          return;
        }
        sendJson(res, 202, { accepted: true });
        const response = await handleRpc(msg, ctx);
        if (response !== undefined) {
          try {
            session.res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
          } catch {
            /* closed */
          }
        }
        return;
      }

      if (req.method === 'DELETE' && url.pathname === '/mcp') {
        const sessionId = req.headers['mcp-session-id'];
        if (typeof sessionId === 'string') sessions.delete(sessionId);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/mcp' || url.pathname === '/')) {
        res.writeHead(405, {
          'Content-Type': 'application/json; charset=utf-8',
          Allow: 'POST, DELETE, OPTIONS',
          ...corsHeaders(),
        });
        res.end(JSON.stringify({ error: '请使用 POST /mcp（SSE 客户端请用 GET /sse）' }));
        return;
      }

      if (req.method === 'POST' && (url.pathname === '/mcp' || url.pathname === '/')) {
        const text = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          sendJson(res, 400, rpcError(null, -32700, 'JSON 解析失败'));
          return;
        }

        const headerSession = req.headers['mcp-session-id'];
        let sessionId = typeof headerSession === 'string' && headerSession ? headerSession : '';
        const isInit = Array.isArray(payload)
          ? payload.some((m) => m && m.method === 'initialize')
          : payload && payload.method === 'initialize';
        if (!sessionId && isInit) sessionId = crypto.randomUUID();
        if (sessionId && isInit && !sessions.has(sessionId)) {
          sessions.set(sessionId, {
            createdAt: Date.now(),
            protocol: negotiateProtocol(payload && payload.params && payload.params.protocolVersion),
          });
        }
        if (sessionId && !sessions.has(sessionId)) {
          sessions.set(sessionId, { createdAt: Date.now(), protocol: LATEST_PROTOCOL });
        }

        let result;
        if (Array.isArray(payload)) {
          const list = await Promise.all(payload.map((m) => handleRpc(m, ctx)));
          result = list.filter((item) => item !== undefined);
          if (!result.length) {
            res.writeHead(202, corsHeaders(sessionId ? { 'Mcp-Session-Id': sessionId } : {}));
            res.end();
            return;
          }
        } else {
          result = await handleRpc(payload, ctx);
          if (result === undefined) {
            res.writeHead(202, corsHeaders(sessionId ? { 'Mcp-Session-Id': sessionId } : {}));
            res.end();
            return;
          }
        }

        const protocol = ctx.protocol || LATEST_PROTOCOL;
        sendJson(res, 200, result, {
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
          'MCP-Protocol-Version': protocol,
        });
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      if (error && error.statusCode === 413) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      log('HTTP 处理失败', error && error.message ? error.message : error);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    }
  });

  server.keepAliveTimeout = 65000;
  server.requestTimeout = 0;

  const closeAll = () => {
    for (const { res } of sseSessions.values()) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    sseSessions.clear();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.once('SIGINT', closeAll);
  process.once('SIGTERM', closeAll);

  server.listen(port, host, () => {
    log(`HTTP 模式已启动：http://${host}:${port}/mcp（健康检查 /health，SSE /sse）`);
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      log('警告：当前监听地址不是回环地址，请确认网络环境可信');
    }
    if (!token) log('提示：未设置 Token；仅建议在本机使用。设置 --token 可要求 Bearer 鉴权');
  });
  server.on('error', (error) => {
    log('HTTP 服务错误', error.message);
    process.exit(1);
  });
}

/* ---------------- 入口 ---------------- */

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${usage()}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.version) {
    console.log(VERSION);
    return;
  }

  const root = await locateRoot(args.root);
  try {
    const st = await fsp.stat(root);
    if (!st.isDirectory()) throw new Error('不是目录');
  } catch {
    log(`仓库目录尚不存在，写入时会自动创建：${root}`);
  }
  const store = createStore(root);
  log(`版本 ${VERSION} · 仓库 ${root}`);

  if (!args.http) args.stdio = true;
  if (args.stdio) {
    await runStdio(store);
    return;
  }
  const port = Number.isInteger(args.port) && args.port > 0 && args.port < 65536 ? args.port : 8765;
  runHttp(store, args.host, port, args.token || process.env.GLIMNOTE_MCP_TOKEN || '');
}

main().catch((error) => {
  log('启动失败', error && error.stack ? error.stack : error);
  process.exit(1);
});
