import {currentConversationRelevant,pendingEvidenceCount} from './conversation-evidence.mjs';
import {listeningReady} from './search-plan.mjs';
import {budgetDay} from './qualification.mjs';
import {ANALYSIS_DAILY_LIMIT} from './analysis.mjs';
import {stageContext} from './pipeline-stages.mjs';
import {stageReservation} from './pipeline-provider.mjs';

export function discoveryProgress(data,product,{settings,available=true,now=Date.now()}={}){
  const jobs=[data.collection?.cycles?.[product.id],data.collection?.backfills?.[product.id]].filter(Boolean);
  const pending=product.listeningVersion==='v2'?pendingEvidenceCount(data,product):Object.values(data.qualifications||{}).filter(q=>q.productId===product.id&&['pending','running'].includes(q.status)).length;
  const reviewing=Object.values(data.analysisLeases||{}).some(l=>l.productId===product.id&&l.stage==='qualify'&&l.expiresAt>now);
  const active=jobs.some(j=>['running','reviewing'].includes(j.status))||pending>0||reviewing;
  const usage=data.aiBudget?.dailyUsage?.[budgetDay(now)]||{};
  const reservation=product.listeningVersion==='v2'&&pending&&listeningReady(product)?stageReservation('qualify',stageContext(data,product.id,'qualify').input):0;
  const allowance=product.listeningVersion!=='v2'&&(data.analysisUsage?.[budgetDay(now)]||0)>=ANALYSIS_DAILY_LIMIT||settings&&(data.aiBudget?.overrun||(usage.calls||0)>=settings.dailyMaxCalls||(usage.spentMicroUsd||0)+(usage.reservedMicroUsd||0)+reservation>settings.budgetMicroUsd);
  let phase=active?'finding':'idle',reason=null;
  if(active&&(!listeningReady(product)||data.aiBudget?.overrun||data.collection?.overrun||jobs.some(j=>['search_plan_needs_review','storage_capacity','qualification_history_full'].includes(j.blocked)))){phase='paused';reason='setup';}
  else if(active&&!reviewing&&(jobs.some(j=>['running','reviewing'].includes(j.status)&&j.blocked==='daily_scraper_budget')||pending&&allowance)){phase='paused';reason='allowance';}
  else if(pending&&(!available||settings&&!settings.active)){phase='paused';reason='unavailable';}
  const results=data.items.filter(i=>i.productId===product.id&&i.status!=='dismissed'&&currentConversationRelevant(data,i));
  const updatedAt=[...jobs.map(j=>j.finishedAt),...results.map(i=>i.lastSeenAt)].filter(Boolean).sort().at(-1)||null;
  return {phase,reason,ready:results.length,directFits:results.filter(i=>i.qualification?.directFit===true).length,updatedAt,partial:jobs.some(j=>(j.errors||[]).length>0)};
}
