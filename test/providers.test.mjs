import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Store, repoConfig } from '../src/core.mjs';
import { createProvider, sourceUrl } from '../src/providers.mjs';
import { archive } from './mock.mjs';
import { temporary } from './temporary.mjs';

test('GitLab archive uses a fetch mode accepted by hotlink protection over real HTTP', async t => {
  const modes = []; const sha = 'a'.repeat(40);
  const body = await archive([{ name: 'repo/README.md', body: '# GitLab archive' }]);
  const server = http.createServer((req, res) => {
    if (req.headers['private-token'] !== 'test-secret') { res.writeHead(401).end(); return; }
    if (req.url.includes('/repository/archive.tar.gz')) {
      modes.push(req.headers['sec-fetch-mode']);
      if (['cors', 'no-cors', 'websocket'].includes(req.headers['sec-fetch-mode'])) { res.writeHead(406).end('{"message":"406 Not Acceptable"}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/gzip' }).end(body); return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.includes('/branches/') ? { commit: { id: sha } } : { default_branch: 'master' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const repo = repoConfig({ url: `http://127.0.0.1:${server.address().port}/team/project`, token: 'test-secret' });
  const baseline = await fetch(`${repo.gitlabBase}/api/v4/projects/team%2Fproject/repository/archive.tar.gz?sha=${sha}`, { headers: { 'PRIVATE-TOKEN': repo.token } });
  assert.equal(baseline.status, 406); await baseline.body.cancel();
  const store = new Store(await temporary()); await store.sync(repo);
  assert.equal(store.snapshots.get(repo.id)?.documents[0].title, 'GitLab archive', JSON.stringify(store.statuses.get(repo.id)));
  assert.deepEqual(modes, ['cors', 'same-origin']);
});

test('GitLab HTTP errors identify the stage and request ID without exposing response bodies or token', async () => {
  const repo = repoConfig({ url: 'https://gitlab.company/team/project', token: 'test-secret' });
  const provider = createProvider(repo, async () => new Response('upstream body test-secret', { status: 406, headers: { 'x-request-id': 'request-123' } }));
  await assert.rejects(provider.archive('a'.repeat(40)), error => {
    assert.match(error.message, /HTTP 406/); assert.match(error.message, /下载仓库压缩包/);
    assert.match(error.message, /request-123/); assert.doesNotMatch(error.message, /test-secret|upstream body/); return true;
  });
});

test('GitLab archive mode keeps cross-origin redirect rejection', async () => {
  const repo = repoConfig({ url: 'https://gitlab.company/team/project', token: 'test-secret' });
  let calls = 0;
  const provider = createProvider(repo, async (url, options) => {
    calls++; assert.equal(options.mode, 'same-origin'); assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://unexpected.example/archive' } });
  });
  await assert.rejects(provider.archive('a'.repeat(40)), /非预期/); assert.equal(calls, 1);
});

test('platform is inferred from URL and public repositories do not require a token', () => {
  for (const [url, provider] of [['https://github.com/team/project.git', 'github'], ['https://gitee.com/team/project', 'gitee'], ['http://gitlab.company/team/project', 'gitlab']]) {
    const repo = repoConfig({ url }); assert.equal(repo.provider, provider); assert.equal(repo.token, '');
    assert.equal(repo.project, 'team/project');
    assert.ok(sourceUrl(repo, 'main', 'README.md').includes(provider === 'gitlab' ? '/-/blob/main/' : '/blob/main/'));
  }
});
for (const type of ['github', 'gitee']) test(`${type}: authenticated sync, pinned archive, deletion update and public error handling`, async () => {
  const repo = repoConfig({ url: `https://${type}.com/team/project.git`, token: 'test-secret' });
  let sha = 'c'.repeat(40); let files = [{ name: 'root/README.md', body: '# 内容\n测试' }]; const calls = [];
  const fetchMock = async (url, options) => {
    calls.push({ url, headers: options.headers });
    assert.equal(options.mode, undefined, `${type} keeps its existing fetch mode`);
    if (url.startsWith('https://codeload.github.com/')) { assert.equal(options.headers.Authorization, undefined); return new Response(await archive(files)); }
    assert.equal(options.headers.Authorization, 'Bearer test-secret'); assert.ok(!url.includes('test-secret'));
    if (url.includes('/tarball')) {
      assert.ok(url.includes(sha));
      return type === 'github' ? new Response(null, { status: 302, headers: { location: 'https://codeload.github.com/team/project/legacy.tar.gz/' + sha } }) : new Response(await archive(files));
    }
    return Response.json(url.includes('/branches/') ? { commit: { sha } } : { default_branch: 'main' });
  };
  const dir = await temporary();
  const store = new Store(dir, fetchMock); await store.sync(repo);
  assert.equal(store.snapshots.get(repo.id)?.documents[0].title, '内容', JSON.stringify(store.statuses.get(repo.id)));
  assert.equal(calls.filter(c => c.url.includes('/tarball')).length, 1);
  await store.sync(repo); assert.equal(calls.filter(c => c.url.includes('/tarball')).length, 1);
  sha = 'd'.repeat(40); files = [{ name: 'root/docs/new.md', body: '# 新版' }]; await store.sync(repo);
  assert.deepEqual(store.snapshots.get(repo.id).documents.map(d => d.path), ['docs/new.md']);
  if (type === 'gitee') assert.ok(calls.some(c => c.url.endsWith('/tarball?ref=' + sha)));
  const publicStore = new Store(dir, async () => new Response(null, { status: 403 }));
  const publicRepo = { ...repo, token: '' }; await publicStore.sync(publicRepo);
  assert.match(publicStore.statuses.get(repo.id).error, /访问被拒绝/); assert.doesNotMatch(publicStore.statuses.get(repo.id).error, /已隐藏/);
});
test('archive redirect never sends credentials to a different host and rejects unknown destinations', async () => {
  const repo = repoConfig({ url: 'https://github.com/team/project', token: 'secret' });
  const provider = createProvider(repo, async () => new Response(null, { status: 302, headers: { location: 'https://unexpected.example/archive' } }));
  await assert.rejects(provider.archive('a'.repeat(40)), /非预期/);
});
test('editing repository host does not silently forward the previous token', () => {
  const previous = repoConfig({ url: 'https://gitlab.company/team/project', token: 'private-token' });
  const updated = repoConfig({ url: 'https://github.com/team/project' }, previous);
  assert.equal(updated.token, '');
  assert.equal(repoConfig({ url: previous.url, clearToken: true }, previous).token, '');
});
test('Gitee without token reads public tree/blobs; supplied invalid token never falls back', async () => {
  const repo = repoConfig({ url: 'https://gitee.com/team/public' });
  const dir = await temporary();
  const calls = [];
  const fetchMock = async (url, options) => {
    calls.push(url); assert.equal(options.headers.Authorization, undefined);
    if (url.includes('/git/trees/')) return Response.json({ truncated: false, tree: [{ path: 'docs/公开.md', mode: '100644', type: 'blob', sha: 'b'.repeat(40), size: 20 }, { path: 'Main.java', mode: '100644', type: 'blob', sha: 'f'.repeat(40) }] });
    if (url.includes('/git/blobs/')) return Response.json({ encoding: 'base64', content: Buffer.from('# 公开文档\n正文').toString('base64') });
    return Response.json(url.includes('/branches/') ? { commit: { sha: 'a'.repeat(40) } } : { default_branch: 'main' });
  };
  const store = new Store(dir, fetchMock); await store.sync(repo);
  assert.equal(store.snapshots.get(repo.id)?.documents[0].title, '公开文档', JSON.stringify(store.statuses.get(repo.id)));
  assert.ok(!calls.some(url => url.includes('/tarball'))); assert.equal(calls.filter(url => url.includes('/git/blobs/')).length, 1);
  let count = 0;
  const invalid = new Store(dir, async (url, options) => { count++; assert.equal(options.headers.Authorization, 'Bearer invalid'); return new Response(null, { status: 401 }); });
  await invalid.sync({ ...repo, token: 'invalid' }); assert.equal(count, 1); assert.match(invalid.statuses.get(repo.id).error, /Token 无效/);
});
test('Gitee anonymous retry reuses downloaded blobs after rate limiting', async () => {
  const repo = repoConfig({ url: 'https://gitee.com/team/public' });
  const dir = await temporary();
  let fail = true; const blobs = [];
  const mock = async url => {
    if (url.includes('/git/trees/')) return Response.json({ tree: ['b', 'c'].map(c => ({ path: c + '.md', mode: '100644', type: 'blob', sha: c.repeat(40), size: 4 })) });
    if (url.includes('/git/blobs/')) {
      const sha = url.split('/').at(-1); blobs.push(sha);
      if (sha.startsWith('c') && fail) return new Response('Rate Limit Exceeded', { status: 403 });
      return Response.json({ encoding: 'base64', content: Buffer.from('# ' + sha[0]).toString('base64') });
    }
    return Response.json(url.includes('/branches/') ? { commit: { sha: 'a'.repeat(40) } } : { default_branch: 'main' });
  };
  const store = new Store(dir, mock); await store.sync(repo);
  assert.match(store.statuses.get(repo.id).error, /限流/); assert.equal(store.snapshots.has(repo.id), false);
  fail = false; await store.sync(repo);
  assert.equal(store.snapshots.get(repo.id)?.documents.length, 2, JSON.stringify(store.statuses.get(repo.id)));
  assert.equal(blobs.filter(s => s.startsWith('b')).length, 1);
});
