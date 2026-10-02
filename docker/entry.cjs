const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
process.umask(0o077);
const dir = process.env.GIT_DOCS_DATA || '/data';
const file = path.join(dir, 'config.json');
const passwordFile = path.join(dir, 'admin-password.txt');
const command = process.argv[2] || 'serve';
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const save = (file, content) => {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, file);
};
const newPassword = () => crypto.randomBytes(18).toString('base64url');
const hash = password => crypto.createHash('sha256').update(password).digest('hex');
if (command === 'serve' && !fs.existsSync(file)) {
  const password = process.env.GIT_DOCS_ADMIN_PASSWORD || newPassword();
  if (password.length < 10) throw new Error('管理密码至少需要 10 位');
  const intervalMinutes = Number(process.env.GIT_DOCS_INTERVAL_MINUTES || 10);
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1) throw new Error('同步间隔至少为 1 分钟');
  save(passwordFile, password + '\n');
  save(file, JSON.stringify({ version: 1, host: '0.0.0.0', port: 8080, intervalMinutes, adminHash: hash(password), repos: [] }, null, 2));
  console.log('首次初始化完成。管理密码保存在 /data/admin-password.txt。');
  console.log('查看密码：docker exec git-docs cat /data/admin-password.txt');
}
if (command === 'reset-password') {
  if (!fs.existsSync(file)) throw new Error('请先启动服务完成初始化');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const password = newPassword(); config.adminHash = hash(password);
  save(passwordFile, password + '\n'); save(file, JSON.stringify(config, null, 2));
  console.log('管理密码已重置，启动服务后可查看 /data/admin-password.txt。');
} else {
  require('./app.cjs');
}
