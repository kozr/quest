import {test} from 'node:test';
import assert from 'node:assert/strict';
import {researchMarket,researchInputBytes,researchReservation,MARKET_RESEARCH_CALLS,MARKET_RESEARCH_OUTPUT} from '../src/market-research.js';
import type {LeadProfile} from '../src/leads-types.js';
const input={appName:'Collection notebook',profile:{capabilities:[{text:'Track owned figures'}],problems:[{text:'Keeping a collection inventory'}],communities:['collectibles'],keywords:['inventory']} as LeadProfile};
const value={findings:[{title:'Keeping inventory up to date',summary:'An older discussion describes difficulty maintaining a collection list. This is an early signal.',sources:[{url:'https://forum.example.com/discussion/123',title:'Collection lists discussion'}]}]};
function response(overrides:any={}) {return {status:'completed',model:'gpt-6-luna',usage:{input_tokens:4500,output_tokens:1100},output_text:JSON.stringify(value),output:[{type:'web_search_call',action:{type:'search',sources:[{url:value.findings[0]!.sources[0]!.url}]}}],...overrides};}
function mock(body:any,calls:any[]=[]) {return (async(url:any,init:any)=>{calls.push(JSON.parse(init.body));return new Response(JSON.stringify(body));}) as typeof fetch;}
test('Sol High trial preserves the research prompt, schema and search limits',async()=>{
 const baseline:any[]=[],trial:any[]=[];
 await researchMarket('fixture','gpt-6-luna',input,mock(response(),baseline));
 const result=await researchMarket('fixture','gpt-6-sol',input,mock(response({model:'gpt-6-sol'}),trial),fetch,'high');
 assert.equal(result.model,'gpt-6-sol');
 assert.deepEqual(trial[0],{...baseline[0],model:'gpt-6-sol',reasoning:{effort:'high'}});
});
test('Market uses maximum reasoning and required broad web search without a date or domain filter',async()=>{
 const calls:any[]=[];const result=await researchMarket('fixture','gpt-6-luna',input,mock(response(),calls));
 assert.deepEqual(result.value,value);assert.equal(result.searchCalls,1);assert.equal(result.inputBytes,researchInputBytes(input));
 assert.equal(calls[0].reasoning.effort,'max');assert.equal(calls[0].tool_choice,'required');assert.equal(calls[0].tools[0].type,'web_search');assert.equal(calls[0].tools[0].filters,undefined);
 assert.equal(calls[0].max_tool_calls,MARKET_RESEARCH_CALLS);assert.equal(calls[0].max_output_tokens,MARKET_RESEARCH_OUTPUT);
 assert.match(calls[0].input[0].content,/across all dates/);assert.match(calls[0].input[0].content,/not verified quotes/);
});
test('rejects invented citations, unsafe links, missing searches, invalid usage and incomplete results',async()=>{
 for(const changed of [
  {output_text:JSON.stringify({findings:[{...value.findings[0],sources:[{url:'https://invented.example/story',title:'Not searched'}]}]})},
  {output:[]},{usage:{input_tokens:-1,output_tokens:2}},{status:'incomplete'},{model:'different'},
  {output:[{type:'web_search_call',action:{type:'unknown'}}]},
 ]) await assert.rejects(researchMarket('fixture','gpt-6-luna',input,mock(response(changed))));
});
test('an empty finding list still requires actual web search and records its cost',async()=>{
 const result=await researchMarket('fixture','gpt-6-luna',input,mock(response({output_text:'{"findings":[]}'})));
 assert.equal(result.value.findings.length,0);assert.equal(result.searchCalls,1);
 const reserved=researchReservation(result.inputBytes,{inputPriceCeiling:.125,outputPriceCeiling:.5} as any);
 assert.ok(reserved>60000,'reserve all search fees plus context and output');assert.ok(reserved<1000000);
});

test('incomplete research preserves reported usage for exact settlement and reports the cause',async()=>{
 const {MarketResearchResponseError}=await import('../src/market-research.js');
 await assert.rejects(researchMarket('fixture','gpt-6-luna',input,mock(response({status:'incomplete'}))),error=>{
  assert.ok(error instanceof MarketResearchResponseError);assert.equal(error.message,'RESEARCH_OUTPUT_INCOMPLETE');
  assert.deepEqual(error.usage,{model:'gpt-6-luna',inputTokens:4500,outputTokens:1100,searchCalls:1});return true;
 });
});

 test('provider schema enforces the same text bounds as the persisted findings',async()=>{
 const calls:any[]=[];await researchMarket('fixture','gpt-6-luna',input,mock(response(),calls));
 const fields=calls[0].text.format.schema.properties.findings.items.properties;
 assert.equal(fields.title.pattern,'^[\\s\\S]{3,120}$');assert.equal(fields.summary.pattern,'^[\\s\\S]{3,600}$');
 assert.equal(fields.sources.items.properties.title.pattern,'^[\\s\\S]{1,200}$');
 assert.equal(fields.sources.items.properties.url.format,undefined);
 await assert.rejects(researchMarket('fixture','gpt-6-luna',input,mock(response({output_text:JSON.stringify({findings:[{...value.findings[0],summary:'x'.repeat(601)}]})}))),/RESEARCH_SCHEMA_INVALID/);
 await assert.rejects(researchMarket('fixture','gpt-6-luna',input,mock(response({output_text:'invalid'}))),/RESEARCH_JSON_INVALID/);
 });

