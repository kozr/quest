import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Timestamp} from 'firebase-admin/firestore';
import {
  OpenAIResponsesMarketAIProvider,MARKET_AI_OUTPUT_TOKENS,actualMarketAICostMicroUsd,estimateMarketInputBytes,
  maximumMarketAICostMicroUsd,
} from '../src/market-ai.js';
import {makeMarketObservation,validateMarketOutput} from '../src/market-aggregation.js';
import type {LeadProfile} from '../src/leads-types.js';
import type {MarketAnalysisOutput,MarketProblemRecord,MarketSource} from '../src/market-types.js';

const now=Date.parse('2026-09-24T12:00:00.000Z');
const REVISION=4;
const capabilityID='70000000-0000-4000-8000-000000000001';
const existingProblem:MarketProblemRecord={id:'60000000-0000-4000-8000-000000000001',user_id:'acct',app_id:'app',
  title:'Collection inventory tracking',summary:'Track what collectible figures are owned.',signalKind:'recurring_problem',groupKey:'collection-tracking',
  createdAt:new Date(now-86_400_000).toISOString(),updatedAt:new Date(now).toISOString(),expireAt:Timestamp.fromMillis(now+30*86_400_000)};
const profile:LeadProfile={user_id:'acct',app_id:'app',schemaVersion:1,revision:4,enabled:true,
  problems:[{id:'50000000-0000-4000-8000-000000000001',text:'Track figure collections'}],
  capabilities:[{id:capabilityID,text:'Track collection inventory',source:'user_confirmed'}],communities:['blindbox'],keywords:['inventory'],
  descriptionSource:null,confirmedAt:new Date(now-86_400_000).toISOString(),updatedAt:new Date(now).toISOString()};
const exactQuote='  I use Notes to track the figures I own.  ';
const source:MarketSource={id:'reddit:post:post123',provider:'reddit',kind:'post',threadId:'post123',parentId:null,
  authorKey:'reddit:t2_collector',authorDisplayName:'Collector',title:'My collection notes',text:`Before quote.${exactQuote}After quote.`,community:'blindbox',
  url:'https://www.reddit.com/r/blindbox/comments/post123/',createdAt:new Date(now-60_000).toISOString(),fetchedAt:new Date(now).toISOString(),
  contentHash:'source-hash',expiresAt:new Date(now+30*86_400_000).toISOString(),expireAt:Timestamp.fromMillis(now+30*86_400_000)};
const output:MarketAnalysisOutput={groups:[{problemId:existingProblem.id,groupKey:'collection-tracking',title:'Tracking owned figures',
  summary:'Collectors need an easier way to keep track of what they own.',signalKind:'recurring_problem',observations:[{
    sourceId:source.id,quote:exactQuote,explanation:'The author describes using Notes to track owned figures.',prospectReason:'The source describes a current tracking need.',
    needStatus:'unresolved',isProductBuilder:false,isSatisfied:false,matchedCapabilityIds:[capabilityID],competitorName:null,
  }]}]};

function providerWith(body:unknown,model='gpt-6-luna') {
  const calls:{url:string;init:RequestInit|undefined}[]=[];
  const request=(async(url:RequestInfo|URL,init?:RequestInit)=>{
    calls.push({url:String(url),init});return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  }) as typeof fetch;
  return {provider:new OpenAIResponsesMarketAIProvider('mock-key',model,request),calls};
}
function validResponse(overrides:Record<string,unknown>={}) {
  return {id:'resp_market_1',model:'gpt-6-luna',status:'completed',output_text:JSON.stringify(output),
    usage:{input_tokens:420,output_tokens:180},...overrides};
}
function providerInput(extra:{sources?:MarketSource[];existingProblems?:MarketProblemRecord[]}={}) {
  return {appName:'Blind Box Tracker',profile,existingProblems:extra.existingProblems??[existingProblem],sources:extra.sources??[source]};
}

