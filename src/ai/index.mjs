// AI 模块的 HTTP 入口：MCP 协议端点、原始 Markdown、llms.txt。
// 主服务只需要把匹配到的路由交给这里的 handle()。
import { randomUUID } from 'node:crypto';
import { createDataset, AiError } from './dataset.mjs';
import { TOOLS, PROTOCOL_VERSION, callTool } from './mcp.mjs';
import { VERSION } from '../version.mjs';

const MAX_BODY = 1024 * 1024;
const AI_ROUTES = new Set(['/mcp', '/raw', '/llms.txt']);

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new AiError(413, '请求过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createAi({ getConfig, store }) {
  const dataset = createDataset({ getConfig, store });

  function sendJson(res, status, value, extra) {
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra || {}));
    res.end(JSON.stringify(value));
  }

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  function authorized(req) {
    const secret = String(process.env.GIT_DOCS_AI_TOKEN || '').trim();
    if (!secret) return true;
    return String(req.headers.authorization || '') === 'Bearer ' + secret;
  }

  async function handleRpc(message) {
    const id = message && typeof message === 'object' && Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : undefined;
    const notification = id === undefined || id === null;
    const ok = result => ({ jsonrpc: '2.0', id: notification ? null : id, result });
    const fail = (code, text) => ({ jsonrpc: '2.0', id: notification ? null : id, error: { code, message: text } });
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return fail(-32600, '无效请求');
    const method = message.method;
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    if (method === 'initialize') return ok({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'git-docs', title: 'Git Docs 文档服务', version: VERSION } });
    if (method.startsWith('notifications/')) return null;
    if (notification) return null;
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: TOOLS });
    if (method === 'tools/call') {
      const tool = TOOLS.find(item => item.name === params.name);
      if (!tool) return fail(-32602, '未知工具：' + String(params.name));
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      try {
        const value = await callTool(tool.name, args, dataset);
        return ok({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
      } catch (error) {
        return ok({ content: [{ type: 'text', text: error && error.message ? error.message : '工具执行失败' }], isError: true });
      }
    }
    return fail(-32601, '未知方法：' + method);
  }

  async function mcp(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'MCP 端点仅支持 POST' }));
      return;
    }
    if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
      sendJson(res, 415, { error: '需要 application/json 请求' });
      return;
    }
    let payload;
    try { payload = JSON.parse(await readBody(req) || 'null'); }
    catch { sendJson(res, 400, { error: '请求内容不是有效 JSON' }); return; }
    const messages = Array.isArray(payload) ? payload : [payload];
    if (!messages.length || messages.some(item => !item || typeof item !== 'object')) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: '无效请求' } });
      return;
    }
    const responses = [];
    let started = false;
    for (const message of messages) {
      if (message.method === 'initialize') started = true;
      const response = await handleRpc(message);
      if (response) responses.push(response);
    }
    const extra = started ? { 'Mcp-Session-Id': randomUUID() } : {};
    if (!responses.length) { res.writeHead(202, extra); res.end(); return; }
    sendJson(res, 200, Array.isArray(payload) ? responses : responses[0], extra);
  }

  function raw(res, url) {
    const repo = dataset.findRepo(url.searchParams.get('repo'));
    const doc = dataset.getDoc(repo, url.searchParams.get('path'), url.searchParams.get('branch') || undefined);
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=30',
      'X-Doc-Repo': repo.id,
      'X-Doc-Branch': encodeURIComponent(doc.branch),
      'X-Doc-Path': encodeURIComponent(doc.path)
    });
    res.end(doc.text);
  }

  function llms(res, url) {
    const reference = url.searchParams.get('repo');
    const body = reference ? dataset.llmsRepo(reference, url.searchParams.get('branch') || undefined) : dataset.llmsIndex();
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=30' });
    res.end(body);
  }

  return {
    async handle(req, res, url) {
      if (!AI_ROUTES.has(url.pathname)) return false;
      if (!originAllowed(req)) { sendJson(res, 403, { error: '请求来源无效' }); return true; }
      if (!authorized(req)) { sendJson(res, 401, { error: '需要 AI 访问令牌' }); return true; }
      try {
        if (url.pathname === '/mcp') { await mcp(req, res); return true; }
        if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { error: '不支持此操作' }); return true; }
        if (url.pathname === '/raw') raw(res, url); else llms(res, url);
        return true;
      } catch (error) {
        sendJson(res, error instanceof AiError ? error.status : 500, { error: error && error.message ? error.message : '服务端错误' });
        return true;
      }
    }
  };
}
