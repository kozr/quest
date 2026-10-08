import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {Store} from '../store.mjs';
import {createTrackerApp} from '../server.mjs';
import {researchProduct, analyzeMatch, validateFit, validateResearch, analysisSnapshot, analysisConfiguration, ANALYSIS_DAILY_LIMIT} from '../analysis.mjs';

const product={name:'QuietBoard',url:'https://quietboard.dev/',description:'Track subscriptions and send renewal reminders.',capabilities:['Send renewal reminders.'],needs:['Remember upcoming renewals.'],keywords:['subscription reminders'],aliases:['QuietBoard'],communities:[],exclusions:[],monitoring:false};
const item={url:'https://www.reddit.com/r/productivity/comments/abc123/',title:'How do you remember renewals?',snippet:'I need subscription reminders before renewal.',author:'reader_one',source:'Reddit',kind:'opportunity',publishedAt:null};
const finding={title:'Renewal reminders',summary:'Some readers describe missing a renewal date.',sources:[{url:item.url,title:'Original discussion'}]};
const person={handle:'reader_one',sourceUrl:item.url,sourceEvidence:'u/reader_one: I need subscription reminders before renewal.',excerpt:item.snippet,problem:'Remembering upcoming renewals.',fitReason:'The reminder feature may help; current need is unknown.',matchType:'exact',needStatus:'unresolved_at_posting',publishedAt:null,matchedCapabilityIds:['c1']};
const research={findings:[finding],landscape:[{...finding,title:'Calendar reminders as a workaround'}],people:[person],coverage:'One thread inspected; comments were not fully expanded.'};
const fit={decision:'strong_fit',summary:'An expressed reminder need matches the confirmed feature.',evidenceQuote:item.snippet,matchedCapabilityIds:['c1'],limitations:'The publication date is unknown and only the collected excerpt was assessed.',replies:[{approach:'helpful',body:'You could add a calendar reminder a few days before each renewal.'},{approach:'product',body:'A reminder before renewal could help. QuietBoard is my product and sends renewal reminders.'}]};
const config={available:true,apiKey:'fixture-key-never-public',model:'fixture-analysis-model'};
function providerResponse(value,{sources=[item.url],search=true,status='completed'}={}) {
  return new Response(JSON.stringify({model:config.model,status,usage:{input_tokens:100,output_tokens:200},output:[...(search?[{type:'web_search_call',status:'completed',action:{type:'search',sources:sources.map(url=>({url}))}}]:[]),{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(value)}]}]}),{status:200});
}
async function temporaryStore(t) {
  const path=await mkdtemp(join(tmpdir(),'tracker-analysis-'));t.after(()=>rm(path,{recursive:true,force:true}));return {store:new Store(path),path};
}
async function server(t,options={}) {
  const {path}=await temporaryStore(t);
  const created=createTrackerApp({dataDirectory:path,analysisProvider:{available:true,research:async()=>structuredClone(research),match:async()=>structuredClone(fit)},...options});
  const listener=created.app.listen(0,'127.0.0.1');await once(listener,'listening');t.after(()=>new Promise(resolve=>listener.close(resolve)));
  const origin=`http://127.0.0.1:${listener.address().port}`;
  const token=(await (await fetch(`${origin}/api/state`)).json()).token;
  const request=async(path,{method='GET',body,authorized=true}={})=>{
    const response=await fetch(`${origin}/api${path}`,{method,headers:{'Content-Type':'application/json',...(authorized?{'X-Tracker-Token':token}:{})},...(method==='GET'?{}:{body:JSON.stringify(body||{})})});
    return {status:response.status,value:await response.json()};
  };
  const saved=(await request('/products',{method:'POST',body:product})).value.product;
  await created.store.recordSearch(saved.id,{items:[item],searchedAt:new Date().toISOString(),sources:[]});
  return {...created,request,product:saved,item:created.store.snapshot().items[0]};
}