test('a rejected request records zero usage instead of charging the reservation',async()=>{
 const {MarketResearchResponseError}=await import('../src/market-research.js');
 await assert.rejects(researchMarket('fixture','gpt-6-luna',input,(async()=>new Response('{}',{status:400})) as typeof fetch),error=>{
 assert.ok(error instanceof MarketResearchResponseError);assert.equal(error.message,'RESEARCH_REQUEST_REJECTED');
 assert.deepEqual(error.usage,{model:'gpt-6-luna',inputTokens:0,outputTokens:0,searchCalls:0});return true;
 });
});

test('accounts for an extra provider search instead of discarding cited research',async()=>{
 const body=response();body.output=Array.from({length:MARKET_RESEARCH_CALLS+1},()=>body.output[0]);
 const result=await researchMarket('fixture','gpt-6-luna',input,mock(body));
 assert.equal(result.searchCalls,MARKET_RESEARCH_CALLS+1);assert.deepEqual(result.value,value);
});

test('citation aliases preserve the exact searched URL and reject unrelated pages',async()=>{
 const url='https://www.reddit.com/r/coffee/comments/abc123/a_post_title/?utm_source=share';
 const body=response({output:[{type:'web_search_call',action:{type:'search',sources:[{url}]}}],output_text:JSON.stringify({findings:[{...value.findings[0],sources:[{url:'https://reddit.com/r/coffee/comments/abc123/',title:'Coffee discussion'}]}]})});
 const result=await researchMarket('fixture','gpt-6-luna',input,mock(body));assert.equal(result.value.findings[0]!.sources[0]!.url,url);
 body.output_text=JSON.stringify({findings:[{...value.findings[0],sources:[{url:'https://reddit.com/r/coffee/comments/def456/',title:'Different discussion'}]}]});
 await assert.rejects(researchMarket('fixture','gpt-6-luna',input,mock(body)),/RESEARCH_CITATION_UNVERIFIED/);
});

test('keeps fully cited findings while excluding a finding with an invented reference',async()=>{
 const body=response({output_text:JSON.stringify({findings:[value.findings[0],{...value.findings[0],sources:[{title:'Invented',url:'https://fake.example/invented'}]}]})});
 const result=await researchMarket('fixture','gpt-6-luna',input,mock(body));assert.deepEqual(result.value,value);
});

test('search candidates require searched URLs without a direct platform lookup',async()=>{
 const cap='70000000-0000-4000-8000-000000000001';const video='https://www.youtube.com/watch?v=abcdefghijk';
 const profile={...input.profile,capabilities:[{id:cap,text:'Track owned figures',source:'user_confirmed' as const}]};
 const prospectCandidates=[{sourceUrl:'https://youtu.be/abcdefghijk',relationship:'creator_partner',problem:'Managing a collection',fitReason:'Discusses collection inventory',excerpt:'Tracking my collection',matchedCapabilityIds:[cap]}];
 const body=response({output:[{type:'web_search_call',action:{type:'search',sources:[{url:video}]}}],output_text:JSON.stringify({findings:[],prospectCandidates})});
 const publicFetch=(async()=>{throw new Error('Direct lookup must not run');}) as typeof fetch;
 const result=await researchMarket('fixture','gpt-6-luna',{...input,profile},mock(body),publicFetch);assert.equal(result.value.prospects?.length,1);assert.equal(result.value.prospects?.[0]?.status,'needs_review');
 let fetched=false;body.output=[{type:'web_search_call',action:{type:'search',sources:[{url:'https://forum.example.com/unrelated'}]}}];
 const blocked=await researchMarket('fixture','gpt-6-luna',{...input,profile},mock(body),(async()=>{fetched=true;throw Error();}) as typeof fetch);assert.equal(fetched,false);assert.equal(blocked.value.prospects,undefined);
});

test('a malformed author candidate cannot discard otherwise valid research',async()=>{
 const body=response({output_text:JSON.stringify({...value,prospectCandidates:[{sourceUrl:'not-a-url',excerpt:'Unusable author candidate'}]})});
 const result=await researchMarket('fixture','gpt-6-luna',input,mock(body));assert.deepEqual(result.value,value);
});

