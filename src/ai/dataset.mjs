// AI 模块的只读数据视图：复用主服务已同步的快照，不写入、不联网。
import { loweredDocuments } from '../core.mjs';

export class AiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function titleForLink(value) {
  return String(value).replace(/[[\]]/g, ch => '\\' + ch);
}

export function createDataset({ getConfig, store }) {
  const repos = () => {
    const config = getConfig();
    return config && Array.isArray(config.repos) ? config.repos : [];
  };

  function findRepo(reference) {
    if (reference && typeof reference === 'object' && typeof reference.id === 'string') return reference;
    const value = String(reference ?? '').trim();
    const list = repos();
    if (!value) {
      if (list.length === 1) return list[0];
      throw new AiError(400, '缺少 repo 参数（仓库 ID 或名称）');
    }
    const found = list.find(repo => repo.id === value) || list.find(repo => repo.name === value);
    if (!found) throw new AiError(404, '未找到仓库：' + value);
    return found;
  }

  function cachedBranches(repo) {
    const names = [];
    const channel = store.channels.get(repo.id);
    if (channel) for (const [branch, channelStore] of channel) if (channelStore.snapshots.get(repo.id)) names.push(branch);
    const fallback = store.defaultBranch(repo);
    if (fallback && !names.includes(fallback) && store.snapshots.get(repo.id)) names.push(fallback);
    return names.sort((a, b) => (a === fallback ? -1 : b === fallback ? 1 : 0) || a.localeCompare(b, 'zh-CN', { numeric: true }));
  }

  function snapshotFor(repo, branch) {
    const name = branch ? String(branch).trim() : store.defaultBranch(repo);
    const snapshot = name ? store.snapshot(repo, name) : null;
    if (!snapshot) {
      const available = cachedBranches(repo);
      throw new AiError(409, '仓库「' + repo.name + '」的' + (name ? '分支 ' + name : '默认分支') + '尚未同步'
        + (available.length ? '；已缓存分支：' + available.join('、') : '；请先在文档站点打开一次以完成同步'));
    }
    return snapshot;
  }

  function rawUrl(id, branch, path) {
    const params = new URLSearchParams({ repo: id, path });
    if (branch) params.set('branch', branch);
    return '/raw?' + params.toString();
  }

  function listRepos() {
    return repos().map(repo => {
      const snapshot = store.snapshots.get(repo.id);
      return {
        id: repo.id,
        name: repo.name,
        url: repo.url,
        defaultBranch: store.defaultBranch(repo) || repo.branch || null,
        cachedBranches: cachedBranches(repo),
        documents: snapshot ? snapshot.documents.length : 0,
        updatedAt: snapshot ? snapshot.updatedAt : null
      };
    });
  }

  function listBranches(reference) {
    const repo = findRepo(reference);
    return {
      repo: repo.name,
      id: repo.id,
      defaultBranch: store.defaultBranch(repo) || null,
      branches: cachedBranches(repo).map(branch => {
        const snapshot = store.snapshot(repo, branch);
        return { branch, documents: snapshot ? snapshot.documents.length : 0, updatedAt: snapshot ? snapshot.updatedAt : null };
      })
    };
  }

  function listDocs(reference, branch) {
    const repo = findRepo(reference);
    const snapshot = snapshotFor(repo, branch);
    return {
      repo: repo.name,
      id: repo.id,
      branch: snapshot.branch,
      updatedAt: snapshot.updatedAt,
      documents: snapshot.documents.map(doc => ({ path: doc.path, title: doc.title }))
    };
  }

  function getDoc(reference, path, branch) {
    const repo = findRepo(reference);
    const wanted = String(path ?? '').trim();
    if (!wanted) throw new AiError(400, '缺少 path 参数（文档路径）');
    const snapshot = snapshotFor(repo, branch);
    const doc = snapshot.documents.find(item => item.path === wanted)
      || snapshot.documents.find(item => item.path.toLowerCase() === wanted.toLowerCase());
    if (!doc) throw new AiError(404, '文档不存在：' + wanted);
    return { repo: repo.name, id: repo.id, branch: snapshot.branch, updatedAt: snapshot.updatedAt, path: doc.path, title: doc.title, text: doc.text };
  }

  function searchDocs(reference, query, branch, limit) {
    const repo = findRepo(reference);
    const keyword = String(query ?? '').trim().toLowerCase();
    if (!keyword) throw new AiError(400, '缺少 query 参数（搜索关键词）');
    const snapshot = snapshotFor(repo, branch);
    const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const matches = [];
    for (const entry of loweredDocuments(snapshot)) {
      const position = entry.text.indexOf(keyword);
      const inTitle = entry.title.includes(keyword);
      const inPath = entry.path.includes(keyword);
      if (!inTitle && !inPath && position < 0) continue;
      const score = (entry.title === keyword ? 100 : inTitle ? 50 : 0) + (inPath ? 20 : 0) + (position >= 0 ? 5 : 0);
      const from = position >= 0 ? Math.max(0, position - 80) : 0;
      matches.push({ path: entry.doc.path, title: entry.doc.title, score, snippet: entry.doc.text.slice(from, from + 320) });
    }
    matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, 'zh-CN', { numeric: true }));
    return {
      repo: repo.name,
      id: repo.id,
      branch: snapshot.branch,
      total: matches.length,
      results: matches.slice(0, max).map(item => ({ path: item.path, title: item.title, snippet: item.snippet }))
    };
  }

  function llmsIndex() {
    const lines = ['# Git Docs 基础框架文档', '', '> 内部基础框架工程的 Markdown 文档，可按仓库和分支读取原始 Markdown。', ''];
    const list = repos();
    if (!list.length) { lines.push('（尚未配置仓库）'); return lines.join('\n'); }
    for (const repo of list) {
      const branches = cachedBranches(repo);
      const def = store.defaultBranch(repo) || repo.branch || null;
      const snapshot = def ? store.snapshot(repo, def) : null;
      lines.push('## ' + repo.name, '');
      lines.push('- 仓库地址：' + repo.url);
      lines.push('- 默认分支：' + (def || '未知'));
      lines.push('- 已缓存分支：' + (branches.length ? branches.join('、') : '无'));
      lines.push('- 文档数量：' + (snapshot ? snapshot.documents.length : 0));
      lines.push('- 文档清单：/llms.txt?repo=' + encodeURIComponent(repo.id));
      if (def) lines.push('- 原始 Markdown：/raw?repo=' + encodeURIComponent(repo.id) + '&branch=' + encodeURIComponent(def) + '&path=<文档路径>');
      lines.push('');
    }
    return lines.join('\n');
  }

  function llmsRepo(reference, branch) {
    const repo = findRepo(reference);
    const snapshot = snapshotFor(repo, branch);
    const capped = snapshot.documents.slice(0, 20000);
    const lines = ['# ' + repo.name, '', '> 分支 ' + snapshot.branch + '，共 ' + snapshot.documents.length + ' 篇文档，更新于 ' + (snapshot.updatedAt || '未知') + '。', ''];
    if (snapshot.documents.length > capped.length) lines.push('（文档过多，仅列出前 ' + capped.length + ' 篇，建议改用 search_docs）', '');
    for (const doc of capped) lines.push('- [' + titleForLink(doc.title) + '](' + rawUrl(repo.id, snapshot.branch, doc.path) + ')');
    return lines.join('\n');
  }

  return { repos, findRepo, cachedBranches, snapshotFor, listRepos, listBranches, listDocs, getDoc, searchDocs, llmsIndex, llmsRepo, rawUrl };
}
