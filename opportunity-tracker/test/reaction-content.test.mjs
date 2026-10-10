import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTrackerApp} from '../server.mjs';
import {FirestoreStore} from '../firestore-store.mjs';
import {LocalRecordBackend} from '../record-backend.mjs';
import {stageContext,stageSnapshot,validateStageRecords} from '../pipeline-stages.mjs';
import {validateVideos,videoEditVersion} from '../video-content.mjs';
import {validateVideoLibrary} from '../video-library.mjs';
import {videoDuration,videoSubtitles} from '../ui/src/video-render.mjs';
import {keyGreenPixels} from '../ui/src/reaction-render.mjs';
import {v2Business,conversations,stageValue} from './pipeline.fixture.mjs';

const library=()=>[{id:'clip-one',kind:'clip',mode:'green',label:'Walk toward camera',description:'A person walks confidently toward the camera and stops to pose. There is no reversal or embarrassment.',width:608,height:1080,duration:6.55,clean:true,sourceUrl:''},{id:'bg-one',kind:'background',mode:'image',label:'Café counter',description:'A café counter with a lunch menu behind it and room in front for a person.',width:1080,height:1920,duration:0,clean:true,sourceUrl:''}];
const reactionValue=input=>({videos:[{id:'lunch-reaction',insightId:input.insights[0].id,title:'Lunch plans',evidenceIds:input.insights[0].sources.map(source=>source.id),offeringIds:[],affiliation:'',format:'reaction',template:'paper',reaction:{viewpoint:'A customer deciding where to get lunch.',want:'Find the sandwich they wanted for lunch.',trigger:'Lunch is the first plan they commit to today.',action:'Walk purposefully toward the café counter.',turn:'The confidence comes from a small lunch plan.',clipCriteria:'A purposeful walk toward camera, without an unrelated attack or reversal.',backgroundCriteria:'A café counter makes the destination clear.',clipId:input.videoLibrary?.find(row=>row.kind==='clip')?.id||'',backgroundId:input.videoLibrary?.find(row=>row.kind==='background')?.id||'',clipStart:0},scenes:[{role:'hook',headline:'when lunch is the first plan you commit to today',body:'',seconds:'6'}],caption:'one thing at a time',reviewNotes:['Illustrative fixture copy; review the situation and action before sharing.']}],limitations:[]});
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'hearwhispers-reactions-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=new FirestoreStore(new LocalRecordBackend(directory));
 const tracker=createTrackerApp({store,qualificationEnv:{},stageProvider:{available:true,run:async(stage,input)=>{
  const value=stage==='videos'?reactionValue(input):stageValue(stage,input);
  if(stage==='qualify')for(const row of value.results)row.entityMatch={status:'not_mentioned',basis:'none',reference:'',quote:'',identityQuote:'',businessQuote:'',contextSource:'none',reason:'No business named.'};
  return {value,model:'fixture',costMicroUsd:1000};
 }}});
 const product=await store.saveProduct(v2Business());await tracker.runStage(product.id,'search_plan');
 await store.saveSearchPlan(product.id,{...(await store.snapshot()).pipelineStages[product.id].search_plan.data,reviewed:true},'v2');
 await store.recordSearch(product.id,{items:[],candidates:conversations(),semantic:true,sources:[],searchedAt:new Date().toISOString()});
 for(const stage of ['qualify','insights'])await tracker.runStage(product.id,stage);
 return {...tracker,product,directory};
}

test('reaction generation captures the supplied library and keeps source attribution independent of the model',async t=>{
 const f=await fixture(t),assets=library();await f.runStage(f.product.id,'videos',false,undefined,assets);
 const data=await f.store.snapshot(),record=data.pipelineStages[f.product.id].videos,video=record.data.videos[0];
 assert.deepEqual(record.videoLibrary,assets);assert.equal(video.format,'reaction');assert.equal(video.scenes.length,1);assert.equal(videoDuration(video),6);assert.equal(video.reaction.clipId,'clip-one');
 assert.equal(stageSnapshot(data)[f.product.id].videos.stale,false);assert.deepEqual(video.sources,stageContext(data,f.product.id,'videos').input.insights[0].sources);
 assert.match(videoSubtitles(video),/00:00:00,000 --> 00:00:06,000/);
 const restored=validateStageRecords(data.pipelineStages,data.products)[f.product.id].videos;assert.equal(restored.imported,true);assert.deepEqual(restored.videoLibrary,assets);assert.equal(restored.data.videos[0].reaction.action,video.reaction.action);
});

