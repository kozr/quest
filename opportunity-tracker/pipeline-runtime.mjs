import {validateQualificationBatch} from './listening-qualification.mjs';
import {stageReservation} from './pipeline-provider.mjs';
import {randomUUID} from 'node:crypto';
import {stageContext,STAGE_DEFINITIONS} from './pipeline-stages.mjs';
import {problem,PIPELINE_VERSION,hash} from './pipeline-contract.mjs';
import {reserveAnalysis,settleAnalysis,retireAnalysis,budgetDay} from './qualification.mjs';
import {ANALYSIS_DAILY_LIMIT} from './analysis.mjs';
import {validateSearchPlan,validateSavedPlan} from './search-plan.mjs';
import {findEvidence,qualificationInputHash,qualificationEvidence,saveConversationReview,recordReviewFailure} from './conversation-evidence.mjs';

export function claimStage(data,productId,stage,settings,refresh,now){
  retireAnalysis(data,now);
  const context=stageContext(data,productId,stage),cached=data.pipelineStages?.[productId]?.[stage];
  if(stage!=='qualify'&&!refresh&&cached&&!cached.imported&&cached.inputHash===context.inputHash&&Date.parse(cached.generatedAt)>now-30*86400000)return {cached:structuredClone(cached)};
  data.analysisLeases ||= {};
  if(Object.values(data.analysisLeases).some(l=>l.productId===productId))problem('A stage is already running for this business.',409);
  const day=budgetDay(now);data.analysisUsage ||= {};
  if(stage!=='qualify'&&(data.analysisUsage[day]||0)>=ANALYSIS_DAILY_LIMIT)problem('The daily analysis request limit has been reached.',429);
  const lease={token:randomUUID(),kind:'pipeline-stage',productId,stage,inputHash:context.inputHash,stageReservationMicroUsd:stageReservation(stage,context.input),expiresAt:now+120000};
  if(stage==='qualify'){lease.qualificationInput=context.input;lease.qualificationProfileHash=qualificationInputHash(context.product);}
  if(settings)reserveAnalysis(data,lease,settings,now);
  data.analysisLeases[lease.token]=lease;if(stage!=='qualify')data.analysisUsage[day]=(data.analysisUsage[day]||0)+1;
  return {lease:structuredClone(lease),input:structuredClone(context.input)};
}
export function finishStage(data,lease,result,now){
  const saved=data.analysisLeases?.[lease.token];
  if(!saved||saved.expiresAt<=now||saved.kind!=='pipeline-stage')problem('This stage expired. Run it again.',409);
  let context;
  if(saved.stage==='qualify'){
    const product=data.products.find(p=>p.id===saved.productId);
    if(!product||product.listeningVersion!=='v2'||qualificationInputHash(product)!==saved.qualificationProfileHash||saved.qualificationInput.evidence.some(old=>{const current=findEvidence(data,product,old.id);return !current||hash(qualificationEvidence(current))!==hash(old);}))problem('Stage inputs changed while it was running. Refresh and try again.',409);
    context={product,input:saved.qualificationInput,inputHash:saved.inputHash,definition:STAGE_DEFINITIONS.qualify};
  }else context=stageContext(data,saved.productId,saved.stage);
  if(context.inputHash!==saved.inputHash)problem('Stage inputs changed while it was running. Refresh and try again.',409);
  const validated=saved.stage==='qualify'?validateQualificationBatch(result.value,context.product,context.input):null;
  const output=validated?{results:validated.results}:context.definition.validate(result.value,context.product,context.input);
  const record={version:PIPELINE_VERSION,stage:saved.stage,inputHash:saved.inputHash,generatedAt:new Date(now).toISOString(),model:result.model,data:output};
  data.pipelineStages ||= {};data.pipelineStages[saved.productId] ||= {};if(!validated||validated.results.length)data.pipelineStages[saved.productId][saved.stage]=record;
  if(validated)for(const failure of validated.failed)recordReviewFailure(data,context.product,findEvidence(data,context.product,failure.evidenceId),failure.reason,record.generatedAt);
  if(validated?.failed.length)record.failed=validated.failed;
  if(saved.stage==='qualify')for(const decision of output.results){
    saveConversationReview(data,context.product,findEvidence(data,context.product,decision.evidenceId),decision,record.generatedAt,result.model);
  }
  settleAnalysis(data,saved,result.costMicroUsd);delete data.analysisLeases[lease.token];return structuredClone(record);
}
export function saveSearchPlan(data,productId,value,version){
  const p=data.products.find(x=>x.id===productId);if(!p)problem('Business not found.',404);
  if(!['v1','v2'].includes(version))problem('Choose v1 or v2 listening.');
  if(value){p.searchPlanV2=version==='v2'?validateSearchPlan(value,p):validateSavedPlan(value);}
  if(version==='v2'&&!p.searchPlanV2?.reviewed)problem('Review the search plan before activating it.',409);
  if(version==='v2')p.searchPlanV2=validateSearchPlan(p.searchPlanV2,p);
  p.listeningVersion=version;p.updatedAt=new Date().toISOString();return structuredClone(p);
}

export function saveDrafts(data,productId,value){
  const c=stageContext(data,productId,'drafts'),r=data.pipelineStages?.[productId]?.drafts;
  if(!r||r.imported||r.inputHash!==c.inputHash)problem('The draft sources changed. Regenerate before saving edits.',409);
  r.data=c.definition.validate(value,c.product,c.input);r.editedAt=new Date().toISOString();return structuredClone(r);
}

export function failStage(data,lease,reason,costMicroUsd,now){
  const saved=data.analysisLeases?.[lease.token];if(!saved)return;
  if(saved.stage==='qualify'){
    const product=data.products.find(p=>p.id===saved.productId);
    if(product&&qualificationInputHash(product)===saved.qualificationProfileHash)for(const source of saved.qualificationInput.evidence){
      const row=findEvidence(data,product,source.id);if(row&&hash(qualificationEvidence(row))===hash(source))recordReviewFailure(data,product,row,reason,new Date(now).toISOString());
    }
  }
  settleAnalysis(data,saved,costMicroUsd);delete data.analysisLeases[lease.token];
}
