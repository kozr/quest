import {saveVideoEdits,videoEditVersion} from './video-content.mjs';
import {activeProduct,assertSubscriptionActive,planError} from './plans.mjs';
import {validateQualificationBatch} from './listening-qualification.mjs';
import {stageReservation} from './pipeline-provider.mjs';
import {randomUUID} from 'node:crypto';
import {stageContext,STAGE_DEFINITIONS} from './pipeline-stages.mjs';
import {problem,PIPELINE_VERSION,hash} from './pipeline-contract.mjs';
import {reserveAnalysis,settleAnalysis,retireAnalysis,budgetDay} from './qualification.mjs';
import {ANALYSIS_DAILY_LIMIT} from './analysis.mjs';
import {validateSearchPlan,validateSavedPlan} from './search-plan.mjs';
import {findEvidence,qualificationInputHash,qualificationEvidence,saveConversationReview,recordReviewFailure} from './conversation-evidence.mjs';
import {pilotBudgetBlock} from './pilot-budget.mjs';
import {needsEntityReview} from './entity-mention.mjs';
import {pendingEvidenceAll} from './conversation-evidence.mjs';
import {analysisCandidate,claimAnalysisCycleBatch,finishAnalysisCycleBatch,releaseAnalysisCycleBatch,resizeAnalysisCycleBatch} from './analysis-cycles.mjs';

function claimProvisionedQualification(data,productId,settings,now){
  const product=data.products.find(row=>row.id===productId);if(!product)problem('Business not found.',404);
  const version=STAGE_DEFINITIONS.qualify.promptVersion,profileHash=qualificationInputHash(product);
  const pending=pendingEvidenceAll(data,product),priorityCandidateIds=pending.filter(row=>needsEntityReview(product,row)).map(row=>row.id);
  const targeted=new Set(priorityCandidateIds);
  const candidates=pending.map(row=>analysisCandidate(row,{profileHash,version:targeted.has(row.id)?`${version}:entity-review-v1`:version}));
  const claim=claimAnalysisCycleBatch(data,productId,{candidates,priorityCandidateIds,profileHash,version,now,maxBatch:12,manual:true});
  for(const cached of claim.cached||[]) {
    const row=findEvidence(data,product,cached.candidate.id);
    if(row&&cached.result?.decision)saveConversationReview(data,product,row,cached.result.decision,cached.result.generatedAt,cached.result.model);
  }
  if(!claim.batch)return {status:claim.status,blocked:claim.blocked||null,nextRunAt:claim.nextRunAt||claim.cycle?.nextRunAt||null,cycle:claim.cycle||null};
  const definition=STAGE_DEFINITIONS.qualify;
  const input={...definition.input(data,product),asOf:new Date(now).toISOString(),evidence:claim.batch.candidates.map(candidate=>qualificationEvidence(findEvidence(data,product,candidate.id)))};
  if(settings){
    const daily=data.aiBudget?.dailyUsage?.[budgetDay(now)],available=settings.budgetMicroUsd-(daily?.spentMicroUsd||0)-(daily?.reservedMicroUsd||0);
    while(input.evidence.length>1){
      const cost=stageReservation('qualify',input);
      if(cost<=available&&!pilotBudgetBlock(data,'aiMicroUsd',cost))break;
      input.evidence.pop();
    }
    if(input.evidence.length<claim.batch.candidates.length)claim.batch=resizeAnalysisCycleBatch(data,productId,claim.batch.id,input.evidence.length,{now});
  }
  const inputHash=hash([PIPELINE_VERSION,'qualify',definition.promptVersion,input]);
  const lease={token:randomUUID(),kind:'pipeline-stage',productId,stage:'qualify',inputHash,stageReservationMicroUsd:stageReservation('qualify',input),expiresAt:now+120000,qualificationInput:input,qualificationProfileHash:profileHash,analysisCycleBatchId:claim.batch.id};
  try{if(settings)reserveAnalysis(data,lease,settings,now);}
  catch(error){const cycle=releaseAnalysisCycleBatch(data,productId,claim.batch.id,error,{now});return {status:'blocked',blocked:cycle?.blocked||{message:error.message,status:error.status},cycle};}
  data.analysisLeases[lease.token]=lease;
  return {lease:structuredClone(lease),input:structuredClone(input)};
}

