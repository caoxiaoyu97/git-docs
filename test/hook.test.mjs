import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHook } from '../src/hook/index.mjs';

test('webhook only updates the pushed default or previously downloaded branch', async () => {
  const previous = process.env.GIT_DOCS_HOOK_TOKEN;
  process.env.GIT_DOCS_HOOK_TOKEN = 'test-hook-token';
  const repo = { id: 'repo', name: 'docs', url: 'https://github.com/team/docs' };
  const calls = [];
  let hook;
  const reset = () => { hook = createHook({ getConfig: () => ({ repos: [repo] }), store: {
    defaultBranch: () => 'main',
    snapshot: (_, branch) => branch === 'release/cached' ? {} : undefined,
    sync: async (_, branch) => { calls.push(branch); }
  } }); };
  const server = http.createServer((req, res) => hook.handle(req, res, new URL(req.url, 'http://localhost')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const send = async payload => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/hook?token=test-hook-token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repository: { clone_url: repo.url + '.git' }, ...payload })
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    for (const branch of ['main', 'release/cached']) {
      reset();
      assert.deepEqual((await send({ ref: 'refs/heads/' + branch })).triggered, ['docs']);
      assert.equal(calls.at(-1), branch);
    }
    for (const payload of [
      { ref: 'refs/heads/never-downloaded' },
      { ref: 'refs/heads/main', deleted: true },
      { ref: 'refs/tags/v1' }, {}
    ]) {
      reset();
      assert.deepEqual((await send(payload)).triggered, []);
    }
    assert.deepEqual(calls, ['main', 'release/cached']);
    reset();
    await send({ ref: 'refs/heads/main' });
    assert.deepEqual((await send({ ref: 'refs/heads/main' })).triggered, []);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.GIT_DOCS_HOOK_TOKEN;
    else process.env.GIT_DOCS_HOOK_TOKEN = previous;
  }
});
