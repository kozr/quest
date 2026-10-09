import test from 'node:test';
import assert from 'node:assert/strict';
import {stageRequest,stageReservation,createStageProvider} from '../pipeline-provider.mjs';
import {STAGE_DEFINITIONS} from '../pipeline-stages.mjs';
const input=count=>({business:{name:'Fixture'},evidence:Array.from({length:count},(_,i)=>({id:`row${i}`,text:'Original complete source excerpt'}))});

test('qualification output reserve scales with bounded batch size and leaves full batches and other stages unchanged',()=>{
 for(const [count,tokens] of [[1,4096],[2,5120],[3,6144],[4,7168],[5,8000],[12,8000]]){
  const request=stageRequest('qualify',input(count));assert.equal(request.max_output_tokens,tokens);assert.equal(request.model,'gpt-6.1-sol');assert.equal(request.reasoning.effort,'medium');assert.equal(request.text.format.strict,true);assert.strictEqual(request.text.format.schema,STAGE_DEFINITIONS.qualify.schema);
  assert.equal(stageReservation('qualify',input(count)),Math.ceil((Buffer.byteLength(JSON.stringify(request))+tokens)*2.5+tokens*10));
 }
 for(const stage of ['search_plan','insights','actions','drafts'])assert.equal(stageRequest(stage,input(1)).max_output_tokens,STAGE_DEFINITIONS[stage].maxOutput);
});
test('provider sends the same smaller cap used by reservation and makes no automatic truncation retry',async()=>{
 let calls=0;
 const provider=createStageProvider({request:async(url,options)=>{
  calls++;const request=JSON.parse(options.body);assert.equal(request.max_output_tokens,4096);assert.equal(request.input[1].content,JSON.stringify(input(1)));
  return Response.json({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},model:request.model,usage:{input_tokens:10,output_tokens:4096},output_text:'{"results":['});
 }});
 await assert.rejects(provider.run('qualify',input(1)),error=>error.status===502);assert.equal(calls,1);
});
