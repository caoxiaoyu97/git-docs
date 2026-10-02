import fs from 'node:fs/promises';
import { build } from 'esbuild';

const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+/.test(pkg.version)) throw new Error('package.json 缺少可用版本号');

await build({
  entryPoints: ['src/main.mjs'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: 'dist/app.cjs',
  define: { __GIT_DOCS_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'info'
});