test('split research calls Sol High then Luna Max while preserving fit and accounting both stages',async()=>{
 const cap='70000000-0000-4000-8000-000000000001',url='https://www.reddit.com/r/collectors/comments/abc123/';
 const profile={...input.profile,capabilities:[{id:cap,text:'Track owned figures',source:'user_confirmed' as const}]};
 const fit='Visual inventory fits their stated shopping workflow.';
 const candidate={sourceUrl:url,relationship:'potential_user',problem:'Tracking figures',fitReason:fit,excerpt:'I need a collection list',sourceEvidence:'u/collector: I need a collection list',matchedCapabilityIds:[cap]};
 const requests:any[]=[];
 const request=(async(_url:any,init:any)=>{const body=JSON.parse(init.body);requests.push(body);return new Response(JSON.stringify(requests.length===1?response({model:'gpt-6-sol',output:[{type:'web_search_call',action:{type:'search',sources:[{url}]}}],output_text:JSON.stringify({findings:[],prospectCandidates:[candidate]})}):{model:'gpt-6-luna',status:'completed',usage:{input_tokens:100,output_tokens:100},output_text:JSON.stringify({details:[{index:0,publicHandle:'u/collector',displayName:null,profileUrl:null,publishedAt:null}]})}));}) as typeof fetch;
 const result=await researchMarket('fixture','gpt-6-sol',{...input,profile},request,fetch,'high',true);
 assert.deepEqual(requests.map(r=>[r.model,r.reasoning.effort]),[['gpt-6-sol','high'],['gpt-6-luna','max']]);
 assert.equal(result.value.prospects?.[0]?.fitReason,fit);assert.equal(result.value.prospects?.[0]?.publicHandle,'u/collector');assert.equal(result.detailsCostMicroUsd,63);
 assert.equal(result.model,'gpt-6-sol');assert.equal(result.detailsStatus,'complete');
});

test('Landscape is separately validated and cannot replace existing Problems findings',async()=>{
 const landscape={title:'Existing collection tools',summary:'A vendor offers visual inventory tracking.',sources:[{url:'https://vendor.example/pricing',title:'Vendor pricing'}]};
 const body=response({output_text:JSON.stringify({...value,landscape:[landscape],peopleCoverage:'Inspected one public conversation.'})});
 body.output[0].action.sources.push({url:landscape.sources[0]!.url});
 const result=await researchMarket('fixture','gpt-6-luna',input,mock(body));
 assert.deepEqual(result.value.findings,value.findings);
 assert.deepEqual(result.value.landscape,[landscape]);
 assert.equal(result.value.peopleCoverage,'Inspected one public conversation.');
 body.output[0].action.sources.pop();
 const unsupported=await researchMarket('fixture','gpt-6-luna',input,mock(body));
 assert.deepEqual(unsupported.value.findings,value.findings);assert.deepEqual(unsupported.value.landscape,[]);
});

test('an attributed comment from a cited thread becomes a person without claiming capability coverage',async()=>{
 const thread='https://www.reddit.com/r/collectors/comments/abc123/';
 const url=thread+'comment/def456/';
 const candidate={sourceUrl:url,relationship:'potential_user',matchType:'similar',needStatus:'unresolved_at_posting',
  publicHandle:'u/collector',displayName:null,profileUrl:null,publishedAt:'2026-09-20T12:00:00Z',
  problem:'Missing figures in my tracker',fitReason:'Same collection workflow, but support for their figures is unconfirmed.',
  excerpt:'My tracker is missing this series',sourceEvidence:`u/collector: My tracker is missing this series ${url}`,matchedCapabilityIds:[]};
 const body=response({output:[{type:'web_search_call',action:{type:'open_page',url:thread}}],output_text:JSON.stringify({findings:[],landscape:[],prospectCandidates:[candidate]})});
 const result=await researchMarket('fixture','gpt-6-luna',input,mock(body));
 assert.equal(result.value.prospects?.length,1);assert.equal(result.value.prospects?.[0]?.evidence[0]?.url,url);
 assert.equal(result.value.prospects?.[0]?.matchType,'similar');assert.deepEqual(result.value.prospects?.[0]?.matchedCapabilityIds,[]);
 for(const changed of [{sourceEvidence:'u/collector: My tracker is missing this series'},
  {sourceEvidence:`other_author: My tracker is missing this series ${url}`},{publicHandle:null},
  {sourceUrl:'https://www.reddit.com/r/collectors/comments/xyz999/comment/def456/'}]){
  body.output_text=JSON.stringify({findings:[],prospectCandidates:[{...candidate,...changed}]});
  assert.equal((await researchMarket('fixture','gpt-6-luna',input,mock(body))).value.prospects,undefined);
 }
});
