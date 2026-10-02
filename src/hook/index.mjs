// 推送即同步：Git 平台 push 后主动通知本服务，收到就立刻触发一次同步。
// 与 AI 模块一样，主服务只把匹配到的路由转发过来。
import { verifySecret } from '../core.mjs';

const MAX_BODY = 1024 * 1024;
const COOLDOWN_MS = 15000;

function normalize(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const u = new URL(text);
    return (u.origin + u.pathname.replace(/\/+$/, '').replace(/\.git$/i, '')).toLowerCase();
  } catch {
    return text.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
  }
}

function candidateUrls(payload) {
  const out = [];
  const add = value => { if (typeof value === 'string' && value.trim()) out.push(value); };
  const repository = payload && payload.repository;
  if (repository && typeof repository === 'object') {
    add(repository.git_http_url); add(repository.http_url); add(repository.clone_url);
    add(repository.html_url); add(repository.web_url); add(repository.git_url);
    add(repository.url); add(repository.homepage);
  }
  const project = payload && payload.project;
  if (project && typeof project === 'object') {
    add(project.git_http_url); add(project.web_url); add(project.http_url);
  }
  return out;
}

async function readPayload(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) { const error = new Error('请求过大'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (type.includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(raw);
    const payload = form.get('payload');
    if (payload) { try { return JSON.parse(payload); } catch { return {}; } }
    return Object.fromEntries(form.entries());
  }
  try { return JSON.parse(raw); } catch { return {}; }
}

export function createHook({ getConfig, store }) {
  const lastRun = new Map();

  function authorized(req, url) {
    const expected = String(process.env.GIT_DOCS_HOOK_TOKEN || '').trim();
    const provided = String(url.searchParams.get('token') || req.headers['x-gitlab-token'] || req.headers['x-gitee-token'] || '').trim();
    if (!provided) return false;
    if (expected) return provided === expected;
    return verifySecret(provided, getConfig().adminHash);
  }

  return {
    async handle(req, res, url) {
      if (url.pathname !== '/hook') return false;
      const send = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(value));
      };
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '仅支持 POST' }));
        return true;
      }
      if (!authorized(req, url)) { send(401, { error: '密码不正确' }); return true; }
      let payload;
      try { payload = await readPayload(req); }
      catch (error) { send(error.status || 400, { error: error.message }); return true; }

      const repos = getConfig().repos;
      const wanted = new Set(repos.map(repo => normalize(repo.url)));
      const matched = new Set();
      for (const value of candidateUrls(payload)) {
        const key = normalize(value);
        if (key && wanted.has(key)) matched.add(key);
      }
      const now = Date.now();
      const triggered = [];
      for (const key of matched) {
        const repo = repos.find(item => normalize(item.url) === key);
        if (!repo) continue;
        if (now - (lastRun.get(repo.id) || 0) < COOLDOWN_MS) continue;
        lastRun.set(repo.id, now);
        void store.sync(repo);
        triggered.push(repo.name);
      }
      send(200, { ok: true, matched: matched.size, triggered });
      return true;
    }
  };
}
