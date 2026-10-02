import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { extractDocs, repoConfig, Store, renderMarkdown, atomicJson, digest } from '../src/core.mjs';
import { archive, mockGitLab } from './mock.mjs';
const temporary = () => fs.mkdtemp(path.join(process.cwd(), '.test-'));

test('interactive init creates configuration without printing the supplied password', async () => {
  const dir = await temporary();
  const child = spawn(process.execPath, ['dist/app.cjs', 'init'], { cwd: process.cwd(), env: { ...process.env, GIT_DOCS_DATA: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let stage = 0;
  const prompts = [['网页端口', '\n'], ['同步间隔', '\n'], ['设置管理密码', 'test-admin-password\n'], ['仓库 HTTP 地址', '\n']];
  child.stdout.on('data', chunk => { output += chunk; if (stage < prompts.length && output.includes(prompts[stage][0])) child.stdin.write(prompts[stage++][1]); });
  child.stderr.on('data', chunk => output += chunk);
  const timer = setTimeout(() => child.kill(), 10000);
  const code = await new Promise(r => child.on('exit', r)); clearTimeout(timer);
  assert.equal(code, 0, output); const config = JSON.parse(await fs.readFile(path.join(dir, 'config.json')));
  assert.equal(config.port, 8080); assert.equal(config.repos.length, 0); assert.equal(config.adminHash, digest('test-admin-password'));
  assert.doesNotMatch(output, /test-admin-password/);
});

test('archive preserves paths, filters code/build output and ignores symlinks', async () => {
  const out = await temporary();
  const buffer = await archive([
    { name: 'root/docs/中文.MD', body: '# 中文标题\n测试' },
    { name: 'root/docs/p.png', body: 'image' },
    { name: 'root/a/target/README.md', body: '# generated' },
    { name: 'root/src/Secret.java', body: 'secret' },
    { name: 'root/link.md', type: 'symlink', linkname: '/etc/passwd' }
  ]);
  const result = await extractDocs(Readable.from([buffer]), out);
  assert.deepEqual(result.files, ['docs/中文.MD', 'docs/p.png']);
  assert.equal(result.documents[0].title, '中文标题');
  assert.equal(await fs.readFile(path.join(out, 'docs', '中文.MD'), 'utf8'), '# 中文标题\n测试');
  await assert.rejects(fs.stat(path.join(out, 'src', 'Secret.java')));
});
test('archive rejects traversal and duplicate paths', async () => {
  for (const entries of [[{ name: 'root/../escape.md', body: 'x' }], [{ name: 'root/a.md', body: 'x' }, { name: 'root/a.md', body: 'y' }]]) {
    const out = await temporary(); const buffer = await archive(entries);
    await assert.rejects(extractDocs(Readable.from([buffer]), out));
  }
});
test('multi-level repository and subpath GitLab URLs are normalized', () => {
  const repo = repoConfig({ url: 'https://example.com/gitlab/team/sub/project.git', gitlabBase: 'https://example.com/gitlab', token: 'secret', branch: 'release/1' });
  assert.equal(repo.project, 'team/sub/project'); assert.equal(repo.branch, 'release/1');
  assert.throws(() => repoConfig({ url: 'https://secret@example.com/team/repo', token: 'secret' }));
});
test('sync skips unchanged commits, reflects deletions, keeps last good snapshot on failure and survives restart', async t => {
  const mock = await mockGitLab(); t.after(() => mock.server.close());
  const repo = repoConfig({ url: mock.base + '/team/framework.git', token: 'mock-test-token' });
  const dir = await temporary(); const store = new Store(dir);
  await store.sync(repo); assert.equal(store.snapshots.get(repo.id).documents.length, 3); assert.equal(mock.state.downloads, 1);
  await store.sync(repo); assert.equal(mock.state.downloads, 1);
  mock.state.sha = 'b'.repeat(40); mock.state.entries = [{ name: 'root/NEW.md', body: '# 新版\n新内容' }];
  await store.sync(repo); assert.deepEqual(store.snapshots.get(repo.id).documents.map(d => d.path), ['NEW.md']);
  mock.state.deny = true; await store.sync(repo);
  assert.match(store.statuses.get(repo.id).error, /Token/); assert.equal(store.snapshots.get(repo.id).sha, 'b'.repeat(40));
  const restored = new Store(dir); await restored.load(repo); assert.equal(restored.snapshots.get(repo.id).documents[0].title, '新版');
});
test('Markdown sanitizes executable HTML and rewrites relative links/images', () => {
  const repo = { id: 'abc', url: 'https://gitlab.example.com/team/project' };
  const snapshot = { files: ['README.md', 'docs/img/p.png'], branch: 'main' };
  const html = renderMarkdown('# 中文标题\n\n[首页](../README.md#开始)\n\n![图](img/p.png)\n\n<script>alert(1)</script><img src="x" onerror="alert(1)">\n\n[危险](javascript:alert(1))', repo, snapshot, 'docs/a.md');
  assert.match(html, /id="中文标题"/); assert.match(html, /\/repo\/abc\?path=README.md/); assert.match(html, /\/asset\/abc\/docs\/img\/p.png/);
  assert.doesNotMatch(html, /<script|onerror|javascript:/);
});
test('bundled server: public API does not reveal token; admin auth, search, document and asset controls work', async t => {
  const mock = await mockGitLab(); t.after(() => mock.server.close());
  const dir = await temporary(); const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
  const repo = repoConfig({ url: mock.base + '/team/framework.git', token: 'mock-test-token', name: '测试框架' });
  await atomicJson(path.join(dir, 'config.json'), { host: '127.0.0.1', port, intervalMinutes: 10, adminHash: digest('test-admin-password'), repos: [repo] });
  const child = spawn(process.execPath, ['dist/app.cjs'], { cwd: process.cwd(), env: { ...process.env, GIT_DOCS_DATA: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill()); let log = ''; child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  const base = `http://127.0.0.1:${port}`; let list;
  for (let i = 0; i < 70; i++) { try { list = await (await fetch(base + '/api/repos')).json(); if (list.repos[0]?.count === 3) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  assert.equal(list?.repos[0]?.count, 3, log); assert.doesNotMatch(JSON.stringify(list), /mock-test-token/);
  assert.equal((await fetch(base + '/api/admin/repos')).status, 401);
  const auth = { Authorization: 'Bearer test-admin-password' };
  const admin = await (await fetch(base + '/api/admin/repos', { headers: auth })).text(); assert.doesNotMatch(admin, /mock-test-token/);
  const search = await (await fetch(base + `/api/repo/${repo.id}/search?q=${encodeURIComponent('鉴权')}`)).json(); assert.equal(search.results.length, 1);
  const doc = await (await fetch(base + `/api/repo/${repo.id}/doc?path=README.md`)).json(); assert.match(doc.html, /基础框架/);
  assert.equal((await fetch(base + `/asset/${repo.id}/src/Main.java`)).status, 404);
  assert.equal((await fetch(base + '/data/config.json')).status, 404);
  assert.equal((await fetch(base + '/')).status, 200);
  const add = await fetch(base + '/api/admin/repos', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '第二个仓库', url: mock.base + '/team/another', token: 'mock-test-token' }) });
  assert.equal(add.status, 200); const after = await (await fetch(base + '/api/repos')).json(); assert.equal(after.repos.length, 2);
});
