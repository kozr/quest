import {CONVERSATION_MATCH_RULES} from './keyword-mention.mjs';
import {privateConversationReadViews} from './conversation-pages.mjs';
import {analysisUsageState,monthlyPeriod} from './usage.mjs';
import {collectedUsageState} from './collected-usage.mjs';
import {collectionPublicState,collectionPlanState} from './collection.mjs';
import {analysisCycleState} from './analysis-cycles.mjs';
import {evidenceFor,failedEvidenceCount,pendingEvidenceCount,relevantEvidence} from './conversation-evidence.mjs';
import {listeningReady} from './search-plan.mjs';
import {discoverySummary} from './discovery-progress.mjs';
import {REVIEW_BATCH_LIMIT} from './conversation-evidence.mjs';

export const WORKSPACE_READ_VIEW_VERSION=1;
// Derived views contain only public projections and small clock-sensitive seeds.
// The original state, usage receipts and immutable storage format stay intact.
export function workspaceReadViews(data){
  if(data.workspace||!data.subscription)return null;
  const views=privateConversationReadViews(data);
  const names=['version','products','subscription','searches','loopSchedules','analysisUsage','aiBudget','analysisLeases','leases','pilotBudget'];
  const seed=Object.fromEntries(names.filter(name=>data[name]!==undefined).map(name=>[name,data[name]]));
  seed.items=[];seed.collection={overrun:Boolean(data.collection?.overrun),daily:data.collection?.daily||{},apifyDaily:data.collection?.apifyDaily||{}};
  const counts={},productCounts=Object.fromEntries(data.products.map(p=>[p.id,{}]));
  for(const q of Object.values(data.qualifications||{})){counts[q.status]=(counts[q.status]||0)+1;const p=productCounts[q.productId]||={};p[q.status]=(p[q.status]||0)+1;}
  const analysisPeriods=Object.fromEntries(Object.keys(data.usage?.periods||{}).map(period=>[period,analysisUsageState(data,Date.parse(`${period}-15T12:00:00Z`)).monthly]));
  const collectedPeriods=Object.fromEntries(Object.keys(data.collectedUsage?.monthly||{}).map(period=>[period,collectedUsageState(data,Date.parse(`${period}-15T12:00:00Z`)).monthly]));
  const collection=collectionPublicState(data),analysis=analysisUsageState(data);
  collectedPeriods[collection.collectedUsage.monthly.period]=collection.collectedUsage.monthly;
  const summary={schema:WORKSPACE_READ_VIEW_VERSION,matchRules:CONVERSATION_MATCH_RULES,seed,counts,productCounts,analysisPeriods,analysisHistorical:analysis.historical,collectedPeriods,collectedHistorical:collection.collectedUsage.historical,
    collection,collectionDaily:data.collection?.daily||{},apifyDaily:data.collection?.apifyDaily||{},total:data.items?.length||0,
    cycles:Object.fromEntries(data.products.map(p=>[p.id,analysisCycleState(data,p.id)])),
    pipeline:Object.fromEntries(data.products.map(p=>[p.id,{ready:listeningReady(p),retained:evidenceFor(data,p).length,batchSize:REVIEW_BATCH_LIMIT,failed:failedEvidenceCount(data,p),pending:pendingEvidenceCount(data,p),relevant:relevantEvidence(data,p).length}])),
    discovery:Object.fromEntries(data.products.map(p=>[p.id,discoverySummary(data,p)]))};
  // JSON string packs scalars into a handful of nodes instead of hundreds of
  // tiny records. Schema and current-root binding are validated on every read.
  views.summary=JSON.stringify(summary);return views;
}
export function readWorkspaceSummary(value){
  if(value===null)return null;
  const summary=JSON.parse(value);
  if(summary.schema!==WORKSPACE_READ_VIEW_VERSION||summary.seed.workspace||!summary.seed.subscription)throw Object.assign(new Error('Unsupported workspace read view.'),{status:503});
  if(summary.matchRules!==CONVERSATION_MATCH_RULES)return null;
  return summary;
}
export function summaryUsage(summary,now=Date.now()){
  const period=monthlyPeriod(now),base=analysisUsageState(summary.seed,now);
  return {...base,monthly:summary.analysisPeriods[period.key]||base.monthly,historical:summary.analysisHistorical};
}
export function summaryCollection(summary,day,now=Date.now(),settings={}){
  const period=monthlyPeriod(now),base=collectedUsageState(summary.seed,now),collection=structuredClone(summary.collection),budget=summary.apifyDaily[day]||{};
  for(const [id,cycle] of Object.entries(collection.cycles))cycle.schedules=collectionPlanState(summary.seed,id,now);
  return {...collection,day,budget:summary.collectionDaily[day]||{},collectedUsage:{monthly:summary.collectedPeriods[period.key]||base.monthly,historical:summary.collectedHistorical},apify:{...collection.apify,budget,dailyLimitMicroUsd:settings.apifyDailyLimitMicroUsd},commentSearch:{...collection.commentSearch,budget,dailyLimitMicroUsd:settings.commentDailyLimitMicroUsd}};
}
