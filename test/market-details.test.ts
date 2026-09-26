import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractMarketDetails,MARKET_DETAILS_RESERVE_MICRO_USD} from '../src/market-details.js';
import {marketAISettings} from '../src/market-ai.js';
import type {ProspectCandidate} from '../src/market-prospects.js';
const candidate:ProspectCandidate={sourceUrl:'https://www.reddit.com/r/collectors/comments/abc123/',relationship:'potential_user',problem:'Tracking collection',fitReason:'Owned tracking fits their workflow.',excerpt:'I track my collection',sourceEvidence:'Author: u/collector. I track my collection',matchedCapabilityIds:['70000000-0000-4000-8000-000000000001']};
test('Luna extracts only source-backed fields and cannot change Sol assessment or order',async()=>{
 let body:any;
 const request=(async(_url:any,init:any)=>{body=JSON.parse(init.body);return new Response(JSON.stringify({model:'gpt-6-luna',status:'completed',usage:{input_tokens:100,output_tokens:50},output_text:JSON.stringify({details:[{index:0,publicHandle:'u/collector',displayName:'Invented Name',profileUrl:'https://evil.example/',publishedAt:null}]})}));}) as typeof fetch;
 const result=await extractMarketDetails('fixture',[candidate],request);
 assert.equal(body.model,'gpt-6-luna');assert.equal(body.reasoning.effort,'max');assert.equal(body.tools,undefined);
 assert.equal(result.candidates[0]?.publicHandle,'u/collector');assert.equal(result.candidates[0]?.displayName,null);assert.equal(result.candidates[0]?.profileUrl,null);
 assert.equal(result.candidates[0]?.fitReason,candidate.fitReason);assert.equal(result.candidates[0]?.sourceUrl,candidate.sourceUrl);assert.equal(result.costMicroUsd,38);
});
test('failed or malformed extraction retains every assessment and accounts for cost',async()=>{
 const uncertain=await extractMarketDetails('fixture',[candidate],(async()=>{throw Error('timeout');}) as typeof fetch);
 assert.equal(uncertain.candidates.length,1);assert.equal(uncertain.status,'unavailable');assert.equal(uncertain.costMicroUsd,MARKET_DETAILS_RESERVE_MICRO_USD);
 const malformed=await extractMarketDetails('fixture',[candidate],(async()=>new Response(JSON.stringify({model:'gpt-6-luna',status:'incomplete',usage:{input_tokens:80,output_tokens:20}}))) as typeof fetch);
 assert.equal(malformed.candidates[0]?.fitReason,candidate.fitReason);assert.equal(malformed.costMicroUsd,20);
});
test('empty candidates do not dispatch Luna and split config preserves shared caps',async()=>{
 const result=await extractMarketDetails('fixture',[],(async()=>{throw Error('unexpected');}) as typeof fetch);assert.equal(result.status,'skipped');assert.equal(result.costMicroUsd,0);
 const settings=marketAISettings({MARKET_AI_ENABLED:'true',MARKET_RESEARCH_PIPELINE:'sol-luna',LEADS_MODEL_ID:'gpt-6-luna',LEADS_AI_ACCOUNT_CAP_USD:'4',LEADS_AI_GLOBAL_CAP_USD:'5'},false);
 assert.equal(settings.model,'gpt-6-sol');assert.equal(settings.inputPriceCeiling,2.5);assert.equal(settings.outputPriceCeiling,10);assert.equal(settings.accountCapMicroUsd,4e6);assert.equal(settings.globalCapMicroUsd,5e6);
});