test('parses a structured Responses API result and sends the configured runtime model at maximum reasoning',async()=>{
  const {provider,calls}=providerWith(validResponse());
  const result=await provider.analyze(providerInput());
  assert.deepEqual(result.value,output);
  assert.equal(result.inputTokens,420);
  assert.equal(result.outputTokens,180);
  assert.equal(result.model,'gpt-6-luna');
  assert.equal(result.requestId,'resp_market_1');
  const call=calls[0]!;
  assert.equal(call.url,'https://api.openai.com/v1/responses');
  const body=JSON.parse(String(call.init?.body));
  assert.equal(body.model,'gpt-6-luna');
  assert.equal(body.reasoning.effort,'max');
  assert.equal(body.store,false);
  assert.equal(body.text.format.type,'json_schema');
  assert.equal(body.text.format.strict,true);
  assert.equal(body.max_output_tokens,MARKET_AI_OUTPUT_TOKENS);
});

test('parses structured output from the assistant message envelope',async()=>{
  const {provider}=providerWith({id:'resp_market_2',model:'gpt-6-luna',status:'completed',usage:{input_tokens:17,output_tokens:9},
    output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(output)}]}]});
  assert.deepEqual((await provider.analyze(providerInput())).value,output);
});

test('rejects malformed, invalid-schema, incomplete, or usage-free provider responses',async()=>{
  const malformed=providerWith(validResponse({output_text:'{not json'})).provider;
  await assert.rejects(malformed.analyze(providerInput()));
  const invalidSchema=providerWith(validResponse({output_text:JSON.stringify({groups:[{unexpected:true}]})})).provider;
  await assert.rejects(invalidSchema.analyze(providerInput()));
  const incomplete=providerWith(validResponse({status:'incomplete'})).provider;
  await assert.rejects(incomplete.analyze(providerInput()),/incomplete/);
  const missingUsage=providerWith(validResponse({usage:{output_tokens:4}})).provider;
  await assert.rejects(missingUsage.analyze(providerInput()),/usage/);
});

test('rejects a response whose returned model differs from the configured model',async()=>{
  const {provider}=providerWith(validResponse({model:'gpt-6-sol'}),'gpt-6-luna');
  await assert.rejects(provider.analyze(providerInput()),/model/i);
});

test('reserves bytes from the exact serialized prompt, profile, sources, and schema',async()=>{
  const manySources=Array.from({length:82},(_,index)=>({...source,id:`source-${index}`,threadId:`thread-${index}`,
    title:`Title ${index} 🚀`,text:`A long body ${index} ${'collectible tracking '.repeat(170)}`}));
  const manyProblems=Array.from({length:55},(_,index)=>({...existingProblem,id:`problem-${index}`,title:`Existing ${index}`}));
  const input=providerInput({sources:manySources,existingProblems:manyProblems});
  const {provider,calls}=providerWith(validResponse());
  const result=await provider.analyze(input);
  const body=JSON.parse(String(calls[0]!.init?.body));
  const system=body.input[0].content as string;
  const user=body.input[1].content as string;
  const schema=JSON.stringify(body.text.format.schema);
  const serializedPromptBytes=Buffer.byteLength(system)+Buffer.byteLength(user)+Buffer.byteLength(schema)+8192;
  assert.equal(result.inputBytes,serializedPromptBytes);
  assert.equal(result.inputBytes,estimateMarketInputBytes(input));
  const parsedUser=JSON.parse(user);
  assert.equal(parsedUser.sources.length,80);
  assert.equal(parsedUser.existingProblems.length,50);
  assert.equal(parsedUser.sources[0].text.length,2500);

  const settings={inputPriceCeiling:2,outputPriceCeiling:3} as Parameters<typeof maximumMarketAICostMicroUsd>[1];
  const reserve=maximumMarketAICostMicroUsd(result.inputBytes,settings);
  const actual=actualMarketAICostMicroUsd(result.inputTokens,result.outputTokens,settings);
  assert.equal(reserve,Math.ceil(result.inputBytes*2+MARKET_AI_OUTPUT_TOKENS*3));
  assert.ok(reserve>=actual);
});

