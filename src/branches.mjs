import fs from 'node:fs/promises';
import path from 'node:path';
import { Store, digest, atomicJson, readJson } from './core.mjs';
import { createProvider } from './providers.mjs';
export class BranchStore extends Store {
  constructor(dir, fetchImpl = fetch) { super(dir, fetchImpl); this.channels = new Map(); this.defaults = new Map(); this.catalogs = new Map(); this.jobs = new Map(); this.active = 0; this.waiters = []; }
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
  busy(id) { return [...this.jobs.keys()].some(k => k.startsWith(id + '\0')); }
  async load(repo) {
    await super.load(repo);
    const old = this.snapshots.get(repo.id);
    if (old) {
      this.defaults.set(repo.id, old.branch);
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
    }
    const current = this.defaultBranch(repo);
    if (current && this.snapshot(repo, current)) this.snapshots.set(repo.id, this.snapshot(repo, current));
  }
  sync(repo, requested) {
    const branch = requested || this.defaultBranch(repo);
    const key = repo.id + '\0' + (branch || '');
    if (this.jobs.has(key)) return this.jobs.get(key);
    if (this.jobs.size >= 50) { this.channel(repo, branch).statuses.set(repo.id, { checking: false, error: '同步任务较多，请稍后重试' }); return Promise.resolve(); }
    const run = async () => {
      let resolved = branch;
      if (!resolved) { const latest = await createProvider(repo, this.fetchImpl).latest(); resolved = latest.branch; this.defaults.set(repo.id, resolved); }
      const s = this.channel(repo, resolved);
      s.statuses.set(repo.id, { checking: true, queued: true });
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
    if (remote.defaultBranch) this.defaults.set(repo.id, remote.defaultBranch);
    const names = new Set([...remote.names, ...(this.channels.get(repo.id)?.keys() || []), ...(this.defaultBranch(repo) ? [this.defaultBranch(repo)] : [])]);
    return { defaultBranch: this.defaultBranch(repo), error, branches: [...names].sort((a,b)=>a.localeCompare(b, 'zh-CN', { numeric:true })).map(name => { const snap = this.snapshot(repo,name), state = this.state(repo,name); return { name, synced: Boolean(snap), count: snap?.documents.length || 0, updatedAt: snap?.updatedAt, ...state }; }) };
  }
  forget(id) { this.channels.delete(id); this.defaults.delete(id); this.catalogs.delete(id); this.snapshots.delete(id); this.statuses.delete(id); }
}
