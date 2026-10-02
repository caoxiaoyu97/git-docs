import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const release = path.join(root, 'dist', 'release');
const tags = ['amd64', 'arm64'].map(arch => `git-docs:${pkg.version}-${arch}`);
async function docker(args) {
  await new Promise((resolve, reject) => {
    const child = spawn('docker', args, { cwd: root, stdio: 'inherit', shell: false });
    child.on('error', e => reject(new Error('无法执行 Docker，请先安装并启动 Docker。' + e.message)));
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`docker ${args[0]} 失败（退出码 ${code}）`)));
  });
}
try {
  await docker(['info', '--format', '{{.OSType}}/{{.Architecture}}']);
  await fs.mkdir(release, { recursive: true });
  const hostArch = execFileSync('docker', ['version', '--format', '{{.Server.Arch}}'], { encoding: 'utf8' }).trim();
  if (!['amd64', 'arm64'].includes(hostArch)) throw new Error('打包主机需要 amd64 或 arm64 Docker 引擎');
  for (const arch of ['amd64', 'arm64']) {
    const base = `git-docs-node-base:24-${arch}`;
    const exists = await new Promise(resolve => {
      const child = spawn('docker', ['image', 'inspect', base], { stdio: 'ignore', shell: false });
      child.on('error', () => resolve(false)); child.on('exit', code => resolve(code === 0));
    });
    if (!exists) {
      await docker(['pull', '--platform', `linux/${arch}`, 'node:24-bookworm-slim']);
      await docker(['tag', 'node:24-bookworm-slim', base]);
    }
  }
  for (const [i, arch] of ['amd64', 'arm64'].entries()) {
    console.log(`\n构建 linux/${arch}：${tags[i]}\n`);
    await docker(['build', '--platform', `linux/${arch}`, '--build-arg', `BUILD_IMAGE=git-docs-node-base:24-${hostArch}`, '--build-arg', `RUNTIME_IMAGE=git-docs-node-base:24-${arch}`, '--build-arg', `APP_VERSION=${pkg.version}`, '--tag', tags[i], '.']);
  }
  const raw = path.join(release, 'git-docs-images.tar');
  const output = path.join(release, 'git-docs-images.tar.gz');
  await docker(['image', 'save', '-o', raw, ...tags]);
  console.log('\n压缩镜像包…');
  await pipeline(createReadStream(raw), createGzip({ level: 6 }), createWriteStream(output + '.tmp'));
  await fs.rename(output + '.tmp', output);
  await fs.unlink(raw);
  // 一并输出启动向导和部署说明，让 release 目录可以直接分发。
  for (const name of ['start.sh', 'start.bat', 'start.ps1']) {
    const source = await fs.readFile(path.join(root, 'scripts', name), 'utf8');
    let content = source.replaceAll('__VERSION__', pkg.version);
    // .bat 必须是 CRLF，否则 cmd 会把命令解析错。
    if (name.endsWith('.bat')) content = content.replace(/\r?\n/g, '\r\n');
    // .ps1 带 BOM，Windows PowerShell 才会按 UTF-8 读取其中的中文。
    // 源码里通常已经有一个，先去掉再补，避免出现两个 BOM 让第一行解析失败。
    const output = name.endsWith('.ps1') ? '\uFEFF' + content.replace(/^\uFEFF/, '') : content;
    await fs.writeFile(path.join(release, name), output, { mode: 0o755 });
  }
  await fs.copyFile(path.join(root, '3-部署说明.md'), path.join(release, '3-部署说明.md'));
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(output)) hash.update(chunk);
  await fs.writeFile(output + '.sha256', `${hash.digest('hex')}  git-docs-images.tar.gz\n`);
  console.log(`\n完成：${output}\n镜像：${tags.join('、')}\n启动：./start.sh（Linux/macOS）或双击 start.bat（Windows）`);
} catch (e) {
  console.error('\n打包未完成：' + e.message);
  process.exitCode = 1;
}
