import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { Store, atomicJson, readJson, repoConfig, digest, verifySecret, renderMarkdown, ASSETS, validRelative } from './core.mjs';
import { BranchStore } from './branches.mjs';
import { sourceUrl } from './providers.mjs';

const home = path.resolve(process.env.GIT_DOCS_HOME || process.cwd());
const data = path.resolve(process.env.GIT_DOCS_DATA || path.join(home, 'data'));
const configFile = path.join(data, 'config.json');
const command = process.argv[2] || 'serve';
process.umask(0o077);

async function initialize() {
  const existing = await readJson(configFile);
  if (existing) { console.log('已初始化。启动后可在网页“管理仓库”中添加或修改仓库。'); return; }
  let muted = false;
  const output = new Writable({ write(chunk, enc, cb) { if (!muted) process.stdout.write(chunk, enc); cb(); } });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  async function ask(label, secret = false) {
    if (secret) { process.stdout.write(label); muted = true; }
    const answer = await new Promise(resolve => rl.question(secret ? '' : label, resolve));
    muted = false; if (secret) console.log(); return answer.trim();
  }
  console.log('\nGit Docs · 文档门户\n支持 GitLab、GitHub、Gitee。令牌输入不回显。\n');
  try {
    const port = Number(await ask('网页端口 [8080]：') || 8080);
    const intervalMinutes = Number(await ask('同步间隔，分钟 [10]：') || 10);
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || !Number.isFinite(intervalMinutes) || intervalMinutes < 1) throw new Error('端口应为 1024–65535，同步间隔至少 1 分钟');
    let adminSecret = await ask('设置管理密码（至少 10 位，留空自动生成）：', true);
    if (!adminSecret) { adminSecret = randomBytes(18).toString('base64url'); console.log(`请保存管理密码：${adminSecret}`); }
    if (adminSecret.length < 10) throw new Error('管理密码至少需要 10 位');
    const repos = [];
    while (true) {
      const url = await ask('\n仓库 HTTP 地址（留空结束，之后也可在网页添加）：');
      if (!url) break;
      const name = await ask('显示名称（留空用仓库名）：');
      const branch = await ask('分支（留空用默认分支）：');
      const token = await ask('Token（可留空；留空匿名访问公开仓库）：', true);
      try { repos.push(repoConfig({ url, name, branch, token })); console.log('已添加。'); }
      catch (e) { console.log(`未添加：${e.message}`); }
    }
    await atomicJson(configFile, { version: 1, host: '0.0.0.0', port, intervalMinutes, adminHash: digest(adminSecret), repos });
    console.log(`\n初始化完成，已配置 ${repos.length} 个仓库。运行 bash start.sh，然后访问 http://服务器IP:${port}\n`);
  } finally { rl.close(); }
}

