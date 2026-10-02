import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store, repoConfig } from '../src/core.mjs';
import { createProvider, sourceUrl } from '../src/providers.mjs';
import { archive } from './mock.mjs';

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
    if (url.startsWith('https://codeload.github.com/')) { assert.equal(options.headers.Authorization, undefined); return new Response(await archive(files)); }
    assert.equal(options.headers.Authorization, 'Bearer test-secret'); assert.ok(!url.includes('test-secret'));
    if (url.includes('/tarball')) {
      assert.ok(url.includes(sha));
      return type === 'github' ? new Response(null, { status: 302, headers: { location: 'https://codeload.github.com/team/project/legacy.tar.gz/' + sha } }) : new Response(await archive(files));
    }
    return Response.json(url.includes('/branches/') ? { commit: { sha } } : { default_branch: 'main' });
  };
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.test-'));
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
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.test-'));
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
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.test-'));
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
