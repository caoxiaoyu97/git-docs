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
