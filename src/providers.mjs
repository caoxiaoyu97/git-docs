import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import tar from 'tar-stream';
import fs from 'node:fs/promises';
import path from 'node:path';
let giteeNextAt = 0;
let giteeGate = Promise.resolve();

export function providerType(repo) {
  if (['gitlab', 'github', 'gitee'].includes(repo.provider)) return repo.provider;
  const host = new URL(repo.url).hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com') return 'github';
  if (host === 'gitee.com' || host === 'www.gitee.com') return 'gitee';
  return 'gitlab';
}
export function sourceUrl(repo, branch, file) {
  const prefix = providerType(repo) === 'gitlab' ? '/-/blob/' : '/blob/';
  return `${repo.url}${prefix}${encodeURIComponent(branch)}/${file.split('/').map(encodeURIComponent).join('/')}`;
}
export function createProvider(repo, fetchImpl = fetch, { cacheDir } = {}) {
  const type = providerType(repo);
  const label = { gitlab: 'GitLab', github: 'GitHub', gitee: 'Gitee' }[type];
  const base = new URL(repo.url).origin;
  const root = type === 'gitlab'
    ? `${repo.gitlabBase || base}/api/v4/projects/${encodeURIComponent(repo.project)}`
    : `${type === 'github' ? 'https://api.github.com' : 'https://gitee.com/api/v5'}/repos/${repo.project.split('/').map(encodeURIComponent).join('/')}`;
  const headers = { 'User-Agent': 'Git-Docs/1.1.0' };
  if (repo.token) headers[type === 'gitlab' ? 'PRIVATE-TOKEN' : 'Authorization'] = type === 'gitlab' ? repo.token : `Bearer ${repo.token}`;
  if (type === 'github') { headers.Accept = 'application/vnd.github+json'; headers['X-GitHub-Api-Version'] = '2022-11-28'; }

  async function request(route, archive = false) {
    let url = new URL(root + route); let currentHeaders = { ...headers };
    for (let hop = 0; hop < 6; hop++) {
      let response;
      if (type === 'gitee' && !repo.token && fetchImpl === fetch) {
        giteeGate = giteeGate.then(async () => {
          const delay = Math.max(0, giteeNextAt - Date.now());
          if (delay) await new Promise(resolve => setTimeout(resolve, delay));
          giteeNextAt = Date.now() + 1250;
        });
        await giteeGate;
      }
      try { response = await fetchImpl(url.href, { headers: currentHeaders, redirect: 'manual', signal: AbortSignal.timeout(180000) }); }
      catch (e) { throw new Error(e.name === 'TimeoutError' ? `${label} 请求超时` : `无法连接 ${label}，请检查网络、地址和证书`); }
      if ([301, 302, 303, 307, 308].includes(response.status) && archive) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location) throw new Error(`${label} 下载重定向缺少地址`);
        const next = new URL(location, url);
        const host = next.hostname.toLowerCase();
        const trusted = type === 'github' ? host === 'codeload.github.com' : type === 'gitee' ? /(^|\.)(gitee\.com|gitee\.cn|giteeusercontent\.com)$/.test(host) : false;
        if (next.username || next.password || !['http:', 'https:'].includes(next.protocol) || (url.protocol === 'https:' && next.protocol !== 'https:') || (next.origin !== url.origin && !(next.protocol === 'https:' && trusted))) throw new Error(`${label} 下载跳转到非预期地址，已停止`);
        if (next.origin !== url.origin) currentHeaders = { 'User-Agent': 'Git-Docs/1.1.0' };
        url = next; continue;
      }
      if (!response.ok) {
        let detail = '';
        if (response.body) {
          const reader = response.body.getReader();
          try { const part = await reader.read(); detail = Buffer.from(part.value || []).subarray(0, 4096).toString(); }
          finally { await reader.cancel().catch(() => {}); }
        }
        if (response.status === 429 || /rate.?limit|频率|限流/i.test(detail) || response.headers.get('x-ratelimit-remaining') === '0') throw new Error(`${label}：API 已限流，将在下次同步重试${type === 'gitee' && !repo.token ? '（已下载文件会复用）' : ''}`);
        const messages = { 401: 'Token 无效或已过期', 403: '访问被拒绝，请检查 Token 权限或 API 请求限额', 404: '仓库或分支不存在，或 Token 无权访问', 429: 'API 请求过于频繁，稍后自动重试' };
        throw new Error(`${label}：${messages[response.status] || `返回 HTTP ${response.status}`}`);
      }
      return response;
    }
    throw new Error(`${label} 下载重定向次数过多`);
  }
  async function json(route, maxBytes = 2 * 1024 * 1024) {
    const response = await request(route); const chunks = []; let size = 0;
    for await (const chunk of Readable.fromWeb(response.body)) { size += chunk.length; if (size > maxBytes) throw new Error(`${label} API 响应过大`); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Error(`${label} API 未返回 JSON，请检查仓库地址`); }
  }
  async function publicGiteeArchive(sha) {
    // Gitee's archive endpoint requires authentication even for public projects.
    // Anonymous tree/blob endpoints let public repositories work without a token.
    const tree = await json(`/git/trees/${sha}?recursive=1`, 64 * 1024 * 1024);
    if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('Gitee 目录列表不完整，请填写 Token 后重试');
    if (tree.tree.length > 250000) throw new Error('仓库文件数超过 250000');
    const files = tree.tree.filter(f => f.type === 'blob' && ['100644', '100755'].includes(f.mode) && /\.(md|png|jpe?g|gif|webp|svg|avif|ico|pdf)$/i.test(f.path) && !f.path.split('/').some(p => ['.git', 'target', 'node_modules', '.idea', '.gradle'].includes(p)));
    if (cacheDir) {
      await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
      const wanted = new Set(files.map(f => f.sha));
      for (const name of await fs.readdir(cacheDir)) if (/^[a-f0-9]{40,64}(\.tmp)?$/.test(name) && !wanted.has(name)) await fs.unlink(path.join(cacheDir, name));
    }
    const pack = tar.pack(); const gzip = createGzip();
    pack.on('error', error => gzip.destroy(error)); gzip.on('error', () => {});
    gzip.on('close', () => pack.destroy()); pack.pipe(gzip);
    const body = Readable.toWeb(gzip);
    void (async () => {
      try {
        let total = 0;
        for (const file of files) {
          if (pack.destroyed) return;
          const max = /\.md$/i.test(file.path) ? 2 * 1024 * 1024 : 25 * 1024 * 1024;
          if (file.size > max) throw new Error('单个文档超过 2MB 或图片/附件超过 25MB');
          if (!/^[a-f0-9]{40,64}$/i.test(file.sha)) throw new Error('Gitee 文件摘要无效');
          const cached = cacheDir && path.join(cacheDir, file.sha);
          let buffer;
          if (cached) { try { buffer = await fs.readFile(cached); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
          let downloaded = false;
          if (!buffer) {
            const blob = await json(`/git/blobs/${file.sha}`, 36 * 1024 * 1024);
            if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error('Gitee 文件内容格式不支持');
            buffer = Buffer.from(blob.content, 'base64'); downloaded = true;
          }
          total += buffer.length;
          if (buffer.length > max || total > 256 * 1024 * 1024) throw new Error('文档或资源超过大小限制');
          if (cached && downloaded) { await fs.writeFile(cached + '.tmp', buffer, { mode: 0o600 }); await fs.rename(cached + '.tmp', cached); }
          await new Promise((resolve, reject) => pack.entry({ name: 'repo/' + file.path, size: buffer.length, type: 'file' }, buffer, error => error ? reject(error) : resolve()));
        }
        pack.finalize();
      } catch (e) { pack.destroy(e); }
    })();
    return new Response(body, { headers: { 'Content-Type': 'application/gzip' } });
  }
  return {
    type,
    async latest() {
      const project = await json(''); const branch = repo.branch || project.default_branch;
      if (!branch) throw new Error('仓库没有默认分支，可能是空仓库');
      const result = await json(`${type === 'gitlab' ? '/repository' : ''}/branches/${encodeURIComponent(branch)}`);
      const sha = type === 'gitlab' ? result.commit?.id : result.commit?.sha;
      if (!/^[a-f0-9]{40,64}$/i.test(sha || '')) throw new Error('无法读取分支提交信息');
      return { branch, sha };
    },
    async archive(sha) {
      if (type === 'gitee' && !repo.token) return publicGiteeArchive(sha);
      const route = type === 'gitlab' ? `/repository/archive.tar.gz?sha=${sha}&include_lfs_blobs=false` : type === 'github' ? `/tarball/${sha}` : `/tarball?ref=${sha}`;
      return request(route, true);
    }
  };
}
