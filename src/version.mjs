import { readFileSync } from 'node:fs';
import path from 'node:path';

// 构建时由 scripts/build.mjs 通过 esbuild define 注入 __GIT_DOCS_VERSION__，
// 版本号只在 package.json 维护一处。未打包直接运行时回退读取 package.json。
function fromPackage() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch { return '0.0.0'; }
}

export const VERSION = typeof __GIT_DOCS_VERSION__ === 'string' ? __GIT_DOCS_VERSION__ : fromPackage();