test('unknown clips, backgrounds on original footage and edits that cut off the reaction are rejected',()=>{
 const input={business:{name:'Café'},insights:[{id:'topic',sources:[{id:'source'}],offeringIds:[]}],videoLibrary:library()},value=reactionValue(input);
 value.videos[0].reaction.clipId='made-up';assert.throws(()=>validateVideos(value,{},input),/batch library/);
 value.videos[0].reaction.clipId='clip-one';value.videos[0].reaction.clipStart=1;assert.throws(()=>validateVideos(value,{},input),/complete reaction/);
 value.videos[0].reaction.clipStart=0;input.videoLibrary[0].mode='original';assert.throws(()=>validateVideos(value,{},input),/green-screen/);
 value.videos[0].reaction.backgroundId='';value.videos[0].scenes[0].body='An explanation of the joke.';assert.throws(()=>validateVideos(value,{},input),/one situation overlay/);
 value.videos[0].scenes[0].body='';value.videos[0].reaction.action='';assert.throws(()=>validateVideos(value,{},input),/invalid text/);
});

test('drafts can wait for a specific clip and later bind a new library without losing version checks or evidence',async t=>{
 const f=await fixture(t);await f.runStage(f.product.id,'videos');let record=(await f.store.snapshot()).pipelineStages[f.product.id].videos;
 assert.equal(record.data.videos[0].reaction.clipId,'');assert.match(record.data.videos[0].reaction.clipCriteria,/purposeful/);
 const before=structuredClone(record),body={...record.data,expectedVersion:videoEditVersion(record),videoLibrary:library()};
 body.videos[0].reaction={...body.videos[0].reaction,clipId:'clip-one',backgroundId:'bg-one'};
 await f.store.saveVideos(f.product.id,body);record=(await f.store.snapshot()).pipelineStages[f.product.id].videos;
 assert.deepEqual(record.data.videos[0].sources,before.data.videos[0].sources);assert.equal(record.data.videos[0].caption,before.data.videos[0].caption);assert.equal(stageSnapshot(await f.store.snapshot())[f.product.id].videos.stale,false);
 await assert.rejects(()=>f.store.saveVideos(f.product.id,body),error=>error.status===409);
 const restarted=new FirestoreStore(new LocalRecordBackend(f.directory));assert.deepEqual((await restarted.snapshot()).pipelineStages[f.product.id].videos.videoLibrary,library());
});

test('an in-flight generation validates against its own catalog and stale source changes cannot be hidden by a library edit',async t=>{
 const f=await fixture(t),assets=library(),claim=await f.store.claimStage(f.product.id,'videos',null,false,Date.now(),undefined,assets);
 assets[0].id='changed-outside';assert.equal(claim.input.videoLibrary[0].id,'clip-one');
 await f.store.finishStage(claim.lease,{value:reactionValue(claim.input),model:'fixture',costMicroUsd:1000});
 const record=(await f.store.snapshot()).pipelineStages[f.product.id].videos;
 await f.store.mutate(data=>data.pipelineStages[f.product.id].insights.data.insights[0].title+=' changed');
 await assert.rejects(()=>f.store.saveVideos(f.product.id,{...record.data,expectedVersion:videoEditVersion(record),videoLibrary:library()}),error=>error.status===409);
});

test('the library cannot carry media bytes or forged clean status into a writing request',()=>{
 const assets=library();assets[0].blob='never sent';assert.equal(Object.hasOwn(validateVideoLibrary(assets)[0],'blob'),false);
 assets[0].clean=false;assert.throws(()=>validateVideoLibrary(assets),/captions/);
 assets[0].clean=true;assets[0].sourceUrl='https://user:secret@creatorset.com/clip';assert.throws(()=>validateVideoLibrary(assets),/credentials/);
 assets[0].sourceUrl='';assets[0].duration=3;assert.throws(()=>validateVideoLibrary(assets),/duration/);
});

