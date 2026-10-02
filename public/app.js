const app = document.querySelector('#app');
let adminPassword = ''; let generation = 0; let refreshTimer;
const escape = value => String(value ?? '').replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
const date = s => s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '尚未同步';
const docLink = (id, path) => `/repo/${id}?path=${encodeURIComponent(path)}${new URLSearchParams(location.search).get('branch') ? '&branch=' + encodeURIComponent(new URLSearchParams(location.search).get('branch')) : ''}`;
async function api(url, body, admin = false) {
  if (/^\/api\/repo\/[^/]+\/(docs|doc|search)(\?|$)/.test(url)) {
    const branch = new URLSearchParams(location.search).get('branch');
    if (branch) { const u = new URL(url, location.origin); u.searchParams.set('branch', branch); url = u.pathname + u.search; }
  }
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(admin ? { Authorization: 'Bearer ' + adminPassword } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json(); if (!response.ok) { const error = new Error(result.error || '请求失败'); error.status = response.status; throw error; } return result;
}
function toast(text) { const el = document.querySelector('#toast'); el.textContent = text; el.hidden = false; setTimeout(() => el.hidden = true, 3500); }
const sidebarPositions = new Map();
const searchQueries = new Map();
let restoring = false;
history.scrollRestoration = 'manual';
function savePosition() {
  history.replaceState({ ...history.state, scrollY: window.scrollY }, '');
  const side = document.querySelector('.sidebar');
  if (side) sidebarPositions.set(side.dataset.repo, side.scrollTop);
}
window.addEventListener('scroll', () => { if (!restoring) savePosition(); }, { passive: true });
function navigate(url) { savePosition(); history.pushState({}, '', url); render(); }
document.addEventListener('click', e => {
  const a = e.target.closest('a'); if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || a.target || a.hasAttribute('download')) return;
  const u = new URL(a.href);
  if (u.origin === location.origin && ['/', '/admin'].includes(u.pathname) || (u.origin === location.origin && u.pathname.startsWith('/repo/'))) {
    if (u.pathname === location.pathname && u.search === location.search && u.hash) return;
    e.preventDefault(); navigate(u.pathname + u.search + u.hash);
  }
});
window.addEventListener('popstate', () => render(true));