test('validates exact source quotes and rejects fabricated source IDs, quotes, capabilities, and canonical problems',()=>{
  const parsed=validateMarketOutput(output,[source],profile,[existingProblem]);
  assert.equal(parsed.groups[0]?.observations[0]?.quote,exactQuote);
  assert.equal(parsed.groups[0]?.observations[0]?.sourceId,source.id);
  assert.throws(()=>validateMarketOutput({...output,groups:[{...output.groups[0]!,observations:[{...output.groups[0]!.observations[0]!,
    sourceId:'reddit:post:invented'}]}]},[source],profile,[existingProblem]),/source/i);
  assert.throws(()=>validateMarketOutput({...output,groups:[{...output.groups[0]!,observations:[{...output.groups[0]!.observations[0]!,
    quote:'A completely fabricated statement.'}]}]},[source],profile,[existingProblem]),/quotation/i);
  assert.throws(()=>validateMarketOutput({...output,groups:[{...output.groups[0]!,observations:[{...output.groups[0]!.observations[0]!,
    matchedCapabilityIds:['80000000-0000-4000-8000-000000000001']}]}]},[source],profile,[existingProblem]),/capability/i);
  assert.throws(()=>validateMarketOutput({...output,groups:[{...output.groups[0]!,problemId:'90000000-0000-4000-8000-000000000001'}]},
    [source],profile,[existingProblem]),/canonical problem/i);
});

test('resolved, builder, and satisfied mentions stay in market intelligence without prospect status',()=>{
  const cases=[
    {id:'resolved',needStatus:'resolved' as const,isProductBuilder:false,isSatisfied:false},
    {id:'builder',needStatus:'unresolved' as const,isProductBuilder:true,isSatisfied:false},
    {id:'satisfied',needStatus:'unresolved' as const,isProductBuilder:false,isSatisfied:true},
  ];
  for(const entry of cases) {
    const rowSource={...source,id:entry.id,threadId:entry.id};
    const row=makeMarketObservation({userId:'acct',appId:'app',revision:REVISION,problemId:existingProblem.id,source:rowSource,
      observation:{sourceId:rowSource.id,quote:rowSource.text,explanation:'Still useful market evidence.',prospectReason:'This need is not actionable.',
        needStatus:entry.needStatus,isProductBuilder:entry.isProductBuilder,isSatisfied:entry.isSatisfied,matchedCapabilityIds:[capabilityID],competitorName:null},
      signalKind:'competitor_complaint',model:'mock-model',now});
    assert.equal(row.prospectStatus,'not_a_prospect');
    assert.equal(row.signalKind,'competitor_complaint');
  }
});

test('AI payload allowlist excludes account linkage and source author identifiers from full records',async()=>{
  const {provider,calls}=providerWith(validResponse());
  const input=providerInput();
  const result=await provider.analyze(input);
  const body=JSON.parse(calls[0]!.init!.body as string);
  const sent=JSON.parse(body.input[1].content);
  assert.deepEqual(Object.keys(sent.existingProblems[0]).sort(),['id','signalKind','summary','title']);
  assert.deepEqual(Object.keys(sent.sources[0]).sort(),['community','createdAt','id','kind','text','threadId','title']);
  assert.equal(sent.sources[0].authorDisplayName,undefined);
  assert.equal(sent.sources[0].authorKey,undefined);
  assert.equal(sent.existingProblems[0].user_id,undefined);
  assert.equal(sent.existingProblems[0].app_id,undefined);
  assert.equal(sent.profile.user_id,undefined);
  assert.equal(sent.profile.app_id,undefined);
  assert.equal(body.store,false);
  assert.equal(result.inputBytes,estimateMarketInputBytes(input));
});
