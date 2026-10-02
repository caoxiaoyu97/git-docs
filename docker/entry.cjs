const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

process.umask(0o077);
const dir = process.env.GIT_DOCS_DATA || '/data';
const file = path.join(dir, 'config.json');
const passwordFile = path.join(dir, 'admin-password.txt');
const command = process.argv[2] || 'serve';

function save(target, content) {
  const temp = target + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, target);
}
const newPassword = () => crypto.randomBytes(18).toString('base64url');
const hash = password => crypto.createHash('sha256').update(password).digest('hex');

function banner(lines) {
  console.log('');
  console.log('  ==================================================');
  for (const line of lines) console.log(line ? '  ' + line : '');
  console.log('  ==================================================');
  console.log('');
}

// Docker Desktop 把宿主机目录挂进来时，文件系统类型是 9p / virtiofs / fuse。
// 只在明确是宿主机目录时才这么提示，避免把 Docker 卷误报成宿主机目录。
function fromHostFolder() {
  try {
    for (const line of fs.readFileSync('/proc/mounts', 'utf8').split('\n')) {
      const parts = line.split(' ');
      if (parts[1] === dir && /^(9p|virtiofs|fuseblk|fuse)/.test(parts[2] || '')) return true;
    }
  } catch (error) {}
  return false;
}

fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

if (command === 'serve' && !fs.existsSync(file)) {
  const fromEnv = Boolean(process.env.GIT_DOCS_ADMIN_PASSWORD);
  const password = process.env.GIT_DOCS_ADMIN_PASSWORD || newPassword();
  if (password.length < 10) throw new Error('管理密码至少需要 10 位');
  const intervalMinutes = Number(process.env.GIT_DOCS_INTERVAL_MINUTES || 10);
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1) throw new Error('同步间隔至少为 1 分钟');
  save(passwordFile, password + '\n');
  save(file, JSON.stringify({ version: 1, host: '0.0.0.0', port: 8080, intervalMinutes, adminHash: hash(password), repos: [] }, null, 2));
  banner([
    'Git Docs 首次启动完成',
    '',
    '管理密码：' + (fromEnv ? '使用环境变量 GIT_DOCS_ADMIN_PASSWORD 设置的值' : password),
    '数据目录：' + dir + (fromHostFolder() ? '（来自宿主机目录）' : ''),
    '如需把文档直接放到宿主机目录方便备份，启动时加 -v 宿主机目录:/data。',
    '',
    '浏览器打不开时，检查启动命令是否发布了端口，例如：',
    'docker run -d -p 18080:8080 -v /宿主机目录:/data <镜像>',
    fromEnv ? '' : '以上密码只在首次启动时打印，请及时保存。',
    '忘记密码可执行：docker exec <容器名> node entry.cjs reset-password'
  ]);
} else if (command === 'serve') {
  console.log('Git Docs 启动中，数据目录：' + dir + '；管理密码见该目录下的 admin-password.txt');
}

if (command === 'reset-password') {
  if (!fs.existsSync(file)) throw new Error('请先启动服务完成初始化');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const password = process.env.GIT_DOCS_ADMIN_PASSWORD || newPassword();
  if (password.length < 10) throw new Error('管理密码至少需要 10 位');
  config.adminHash = hash(password);
  save(passwordFile, password + '\n');
  save(file, JSON.stringify(config, null, 2));
  banner(['管理密码已重置', '', '新密码：' + password, '数据目录：' + dir]);
} else if (command === 'serve' || command === 'init') {
  require('./app.cjs');
}