test('green removal preserves opaque dark/flesh colors and removes the green screen',()=>{
 const pixels=new Uint8ClampedArray([0,255,0,255,230,174,140,255,10,10,10,255,100,150,100,255]);keyGreenPixels(pixels);
 assert.equal(pixels[3],0);assert.deepEqual([...pixels.slice(4,12)],[230,174,140,255,10,10,10,255]);assert.ok(pixels[15]>0&&pixels[15]<255);
});

test('legacy text-video backups retain their scenes and provenance when the reaction schema is introduced',async t=>{
 const f=await fixture(t);await f.runStage(f.product.id,'videos');
 const data=await f.store.snapshot(),record=data.pipelineStages[f.product.id].videos,video=record.data.videos[0];
 delete video.format;delete video.reaction;delete record.videoLibrary;
 video.scenes=[{role:'hook',headline:'Pick up lunch',body:'Check your route.',seconds:'4'},{role:'tip',headline:'Check the menu',body:'Choose what suits you.',seconds:'4'},{role:'close',headline:'Leave time',body:'Plan around pickup.',seconds:'4'}];
 const restored=validateStageRecords(data.pipelineStages,data.products)[f.product.id].videos;
 assert.equal(restored.data.videos[0].format,'text');assert.deepEqual(restored.data.videos[0].scenes,video.scenes);assert.deepEqual(restored.data.videos[0].sources,video.sources.map(({id,url,title,author,publishedAt,quote})=>({id,url,title,author,publishedAt,quote})));assert.equal(restored.imported,true);
});

test('the authenticated video endpoint accepts bounded clip metadata and records the provider selection',async t=>{
 const f=await fixture(t),listener=f.app.listen(0,'127.0.0.1');await new Promise(resolve=>listener.once('listening',resolve));
 t.after(()=>new Promise(resolve=>{listener.closeAllConnections();listener.close(resolve);}));
 const origin=`http://127.0.0.1:${listener.address().port}/api`,auth=await (await fetch(origin+'/state?light=1')).json(),headers={'Content-Type':'application/json','X-Tracker-Token':auth.token},path=`/products/${f.product.id}/stages/videos`;
 const response=await fetch(origin+path,{method:'POST',headers,body:JSON.stringify({videoLibrary:library()})});assert.equal(response.status,200);
 assert.match(response.headers.get('content-security-policy'),/media-src 'self' blob:/);assert.match(response.headers.get('content-security-policy'),/img-src 'self' data: blob:/);
 const record=(await response.json()).result;assert.equal(record.data.videos[0].reaction.clipId,'clip-one');assert.deepEqual(record.videoLibrary,library());
 const wrong=library();wrong[0].clean=false;
 assert.equal((await fetch(origin+path,{method:'POST',headers,body:JSON.stringify({refresh:true,expectedVersion:videoEditVersion(record),videoLibrary:wrong})})).status,400);
});


test('social caption styles save and survive record restart and backup validation without changing source identity',async t=>{
 const f=await fixture(t);await f.runStage(f.product.id,'videos',false,undefined,library());
 const prior=(await f.store.snapshot()).pipelineStages[f.product.id].videos;
 for(const style of ['snapchat','instagram']){
  const record=(await f.store.snapshot()).pipelineStages[f.product.id].videos,body={...structuredClone(record.data),expectedVersion:videoEditVersion(record)};
  body.videos[0].template=style;await f.store.saveVideos(f.product.id,body);
  const restarted=new FirestoreStore(new LocalRecordBackend(f.directory)),data=await restarted.snapshot(),saved=data.pipelineStages[f.product.id].videos;
  assert.equal(saved.data.videos[0].template,style);assert.deepEqual(saved.data.videos[0].sources,prior.data.videos[0].sources);assert.equal(saved.data.videos[0].caption,prior.data.videos[0].caption);
  assert.equal(validateStageRecords(data.pipelineStages,data.products)[f.product.id].videos.data.videos[0].template,style);
 }
});
