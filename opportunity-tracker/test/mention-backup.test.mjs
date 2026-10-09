import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {Store} from '../store.mjs';
import {createTrackerApp} from '../server.mjs';

test('review and web backups retain decisions and original identity without minting listing proof',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mention-backup-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=new Store(directory),product=store.saveProduct({name:'Example',url:'https://example.dev/',description:'A cafe.',capabilities:['Serve coffee.'],needs:['Find coffee.'],keywords:['Example'],aliases:[],communities:[],exclusions:[],monitoring:false});
 const rows=[
  {source:'Google Maps review',sourceId:'gm_'+'a'.repeat(32),postId:'0x123:0x456',url:'https://www.google.com/maps?cid=1110&review_key='+'a'.repeat(32),sourceLinkKind:'listing',businessReview:{version:1,dataId:'0x123:0x456',officialDomain:'example.dev'}},
  {source:'App Store review',sourceId:'as_123456',postId:'id6742131820',url:'https://apps.apple.com/us/app/id6742131820?review_id=123456',sourceLinkKind:'listing',businessReview:{version:1,appId:'6742131820',reviewId:'123456',country:'us'}},
  {source:'Instagram',sourceId:'ig_ExampleAb-1',postId:'ig_ExampleAb-1',url:'https://www.instagram.com/p/ExampleAb-1/',discoverySource:'google'},
  {source:'Web',sourceId:'web_'+'b'.repeat(32),postId:null,url:'https://example.dev/article',contentOrigin:'original_page',discoverySource:'google',discoveryURL:'https://example.dev/article'}
 ].map((row,index)=>({...row,id:'item'+index,productId:product.id,provider:'scrapebadger',parentId:null,type:'comment',kind:'conversation',status:'saved',note:'Private note',draft:'Saved draft',title:'Original '+index,snippet:'Original written source '+index,author:'Writer',publishedAt:'2026-02-19T12:00:00Z',context:'Original listing',foundAt:'2026-10-09T20:00:00Z'}));
 store.commit({...store.snapshot(),subscription:{planId:'growth',status:'manual'},items:rows});
 const {app}=createTrackerApp({store}),listener=app.listen(0,'127.0.0.1');await once(listener,'listening');t.after(()=>new Promise(resolve=>listener.close(resolve)));
 const origin=`http://127.0.0.1:${listener.address().port}`,token=(await(await fetch(origin+'/api/state')).json()).token;
 const backup=await(await fetch(origin+'/api/export')).json();
 async function restore(value){return fetch(origin+'/api/import',{method:'POST',headers:{'Content-Type':'application/json','X-Tracker-Token':token},body:JSON.stringify(value)});}
 assert.equal((await restore(backup)).status,200);
 for(const row of rows){const saved=store.snapshot().items.find(item=>item.id===row.id);for(const key of ['sourceId','postId','note','draft','sourceLinkKind','contentOrigin','discoverySource','discoveryURL','businessReview'])assert.deepEqual(saved[key],row[key],key);}
 const forged=structuredClone(backup);forged.items[0].snippet='Changed original evidence';forged.items[0].businessReview={version:1,officialDomain:'attacker.dev'};
 assert.equal((await restore(forged)).status,200);assert.equal(store.snapshot().items[0].businessReview,undefined);
 const unsafe=structuredClone(backup);unsafe.items[0].sourceId='gm_invalid';assert.equal((await restore(unsafe)).status,400);
});
