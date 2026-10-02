import fs from 'node:fs/promises';
import path from 'node:path';
const out = path.resolve('dist/licenses');
await fs.mkdir(out, { recursive: true });
async function collect(dir, prefix = '') {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const here = path.join(dir, entry.name);
    if (entry.name.startsWith('@')) { await collect(here, entry.name + '-'); continue; }
    for (const file of await fs.readdir(here)) if (/^(license|licence|copying)(\..*)?$/i.test(file)) {
      await fs.copyFile(path.join(here, file), path.join(out, prefix + entry.name + '-' + file));
    }
  }
}
await collect('node_modules');