async function home(run) {
  const { repos, intervalMinutes } = await api('/api/repos'); if (run !== generation) return;
  app.innerHTML = `<section class="home"><div class="heading"><div><div class="eyebrow">DOCUMENT LIBRARY</div><h1>团队的开发文档</h1><p>按仓库查阅框架说明、模块用法与开发规范。</p></div><div class="sync-note">每 ${escape(intervalMinutes)} 分钟自动同步</div></div><div class="section-label">全部仓库 <span>${repos.length}</span></div>${repos.length ? `<div class="cards">${repos.map((r, i) => `<a class="repo-card" href="/repo/${r.id}"><div class="card-top"><span class="repo-icon">${String(i + 1).padStart(2, '0')}</span><span class="badge ${r.error ? 'warn' : ''}">${r.checking ? '同步中' : r.error ? '同步异常' : r.updatedAt ? '已同步' : '待同步'}</span></div><h2>${escape(r.name)}</h2><p class="count">${r.count} 篇文档${r.branch ? ` <span> / ${escape(r.branch)}</span>` : ''}</p><div class="card-foot">${r.error ? escape(r.error) : '更新于 ' + date(r.updatedAt)}</div></a>`).join('')}</div>` : `<div class="empty"><h2>添加你的第一个仓库</h2><p>连接 GitLab、GitHub 或 Gitee 后，Markdown 文档会自动出现在这里。</p><a class="button" href="/admin">添加仓库</a></div>`}<footer>文档内容来自 Git 仓库 · 原仓库保持不变</footer></section>`;
  refreshTimer = setTimeout(() => { if (location.pathname === '/') render(); }, 15000);
}
const folderStates = new Map();
const listingCache = new Map();
let renderFolder = () => '';
function markedText(text, query) {
  const value = String(text || ''), lower = value.toLowerCase(); let result = '', start = 0, at;
  if (!query) return escape(value);
  while ((at = lower.indexOf(query.toLowerCase(), start)) >= 0) { result += escape(value.slice(start, at)) + '<mark>' + escape(value.slice(at, at + query.length)) + '</mark>'; start = at + query.length; }
  return result + escape(value.slice(start));
}
function recentBranches(id) { try { return JSON.parse(localStorage.getItem('git-docs:recent:' + id) || '[]').filter(x => typeof x === 'string').slice(0, 5); } catch { return []; } }
function openFolders(id) {
  if (!folderStates.has(id)) {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem('git-docs:folders:' + id) || '[]'); } catch {}
    folderStates.set(id, new Set(Array.isArray(saved) ? saved.filter(p => typeof p === 'string') : []));
  }
  return folderStates.get(id);
}
document.addEventListener('toggle', event => {
  const folder = event.target;
  if (!folder.matches?.('details[data-folder]') || !folder.isConnected) return;
  if (folder.open && !folder.querySelector('.tree-nested').childElementCount) folder.querySelector('.tree-nested').innerHTML = renderFolder(folder.dataset.folder);
  const id = folder.dataset.repo;
  const opened = openFolders(id);
  if (folder.open) opened.add(folder.dataset.folder); else opened.delete(folder.dataset.folder);
  try { localStorage.setItem('git-docs:folders:' + id, JSON.stringify([...opened])); } catch {}
}, true);
function treeHtml(docs, id, selected) {
  const root = { dirs: Object.create(null), files: [] };
  for (const doc of docs) { const parts = doc.path.split('/'); let node = root; for (const part of parts.slice(0, -1)) node = node.dirs[part] ||= { dirs: Object.create(null), files: [] }; node.files.push(doc); }
  const nodes = new Map();
  function index(node, parent = '') { nodes.set(parent, node); for (const [name, sub] of Object.entries(node.dirs)) index(sub, parent ? parent + '/' + name : name); }
  index(root); renderFolder = folder => nodes.has(folder) ? build(nodes.get(folder), folder) : '';
  function build(node, parent = "") { return Object.entries(node.dirs).sort(([a], [b]) => a.localeCompare(b, 'zh-CN', { numeric: true })).map(([name, sub]) => { const folder = parent ? parent + "/" + name : name; return `<details data-repo="${escape(id)}" data-folder="${escape(folder)}"${openFolders(id).has(folder) ? " open" : ""}><summary>${escape(name)}</summary><div class="tree-nested">${openFolders(id).has(folder) ? build(sub, folder) : ''}</div></details>`; }).join('') + node.files.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true })).map(d => `<a class="tree-file ${d.path === selected ? 'selected' : ''}" href="${docLink(id, d.path)}" title="${escape(d.path)}">${escape(d.title)}${d.title.replace(/\.md$/i, "") === d.path.split("/").at(-1).replace(/\.md$/i, "") ? "" : `<small>${escape(d.path.split("/").at(-1))}</small>`}</a>`).join(''); }
  return build(root);
}
let branchTimer, branchListTimer;
const phaseLabel = s => s.checking ? ({ queued: '排队中', checking: '检查更新', downloading: '下载中', processing: '处理文档中' }[s.phase] || '同步中') : s.error ? '更新失败' : s.synced ? '已缓存，可阅读' : '未同步';
async function mountBranches(id, run, current) {
  clearTimeout(branchListTimer);
  const target = document.querySelector('#branch-picker'); if (!target) return;
  try {
    const listing = await api(`/api/repo/${id}/branches`); if (run !== generation || !target.isConnected) return;
    const recent = recentBranches(id);
    const rank = b => b.name === current ? 0 : b.name === listing.defaultBranch ? 1 : recent.includes(b.name) ? 2 + recent.indexOf(b.name) : b.synced ? 8 : 9;
    listing.branches.sort((a,b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'zh-CN', {numeric:true}));
    const opened = target.querySelector('details')?.open;
    const filter = target.querySelector('input')?.value || '';
    const focused = document.activeElement === target.querySelector('input');
    const scroll = target.querySelector('.branch-list')?.scrollTop || 0;
    target.innerHTML = `<details class="branch-menu"><summary>分支：${escape(current || listing.defaultBranch || '默认分支')} ▾</summary><input class="branch-filter" placeholder="筛选分支" aria-label="筛选分支"><div class="branch-list">${listing.branches.map(b => `<button class="branch-option ${b.checking ? 'syncing' : b.synced ? 'synced' : b.error ? 'failed' : 'unsynced'}" data-branch="${escape(b.name)}" aria-current="${b.name === current ? 'true' : 'false'}"><span>${escape(b.name)}</span><small>${phaseLabel(b) + (b.synced ? ' · ' + b.count + ' 篇' : '') + (b.remoteDeleted ? ' · 远端已删除' : '')}${b.name === current ? ' · 当前' : ''}</small></button>`).join('')}</div>${listing.error ? '<p class="error">' + escape(listing.error) + '</p>' : ''}</details>`;
    const selected = listing.branches.find(b => b.name === current);
    if (selected) {
      const note = document.createElement('div'); note.className = 'branch-status-note';
      note.textContent = phaseLabel(selected) + '；最后成功同步：' + date(selected.updatedAt) + (selected.error ? '；' + selected.error : '');
      if (selected.error) {
        const retry = document.createElement('button'); retry.className = 'secondary'; retry.textContent = '重试更新';
        retry.onclick = async () => { retry.disabled = true; try { await api(`/api/repo/${id}/branch-sync?branch=${encodeURIComponent(current)}`, {}); if (run === generation) mountBranches(id, run, current); } catch(e) { toast(e.message); retry.disabled = false; } }; note.append(retry);
      }
      const doc = document.querySelector('#document');
      if (doc?.dataset.updatedAt && selected.updatedAt && doc.dataset.updatedAt !== selected.updatedAt) {
        const fresh = document.createElement('button'); fresh.className = 'secondary'; fresh.textContent = '文档有更新，刷新查看'; fresh.onclick = () => { listingCache.clear(); render(true); }; note.append(fresh);
      }
      target.prepend(note);
    }
    target.querySelector('details').open = Boolean(opened);
    target.querySelector('.branch-filter').value = filter;
    target.querySelector('.branch-list').scrollTop = scroll;
    if (focused) target.querySelector('.branch-filter').focus({ preventScroll: true });
    target.querySelectorAll('[data-branch]').forEach(button => button.hidden = !button.dataset.branch.toLowerCase().includes(filter.toLowerCase()));
    target.querySelector('.branch-filter').oninput = e => { for (const button of target.querySelectorAll('[data-branch]')) button.hidden = !button.dataset.branch.toLowerCase().includes(e.target.value.toLowerCase()); };
    target.querySelectorAll('[data-branch]').forEach(button => button.onclick = () => {
      if (button.dataset.branch === current && document.querySelector('.markdown')) return;
      try { localStorage.setItem('git-docs:recent:' + id, JSON.stringify([button.dataset.branch, ...recentBranches(id).filter(b => b !== button.dataset.branch)].slice(0, 5))); } catch {}
      const u = new URL(location.href); u.searchParams.set('branch', button.dataset.branch); u.hash = '';
      navigate(u.pathname + u.search);
    });
  } catch (e) { if (run === generation && target.isConnected) { target.textContent = '分支列表加载失败：' + e.message; const retry = document.createElement('button'); retry.textContent = '重试'; retry.onclick = () => mountBranches(id, run, current); target.append(retry); } }
  finally { if (run === generation && target.isConnected) branchListTimer = setTimeout(() => mountBranches(id, run, current), 5000); }
}
async function waitForBranch(id, branch, run) {
  app.innerHTML = `<section class="branch-wait"><a href="/repo/${id}">返回默认分支</a><h2>${escape(branch)}</h2><p id="branch-progress" role="status">正在同步，请等待…</p><p>同步在后台进行，重复点击不会重复下载，也可以先查看其他分支。</p><div id="branch-picker"></div><button id="retry-branch" hidden>重试同步</button></section>`;
  const retry = document.querySelector('#retry-branch'); retry.onclick = () => render();
  try {
    await api(`/api/repo/${id}/branch-sync?branch=${encodeURIComponent(branch)}`, {});
    if (run !== generation) return;
    void mountBranches(id, run, branch);
    const poll = async () => {
      if (run !== generation) return;
      try {
        const status = await api(`/api/repo/${id}/branch-status?branch=${encodeURIComponent(branch)}`);
        if (run !== generation) return;
        if (status.synced) return render();
        document.querySelector('#branch-progress').textContent = status.error || (phaseLabel(status) + '，请等待…');
        if (status.error && !status.checking) { retry.hidden = false; void mountBranches(id, run, branch); return; }
        branchTimer = setTimeout(poll, 2000);
      } catch(e) { if (run === generation) { document.querySelector('#branch-progress').textContent = e.message; retry.hidden = false; } }
    };
    await poll();
  } catch(e) { if (run === generation) { document.querySelector('#branch-progress').textContent = e.message; retry.hidden = false; void mountBranches(id, run, branch); } }
}
async function repository(id, run, restore) {
  const requestedBranch = new URLSearchParams(location.search).get('branch');
  if (requestedBranch) {
    const status = await api(`/api/repo/${id}/branch-status?branch=${encodeURIComponent(requestedBranch)}`);
    if (run !== generation) return;
    if (!status.synced) return waitForBranch(id, requestedBranch, run);
  }
  const cacheKey = id + ':' + (requestedBranch || '');
  let cached = listingCache.get(cacheKey);
  const listing = cached && cached.expires > Date.now() ? cached.value : await api(`/api/repo/${id}/docs`);
  if (!cached || cached.value !== listing) { listingCache.set(cacheKey, {value:listing, expires:Date.now()+15000}); if (listingCache.size > 12) listingCache.delete(listingCache.keys().next().value); } if (run !== generation) return;
  if (!requestedBranch && listing.branch) { const u = new URL(location.href); u.searchParams.set('branch', listing.branch); history.replaceState(history.state, '', u); }
  const wantedPath = new URLSearchParams(location.search).get('path');
  const selected = (wantedPath && listing.documents.some(d => d.path === wantedPath) ? wantedPath : null) || listing.documents.find(d => /^readme\.md$/i.test(d.path))?.path || listing.documents[0]?.path;
  if (selected) {
    const parts = selected.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) openFolders(id).add(parts.slice(0, i).join('/'));
  }
  app.innerHTML = `<div class="workspace"><button class="mobile-directory secondary" aria-expanded="false" aria-controls="repo-sidebar">☰ 文档目录</button><aside id="repo-sidebar" class="sidebar" data-repo="${escape(id)}"><a class="back" href="/">‹ 全部仓库</a><h2>${escape(listing.name)}</h2><label class="search-label" for="search">搜索当前分支</label><input id="search" type="search" placeholder="标题、路径或正文…" autocomplete="off"><div id="tree" class="tree">${treeHtml(listing.documents, id, selected)}</div><div class="side-bottom">${listing.documents.length} 篇文档<div id="branch-picker">正在读取分支…</div></div></aside><section class="reader"><div id="document">${selected ? '<p class="loading">正在打开文档…</p>' : '<div class="empty"><h2>这个仓库还没有 Markdown 文档</h2><p>提交 .md 文件后会在下次同步时显示。</p></div>'}</div></section></div>`;
  void mountBranches(id, run, listing.branch);
  if (wantedPath && wantedPath !== selected) toast('当前分支没有这篇文档，已打开分支首页');
  const side = document.querySelector('.sidebar');
  const directoryButton = document.querySelector('.mobile-directory');
  directoryButton.onclick = () => {
    const opened = document.querySelector('.workspace').classList.toggle('directory-open');
    directoryButton.setAttribute('aria-expanded', String(opened));
    directoryButton.textContent = opened ? '收起文档目录' : '☰ 文档目录';
    if (opened) revealSelected();
  };
  side.scrollTop = sidebarPositions.get(id) || 0;
  function revealSelected() {
    const active = side.querySelector('.tree-file.selected');
    if (!active) return;
    const a = active.getBoundingClientRect(), b = side.getBoundingClientRect();
    if (a.top < b.top) side.scrollTop += a.top - b.top - 12;
    else if (a.bottom > b.bottom) side.scrollTop += a.bottom - b.bottom + 12;
  }
  revealSelected();
  side.addEventListener('scroll', () => sidebarPositions.set(id, side.scrollTop), { passive: true });
  const search = document.querySelector('#search');
  search.value = searchQueries.get(id) || '';
  search.addEventListener('focus', () => { if (search.value.trim()) search.dispatchEvent(new Event('input')); });
  let debounce; let searchVersion = 0;
  document.querySelector('#search').addEventListener('input', e => {
    clearTimeout(debounce); searchQueries.set(id, e.target.value); const q = e.target.value.trim(); const seq = ++searchVersion;
    debounce = setTimeout(async () => {
      try {
        const result = q ? await api(`/api/repo/${id}/search?q=${encodeURIComponent(q)}`) : null;
        if (run !== generation || seq !== searchVersion) return;
        document.querySelector('#tree').innerHTML = result ? `<div class="result-count">${result.results.length} 个结果（最多 100 个）</div>${result.results.map(d => `<a class="search-result" href="${docLink(id, d.path)}"><strong>${markedText(d.title,q)}</strong><small>${markedText(d.path,q)}</small><p>${markedText(d.snippet,q)}</p></a>`).join('') || '<p>没有匹配的文档</p>'}` : treeHtml(listing.documents, id, selected);
        if (!result) revealSelected();
      } catch (e) { toast(e.message); }
    }, 220);
  });
  if (!selected) return;
  let doc;
  try { doc = await api(`/api/repo/${id}/doc?path=${encodeURIComponent(selected)}`); }
  catch (error) {
    if (run !== generation) return;
    document.querySelector('#document').innerHTML = `<div class="empty"><h2>${error.status === 404 ? '这篇文档不存在或已被移除' : '文档加载失败'}</h2><p>${escape(error.message)}</p><button id="retry-document">重新加载</button> <a href="/repo/${escape(id)}">返回仓库首页</a></div>`;
    document.querySelector('#retry-document').onclick = () => render(true);
    return;
  }
  if (run !== generation) return;
  document.title = `${doc.title} · ${listing.name} · Git Docs`;
  const trail = doc.path.split('/');
  const repoHref = '/repo/' + id + (requestedBranch ? '?branch=' + encodeURIComponent(requestedBranch) : '');
  const crumbs = '<a class="crumb-repo" href="' + repoHref + '">' + escape(listing.name) + '</a>'
    + trail.map((part, index) => '<span class="crumb-sep">›</span><span class="crumb' + (index === trail.length - 1 ? ' current' : '') + '">' + escape(part) + '</span>').join('');
  const position = listing.documents.findIndex(item => item.path === selected);
  const previous = position > 0 ? listing.documents[position - 1] : null;
  const following = position >= 0 && position < listing.documents.length - 1 ? listing.documents[position + 1] : null;
  const pageNav = '<nav class="page-nav" aria-label="上一篇和下一篇">'
    + (previous ? '<a class="page-nav-item" href="' + docLink(id, previous.path) + '"><small>上一篇</small><span>' + escape(previous.title) + '</span></a>' : '<span class="page-nav-item empty"></span>')
    + (following ? '<a class="page-nav-item next" href="' + docLink(id, following.path) + '"><small>下一篇</small><span>' + escape(following.title) + '</span></a>' : '<span class="page-nav-item empty"></span>')
    + '</nav>';
  document.querySelector('#document').innerHTML = '<div class="doc-meta"><nav class="crumbs" aria-label="文档位置">' + crumbs + '</nav><div class="doc-actions"><button class="secondary" id="copy-raw" type="button">复制原文</button><a href="' + escape(doc.source) + '" target="_blank" rel="noopener noreferrer">在原仓库查看</a></div></div><article class="markdown">' + doc.html + '</article>' + pageNav + '<div class="doc-footer">同步于 ' + date(listing.updatedAt) + '</div>';
  const copyRaw = document.querySelector('#copy-raw');
  copyRaw.onclick = async () => {
    copyRaw.disabled = true;
    try {
      const response = await fetch('/raw?repo=' + encodeURIComponent(id) + '&path=' + encodeURIComponent(selected) + (requestedBranch ? '&branch=' + encodeURIComponent(requestedBranch) : ''));
      if (!response.ok) throw new Error('read failed');
      await copyText(await response.text());
    } catch { toast('原文读取失败，请稍后重试'); }
    finally { copyRaw.disabled = false; }
  };
  document.querySelector('#document').dataset.updatedAt = listing.updatedAt || '';
  enhanceReading(selected);
  if (restore && Number.isFinite(history.state?.scrollY)) window.scrollTo(0, history.state.scrollY);
  else if (location.hash) { try { document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView(); } catch {} }
  else window.scrollTo(0, 0);
}
async function copyText(value) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(value);
    else {
      const input = document.createElement('textarea'); input.value = value;
      input.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.append(input);
      const focused = document.activeElement; input.select();
      const copied = document.execCommand('copy'); input.remove(); focused?.focus({ preventScroll: true });
      if (!copied) throw new Error('copy failed');
    }
    toast('已复制');
  } catch { toast('浏览器未允许复制，请手动选择内容复制'); }
}
let disposeReading = () => {};
let lightbox = null;
function lightboxKeys(event) { if (event.key === 'Escape') closeLightbox(); }
function closeLightbox() {
  if (!lightbox) return;
  document.removeEventListener('keydown', lightboxKeys);
  lightbox.remove();
  lightbox = null;
}
function openLightbox(source, alt) {
  if (!source) return;
  closeLightbox();
  lightbox = document.createElement('div');
  lightbox.className = 'lightbox';
  lightbox.setAttribute('role', 'dialog');
  lightbox.setAttribute('aria-label', alt || '图片预览');
  const image = document.createElement('img');
  image.src = source;
  image.alt = alt;
  const hint = document.createElement('p');
  hint.textContent = '点击任意位置或按 Esc 关闭';
  lightbox.append(image, hint);
  lightbox.addEventListener('click', closeLightbox);
  document.body.append(lightbox);
  document.addEventListener('keydown', lightboxKeys);
}
function enhanceReading(selected) {
  const article = document.querySelector('.markdown');
  const used = new Set([...article.querySelectorAll('[id]')].map(e => e.id));
  const headings = [...article.querySelectorAll('h1,h2,h3,h4,h5,h6')];
  headings.forEach((heading, i) => {
    if (!heading.id) { let value = 'section-' + (i + 1); while (used.has(value)) value += '-'; heading.id = value; used.add(value); }
    const title = heading.textContent.trim();
    const button = document.createElement('button'); button.className = 'heading-copy'; button.textContent = '#';
    button.title = '复制标题链接'; button.setAttribute('aria-label', '复制标题链接：' + title);
    button.onclick = () => { const url = new URL(location.href); url.searchParams.set('path', selected); url.hash = heading.id; copyText(url.href); };
    heading.append(button);
  });
  article.querySelectorAll('pre').forEach(pre => {
    const code = pre.querySelector('code'); if (!code) return;
    const wrapper = document.createElement('div'); wrapper.className = 'code-block'; pre.before(wrapper); wrapper.append(pre);
    const button = document.createElement('button'); button.className = 'copy-code'; button.textContent = '复制代码';
    button.onclick = () => copyText(code.textContent); wrapper.append(button);
  });
  article.querySelectorAll('img').forEach(image => {
    image.classList.add('zoomable');
    image.addEventListener('click', () => openLightbox(image.currentSrc || image.src, image.alt || ''));
  });
  const sections = headings.filter(h => h.matches('h2,h3'));
  let links = [];
  if (sections.length) {
    const outline = document.createElement('details'); outline.className = 'article-outline'; outline.open = matchMedia('(min-width: 1100px)').matches;
    const summary = document.createElement('summary'); summary.textContent = '本页大纲'; outline.append(summary);
    const nav = document.createElement('nav'); nav.setAttribute('aria-label', '本页大纲'); outline.append(nav);
    links = sections.map(h => {
      const link = document.createElement('a'); link.href = '#' + encodeURIComponent(h.id);
      link.textContent = h.cloneNode(true).textContent.replace(/#$/, '').trim(); link.className = h.tagName === 'H3' ? 'outline-sub' : '';
      nav.append(link); return link;
    });
    document.querySelector('.doc-meta').after(outline);
  }
  const top = document.createElement('button'); top.className = 'back-top secondary'; top.textContent = '↑ 返回顶部';
  top.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' }); document.querySelector('.reader').append(top);
  let frame;
  function update() {
    cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
      top.hidden = window.scrollY < 400;
      let current = sections[0]; for (const h of sections) { if (h.getBoundingClientRect().top <= 130) current = h; }
      links.forEach((link, i) => { const active = sections[i] === current; link.classList.toggle('active', active); if (active) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current'); });
    });
  }
  window.addEventListener('scroll', update, { passive: true }); update();
  disposeReading = () => { window.removeEventListener('scroll', update); cancelAnimationFrame(frame); };
}
async function admin(run) {
  if (!adminPassword) {
    app.innerHTML = `<section class="login"><div class="eyebrow">ADMINISTRATION</div><h1>管理仓库</h1><p>输入初始化时设置的管理密码。</p><form id="login"><label for="password">管理密码</label><input id="password" type="password" required autocomplete="current-password"><button>进入管理</button><p id="error" class="error"></p></form><a class="back" href="/">返回文档首页</a></section>`;
    document.querySelector('#login').onsubmit = async e => { e.preventDefault(); adminPassword = document.querySelector('#password').value; try { await api('/api/admin/repos', undefined, true); render(); } catch (err) { adminPassword = ''; document.querySelector('#error').textContent = err.message; } }; return;
  }
  const { repos, intervalMinutes } = await api('/api/admin/repos', undefined, true); if (run !== generation) return;
  app.innerHTML = `<section class="admin"><div class="heading"><div><div class="eyebrow">ADMINISTRATION</div><h1>仓库管理</h1><p>保存后立即同步，之后按设置的间隔自动检查。</p></div><button id="logout" class="secondary">退出管理</button></div><div class="admin-grid"><div><h2>已连接仓库 <span class="muted">${repos.length}</span></h2><div class="repo-list">${repos.map(r => `<div class="managed-repo"><h3>${escape(r.name)}</h3><p>${escape(r.url)}</p><small>${escape(r.branch || '默认分支')}</small><div class="actions"><button class="secondary" data-edit="${r.id}">编辑</button><button class="secondary" data-sync="${r.id}">立即同步</button><button class="secondary" data-cache="${r.id}">分支缓存</button><button class="text-button" data-delete="${r.id}">移除</button></div></div>`).join('') || '<p class="muted">尚未添加仓库。</p>'}</div></div><form id="repo-form" class="form-card"><h2 id="form-title">添加仓库</h2><input type="hidden" name="id"><label>显示名称<input name="name" placeholder="留空使用仓库名" maxlength="100"></label><label>仓库 HTTP/HTTPS 地址<input name="url" type="url" placeholder="https://github.com/owner/repo.git" required></label><input type="hidden" name="branch"><p class="hint">首次自动同步仓库默认分支；其他分支可在阅读页切换。</p><label>访问 Token<input name="token" type="password" autocomplete="new-password" placeholder="可选；留空匿名访问公开仓库"></label><p id="provider-hint" class="hint">支持 GitLab、GitHub、Gitee，按仓库地址自动识别。</p><p class="hint">填写 Token 优先认证；未填写则匿名读取公开仓库。编辑时留空保留原令牌。</p><div id="clear-token-row" hidden><label class="inline-check"><input type="checkbox" name="clearToken">清除已保存 Token，改为匿名访问</label></div><p id="form-error" class="error"></p><div class="actions"><button type="submit">保存并同步</button><button id="reset" type="button" class="secondary">清空</button></div></form></div></section>`;
  const settings = document.createElement('form'); settings.className = 'form-card settings-form';
  settings.innerHTML = `<h2>站点设置</h2><label>同步间隔（分钟）<input name="interval" type="number" min="1" max="1440" required value="${intervalMinutes}"></label><label>新管理密码<input name="password" type="password" autocomplete="new-password" minlength="10" maxlength="256" placeholder="留空保持原密码"></label><label>确认新密码<input name="confirmation" type="password" autocomplete="new-password"></label><button>保存设置</button><p class="settings-status" role="status"></p>`;
  document.querySelector('.admin').append(settings);
  settings.onsubmit = async e => {
    e.preventDefault(); const status = settings.querySelector('.settings-status'), button = settings.querySelector('button');
    if (settings.elements.password.value !== settings.elements.confirmation.value) { status.textContent = '两次密码不一致'; return; }
    button.disabled = true;
    try { const password = settings.elements.password.value; await api('/api/admin/settings', {intervalMinutes:Number(settings.elements.interval.value), password}, true); if (password) adminPassword = password; settings.elements.password.value = ''; settings.elements.confirmation.value = ''; status.textContent = '设置已保存并生效'; }
    catch(e) { status.textContent = e.message; } finally { button.disabled = false; }
  };
  document.querySelector('#logout').onclick = () => { adminPassword = ''; render(); };
  const form = document.querySelector('#repo-form');
  function reset() { form.reset(); document.querySelector('#clear-token-row').hidden = true; form.elements.id.value = ''; form.elements.token.required = false; document.querySelector('#form-title').textContent = '添加仓库'; document.querySelector('#form-error').textContent = ''; }
  document.querySelector('#reset').onclick = reset;
  form.elements.url.addEventListener('input', () => {
    let host = ''; try { host = new URL(form.elements.url.value).hostname; } catch {}
    document.querySelector('#provider-hint').textContent = /^(www\.)?github\.com$/.test(host) ? 'GitHub：私有仓库使用有 Contents 只读权限的 Token。' : /^(www\.)?gitee\.com$/.test(host) ? 'Gitee：Token 可选；填写时需有 projects 权限。' : host ? 'GitLab：私有仓库使用有 read_api 权限的 Token。' : '支持 GitLab、GitHub、Gitee，按仓库地址自动识别。';
  });
  form.onsubmit = async e => { e.preventDefault(); const button = form.querySelector('[type=submit]'); button.disabled = true; try { await api('/api/admin/repos', Object.fromEntries(new FormData(form)), true); toast('已保存，正在同步'); render(); } catch (err) { document.querySelector('#form-error').textContent = err.message; } finally { button.disabled = false; } };
  document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { const repo = repos.find(r => r.id === b.dataset.edit); for (const key of ['id', 'name', 'url', 'branch']) form.elements[key].value = repo[key] || ''; form.elements.token.value = ''; form.elements.token.required = false; form.elements.clearToken.checked = false; document.querySelector('#clear-token-row').hidden = !repo.hasToken; document.querySelector('#form-title').textContent = '编辑仓库'; form.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  document.querySelectorAll('[data-sync]').forEach(b => b.onclick = async () => { try { await api('/api/admin/sync', { id: b.dataset.sync }, true); toast('已开始同步，可在首页查看结果'); } catch (e) { toast(e.message); } });
  document.querySelectorAll('[data-cache]').forEach(button => button.onclick = async () => {
    let panel = button.closest('.managed-repo').querySelector('.cache-panel');
    if (!panel) { panel = document.createElement('div'); panel.className = 'cache-panel'; button.closest('.managed-repo').append(panel); }
    const load = async () => {
      panel.textContent = '正在读取缓存记录…';
      try {
        const result = await api('/api/admin/cache?id=' + button.dataset.cache, undefined, true);
        if (run !== generation) return;
        panel.innerHTML = result.branches.map(b => `<div class="cache-row"><strong>${escape(b.branch)}</strong><span>${b.count} 篇 · ${b.bytes == null ? '后台统计中' : (b.bytes / 1024 / 1024).toFixed(2) + ' MB（当前版本）'}</span><small>最后成功同步：${date(b.updatedAt)}</small><button class="secondary" data-clear="${escape(b.branch)}" ${b.checking || b.protected ? 'disabled' : ''}>${b.protected ? '默认分支保留' : b.checking ? '正在同步' : '清理本地缓存'}</button></div>`).join('') || '暂无缓存';
        panel.querySelectorAll('[data-clear]').forEach(clear => clear.onclick = async () => {
          if (!confirm('清理分支 ' + clear.dataset.clear + ' 的本地文档缓存？原 Git 分支不会删除，下次访问会重新同步。')) return;
          clear.disabled = true;
          try { await api('/api/admin/cache-delete', { id: button.dataset.cache, branch: clear.dataset.clear }, true); toast('缓存已清理'); await load(); }
          catch(e) { toast(e.message); clear.disabled = false; }
        });
      } catch(e) { panel.textContent = e.message; }
    }; await load();
  });
  document.querySelectorAll('[data-delete]').forEach(b => b.onclick = async () => { if (!confirm('移除此文档入口？原 Git 仓库不会被修改。')) return; try { await api('/api/admin/delete', { id: b.dataset.delete }, true); render(); } catch (e) { toast(e.message); } });
}
async function render(restore = false) {
  clearTimeout(branchTimer); clearTimeout(branchListTimer);
  disposeReading();
  closeLightbox();
  restoring = true;
  clearTimeout(refreshTimer); const run = ++generation; document.title = 'Git Docs · 开发文档';
  try {
    if (location.pathname === '/admin') await admin(run);
    else if (location.pathname.startsWith('/repo/')) await repository(location.pathname.split('/')[2], run, restore);
    else await home(run);
  } catch (e) { if (run === generation) app.innerHTML = `<section class="empty"><h1>暂时无法打开</h1><p>${escape(e.message)}</p><button onclick="location.reload()">重新加载</button> <a class="button" href="/">返回首页</a><p class="hint">首次同步需要等待；同步异常可在首页查看原因。</p></section>`; }
  if (run === generation) { restoring = false; savePosition(); }
}
render(true);
