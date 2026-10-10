import http from 'node:http';
import tar from 'tar-stream';
import { gzipSync } from 'node:zlib';
export async function archive(entries) {
  const pack = tar.pack(); const chunks = [];
  const reading = (async () => { for await (const chunk of pack) chunks.push(chunk); })();
  for (const entry of entries) {
    const body = Buffer.from(entry.body || '');
    await new Promise((resolve, reject) => pack.entry({ name: entry.name, type: entry.type || 'file', size: body.length, ...(entry.linkname ? { linkname: entry.linkname } : {}) }, body, e => e ? reject(e) : resolve()));
  }
  pack.finalize(); await reading; return gzipSync(Buffer.concat(chunks));
}
export async function mockGitLab(host = '127.0.0.1', port = 0) {
  const state = { sha: 'a'.repeat(40), deny: false, downloads: 0, requests: [], entries: [
    { name: 'repo-root/README.md', body: '# 基础框架\n\n这是演示仓库，用于验证文档门户。\n\n## 快速开始\n\n将框架作为 Maven 依赖引入业务项目。\n\n```xml\n<dependency>\n  <groupId>com.example</groupId>\n  <artifactId>framework-core</artifactId>\n</dependency>\n```\n\n## 模块导航\n\n- [权限模块](auth/docs/权限设计.md)\n- [开发规范](docs/开发规范.md)\n\n| 模块 | 说明 |\n| --- | --- |\n| auth | 权限与身份认证 |\n| common | 公共工具与异常处理 |\n\n> 文档随仓库更新，代码结构保持不变。\n' },
    { name: 'repo-root/auth/docs/权限设计.md', body: '# 权限设计\n\n## 使用方式\n\n角色拥有多个权限。统一鉴权过滤器检查业务接口访问权限。\n\n[返回首页](../../README.md)\n\n![流程图](images/test.png)\n' },
    { name: 'repo-root/docs/开发规范.md', body: '# 开发规范\n\n## 异常处理\n\n所有业务异常应返回统一响应结构。\n\n- [x] 接口参数校验\n- [ ] 完善模块说明\n' },
    { name: 'repo-root/auth/docs/images/test.png', body: '' },
    { name: 'repo-root/src/Main.java', body: 'SECRET SOURCE DO NOT PUBLISH' },
    { name: 'repo-root/module/target/README.md', body: 'generated' }
  ] };
  const server = http.createServer(async (req, res) => {
    state.requests.push(req.url);
    if (state.deny || req.headers['private-token'] !== 'mock-test-token') { res.writeHead(401); res.end('{}'); return; }
    if (req.url.includes('/repository/archive.tar.gz')) { state.downloads++; res.setHeader('Content-Type', 'application/gzip'); res.end(await archive(state.entries)); }
    else if (req.url.includes('/repository/branches?')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify([{name:'main'},{name:'dev'}])); }
    else if (req.url.includes('/repository/branches/')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ commit: { id: state.sha } })); }
    else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ default_branch: 'main', description: '演示仓库描述' })); }
  });
  await new Promise(resolve => server.listen(port, host, resolve));
  return { state, server, base: `http://127.0.0.1:${server.address().port}` };
}
