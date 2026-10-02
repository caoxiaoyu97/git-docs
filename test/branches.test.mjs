import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BranchStore } from '../src/branches.mjs';
import { Store, repoConfig, renderMarkdown } from '../src/core.mjs';
import { archive } from './mock.mjs';

test('branches isolate content/assets, coalesce concurrent clicks, bound downloads and survive restart', async () => {
 const dir = await fs.mkdtemp(path.join(process.cwd(), '.test-branches-'));
 const names = ['main','release/中文','dev','test']; const counts = new Map(); let active=0,max=0;
 const fake = async input => {
   const u=new URL(input); const route=decodeURIComponent(u.pathname);
   if(route.endsWith('/branches'))return Response.json(names.map(name=>({name})));
   if(route.includes('/branches/'))return Response.json({commit:{id:String(names.indexOf(route.split('/branches/')[1])+1).repeat(40)}});
   if(route.endsWith('/archive.tar.gz')){
     const name=names[Number(u.searchParams.get('sha')[0])-1];counts.set(name,(counts.get(name)||0)+1);max=Math.max(max,++active);
     await new Promise(r=>setTimeout(r,30)); const body=await archive([{name:'root/README.md',body:'# '+name+'\n\n[子文档](docs/a.md)\n![图片](p.png)'},{name:'root/docs/a.md',body:name},{name:'root/p.png',body:name}]);active--;return new Response(body);
   }
   return Response.json({default_branch:'main'});
 };
 const repo=repoConfig({url:'https://gitlab.example/team/repo'});
 const legacy=new Store(dir,fake);await legacy.sync(repo);
 const store=new BranchStore(dir,fake);await store.load(repo);
 assert.equal(store.snapshot(repo,'main').documents.length,2);
 assert.match(store.snapshot(repo,'main').root,/branches/);
 const a=store.sync(repo,'release/中文');const b=store.sync(repo,'release/中文');assert.equal(a,b);
 await Promise.all([a,b,store.sync(repo,'dev'),store.sync(repo,'test')]);
 assert.equal(counts.get('release/中文'),1);assert.ok(max<=2);
 for(const name of names){const snap=store.snapshot(repo,name);assert.equal(snap.documents.find(d=>d.path==='README.md').title,name);assert.equal(await fs.readFile(path.join(snap.root,'files','p.png'),'utf8'),name);}
 const snapshot=store.snapshot(repo,'release/中文');const html=renderMarkdown(snapshot.documents.find(d=>d.path==='README.md').text,repo,{...snapshot,scopedBranch:'release/中文'},'README.md');
 assert.match(html,/branch=release%2F%E4%B8%AD%E6%96%87/);
 const restarted=new BranchStore(dir,fake);await restarted.load(repo);assert.equal(restarted.snapshot(repo,'release/中文').documents.length,2);
 const listing=await restarted.branches(repo);assert.equal(listing.branches.filter(b=>b.synced).length,4);
 const before=counts.get('main');await restarted.sync(repo,'main');assert.equal(counts.get('main'),before);
 assert.equal(restarted.snapshot(repo,'unknown'),undefined);assert.equal(restarted.channels.get(repo.id).size,4);
});

test('failed updates preserve cache, cleanup is guarded, and interrupted staging is recovered', async () => {
 const dir=await fs.mkdtemp(path.join(process.cwd(),'.test-recovery-'));
 let sha='a'.repeat(40), deny=false, hold, start;
 const fake=async input=>{
   const u=new URL(input);
   if(deny)return new Response('{}',{status:404});
   if(u.pathname.endsWith('/branches'))return Response.json([{name:'main'},{name:'dev'}]);
   if(u.pathname.includes('/branches/'))return Response.json({commit:{id:sha}});
   if(u.pathname.endsWith('/archive.tar.gz')){if(start)start();if(hold)await hold;return new Response(await archive([{name:'root/README.md',body:'# '+sha}]));}
   return Response.json({default_branch:'main'});
 };
 const repo=repoConfig({url:'https://example.com/team/repo'}), store=new BranchStore(dir,fake);
 await store.sync(repo);await store.sync(repo,'dev');const previous=store.snapshot(repo,'dev');
 deny=true;await store.sync(repo,'dev');assert.equal(store.snapshot(repo,'dev'),previous);assert.match(store.state(repo,'dev').error,/不存在/);
 deny=false;sha='b'.repeat(40);let release;hold=new Promise(r=>release=r);let started=new Promise(r=>start=r);
 const job=store.sync(repo,'dev');await started;
 await assert.rejects(store.clearCache(repo,'dev'),/正在同步/);release();await job;hold=null;start=null;
 assert.equal(store.state(repo,'dev').phase,'complete');
 const channel=store.channel(repo,'dev');const orphan=path.join(channel.repoDir(),'versions','12345678-1234-1234-1234-123456789012');await fs.mkdir(orphan,{recursive:true});await fs.writeFile(path.join(orphan,'partial'),'partial');
 const restarted=new BranchStore(dir,fake);await restarted.load(repo);assert.ok(restarted.snapshot(repo,'main'));assert.ok(restarted.snapshot(repo,'dev'));await assert.rejects(fs.stat(orphan));
 const usage=await restarted.cacheInfo(repo);assert.ok(usage.find(b=>b.branch==='dev').bytes>0);
 await assert.rejects(restarted.clearCache(repo,'main'),/默认/);
 await restarted.clearCache(repo,'dev');assert.equal(restarted.snapshot(repo,'dev'),undefined);
 const next=new BranchStore(dir,fake);await next.load(repo);assert.equal(next.snapshot(repo,'dev'),undefined);await next.sync(repo,'dev');assert.ok(next.snapshot(repo,'dev'));
});

test('disk-full during publication retains the previous readable snapshot', async () => {
 const dir=await fs.mkdtemp(path.join(process.cwd(),'.test-disk-'));let sha='a'.repeat(40);
 const fake=async input=>new URL(input).pathname.endsWith('/archive.tar.gz') ? new Response(await archive([{name:'root/README.md',body:'# '+sha}])) : Response.json(new URL(input).pathname.includes('/branches/')?{commit:{id:sha}}:{default_branch:'main'});
 const repo=repoConfig({url:'https://example.com/team/repo'}),store=new BranchStore(dir,fake);await store.sync(repo);const old=store.snapshot(repo,'main');sha='b'.repeat(40);
 const original=fs.writeFile;fs.writeFile=async(file,...args)=>{if(String(file).includes('current.json.')){const e=new Error('disk full');e.code='ENOSPC';throw e;}return original(file,...args);};
 try{await store.sync(repo,'main');}finally{fs.writeFile=original;}
 assert.equal(store.snapshot(repo,'main'),old);assert.match(store.state(repo,'main').error,/空间不足/);
});
