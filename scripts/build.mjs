import fs from 'node:fs/promises';
import path from 'node:path';
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

// Mermaid 走本地托管：入口很小，图形分块按需加载，不依赖外网 CDN。
const vendor = path.join('dist', 'vendor', 'mermaid');
await fs.rm(path.join('dist', 'vendor'), { recursive: true, force: true });
await fs.mkdir(vendor, { recursive: true });
await fs.copyFile(path.join('node_modules', 'mermaid', 'dist', 'mermaid.esm.min.mjs'), path.join(vendor, 'mermaid.esm.min.mjs'));
await fs.cp(path.join('node_modules', 'mermaid', 'dist', 'chunks', 'mermaid.esm.min'), path.join(vendor, 'chunks', 'mermaid.esm.min'), {
  recursive: true,
  filter: source => !source.endsWith('.map')
});
console.log('mermaid 资源已复制到 dist/vendor/mermaid');
