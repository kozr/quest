import {createHash} from 'node:crypto';
import {conversationSourceKey} from './conversation-evidence.mjs';

const string=value=>typeof value==='string'?value:'';
function identity(productId,row){
  if(typeof productId!=='string'||!productId||typeof row?.url!=='string')return null;
  try {const url=new URL(row.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;}catch{return null;}
  return JSON.stringify([productId,conversationSourceKey(row.url)]);
}
function fingerprint(row){
  const date=Date.parse(row.publishedAt),publishedAt=Number.isFinite(date)?new Date(date).toISOString():null;
  // Never trust an imported contentHash or qualification receipt. Provenance
  // requires the actual original evidence, including attribution and context.
  return createHash('sha256').update(JSON.stringify([string(row.title),string(row.text??row.snippet),string(row.context),typeof row.author==='string'?row.author:null,publishedAt])).digest('hex');
}
function visit(data,each){
  for(const row of data.items||[])each(row.productId,row);
  for(const name of ['conversationEvidence','conversationReviewQueue'])for(const [productId,rows]of Object.entries(data[name]||{}))if(Array.isArray(rows))for(const row of rows)each(productId,row);
}

// Backfill identifiers are attribution, not user-authored evidence. A restore
// may retain existing attribution for the exact same source, but cannot mint
// historical AI allowance by naming a server-created backfill run.
export function restoreSourceProvenance(current,incoming){
  const trusted=new Map();
  visit(current,(productId,row)=>{
    const source=identity(productId,row);if(!source)return;
    const key=JSON.stringify([source,fingerprint(row)]),existing=trusted.get(key);
    if(!existing||row.historical===true)trusted.set(key,row);
  });
  const result=structuredClone(incoming);
  visit(result,(productId,row)=>{
    const source=identity(productId,row),prior=source?trusted.get(JSON.stringify([source,fingerprint(row)])):null;
    delete row.backfillId;delete row.backfillIds;delete row.historicalAllowanceBackfillId;delete row.allowanceAttribution;
    row.historical=prior?.historical===true;
    if(!row.historical)return;
    if(typeof prior.historicalAllowanceBackfillId==='string'&&prior.allowanceAttribution?.kind==='saved-archive-adoption'&&prior.allowanceAttribution.jobId===prior.historicalAllowanceBackfillId){
      row.historicalAllowanceBackfillId=prior.historicalAllowanceBackfillId;row.allowanceAttribution=structuredClone(prior.allowanceAttribution);
    }
    if(typeof prior.backfillId==='string'&&prior.backfillId)row.backfillId=prior.backfillId;
    if(Array.isArray(prior.backfillIds))row.backfillIds=[...new Set(prior.backfillIds.filter(id=>typeof id==='string'&&id))];
  });
  return result;
}
