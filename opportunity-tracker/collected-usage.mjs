import {createHash} from 'node:crypto';
import {sourceIdentity} from './incremental.mjs';
import {planFor} from './plans.mjs';
import {monthlyPeriod} from './usage.mjs';

const key=row=>{const id=sourceIdentity(row);return id?createHash('sha256').update(id).digest('hex'):null;};
const rows=data=>[...(data.items||[]),...['conversationEvidence','conversationReviewQueue'].flatMap(field=>Object.entries(data[field]||{}).flatMap(([productId,values])=>values.map(row=>({...row,productId}))))];
const bucket=()=>({identities:{},holds:{}});
function state(data,now){
 if(data.collectedUsage)return data.collectedUsage;
 const s=data.collectedUsage={version:1,seen:{},monthly:{},historical:{},claims:{}};
 const period=monthlyPeriod(now),current=s.monthly[period.key]={...bucket(),resetAt:period.resetAt};
 for(const row of rows(data)){
  const id=key(row);if(!id)continue;s.seen[id]=true;
  if(row.historical&&row.productId)(s.historical[row.productId]||=bucket()).identities[id]=true;
  else {const stamp=Date.parse(row.foundAt||row.collectedAt||row.lastSeenAt);if(stamp>=Date.parse(period.startsAt)&&stamp<Date.parse(period.resetAt))current.identities[id]=true;}
 }
 return s;
}
function target(data,productId,historical,now){
 const s=state(data,now),p=planFor(data),period=monthlyPeriod(now);
 const id=historical?productId:period.key;
 const b=historical?(s.historical[id]||=bucket()):(s.monthly[id]||={...bucket(),resetAt:period.resetAt});
 return {s,b,id,historical,limit:historical?p.history.collectedAllowancePerProduct:p.limits.monthlyCollectedMentions};
}
export function collectedQuotaBlock(data,productId,historical,count=100,now=Date.now()){
 if(!data.subscription)return null;
 const {b,limit}=target(data,productId,historical,now),used=Object.keys(b.identities).length,reserved=Object.values(b.holds).reduce((a,b)=>a+b,0);
 return used+reserved+count>limit?{code:historical?'historical_collection_quota':'monthly_collection_quota',limit,used,reserved,resetAt:b.resetAt||null}:null;
}
export function reserveCollectedQuota(data,request,now=Date.now()){
 if(!data.subscription)return;
 const historical=request.mode==='backfill',count=100,block=collectedQuotaBlock(data,request.productId,historical,count,now);
 if(block)throw Object.assign(new Error('Collected conversation allowance is exhausted.'),{status:429,...block});
 const {s,b,id}=target(data,request.productId,historical,now);
 b.holds[request.token]=count;s.claims[request.token]={bucket:id,historical,status:'reserved',productId:request.productId};
}
export function settleCollectedQuota(data,request,outcome){
 const s=data.collectedUsage,c=s?.claims?.[request.token];if(!c||c.status!=='reserved')return;
 const b=(c.historical?s.historical:s.monthly)[c.bucket];
 // An ambiguous dispatch keeps its full raw-result hold, independently of the
 // monetary receipt. A complete response or confirmed zero-cost failure can settle.
 if(!outcome.result&&!(outcome.error&&outcome.credits===0)){c.status='uncertain';return;}
 delete b.holds[request.token];c.status='settled';
 const retained=new Set(rows(data).filter(row=>row.productId===c.productId).map(key).filter(Boolean));
 for(const row of outcome.result?.rows||[]){
  const id=key(row);if(!id||!retained.has(id))continue;
  if(c.historical)b.identities[id]=true;
  else if(!s.seen[id])b.identities[id]=true;
  s.seen[id]=true;
 }
}
export function collectedUsageState(data,now=Date.now()){
 if(!data.subscription)return null;
 const copy=structuredClone(data),s=state(copy,now),p=planFor(data),period=monthlyPeriod(now);
 const summary=(b,limit)=>{const used=Object.keys(b?.identities||{}).length,reserved=Object.values(b?.holds||{}).reduce((a,b)=>a+b,0);return {limit,used,reserved,remaining:Math.max(0,limit-used-reserved)};};
 return {monthly:{period:period.key,resetAt:period.resetAt,...summary(s.monthly[period.key],p.limits.monthlyCollectedMentions)},historical:Object.fromEntries(Object.entries(s.historical).map(([id,b])=>[id,summary(b,p.history.collectedAllowancePerProduct)]))};
}