test('research retains only cited findings and attributed people, deduplicating later resolutions',async()=>{
  let payload;
  const value={...research,findings:[finding,{...finding,title:'Invented citation',sources:[{url:'https://made-up.dev/',title:'Unsupported'}]}],people:[person,{...person,handle:'READER_ONE',needStatus:'subsequently_resolved'},{...person,handle:'another_user'},{...person,sourceUrl:'https://www.reddit.com/r/productivity/comments/unknown123/'}]};
  const result=await researchProduct(product,{config,request:async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/responses');payload=JSON.parse(options.body);return providerResponse(value);}});
  assert.equal(result.findings.length,1);assert.equal(result.landscape.length,1);assert.equal(result.people.length,1);
  assert.equal(result.people[0].needStatus,'subsequently_resolved');assert.equal(result.people[0].publishedAt,null);
  assert.match(result.coverage,/omitted/);assert.equal(result.usage.searchCalls,1);
  assert.equal(payload.store,false);assert.equal(payload.max_tool_calls,3);
  assert.equal(payload.input[1].content.includes('fixture-key'),false);
  assert.deepEqual(JSON.parse(payload.input[1].content).capabilities,[{id:'c1',text:product.capabilities[0]}]);
});
test('comment evidence requires the exact permalink inside a cited parent thread passage',async()=>{
  const url=`${item.url}_/def456/`, comment={...person,sourceUrl:url,sourceEvidence:`u/reader_one: ${item.snippet} ${url}`};
  const valid=await researchProduct(product,{config,request:async()=>providerResponse({...research,people:[comment]})});
  assert.equal(valid.people.length,1);assert.equal(valid.people[0].sourceUrl,url);
  const invalid=await researchProduct(product,{config,request:async()=>providerResponse({...research,people:[{...comment,sourceEvidence:person.sourceEvidence}]})});
  assert.equal(invalid.people.length,0);
});
test('unsupported research and invalid or credential-bearing provider responses fail safely',async()=>{
  await assert.rejects(()=>researchProduct(product,{config,request:async()=>providerResponse(research,{sources:[]})}),/supported source/);
  await assert.rejects(()=>researchProduct(product,{config,request:async()=>providerResponse(research,{status:'incomplete'})}),/could not finish/);
  await assert.rejects(()=>researchProduct(product,{config,request:async()=>{throw new Error('secret=fixture-key-never-public');}}),error=>!error.message.includes(config.apiKey)&&error.status===502);
  assert.equal(analysisConfiguration({}).available,false);
  await assert.rejects(()=>researchProduct(product,{config:{available:false}}),error=>error.status===503);
});
test('fit analysis uses source text and confirmed features; unsupported quotes and strong fits fail',async()=>{
  let input;
  const result=await analyzeMatch({...product,note:'private metadata'}, {...item,note:'private notes',status:'saved'}, {config,request:async(_,options)=>{const payload=JSON.parse(options.body);assert.equal(payload.tools,undefined);input=JSON.parse(payload.input[1].content);return providerResponse(fit,{search:false});}});
  assert.equal(result.decision,'strong_fit');assert.equal(result.replies.length,2);
  assert.equal(JSON.stringify(input).includes('private'),false);
  assert.throws(()=>validateFit({...fit,evidenceQuote:'Invented words'},product,item),/unsupported quote/);
  assert.throws(()=>validateFit({...fit,matchedCapabilityIds:['invented']},product,item),/supporting evidence/);
  assert.throws(()=>validateFit({...fit,replies:[]},product,item),/reply suggestions/);
  assert.throws(()=>validateFit({...fit,decision:'not_a_fit'},product,item),/reply suggestions/);
  assert.equal(validateFit({...fit,decision:'unclear',evidenceQuote:null,matchedCapabilityIds:[],replies:[]},product,item).replies.length,0);
});
test('research and match analysis survive restart; source and profile changes invalidate the cache',async t=>{
  const {store,path}=await temporaryStore(t);const p=store.saveProduct(product);
  store.recordSearch(p.id,{items:[item],searchedAt:new Date().toISOString(),sources:[]});let match=store.snapshot().items[0];
  const researchLease=store.claimAnalysis(p.id);store.finishAnalysis(researchLease,research);
  const fitLease=store.claimAnalysis(p.id,match.id);store.finishAnalysis(fitLease,fit);
  const restarted=new Store(path);assert.equal(analysisSnapshot(restarted.snapshot()).items[0].analysis.replies.length,2);
  restarted.recordSearch(p.id,{items:[item],searchedAt:new Date().toISOString(),sources:[]});assert.ok(analysisSnapshot(restarted.snapshot()).items[0].analysis);
  restarted.recordSearch(p.id,{items:[{...item,snippet:'New conversation content.'}],searchedAt:new Date().toISOString(),sources:[]});assert.equal(analysisSnapshot(restarted.snapshot()).items[0].analysis,undefined);
  restarted.saveProduct({...product,description:'A changed product.'},p.id);assert.equal(analysisSnapshot(restarted.snapshot()).research[p.id].stale,true);
  const snapshot=analysisSnapshot(restarted.snapshot());assert.equal(snapshot.analysisUsage,undefined);assert.equal(snapshot.analysisLeases,undefined);
  restarted.deleteProduct(p.id);assert.equal(Object.keys(restarted.snapshot().research).length,0);assert.equal(restarted.snapshot().items.length,0);
});
test('reservations enforce daily limits, prevent overlap and backup races, and reject changed content',async t=>{
  const {store}=await temporaryStore(t);const p=store.saveProduct(product);const first=store.claimAnalysis(p.id);
  assert.throws(()=>store.claimAnalysis(p.id),error=>error.status===409);
  assert.throws(()=>store.importData({version:1,products:[],items:[],searches:{}}),/running analysis/);
  store.saveProduct({...product,description:'Changed while running'},p.id);
  assert.throws(()=>store.finishAnalysis(first,research),error=>error.status===409);store.releaseAnalysis(first.token);
  for(let i=1;i<ANALYSIS_DAILY_LIMIT;i++){const lease=store.claimAnalysis(p.id);store.releaseAnalysis(lease.token);}
  assert.throws(()=>store.claimAnalysis(p.id),error=>error.status===429);
  store.importData({version:1,products:[p],items:[],searches:{}});
  assert.throws(()=>store.claimAnalysis(p.id),error=>error.status===429);
  const tomorrow=Date.now()+86400000;const lease=store.claimAnalysis(p.id,null,tomorrow);assert.ok(lease.token);store.releaseAnalysis(lease.token);
});
test('API caches repeated requests, preserves review decisions, and backs up validated research',async t=>{
  let calls=0;
  const instance=await server(t,{analysisProvider:{available:true,research:async()=>{calls++;return structuredClone(research);},match:async()=>structuredClone(fit)}});
  assert.equal((await instance.request(`/products/${instance.product.id}/research`,{method:'POST',authorized:false})).status,403);
  const first=await instance.request(`/products/${instance.product.id}/research`,{method:'POST'});assert.equal(first.status,200);assert.equal(first.value.cached,false);
  assert.equal((await instance.request(`/products/${instance.product.id}/research`,{method:'POST'})).value.cached,true);assert.equal(calls,1);
  await instance.request(`/items/${instance.item.id}`,{method:'PATCH',body:{status:'saved',note:'Private review note'}});
  const assessment=await instance.request(`/items/${instance.item.id}/analysis`,{method:'POST'});assert.equal(assessment.status,200);
  const state=(await instance.request('/state')).value;assert.equal(state.items[0].status,'saved');assert.equal(state.items[0].note,'Private review note');assert.equal(state.analysisLeases,undefined);
  const backup=(await instance.request('/export')).value;
  assert.equal((await instance.request('/import',{method:'POST',body:backup})).status,200);
  const restored=(await instance.request('/state')).value;
  assert.equal(restored.research[instance.product.id].imported,true);assert.equal(restored.items[0].analysis.imported,true);
  const unsafe=structuredClone(backup);unsafe.research[instance.product.id].findings[0].sources[0].url='javascript:alert(1)';
  assert.equal((await instance.request('/import',{method:'POST',body:unsafe})).status,200);
  assert.equal((await instance.request('/state')).value.research[instance.product.id].findings.length,0);
});
test('API failures retain saved research and refuse stale work, while monitoring never invokes analysis',async t=>{
  let fail=false,calls=0;
  const instance=await server(t,{analysisProvider:{available:true,research:async p=>{calls++;if(fail)throw new Error('Scripted provider failure.');return structuredClone(research);},match:async()=>structuredClone(fit)},discoverFn:async()=>({items:[],sources:[],searchedAt:new Date().toISOString()})});
  await instance.request(`/products/${instance.product.id}/research`,{method:'POST'});fail=true;
  assert.equal((await instance.request(`/products/${instance.product.id}/research`,{method:'POST',body:{refresh:true}})).status,400);
  assert.equal((await instance.request('/state')).value.research[instance.product.id].findings.length,1);
  await instance.request(`/products/${instance.product.id}/search`,{method:'POST'});assert.equal(calls,2);
  assert.equal((await instance.request(`/items/missing/analysis`,{method:'POST'})).status,404);
});
test('unconfigured analysis reports availability and makes no provider requests',async t=>{
  const instance=await server(t,{analysisProvider:{available:false,research:()=>assert.fail('must not run'),match:()=>assert.fail('must not run')}});
  assert.equal((await instance.request('/state')).value.analysis.available,false);
  assert.equal((await instance.request(`/products/${instance.product.id}/research`,{method:'POST'})).status,503);
  assert.equal(Object.keys(instance.store.snapshot().analysisUsage||{}).length,0);
});
test('import validation omits unattributed people and private or unsafe source links',()=>{
  const result=validateResearch({...research,people:[{...person,sourceEvidence:'Unattributed words'}],landscape:[{...finding,sources:[{url:'http://127.0.0.1/private',title:'Private source'}]}]},product);
  assert.equal(result.people.length,0);assert.equal(result.landscape.length,0);
});
