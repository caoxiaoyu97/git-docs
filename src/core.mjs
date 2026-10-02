import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import tar from 'tar-stream';
import { Marked } from 'marked';
import sanitize from 'sanitize-html';
import highlight from 'highlight.js/lib/common';
import { createProvider, providerType, sourceUrl } from './providers.mjs';

export const ASSETS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.ico', '.pdf']);
const SKIP = new Set(['.git', 'target', 'node_modules', '.idea', '.gradle']);
const LIMIT = 256 * 1024 * 1024;
export const digest = s => createHash('sha256').update(s).digest('hex');
export function verifySecret(value, hash) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(hash || '') && timingSafeEqual(Buffer.from(digest(value), 'hex'), Buffer.from(hash, 'hex'));
}
export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temp, file);
}
export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function validRelative(value) {
  if (!value || value.includes('\\') || value.includes('\0') || value.startsWith('/')) return false;
  return value.split('/').every(s => s && s !== '.' && s !== '..' && !/[:\x00-\x1f]/.test(s));
}
export function repoConfig(input, previous = {}) {
  let u;
  try { u = new URL(String(input.url || '').trim()); } catch { throw new Error('请输入完整的 HTTP/HTTPS 仓库地址'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('仓库地址必须是 HTTP/HTTPS 地址，不能包含凭据、查询参数或片段');
  const provider = providerType({ url: u.href });
  const previousBase = previous.url === u.href.replace(/\/$/, '').replace(/\.git$/, '') ? previous.gitlabBase : null;
  const customBase = input.gitlabBase || previousBase;
  let base = provider === 'gitlab' && customBase ? new URL(String(customBase).replace(/\/$/, '')) : new URL(u.origin);
  if (base.origin !== u.origin || base.username || base.password || base.search || base.hash) throw new Error('GitLab 根地址必须与仓库地址同源');
  let prefix = base.pathname.replace(/\/$/, '');
  if (!u.pathname.startsWith(prefix + '/')) throw new Error('仓库不在指定 GitLab 根地址下');
  let project = decodeURIComponent(u.pathname.slice(prefix.length + 1)).replace(/\/$/, '').replace(/\.git$/, '');
  if (!validRelative(project) || project.includes('/-/') || project.split('/').length < 2 || (provider !== 'gitlab' && project.split('/').length !== 2)) throw new Error('请输入仓库首页或 HTTP 克隆地址，不要填写文件或分支页面地址');
  const sameOrigin = previous.url && new URL(previous.url).origin === u.origin;
  const token = String(input.token || (sameOrigin && !input.clearToken ? previous.token : '') || '').trim();
  if (/[\r\n]/.test(token)) throw new Error('Token 不能包含换行');
  const branch = String(input.branch || '').trim();
  if (branch.length > 250 || /[\x00-\x1f]/.test(branch)) throw new Error('分支名称无效');
  const name = String(input.name || project.split('/').at(-1)).trim().slice(0, 100);
  return { id: previous.id || randomUUID(), name, url: `${u.origin}${prefix}/${project}`, provider, ...(provider === 'gitlab' ? { gitlabBase: base.href.replace(/\/$/, '') } : {}), project, token, branch };
}

function meter(max, message) {
  let n = 0;
  return new Transform({ transform(chunk, enc, cb) { n += chunk.length; cb(n > max ? new Error(message) : null, chunk); } });
}
export async function extractDocs(source, destination) {
  let earlyError;
  const captureError = error => { earlyError = error; };
  source.on('error', captureError);
  await fs.mkdir(destination, { recursive: true });
  if (earlyError) throw earlyError;
  const extractor = tar.extract();
  const documents = []; const files = new Set(); let total = 0; let entries = 0;
  const pending = new Set();
  extractor.on('entry', (header, stream, next) => {
    stream.on('error', () => {}); // The outer pipeline reports archive failures.
    const task = (async () => {
      if (++entries > 250000) throw new Error('仓库文件数超过 250000');
      const name = header.name.replace(/\/$/, '');
      if (!validRelative(name)) throw new Error('压缩包包含不安全路径');
      const relative = name.split('/').slice(1).join('/');
      const ext = path.posix.extname(relative).toLowerCase();
      const selected = relative && !relative.split('/').some(s => SKIP.has(s)) && (ext === '.md' || ASSETS.has(ext));
      if (header.type !== 'file' || !selected) { for await (const ignored of stream) {} return; }
      if (files.has(relative)) throw new Error('压缩包中存在重复路径');
      files.add(relative);
      if (header.size > (ext === '.md' ? 2 * 1024 * 1024 : 25 * 1024 * 1024)) throw new Error('单个文档超过 2MB 或图片/附件超过 25MB');
      total += header.size;
      if (total > LIMIT) throw new Error('文档和资源总量超过 256MB');
      const out = path.join(destination, ...relative.split('/'));
      await fs.mkdir(path.dirname(out), { recursive: true });
      await pipeline(stream, createWriteStream(out, { flags: 'wx', mode: 0o600 }));
      if (ext === '.md') {
        let text = (await fs.readFile(out, 'utf8')).replace(/^\uFEFF/, '');
        const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
        documents.push({ path: relative, title: heading || path.posix.basename(relative, path.posix.extname(relative)), text });
      }
    })();
    pending.add(task);
    task.then(() => { pending.delete(task); next(); }, e => { pending.delete(task); stream.destroy(e); extractor.destroy(e); });
  });
  try {
    await pipeline(source, meter(512 * 1024 * 1024, '压缩包超过 512MB'), createGunzip(), meter(2 * 1024 ** 3, '解压数据超过 2GB'), extractor);
  } finally { source.off('error', captureError); await Promise.allSettled([...pending]); }
  documents.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
  return { documents, files: [...files], totalBytes: total };
}

export class Store {
  constructor(directory, fetchImpl = fetch) { this.directory = directory; this.fetchImpl = fetchImpl; this.snapshots = new Map(); this.statuses = new Map(); this.running = new Map(); }
  repoDir(id) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('仓库 ID 无效'); return path.join(this.directory, 'repos', id); }
  async load(repo) {
    const pointer = await readJson(path.join(this.repoDir(repo.id), 'current.json'));
    if (pointer && /^[a-f0-9-]{36}$/.test(pointer.version)) {
      const root = path.join(this.repoDir(repo.id), 'versions', pointer.version);
      const index = await readJson(path.join(root, 'index.json'));
      if (index) this.snapshots.set(repo.id, { ...index, root });
    }
  }
  async sync(repo) {
    if (this.running.has(repo.id)) return this.running.get(repo.id);
    const job = this.doSync(repo).finally(() => this.running.delete(repo.id));
    this.running.set(repo.id, job); return job;
  }
  async doSync(repo) {
    const start = new Date().toISOString(); let stage;
    this.statuses.set(repo.id, { checking: true, phase: 'checking', checkedAt: start });
    try {
      const provider = createProvider(repo, this.fetchImpl, { cacheDir: path.join(this.repoDir(repo.id), 'public-cache') });
      const { branch, sha } = await provider.latest();
      const old = this.snapshots.get(repo.id);
      if (old?.sha === sha && old.branch === branch && old.project === repo.project && old.gitlabBase === repo.gitlabBase && (old.provider || 'gitlab') === provider.type) {
        this.statuses.set(repo.id, { checking: false, phase: 'complete', checkedAt: new Date().toISOString() }); return;
      }
      const version = randomUUID(); stage = path.join(this.repoDir(repo.id), 'versions', version);
      this.statuses.set(repo.id, { checking: true, phase: 'downloading', checkedAt: start });
      const response = await provider.archive(sha);
      const source = Readable.fromWeb(response.body);
      source.once('end', () => this.statuses.set(repo.id, { checking: true, phase: 'processing', checkedAt: start }));
      const index = await extractDocs(source, path.join(stage, 'files'));
      const snapshot = { ...index, sha, branch, project: repo.project, provider: provider.type, gitlabBase: repo.gitlabBase, updatedAt: new Date().toISOString() };
      await atomicJson(path.join(stage, 'index.json'), snapshot);
      await atomicJson(path.join(this.repoDir(repo.id), 'current.json'), { version });
      this.snapshots.set(repo.id, { ...snapshot, root: stage }); stage = null;
      this.statuses.set(repo.id, { checking: false, phase: 'complete', checkedAt: new Date().toISOString() });
      // Keep previous version for in-flight readers; bound disk growth to two snapshots.
      const versions = await fs.readdir(path.join(this.repoDir(repo.id), 'versions'));
      for (const v of versions) if (/^[a-f0-9-]{36}$/.test(v) && v !== version && (!old || path.basename(old.root) !== v)) {
        await fs.rm(path.join(this.repoDir(repo.id), 'versions', v), { recursive: true, force: true });
      }
    } catch (e) {
      this.statuses.set(repo.id, { checking: false, phase: 'failed', checkedAt: new Date().toISOString(), error: e.code === 'ENOSPC' ? '存储空间不足，请清理缓存后重试' : repo.token ? e.message.replaceAll(repo.token, '[已隐藏]') : e.message });
    } finally {
      if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export function docUrl(id, file, hash = '') { return `/repo/${id}?path=${encodeURIComponent(file)}${hash}`; }
export function renderMarkdown(text, repo, snapshot, file) {
  const seen = new Map();
  const markdown = new Marked({ gfm: true, breaks: false });
  markdown.use({ renderer: { code({ text, lang }) {
    const language = (lang || '').split(/\s/)[0];
    const html = language && highlight.getLanguage(language) ? highlight.highlight(text, { language, ignoreIllegals: true }).value : text.replace(/[&<>]/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[s]));
    const className = language.replace(/[^A-Za-z0-9+#-]/g, '');
    return `<pre><code${className ? ' class="language-' + className + '"' : ''}>${html}</code></pre>`;
  }, heading({ tokens, depth }) {
    const html = this.parser.parseInline(tokens);
    const plain = sanitize(html, { allowedTags: [], allowedAttributes: {} });
    const base = plain.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/\s/g, '-');
    const n = seen.get(base) || 0; seen.set(base, n + 1);
    return `<h${depth} id="${base}${n ? '-' + n : ''}">${html}</h${depth}>`;
  } } });
  const fileSet = new Set(snapshot.files);
  function rewrite(value, image) {
    if (!value || value.startsWith('#')) return value;
    if (/^(https?:|mailto:)/i.test(value) || value.startsWith('//')) return value;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return '';
    try {
      const parsed = new URL(value, 'https://docs.invalid/' + file.split('/').map(encodeURIComponent).join('/'));
      const resolved = decodeURIComponent(parsed.pathname.slice(1));
      if (!validRelative(resolved)) return '';
      if (/\.md$/i.test(resolved)) return docUrl(repo.id, resolved, '') + (snapshot.scopedBranch ? '&branch=' + encodeURIComponent(snapshot.scopedBranch) : '') + parsed.hash;
      if (fileSet.has(resolved)) {
        const params = [];
        if (snapshot.scopedBranch) params.push('branch=' + encodeURIComponent(snapshot.scopedBranch));
        if (snapshot.sha) params.push('v=' + encodeURIComponent(String(snapshot.sha).slice(0, 12)));
        return '/asset/' + repo.id + '/' + resolved.split('/').map(encodeURIComponent).join('/') + (params.length ? '?' + params.join('&') : '') + parsed.hash;
      }
      if (image) return '';
      return sourceUrl(repo, snapshot.branch, resolved) + parsed.hash;
    } catch { return ''; }
  }
  return sanitize(markdown.parse(text), {
    allowedTags: [...sanitize.defaults.allowedTags, 'img', 'details', 'summary', 'input', 'span'],
    allowedAttributes: { '*': ['id'], a: ['href', 'title', 'target', 'rel'], img: ['src', 'alt', 'title', 'width', 'height', 'loading'], code: ['class'], span: ['class'], input: ['type', 'checked', 'disabled'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: (tag, attrs) => ({ tagName: tag, attribs: { ...attrs, href: rewrite(attrs.href, false), rel: 'noopener noreferrer', ...(attrs.href && /^(https?:)?\/\//.test(attrs.href) ? { target: '_blank' } : {}) } }),
      img: (tag, attrs) => ({ tagName: tag, attribs: { ...attrs, src: rewrite(attrs.src, true), loading: 'lazy' } }),
      input: (tag, attrs) => ({ tagName: tag, attribs: { type: 'checkbox', disabled: 'disabled', ...(attrs.checked !== undefined ? { checked: '' } : {}) } })
    }
  });
}