async function serve() {
  let config = await readJson(configFile);
  if (!config) throw new Error('请先运行 bash init.sh 完成初始化');
  const store = new BranchStore(data);
  for (const repo of config.repos) await store.load(repo);
  let stopping = false; let ticking = false; let editing = false;
  async function tick() {
    if (ticking || stopping) return; ticking = true;
    try { for (const repo of [...config.repos]) { if (stopping) break; await store.refresh(repo); } }
    finally { ticking = false; }
  }
  function reposList() {
    return config.repos.map(({ id, name }) => {
      const snapshot = store.snapshots.get(id); const status = store.statuses.get(id) || {};
      return { id, name, count: snapshot?.documents.length || 0, updatedAt: snapshot?.updatedAt, sha: snapshot?.sha?.slice(0, 8), branch: snapshot?.branch, ...status };
    });
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: http:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const u = new URL(req.url, 'http://local'); const route = u.pathname;
      if (route.startsWith('/api/admin/')) {
        const secret = String(req.headers.authorization || '').replace(/^Bearer /, '');
        if (!verifySecret(secret, config.adminHash)) return send(401, { error: '管理密码不正确' });
        if (route === '/api/admin/repos' && req.method === 'GET') {
          return send(200, { repos: config.repos.map(({ token, ...r }) => ({ ...r, hasToken: Boolean(token) })), intervalMinutes: config.intervalMinutes });
        }
        if (route === '/api/admin/cache' && req.method === 'GET') {
          const repo = config.repos.find(r => r.id === u.searchParams.get('id'));
          if (!repo) return send(404, { error: '仓库不存在' });
          return send(200, { branches: await store.cacheInfo(repo) });
        }
        if (req.method !== 'POST') return send(405, { error: '不支持此操作' });
        if (req.headers['content-type'] !== 'application/json') return send(415, { error: '需要 JSON 请求' });
        let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 32768) return send(413, { error: '请求过大' }); }
        let body; try { body = JSON.parse(raw || '{}'); } catch { return send(400, { error: '请求内容无效' }); }
        if (route === '/api/admin/cache-delete') {
          const repo = config.repos.find(r => r.id === body.id); if (!repo) return send(404, { error: '仓库不存在' });
          if (editing) return send(409, { error: '正在保存配置，请稍后重试' });
          await store.clearCache(repo, body.branch); return send(200, { ok: true });
        }
        if (route === '/api/admin/sync') {
          const repo = config.repos.find(r => r.id === body.id); if (!repo) return send(404, { error: '仓库不存在' });
          void store.sync(repo); return send(202, { ok: true });
        }
        if (route === '/api/admin/repos') {
          if (editing) return send(409, { error: '正在保存，请稍后重试' }); editing = true;
          try {
            const previous = body.id ? config.repos.find(r => r.id === body.id) : undefined;
            if (body.id && !previous) return send(404, { error: '仓库不存在' });
            if (previous && store.busy(previous.id)) return send(409, { error: '仓库正在同步，请完成后修改' });
            const repo = repoConfig(body, previous);
            if (previous && previous.url !== repo.url) repo.id = repoConfig(body).id;
            const next = { ...config, repos: previous ? config.repos.map(r => r.id === previous.id ? repo : r) : [...config.repos, repo] };
            if (next.repos.length > 100) return send(400, { error: '最多配置 100 个仓库' });
            await atomicJson(configFile, next); config = next;
            if (previous && previous.url !== repo.url) store.forget(previous.id);
            store.catalogs.delete(repo.id);
            void store.sync(repo); return send(200, { ok: true });
          } finally { editing = false; }
        }
        if (route === '/api/admin/delete') {
          if (editing || store.busy(body.id)) return send(409, { error: '正在保存或同步，请稍后重试' }); editing = true;
          try {
            const next = { ...config, repos: config.repos.filter(r => r.id !== body.id) };
            await atomicJson(configFile, next); config = next;
            store.forget(body.id);
            return send(200, { ok: true });
          } finally { editing = false; }
        }
        return send(404, { error: '接口不存在' });
      }
      const branchRoute = /^\/api\/repo\/([a-f0-9-]{36})\/(branches|branch-sync|branch-status)$/.exec(route);
      if (branchRoute) {
        const repo = config.repos.find(r => r.id === branchRoute[1]);
        if (!repo) return send(404, { error: '仓库不存在' });
        if (editing || store.cleaning.has(repo.id)) return send(409, { error: '正在保存或清理仓库，请稍后重试' });
        if (branchRoute[2] === 'branches' && req.method === 'GET') return send(200, await store.branches(repo));
        const branch = u.searchParams.get('branch');
        if (!branch || branch.length > 250 || /[\x00-\x1f]/.test(branch)) return send(400, { error: '分支名称无效' });
        if (branchRoute[2] === 'branch-status' && req.method === 'GET') return send(200, { synced: Boolean(store.snapshot(repo, branch)), ...store.state(repo, branch) });
        if (branchRoute[2] === 'branch-sync' && req.method === 'POST') {
          if (req.headers.origin && req.headers.origin !== new URL('http://' + req.headers.host).origin && req.headers.origin !== new URL('https://' + req.headers.host).origin) return send(403, { error: '请求来源无效' });
          if (req.headers['content-type'] !== 'application/json') return send(415, { error: '需要 JSON 请求' });
          const listing = await store.branches(repo);
          if (!config.repos.includes(repo) || editing) return send(409, { error: '仓库配置已变更，请重试' });
          if (!listing.branches.some(b => b.name === branch)) return send(404, { error: listing.error || '分支不存在' });
          if (!store.snapshot(repo, branch) || store.state(repo, branch).error) void store.sync(repo, branch);
          return send(202, { synced: Boolean(store.snapshot(repo, branch)), ...store.state(repo, branch) });
        }
        return send(405, { error: '不支持此操作' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: '不支持此操作' });
      if (route === '/api/repos') return send(200, { repos: reposList(), intervalMinutes: config.intervalMinutes });
      const apiMatch = /^\/api\/repo\/([a-f0-9-]{36})\/(docs|doc|search)$/.exec(route);
      if (apiMatch) {
        const repo = config.repos.find(r => r.id === apiMatch[1]);
        if (!repo) return send(404, { error: '仓库不存在' });
        const requestedBranch = u.searchParams.get('branch');
        const snapshot = store.snapshot(repo, requestedBranch);
        if (!snapshot) return send(409, { error: store.statuses.get(repo.id)?.error || '首次同步尚未完成，请稍后刷新' });
        if (apiMatch[2] === 'docs') return send(200, { name: repo.name, documents: snapshot.documents.map(({ text, ...d }) => d), updatedAt: snapshot.updatedAt, branch: snapshot.branch });
        if (apiMatch[2] === 'search') {
          const q = (u.searchParams.get('q') || '').trim().toLowerCase().slice(0, 200);
          const results = q ? snapshot.documents.filter(d => (d.title + '\n' + d.path + '\n' + d.text).toLowerCase().includes(q)).slice(0, 100).map(d => {
            const pos = d.text.toLowerCase().indexOf(q);
            return { path: d.path, title: d.title, snippet: d.text.slice(Math.max(0, pos - 40), Math.max(0, pos - 40) + 180) };
          }) : [];
          return send(200, { results });
        }
        const doc = snapshot.documents.find(d => d.path === u.searchParams.get('path'));
        if (!doc) return send(404, { error: '文档不存在或已删除' });
        return send(200, { title: doc.title, path: doc.path, html: renderMarkdown(doc.text, repo, { ...snapshot, scopedBranch: snapshot.branch }, doc.path), source: sourceUrl(repo, snapshot.branch, doc.path) });
      }
      const asset = /^\/asset\/([a-f0-9-]{36})\/(.+)$/.exec(route);
      if (asset) {
        if (!config.repos.some(r => r.id === asset[1])) return send(404, { error: '仓库不存在' });
        const file = decodeURIComponent(asset[2]); const snapshot = store.snapshot(config.repos.find(r => r.id === asset[1]), u.searchParams.get('branch'));
        if (!validRelative(file) || !snapshot?.files.includes(file) || !ASSETS.has(path.extname(file).toLowerCase())) return send(404, { error: '资源不存在' });
        const ext = path.extname(file).toLowerCase();
        const mime = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.pdf': 'application/pdf' }[ext];
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
        if (ext === '.pdf') res.setHeader('Content-Disposition', 'attachment');
        res.writeHead(200, { 'Content-Type': mime }); res.end(await fs.readFile(path.join(snapshot.root, 'files', ...file.split('/')))); return;
      }
      const staticFiles = { '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      const staticFile = staticFiles[route];
      if (staticFile) { res.writeHead(200, { 'Content-Type': staticFile[1] + '; charset=utf-8' }); return res.end(await fs.readFile(path.join(home, 'public', staticFile[0]))); }
      if (route === '/' || route === '/admin' || /^\/repo\/[a-f0-9-]{36}$/.test(route)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(await fs.readFile(path.join(home, 'public', 'index.html')));
      }
      return send(404, { error: '页面不存在' });
    } catch (e) {
      if (!res.headersSent) send(400, { error: e.code ? '文件读取或保存失败，请检查服务端目录权限' : e.message });
      else res.end();
    }
  });
  server.requestTimeout = 20000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host || '0.0.0.0', resolve); });
  console.log(`Git Docs 已启动：http://localhost:${config.port}  |  每 ${config.intervalMinutes} 分钟同步  |  ${config.repos.length} 个仓库`);
  const timer = setInterval(tick, config.intervalMinutes * 60000); void tick();
  const stop = () => { stopping = true; clearInterval(timer); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}

async function main() { try {
  if (command === 'init') await initialize();
  else if (command === 'serve') await serve();
  else if (command === 'reset-password') {
    const config = await readJson(configFile); if (!config) throw new Error('尚未初始化');
    const password = randomBytes(18).toString('base64url');
    config.adminHash = digest(password); await atomicJson(configFile, config);
    console.log(`新管理密码：${password}\n请重启服务后使用。`);
  } else throw new Error('用法：app.cjs init | serve | reset-password');
} catch (e) { console.error(e.code === 'EADDRINUSE' ? '端口已占用，请先停止旧服务或修改 data/config.json 中的 port' : e.message); process.exitCode = 1; } }
void main();