export function claimStage(data,productId,stage,settings,refresh,now,expectedVersion,videoLibrary){
  retireAnalysis(data,now);
  data.analysisLeases ||= {};
  if(data.subscription&&stage==='qualify'){
    if(Object.values(data.analysisLeases).some(l=>l.productId===productId))problem('A stage is already running for this business.',409);
    return claimProvisionedQualification(data,productId,settings,now);
  }
  const context=stageContext(data,productId,stage,stage==='videos'?videoLibrary:undefined),cached=data.pipelineStages?.[productId]?.[stage];
  if(stage!=='qualify'&&!refresh&&cached&&!cached.imported&&cached.inputHash===context.inputHash&&Date.parse(cached.generatedAt)>now-30*86400000)return {cached:structuredClone(cached)};
  if(stage==='videos'&&cached&&expectedVersion!==videoEditVersion(cached))problem('The saved video batch changed. Refresh before regenerating.',409);
  if(data.subscription){assertSubscriptionActive(data,now);if(!activeProduct(context.product)||context.product.planMonitoringBlocked)throw planError('This product is outside the active plan capacity.',{status:403,code:context.product.planMonitoringBlocked||'product_archived'});}
  data.analysisLeases ||= {};
  if(Object.values(data.analysisLeases).some(l=>l.productId===productId))problem('A stage is already running for this business.',409);
  const day=budgetDay(now);data.analysisUsage ||= {};
  if(stage!=='qualify'&&(data.analysisUsage[day]||0)>=ANALYSIS_DAILY_LIMIT)problem('The daily analysis request limit has been reached.',429);
  const lease={token:randomUUID(),kind:'pipeline-stage',productId,stage,inputHash:context.inputHash,stageReservationMicroUsd:stageReservation(stage,context.input),expiresAt:now+120000};
  if(stage==='videos'){lease.videoLibrary=context.input.videoLibrary;if(cached)lease.priorVideoVersion=videoEditVersion(cached);}
  if(stage==='qualify'){lease.qualificationInput=context.input;lease.qualificationProfileHash=qualificationInputHash(context.product);}
  if(settings)reserveAnalysis(data,lease,settings,now);
  data.analysisLeases[lease.token]=lease;if(stage!=='qualify')data.analysisUsage[day]=(data.analysisUsage[day]||0)+1;
  return {lease:structuredClone(lease),input:structuredClone(context.input)};
}
export function finishStage(data,lease,result,now){
  const saved=data.analysisLeases?.[lease.token];
  if(!saved||saved.expiresAt<=now||saved.kind!=='pipeline-stage')problem('This stage expired. Run it again.',409);
  if(saved.stage==='videos'&&saved.priorVideoVersion!== (data.pipelineStages?.[saved.productId]?.videos?videoEditVersion(data.pipelineStages[saved.productId].videos):undefined))problem('The video batch changed during generation. Refresh before trying again.',409);
  let context;
  if(saved.stage==='qualify'){
    const product=data.products.find(p=>p.id===saved.productId);
    if(!product||product.listeningVersion!=='v2'||qualificationInputHash(product)!==saved.qualificationProfileHash||saved.qualificationInput.evidence.some(old=>{const current=findEvidence(data,product,old.id);return !current||hash(qualificationEvidence(current))!==hash(old);}))problem('Stage inputs changed while it was running. Refresh and try again.',409);
    context={product,input:saved.qualificationInput,inputHash:saved.inputHash,definition:STAGE_DEFINITIONS.qualify};
  }else context=stageContext(data,saved.productId,saved.stage,saved.stage==='videos'?saved.videoLibrary:undefined);
  if(context.inputHash!==saved.inputHash)problem('Stage inputs changed while it was running. Refresh and try again.',409);
  const validated=saved.stage==='qualify'?validateQualificationBatch(result.value,context.product,context.input):null;
  const output=validated?{results:validated.results}:context.definition.validate(result.value,context.product,context.input);
  const record={version:PIPELINE_VERSION,stage:saved.stage,inputHash:saved.inputHash,generatedAt:new Date(now).toISOString(),model:result.model,data:output,...(saved.stage==='videos'?{videoLibrary:context.input.videoLibrary}:{})};
  data.pipelineStages ||= {};data.pipelineStages[saved.productId] ||= {};if(!validated||validated.results.length)data.pipelineStages[saved.productId][saved.stage]=record;
  if(validated)for(const failure of validated.failed)recordReviewFailure(data,context.product,findEvidence(data,context.product,failure.evidenceId),failure.reason,record.generatedAt);
  if(validated?.failed.length)record.failed=validated.failed;
  if(saved.stage==='qualify')for(const decision of output.results){
    saveConversationReview(data,context.product,findEvidence(data,context.product,decision.evidenceId),decision,record.generatedAt,result.model);
  }
  if(saved.analysisCycleBatchId){
    const outcomes=Object.fromEntries(output.results.map(decision=>[decision.evidenceId,{status:'success',result:{decision,generatedAt:record.generatedAt,model:result.model}}]));
    for(const failure of validated.failed)outcomes[failure.evidenceId]={status:'failed'};
    finishAnalysisCycleBatch(data,saved.productId,saved.analysisCycleBatchId,outcomes,{now});
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

export function saveVideos(data,productId,value){
 const current=stageContext(data,productId,'videos'),next=stageContext(data,productId,'videos',value?.videoLibrary);
 return saveVideoEdits(data,productId,value,{...next,inputHash:current.inputHash,nextInputHash:next.inputHash});
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
  if(saved.analysisCycleBatchId)finishAnalysisCycleBatch(data,saved.productId,saved.analysisCycleBatchId,Object.fromEntries(saved.qualificationInput.evidence.map(source=>[source.id,{status:Number.isSafeInteger(costMicroUsd)?'failed':'uncertain'}])),{now});
  settleAnalysis(data,saved,costMicroUsd);delete data.analysisLeases[lease.token];
}
