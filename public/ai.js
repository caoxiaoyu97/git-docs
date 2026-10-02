const output = document.querySelector('#probe-output');
let firstRepo = null;

function text(value) { return String(value == null ? '' : value); }
function escapeHtml(value) { return text(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function toast(message) { const el = document.querySelector('#toast'); el.textContent = message; el.hidden = false; setTimeout(() => { el.hidden = true; }, 3000); }

async function copyValue(value) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(value);
    else {
      const scratch = document.createElement('textarea');
      scratch.value = value;
      scratch.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.append(scratch);
      scratch.select();
      const ok = document.execCommand('copy');
      scratch.remove();
      if (!ok) throw new Error('copy failed');
    }
    toast('已复制');
  } catch { toast('浏览器未允许复制，请手动选择'); }
}

const origin = location.origin;
const endpoints = [
  ['#ai-mcp', origin + '/mcp'],
  ['#ai-claude', 'claude mcp add --transport http git-docs ' + origin + '/mcp'],
  ['#ai-codex', 'codex mcp add git-docs --url ' + origin + '/mcp']
];
for (const pair of endpoints) {
  const element = document.querySelector(pair[0]);
  if (element) element.textContent = pair[1];
}
document.querySelectorAll('[data-copy]').forEach(button => {
  button.onclick = () => { const target = document.querySelector(button.dataset.copy); if (target) copyValue(target.textContent); };
});

async function probe(method, params) {
  output.textContent = '请求中…';
  try {
    const response = await fetch('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    const result = await response.json();
    if (result.error) { output.textContent = '错误：' + (typeof result.error === 'string' ? result.error : result.error.message); return; }
    const payload = result.result && result.result.content ? result.result.content[0].text : JSON.stringify(result.result, null, 2);
    output.textContent = result.result && result.result.isError ? '工具返回错误：' + payload : payload;
  } catch (error) { output.textContent = '调用失败：' + error.message; }
}

async function loadRepos() {
  const links = document.querySelector('#ai-links');
  try {
    const data = await (await fetch('/api/repos')).json();
    const repos = data.repos || [];
    firstRepo = repos[0] || null;
    const items = ['<li><a href="/llms.txt">/llms.txt</a>：全部仓库与文档索引</li>'];
    for (const repo of repos) items.push('<li><a href="/llms.txt?repo=' + encodeURIComponent(repo.id) + '">' + escapeHtml(repo.name) + ' 的文档清单</a>：' + repo.count + ' 篇（' + escapeHtml(repo.branch || '默认分支') + '）</li>');
    if (firstRepo) {
      try {
        const listing = await (await fetch('/api/repo/' + firstRepo.id + '/docs')).json();
        const doc = (listing.documents || [])[0];
        if (doc) items.push('<li><a href="/raw?repo=' + encodeURIComponent(firstRepo.id) + '&path=' + encodeURIComponent(doc.path) + '">读取示例文档</a>：' + escapeHtml(doc.path) + ' 的原始 Markdown</li>');
      } catch {}
    }
    links.innerHTML = items.join('');
  } catch (error) {
    links.innerHTML = '<li class="error">仓库列表读取失败：' + escapeHtml(error.message) + '</li>';
  }
}

document.querySelector('#probe-repos').onclick = () => probe('tools/call', { name: 'list_repos', arguments: {} });
document.querySelector('#probe-docs').onclick = () => probe('tools/call', { name: 'list_docs', arguments: firstRepo ? { repo: firstRepo.id } : {} });
document.querySelector('#probe-search').onclick = () => {
  const query = document.querySelector('#probe-query').value.trim();
  if (!query) { output.textContent = '请输入搜索关键词。'; return; }
  probe('tools/call', { name: 'search_docs', arguments: { repo: firstRepo ? firstRepo.id : '', query, limit: 5 } });
};
document.querySelector('#probe-query').addEventListener('keydown', event => { if (event.key === 'Enter') document.querySelector('#probe-search').click(); });

loadRepos();
