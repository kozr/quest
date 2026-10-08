import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {QUALIFICATION_PROMPT,QUALIFICATION_VERSION,batchRequest,resolveBatch,qualificationRequest,resolveQualification,profileSnapshot} from '../qualification.mjs';
import {TAVERN_COMMENT_INSTRUCTIONS} from '../qualification-policy.mjs';

const profile=profileSnapshot({capabilities:['Track owned, missing and duplicate figures.','Export wishlist and trade images.'],needs:['Maintain a collection checklist.']});
const job=(key,row={})=>({key,profile,row:{source:'Reddit',type:'post',title:'Collection checklist',snippet:'My spreadsheet is hard to keep updated. How can I track duplicates?',...row}});
const rejected=id=>({id,decision:'rejected',explicitIntent:false,intentEvidenceId:null,postEvidenceIds:[],capabilityIds:[],whyItFits:''});
const accepted=(id,index)=>({id,decision:'qualified',explicitIntent:true,intentEvidenceId:`candidate:${index}:post:body:0`,postEvidenceIds:[`candidate:${index}:post:body:0`],capabilityIds:[profile.capabilities[0].id],whyItFits:'Keep a checklist of owned and duplicate figures'});

test('dashboard text and comment policies stay verbatim with Tavern’s essential policy',t=>{
  const path=new URL('../../src/leads-ai.ts',import.meta.url);
  if(!existsSync(path)){t.skip('Tavern source is outside this standalone dashboard checkout.');return;}
  const source=readFileSync(path,'utf8');
  if(!source.includes('export const ESSENTIAL_REQUIREMENT_RULE=')){t.skip('This Tavern checkout predates the essential policy integration.');return;}
  const part=source.slice(source.indexOf('  async qualifyPost('));
  const body=part.match(/const system=\[([\s\S]*?)\n    \]\.join\('\\n\\n'\);/)[1];
  // Only evaluate captured quoted string literals, never source statements.
  const paragraphs=[...body.matchAll(/^\s*('(?:\\.|[^'\\])*'),?$/gm)].map(m=>runInNewContext(m[1]));
  const essential=source.match(/export const ESSENTIAL_REQUIREMENT_RULE=('(?:\\.|[^'\\])*');/)[1];
  paragraphs.splice(-1,0,runInNewContext(essential));
  assert.equal(QUALIFICATION_PROMPT,paragraphs.join('\n\n'));
  const comment=part.match(/const commentInstructions=post.comment\?('(?:\\.|[^'\\])*'):/)[1];
  assert.equal(TAVERN_COMMENT_INSTRUCTIONS,runInNewContext(comment));
});

test('single and batch requests both use Tavern rules, preserving Sol medium and strict evidence selection',()=>{
  const jobs=[job('one'),job('two',{type:'comment',title:'I agree',snippet:'My wishlist is impossible to update.',context:'Parent author wants a buyer.'})];
  const single=qualificationRequest(jobs[1]),batch=batchRequest(jobs);
  for(const request of [single,batch]){
    assert(request.input[0].content.startsWith(QUALIFICATION_PROMPT));
    assert(request.input[0].content.includes(TAVERN_COMMENT_INSTRUCTIONS));
    assert.equal(request.model,'gpt-6.1-sol');assert.equal(request.reasoning.effort,'medium');
    assert.equal(request.service_tier,'default');assert.equal(request.tools,undefined);assert.equal(request.text.format.strict,true);
  }
  assert.equal(QUALIFICATION_VERSION,'tracker-tavern-evidence-v3');
  assert.equal(single.input[0].content,QUALIFICATION_PROMPT+TAVERN_COMMENT_INSTRUCTIONS);
  assert.equal(qualificationRequest(jobs[0]).input[0].content,QUALIFICATION_PROMPT);
  const input=JSON.parse(batch.input[1].content);
  assert.deepEqual(input.problems,profile.needs);
  assert.equal(input.candidates[1].threadContext,jobs[1].row.context);
  assert(!input.candidates[1].postEvidence.some(p=>p.text===jobs[1].row.context));
});

test('batched evidence cannot be borrowed from another candidate, parent context or a capability',()=>{
  const jobs=[job('one'),job('two',{snippet:'I just want to sell my figures.'})];
  for(const wrongId of ['candidate:0:post:body:0','thread:parent:0',profile.capabilities[0].id]){
    const result=accepted('two',1);result.intentEvidenceId=wrongId;
    assert.throws(()=>resolveBatch({results:[rejected('one'),result]},jobs),/evidence/);
  }
  const valid=accepted('one',0),out=resolveBatch({results:[rejected('two'),valid]},jobs);
  assert.equal(out.one.intentQuote,jobs[0].row.snippet);
  assert.equal(out.two.decision,'rejected');
  const {id,...single}=valid;single.intentEvidenceId='post:body:0';single.postEvidenceIds=['post:body:0'];
  assert.deepEqual(out.one,resolveQualification(single,jobs[0]));
});

test('malformed, old-format and unsupported batch decisions fail closed',()=>{
  const jobs=[job('one')],base=accepted('one',0);
  for(const results of [[],[base,base],[{...base,id:'another'}],[{...base,explicitIntent:false}],
    [{...base,decision:'uncertain'}],[{...base,whyItFits:'x'.repeat(81)}],
    [{...rejected('one'),postEvidenceIds:['candidate:0:post:body:0']}],
    [{id:'one',decision:'qualified',evidence:jobs[0].row.snippet,reason:'Tracks figures',capabilityIds:[profile.capabilities[0].id]}]]){
    assert.throws(()=>resolveBatch({results},jobs));
  }
});

test('batch schema namespaces literal passages and bounds the shared output',()=>{
  const jobs=[job('one'),job('two',{snippet:'An entirely different request.'})];
  const request=batchRequest(jobs),input=JSON.parse(request.input[1].content),schema=request.text.format.schema;
  const first=input.candidates[0].postEvidence.map(p=>p.id),second=input.candidates[1].postEvidence.map(p=>p.id);
  assert(first.every(id=>!second.includes(id)));
  assert.deepEqual(schema.properties.results.items.properties.intentEvidenceId.enum,[...first,...second,null]);
  assert.deepEqual(schema.properties.results.items.properties.decision.enum,['qualified','rejected']);
  assert.equal(request.max_output_tokens,4096);
});
