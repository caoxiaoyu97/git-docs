import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { temporary } from './temporary.mjs';

test('Windows launcher: cancel preserves container; update retains settings and checks health', { skip: process.platform !== 'win32' }, async () => {
  const dir = await temporary('launcher-');
  const data = path.join(dir, 'existing-data');
  await fs.mkdir(data);
  await fs.writeFile(path.join(data, 'config.json'), '{}');
  const script = path.resolve('scripts/start.ps1');
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  for (const scenario of ['cancel', 'update', 'failed']) {
    const log = path.join(dir, scenario + '.log');
    const harness = path.join(dir, scenario + '.ps1');
    const source = `
$global:launcherAnswers = [System.Collections.Generic.Queue[string]]::new()
${(scenario === 'cancel' ? ['n'] : ['y', '', '', 'abc', '70000', '18081', '18080', '']).map(a => `$global:launcherAnswers.Enqueue(${quote(a)})`).join('\n')}
function Read-Host { param($Prompt) if ($global:launcherAnswers.Count -eq 0) { throw 'Unexpected prompt' }; return $global:launcherAnswers.Dequeue() }
function docker {
  $global:LASTEXITCODE = 0
  Add-Content -LiteralPath ${quote(log)} -Value ($args -join ' ')
  switch ($args[0]) {
    'container' { return '[{"Config":{"Image":"git-docs:old"},"Mounts":[{"Destination":"/data","Type":"bind","Source":${JSON.stringify(data)}}],"HostConfig":{"PortBindings":{"8080/tcp":[{"HostPort":"18080"}]}}}]' }
    'ps' { return @('git-docs 0.0.0.0:18080->8080/tcp', 'another 0.0.0.0:18081->8080/tcp') }
    'inspect' { return '${scenario === 'failed' ? 'exited unhealthy' : 'running healthy'}' }
  }
}
& ${quote(script)}
exit $LASTEXITCODE
`;
    await fs.writeFile(harness, '\uFEFF' + source);
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, scenario === 'failed' ? 1 : 0, result.stdout + result.stderr);
    const calls = await fs.readFile(log, 'utf8');
    if (scenario === 'cancel') assert.doesNotMatch(calls, /rm -f|run -d/);
    else {
      assert.match(calls, /rm -f git-docs/);
      assert.match(calls, /--restart no -p 18080:8080/);
      assert.ok(calls.includes(data + ':/data'));
      assert.match(calls, /inspect --format/);
    }
  }
});
