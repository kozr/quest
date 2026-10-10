import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTrackerApp} from '../server.mjs';
import {FirestoreStore} from '../firestore-store.mjs';
import {LocalRecordBackend} from '../record-backend.mjs';
import {stageSnapshot,stageContext,validateStageRecords} from '../pipeline-stages.mjs';
import {validateVideos,videoEditVersion} from '../video-content.mjs';
import {videoSubtitles,videoDuration,sceneAt} from '../ui/src/video-render.mjs';
import {stageReservation} from '../pipeline-provider.mjs';
import {createAccountRuntime} from '../account-runtime.mjs';
import {qualificationSettings,budgetDay} from '../qualification.mjs';
import {v2Business,conversations,stageValue} from './pipeline.fixture.mjs';

export const videoValue=input=>({videos:[{id:'lunch-guide',insightId:input.insights[0].id,title:'Make lunch pickup easier',evidenceIds:input.insights[0].sources.map(source=>source.id),offeringIds:[],affiliation:'',template:'paper',scenes:[{role:'hook',headline:'Lunch should fit your day.',body:'A few small checks can make pickup easier.',seconds:'6'},{role:'tip',headline:'Start with your route.',body:'Compare nearby menus and current hours before choosing.',seconds:'6'},{role:'close',headline:'Choose what works for you.',body:'Leave enough time for the walk and pickup.',seconds:'6'}],caption:'Make lunch pickup easier: compare nearby menus, check current hours, and leave time for the walk.',reviewNotes:['Check current menus and opening hours before sharing.']}],limitations:['These topics come from a bounded collection of conversations.']});
export function videoProvider(){return {available:true,run:async(stage,input)=>{
 const value=stage==='videos'?videoValue(input):stageValue(stage,input);
 if(stage==='qualify')for(const row of value.results)row.entityMatch={status:'not_mentioned',basis:'none',reference:'',quote:'',identityQuote:'',businessQuote:'',contextSource:'none',reason:'This question does not name the business.'};
 return {value,model:'fixture-sol',costMicroUsd:1000};
}};}
async function fixture(t,{record=false,...options}={}){
 const directory=await mkdtemp(join(tmpdir(),'hearwhispers-content-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=record?new FirestoreStore(new LocalRecordBackend(directory)):undefined;
 const tracker=createTrackerApp({dataDirectory:directory,store,stageProvider:videoProvider(),qualificationEnv:{},...options});
 const product=await tracker.store.saveProduct(v2Business());await tracker.runStage(product.id,'search_plan');
 const plan=(await tracker.store.snapshot()).pipelineStages[product.id].search_plan.data;
 await tracker.store.saveSearchPlan(product.id,{...plan,reviewed:true},'v2');
 await tracker.store.recordSearch(product.id,{items:[],candidates:conversations(),semantic:true,sources:[],searchedAt:new Date().toISOString()});
 for(const stage of ['qualify','insights','actions','drafts'])await tracker.runStage(product.id,stage);
 return {...tracker,product,directory};
}
async function serve(t,tracker){const listener=tracker.app.listen(0,'127.0.0.1');await new Promise(resolve=>listener.once('listening',resolve));t.after(()=>new Promise(resolve=>{listener.closeAllConnections();listener.close(resolve);}));return `http://127.0.0.1:${listener.address().port}/api`;}

test('videos are generated from current collected topics and keep server-authored provenance',async t=>{
 const f=await fixture(t),before=await f.store.snapshot();await f.runStage(f.product.id,'videos');
 const data=await f.store.snapshot(),record=data.pipelineStages[f.product.id].videos,context=stageContext(data,f.product.id,'videos');
 assert.equal(record.data.videos.length,1);assert.equal(record.data.videos[0].sources.length,3);
 assert.deepEqual(record.data.videos[0].sources,context.input.insights[0].sources);
 assert.deepEqual(data.pipelineStages[f.product.id].drafts,before.pipelineStages[f.product.id].drafts);
 assert.deepEqual(data.items,before.items);assert.equal(stageSnapshot(data)[f.product.id].videos.stale,false);
 const injected=videoValue(context.input);injected.videos[0].sources=[{id:'fake',url:'https://fake.test'}];
 assert.deepEqual(validateVideos(injected,context.product,context.input).videos[0].sources,context.input.insights[0].sources);
 injected.videos[0].evidenceIds=['unknown'];assert.throws(()=>validateVideos(injected,context.product,context.input),/unknown/);
 const offering=videoValue(context.input);offering.videos[0].offeringIds=['o1'];assert.throws(()=>validateVideos(offering,context.product,context.input),/disclosure/);
 offering.videos[0].affiliation='I work with Fixture Cafe.';offering.videos[0].caption+=' I work with Fixture Cafe.';assert.equal(validateVideos(offering,context.product,context.input).videos[0].affiliation,offering.videos[0].affiliation);
 offering.videos[0].offeringIds=['unknown'];assert.throws(()=>validateVideos(offering,context.product,context.input),/unknown/);
});

test('two sessions cannot overwrite saved edits; changed evidence or reference IDs cannot be smuggled into a video',async t=>{
 const f=await fixture(t);await f.runStage(f.product.id,'videos');let data=await f.store.snapshot(),record=data.pipelineStages[f.product.id].videos;
 const body={...structuredClone(record.data),expectedVersion:videoEditVersion(record)};body.videos[0].caption='A caption edited by the user.';
 await f.store.saveVideos(f.product.id,body);data=await f.store.snapshot();record=data.pipelineStages[f.product.id].videos;
 assert.equal(record.data.videos[0].caption,body.videos[0].caption);assert.equal(record.editVersion,1);
 await assert.rejects(async()=>f.store.saveVideos(f.product.id,body),error=>error.status===409);
 const smuggled={...structuredClone(record.data),expectedVersion:videoEditVersion(record)};smuggled.videos[0].evidenceIds=smuggled.videos[0].evidenceIds.slice(0,1);
 await assert.rejects(async()=>f.store.saveVideos(f.product.id,smuggled),/original topic/);
 await f.store.mutate(next=>next.pipelineStages[f.product.id].insights.data.insights[0].title+=' updated');
 assert.equal(stageSnapshot(await f.store.snapshot())[f.product.id].videos.stale,true);
 await assert.rejects(async()=>f.store.saveVideos(f.product.id,{...record.data,expectedVersion:videoEditVersion(record)}),error=>error.status===409);
});

test('video scenes have bounded timing, readable text and deterministic subtitle boundaries',()=>{
 const input={business:{name:'Fixture Cafe'},insights:[{id:'one',sources:[{id:'source'}],offeringIds:[]}]},value=videoValue(input),video=value.videos[0];
 assert.equal(videoDuration(video),18);assert.equal(sceneAt(video,5.999).index,0);assert.equal(sceneAt(video,6).index,1);assert.equal(sceneAt(video,18).index,2);
 const srt=videoSubtitles(video);assert.match(srt,/00:00:00,000 --> 00:00:06,000/);assert.match(srt,/00:00:12,000 --> 00:00:18,000/);
 value.videos[0].scenes[0].body='word '.repeat(40).trim();assert.throws(()=>validateVideos(value,{},input),/enough time/);
 value.videos[0].scenes[0].body='';value.videos[0].scenes[0].role='tip';assert.throws(()=>validateVideos(value,{},input),/hook/);
});

test('record-compatible storage preserves videos, edits and unrelated queues across a fresh reader',async t=>{
 const f=await fixture(t,{record:true});await f.runStage(f.product.id,'videos');
 await f.store.mutate(data=>{data.receipts={keep:['receipt-one']};data.collection={watermarks:{keep:'current'}};});
 let data=await f.store.snapshot(),row=data.pipelineStages[f.product.id].videos;
 await f.store.saveVideos(f.product.id,{...row.data,expectedVersion:videoEditVersion(row),videos:row.data.videos.map(video=>({...video,template:'charcoal'}))});
 const restarted=new FirestoreStore(new LocalRecordBackend(f.directory));data=await restarted.snapshot();
 assert.equal(data.pipelineStages[f.product.id].videos.data.videos[0].template,'charcoal');assert.equal(data.pipelineStages[f.product.id].videos.data.videos[0].sources.length,3);
 assert.deepEqual(data.receipts,{keep:['receipt-one']});assert.deepEqual(data.collection.watermarks,{keep:'current'});
 const restored=validateStageRecords(data.pipelineStages,data.products);assert.equal(restored[f.product.id].videos.imported,true);assert.equal(restored[f.product.id].videos.data.videos.length,1);assert.equal(restored[f.product.id].videos.data.videos[0].sources.length,3);
});

test('video dispatch reserves the existing budget and stale results cannot replace the saved batch',async t=>{
 const f=await fixture(t);await f.runStage(f.product.id,'videos');const data=await f.store.snapshot(),prior=structuredClone(data.pipelineStages[f.product.id].videos),now=Date.now();
 const settings=qualificationSettings({TRACKER_AI_ENABLED:'true',TRACKER_AI_MODE:'ongoing',TRACKER_AI_DAILY_BUDGET_USD:'2',TRACKER_OPENAI_API_KEY:'fixture'},now);
 const claim=await f.store.claimStage(f.product.id,'videos',settings,true,now,videoEditVersion(prior));
 assert.equal((await f.store.snapshot()).aiBudget.dailyUsage[budgetDay(now)].reservedMicroUsd,stageReservation('videos',claim.input));
 await f.store.mutate(next=>next.pipelineStages[f.product.id].insights.data.insights[0].title+=' changed');
 await assert.rejects(async()=>f.store.finishStage(claim.lease,{value:videoValue(claim.input),model:'fixture',costMicroUsd:1000},now+1),error=>error.status===409);
 await f.store.failStage(claim.lease,'stale');assert.deepEqual((await f.store.snapshot()).pipelineStages[f.product.id].videos,prior);
});

test('video API requires CSRF and respects the action switch, including saved edits',async t=>{
 const f=await fixture(t),origin=await serve(t,f),auth=await (await fetch(origin+'/state?light=1')).json();
 const path=`/products/${f.product.id}/stages/videos`,headers={'Content-Type':'application/json','X-Tracker-Token':auth.token};
 assert.equal((await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal((await fetch(origin+path,{method:'POST',headers,body:'{}'})).status,200);
 const state=await (await fetch(origin+'/state')).json(),record=state.pipeline.stages[f.product.id].videos;
 const body={...record.data,expectedVersion:record.editToken};body.videos[0].caption='Edited through the API.';
 assert.equal((await fetch(origin+path,{method:'PUT',headers,body:JSON.stringify(body)})).status,200);
 assert.equal((await fetch(origin+path,{method:'PUT',headers,body:JSON.stringify(body)})).status,409);
 const disabled=createTrackerApp({store:f.store,qualificationEnv:{TRACKER_ACTIONS_ENABLED:'false'},stageProvider:videoProvider()});
 await assert.rejects(()=>disabled.runStage(f.product.id,'videos'),error=>error.status===403);
 const other=await serve(t,disabled),token=(await (await fetch(other+'/state?light=1')).json()).token;
 assert.equal((await fetch(other+path,{method:'PUT',headers:{...headers,'X-Tracker-Token':token},body:JSON.stringify(body)})).status,403);
});

test('regeneration rejects an old batch version and blocks edits during an in-flight replacement',async t=>{
 const f=await fixture(t);await f.runStage(f.product.id,'videos');let record=(await f.store.snapshot()).pipelineStages[f.product.id].videos;
 const old=videoEditVersion(record);await f.store.saveVideos(f.product.id,{...record.data,expectedVersion:old});
 await assert.rejects(()=>f.runStage(f.product.id,'videos',true,old),error=>error.status===409);
 record=(await f.store.snapshot()).pipelineStages[f.product.id].videos;
 const claimed=await f.store.claimStage(f.product.id,'videos',null,true,Date.now(),videoEditVersion(record));
 await assert.rejects(async()=>f.store.saveVideos(f.product.id,{...record.data,expectedVersion:videoEditVersion(record)}),/generation is running/);
 await f.store.finishStage(claimed.lease,{value:videoValue(claimed.input),model:'fixture',costMicroUsd:1000});
 assert.notEqual(videoEditVersion((await f.store.snapshot()).pipelineStages[f.product.id].videos),videoEditVersion(record));
});

test('workspace viewers can read saved content but cannot save or regenerate it',async t=>{
 const f=await fixture(t);await f.runStage(f.product.id,'videos');
 const owner={sub:'content-owner',email:'content-owner@gmail.com'},viewer={sub:'content-viewer',email:'content-viewer@gmail.com'};
 await f.store.initializeAccount({id:'content-team',name:'Content test workspace',owner,planId:'team'});
 const invite=await f.store.accountAction(owner,'invite.create',{email:viewer.email,role:'viewer'});
 await f.store.accountAction(viewer,'invite.accept',{token:invite.token});
 const runtime=createAccountRuntime({defaultStore:f.store,defaultWorkspace:'content-team',principalFor:()=>viewer});
 await runtime.middleware({path:'/api/state',method:'GET',get:name=>name==='X-Workspace-ID'?'content-team':undefined},null,async error=>{
  if(error)throw error;
  const {data}=await runtime.publicSnapshot(),record=data.pipelineStages[f.product.id].videos;
  assert.equal(record.data.videos[0].sources.length,3);
  await assert.rejects(async()=>runtime.store.saveVideos(f.product.id,{...record.data,expectedVersion:videoEditVersion(record)}),error=>error.status===403);
  await assert.rejects(async()=>runtime.store.claimStage(f.product.id,'videos',null,true,Date.now(),videoEditVersion(record)),error=>error.status===403);
 });
});
