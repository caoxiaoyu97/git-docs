import fs from 'node:fs/promises';
import path from 'node:path';
import { Store, digest, atomicJson, readJson } from './core.mjs';
import { createProvider } from './providers.mjs';
export class BranchStore extends Store {
  constructor(dir, fetchImpl = fetch) { super(dir, fetchImpl); this.channels = new Map(); this.defaults = new Map(); this.catalogs = new Map(); this.jobs = new Map(); this.cleaning = new Set(); this.active = 0; this.waiters = []; }
  channel(repo, branch) {
    if (!branch || branch.length > 250 || /[\x00-\x1f]/.test(branch)) throw new Error('分支名称无效');
    let group = this.channels.get(repo.id); if (!group) this.channels.set(repo.id, group = new Map());
    if (!group.has(branch)) {
      const s = new Store(this.directory, this.fetchImpl);
      const dir = path.join(this.repoDir(repo.id), 'branches', digest(branch));
      s.repoDir = () => dir; group.set(branch, s);
    }
    return group.get(branch);
  }
  defaultBranch(repo) { return repo.branch || this.defaults.get(repo.id) || this.snapshots.get(repo.id)?.branch; }
  snapshot(repo, branch) { return branch ? this.channels.get(repo.id)?.get(branch)?.snapshots.get(repo.id) : this.snapshots.get(repo.id); }
  state(repo, branch) { return this.channels.get(repo.id)?.get(branch)?.statuses.get(repo.id) || {}; }
  busy(id) { return this.cleaning.has(id) || [...this.jobs.keys()].some(k => k.startsWith(id + '\0')); }
  async load(repo) {
    const meta = await readJson(path.join(this.repoDir(repo.id), 'branch-default.json'));
    if (meta?.branch) this.defaults.set(repo.id, meta.branch);
    await super.load(repo);
    const old = this.snapshots.get(repo.id);
    if (old && !await readJson(path.join(this.repoDir(repo.id), 'cleared-' + digest(old.branch) + '.json'))) {
      if (!this.defaults.has(repo.id)) this.defaults.set(repo.id, old.branch);
      const s = this.channel(repo, old.branch), dir = s.repoDir();
      if (!await readJson(path.join(dir, 'current.json'))) {
        const version = path.basename(old.root);
        await fs.mkdir(path.join(dir, 'versions'), { recursive: true });
        await fs.cp(old.root, path.join(dir, 'versions', version), { recursive: true });
        await atomicJson(path.join(dir, 'branch.json'), { branch: old.branch });
        await atomicJson(path.join(dir, 'current.json'), { version });
      }
    }
    const base = path.join(this.repoDir(repo.id), 'branches');
    for (const name of await fs.readdir(base).catch(() => [])) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const info = await readJson(path.join(base, name, 'branch.json'));
      if (!info?.branch || digest(info.branch) !== name) continue;
      const s = this.channel(repo, info.branch); await s.load(repo);
      const versions = path.join(s.repoDir(), 'versions');
      for (const version of await fs.readdir(versions).catch(() => [])) {
        if (/^[a-f0-9-]{36}$/.test(version) && !await readJson(path.join(versions, version, 'index.json'))) await fs.rm(path.join(versions, version), { recursive: true, force: true });
      }
    }
    const current = this.defaultBranch(repo);
    if (current && this.snapshot(repo, current)) this.snapshots.set(repo.id, this.snapshot(repo, current));
  }
  sync(repo, requested) {
    if (this.cleaning.has(repo.id)) return Promise.resolve();
    const branch = requested || this.defaultBranch(repo);
    const key = repo.id + '\0' + (branch || '');
    if (this.jobs.has(key)) return this.jobs.get(key);
    if (this.jobs.size >= 50) { this.channel(repo, branch).statuses.set(repo.id, { checking: false, error: '同步任务较多，请稍后重试' }); return Promise.resolve(); }
    const run = async () => {
      let resolved = branch;
      if (!resolved) { const latest = await createProvider(repo, this.fetchImpl).latest(); resolved = latest.branch; this.defaults.set(repo.id, resolved); await atomicJson(path.join(this.repoDir(repo.id), 'branch-default.json'), { branch: resolved }); }
      const s = this.channel(repo, resolved);
      s.statuses.set(repo.id, { checking: true, queued: true, phase: 'queued' });
      if (this.active >= 2) await new Promise(resolve => this.waiters.push(resolve)); else this.active++;
      try {
        s.statuses.set(repo.id, { checking: true });
        await atomicJson(path.join(s.repoDir(), 'branch.json'), { branch: resolved });
        await s.sync({ ...repo, branch: resolved });
        if (resolved === this.defaultBranch(repo)) {
          if (s.snapshots.has(repo.id)) this.snapshots.set(repo.id, s.snapshots.get(repo.id));
          this.statuses.set(repo.id, s.statuses.get(repo.id));
        }
      } finally { const next = this.waiters.shift(); if (next) next(); else this.active--; }
    };
    const job = run().catch(e => { const message = repo.token ? e.message.replaceAll(repo.token, '[已隐藏]') : e.message; if (branch) this.channel(repo, branch).statuses.set(repo.id, { checking: false, error: message }); else this.statuses.set(repo.id, { checking: false, error: message }); }).finally(() => this.jobs.delete(key));
    this.jobs.set(key, job); return job;
  }
  async refresh(repo) {
    await this.sync(repo);
    for (const branch of this.channels.get(repo.id)?.keys() || []) if (branch !== this.defaultBranch(repo)) await this.sync(repo, branch);
  }
  async branches(repo) {
    let c = this.catalogs.get(repo.id);
    if (!c || c.expires < Date.now()) {
      c = { expires: Date.now() + 60000, promise: createProvider(repo, this.fetchImpl).branches() };
      this.catalogs.set(repo.id, c);
    }
    let remote, error;
    try { remote = await c.promise; } catch(e) { error = repo.token ? e.message.replaceAll(repo.token, '[已隐藏]') : e.message; remote = { names: [], defaultBranch: this.defaultBranch(repo) }; }
    if (remote.defaultBranch) { this.defaults.set(repo.id, remote.defaultBranch); await atomicJson(path.join(this.repoDir(repo.id), 'branch-default.json'), { branch: remote.defaultBranch }); }
    const names = new Set([...remote.names, ...(this.channels.get(repo.id)?.keys() || []), ...(this.defaultBranch(repo) ? [this.defaultBranch(repo)] : [])]);
    return { defaultBranch: this.defaultBranch(repo), error, branches: [...names].sort((a,b)=>a.localeCompare(b, 'zh-CN', { numeric:true })).map(name => { const snap = this.snapshot(repo,name), state = this.state(repo,name); return { name, remoteDeleted: !error && !remote.names.includes(name), synced: Boolean(snap), count: snap?.documents.length || 0, updatedAt: snap?.updatedAt, ...state }; }) };
  }
  async cacheInfo(repo) {
    const rows = [];
    async function bytes(dir) {
      let total = 0;
      for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) total += await bytes(file);
        else if (entry.isFile()) total += (await fs.stat(file).catch(() => ({ size: 0 }))).size;
      }
      return total;
    }
    for (const [branch, channel] of this.channels.get(repo.id) || []) {
      const snap = this.snapshot(repo, branch);
      rows.push({ branch, count: snap?.documents.length || 0, bytes: await bytes(channel.repoDir()), updatedAt: snap?.updatedAt, checking: this.jobs.has(repo.id + '\0' + branch), protected: branch === this.defaultBranch(repo) });
    }
    return rows;
  }
  async clearCache(repo, branch) {
    if (this.busy(repo.id)) throw new Error('仓库正在同步或清理，请稍后重试');
    if (branch === this.defaultBranch(repo)) throw new Error('默认展示分支需保留，请清理其他分支');
    const channel = this.channels.get(repo.id)?.get(branch);
    if (!channel) throw new Error('此分支没有本地缓存');
    this.cleaning.add(repo.id);
    try {
      const directory = channel.repoDir();
      const expected = path.join(this.repoDir(repo.id), 'branches', digest(branch));
      if (path.resolve(directory) !== path.resolve(expected)) throw new Error('缓存路径无效');
      await atomicJson(path.join(this.repoDir(repo.id), 'cleared-' + digest(branch) + '.json'), { cleared: true });
      await fs.rm(directory, { recursive: true, force: true });
      this.channels.get(repo.id).delete(branch);
    } finally { this.cleaning.delete(repo.id); }
  }
  forget(id) { this.channels.delete(id); this.defaults.delete(id); this.catalogs.delete(id); this.snapshots.delete(id); this.statuses.delete(id); }
}
