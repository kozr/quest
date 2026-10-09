import {canonicalReviewURL} from './review-identity.mjs';
import {needsEntityReview} from './entity-mention.mjs';
import {canonicalSocialSource} from './social-search.mjs';
import {conversationSignals,commentThreadPriority} from './conversation-purpose.mjs';
import {hash,problem,string,array,oneOf} from './pipeline-contract.mjs';
import {publicUrl} from './metadata.mjs';

export const EVIDENCE_LIMIT=120;
export const REVIEW_BATCH_LIMIT=12;
export const REVIEW_QUEUE_LIMIT=150,REVIEW_WORKSPACE_LIMIT=600;
export const QUALIFY_PIPELINE_VERSION='listening-qualification-v3';
export const durableEvidenceEnabled=data=>Boolean(data.subscription);
export const qualificationInputHash=product=>hash([QUALIFY_PIPELINE_VERSION,product.businessProfileV2,product.searchPlanV2,product.aliases||[],product.competitorNames||[]]);
export function qualificationEvidence(row){
  const value=Object.fromEntries(['id','url','title','text','author','community','threadId','type','source','publishedAt','discussionClosed','crosspost','context','postId','parentId','businessReview'].map(k=>[k,row[k]]));
  // Preserve source text in storage. Only the AI request receives an excerpt.
  if(row.retention==='durable')Object.assign(value,{title:String(row.title||'').slice(0,500),text:String(row.text||'').slice(0,2200),context:String(row.context||'').slice(0,1500),sourceContentHash:row.contentHash,sourceTextTruncated:String(row.title||'').length>500||String(row.text||'').length>2200||String(row.context||'').length>1500});
  return value;
}
export function captureEvidence(data,product,rows,at){
  if(durableEvidenceEnabled(data))return captureDurableEvidence(data,product,rows,at);
  if(product.listeningVersion!=='v2')return;
  data.conversationEvidence ||= {};
  const saved=data.conversationEvidence[product.id] ||= [];
  data.conversationReviewQueue ||= {};const queue=data.conversationReviewQueue[product.id] ||= [];
  // Protect unreviewed samples from every business before shared sample eviction.
  for(const p of data.products.filter(p=>p.listeningVersion==='v2')){
    const pending=data.conversationReviewQueue[p.id] ||= [];
    for(const old of evidenceFor(data,p))if(old.qualification?.profileHash!==qualificationInputHash(p)&&!currentReviewFailure(data,p,old)&&!pending.some(r=>r.id===old.id)){
      if(pending.length>=REVIEW_QUEUE_LIMIT||Object.values(data.conversationReviewQueue).reduce((n,rs)=>n+rs.length,0)>=REVIEW_WORKSPACE_LIMIT)problem('Conversation review is catching up. Try collecting again shortly.',409);
      pending.push(structuredClone(old));
    }
  }
  for(const row of rows){
    let url;try{url=new URL(publicUrl(row.url));}catch{continue;}
    const social=canonicalSocialSource(row);
    if(social)url=new URL(social.url);
    else {if(!/(^|\.)(reddit\.com|x\.com|twitter\.com|linkedin\.com)$/.test(url.hostname)&&!canonicalReviewURL(row.url)&&!(row.source==='Web'&&row.contentOrigin==='original_page'))continue;url=new URL(canonicalSourceUrl(url.href));}
    const thread=url.pathname.match(/\/comments\/([a-z0-9]+)/i)?.[1];
    const author=typeof row.author==='string'?row.author.slice(0,120):null;
    const title=String(row.title||'').slice(0,500),text=String(row.snippet||'').slice(0,2200);
    const context=typeof row.context==='string'?row.context.slice(0,1500):'';
    const key=social?social.identity:url.href,prior=evidenceBySource(data,product,url.href),id=prior?.id||hash([product.id,key]).slice(0,24),contentHash=hash(context?[title,text,context]:[title,text]);
    const receipt=data.conversationReviewReceipts?.[product.id]?.[id],item=data.items.find(i=>i.productId===product.id&&conversationSourceKey(i.url)===key);
    const previous=prior?.qualification||receipt?.qualification||item?.qualification;
    const previousHash=prior?.qualification?prior.contentHash:receipt?.contentHash||item?.qualification?.contentHash;
    const record={...sourceProvenance(prior||{}),...sourceProvenance(row),id,url:url.href,title,text,...(context?{context}:{}),author,community:url.pathname.match(/\/r\/([^/]+)/i)?.[1]?.toLowerCase()||String(row.community||row.subreddit||'').replace(/^r\//,'').toLowerCase().slice(0,21)||null,
      threadId:thread?`reddit:${thread}`:String(social?`${social.platform}:${social.post}`:row.postId||row.parentId||url.href),type:row.type==='comment'?'comment':'post',source:String(row.source||'').slice(0,80),publishedAt:Number.isFinite(Date.parse(row.publishedAt))?new Date(row.publishedAt).toISOString():null,
      collectedAt:at,historical:row.historical===true||prior?.historical===true,discussionClosed:row.discussionClosed===true,crosspost:row.crosspost===true||Boolean(row.crosspostParent||row.crosspost_parent),contentHash,
      queryIds:[...new Set([...(prior?.queryIds||[]),...(row.queryId?[row.queryId]:[])])].slice(0,12),
      ...(previousHash===contentHash&&previous?{qualification:previous}:{})};
    const queued=queue.findIndex(r=>r.id===id);
    if(record.qualification?.profileHash!==qualificationInputHash(product)&&!currentReviewFailure(data,product,record)){
      if(queued>=0)queue[queued]={...record,collectedAt:queue[queued].collectedAt};
      else {if(queue.length>=REVIEW_QUEUE_LIMIT||Object.values(data.conversationReviewQueue).reduce((n,rows)=>n+rows.length,0)>=REVIEW_WORKSPACE_LIMIT)problem('Conversation review is catching up. Try collecting again shortly.',409);queue.push(record);}
    }else if(queued>=0)queue.splice(queued,1);
    const index=saved.findIndex(r=>r.id===id);if(index>=0)saved.splice(index,1);saved.unshift(record);
  }
  saved.sort((a,b)=>b.collectedAt.localeCompare(a.collectedAt));saved.splice(EVIDENCE_LIMIT);
  trimEvidence(data);
}
function captureDurableEvidence(data,product,rows,at){
  data.conversationEvidence ||= {};data.conversationReviewQueue ||= {};
  const saved=new Map([...(data.conversationReviewQueue[product.id]||[]),...(data.conversationEvidence[product.id]||[])].map(row=>[row.id,row]));
  const bySource=new Map([...saved.values()].map(row=>[conversationSourceKey(row.url),row]));
  const itemBySource=new Map(data.items.filter(item=>item.productId===product.id).map(item=>[conversationSourceKey(item.url),item]));
  for(const row of rows){
    let url;try{url=new URL(publicUrl(row.url));}catch{continue;}
    const social=canonicalSocialSource(row);
    if(social)url=new URL(social.url);
    else {if(!/(^|\.)(reddit\.com|x\.com|twitter\.com|linkedin\.com)$/.test(url.hostname)&&!canonicalReviewURL(row.url)&&!(row.source==='Web'&&row.contentOrigin==='original_page'))continue;url=new URL(canonicalSourceUrl(url.href));}
    const key=social?social.identity:url.href,prior=bySource.get(key),id=prior?.id||hash([product.id,key]).slice(0,24);
    const title=String(row.title||''),text=String(row.snippet??row.text??''),context=typeof row.context==='string'?row.context:'';
    const contentHash=hash(context?[title,text,context]:[title,text]);
    const receipt=data.conversationReviewReceipts?.[product.id]?.[id],item=itemBySource.get(key);
    const previous=prior?.qualification||receipt?.qualification||item?.qualification;
    const previousHash=prior?.qualification?prior.contentHash:receipt?.contentHash||item?.qualification?.contentHash;
    const thread=url.pathname.match(/\/comments\/([a-z0-9]+)/i)?.[1];
    const queryIds=[...new Set([...(prior?.queryIds||[]),...(row.queryId?[row.queryId]:[]),...(row.queryIds||[])])];
    const queryFamilies=[...new Set([...(prior?.queryFamilies||[]),...(row.queryFamily?[row.queryFamily]:[]),...(row.queryFamilies||[])])];
    const backfillIds=[...new Set([...(prior?.backfillIds||[]),...(prior?.backfillId?[prior.backfillId]:[]),...(row.backfillId?[row.backfillId]:[])])];
    const allowanceSource=prior?.contentHash===contentHash?prior:item?.qualification?.contentHash===contentHash?item:null;
    const allowance=allowanceSource?.historicalAllowanceBackfillId&&allowanceSource?.allowanceAttribution?{historicalAllowanceBackfillId:allowanceSource.historicalAllowanceBackfillId,allowanceAttribution:structuredClone(allowanceSource.allowanceAttribution)}:{};
    const record={...allowance,...sourceProvenance(prior||{}),...sourceProvenance(row),id,url:url.href,title,text,...(context?{context}:{}),retention:'durable',author:typeof row.author==='string'?row.author.slice(0,120):null,
      community:url.pathname.match(/\/r\/([^/]+)/i)?.[1]?.toLowerCase()||String(row.community||row.subreddit||'').replace(/^r\//,'').toLowerCase().slice(0,21)||null,
      threadId:thread?`reddit:${thread}`:String(social?`${social.platform}:${social.post}`:row.postId||row.parentId||url.href),type:row.type==='comment'?'comment':'post',source:String(row.source||'').slice(0,80),publishedAt:Number.isFinite(Date.parse(row.publishedAt))?new Date(row.publishedAt).toISOString():null,
      collectedAt:prior?.collectedAt||at,lastSeenAt:at,historical:row.historical===true||prior?.historical===true,discussionClosed:row.discussionClosed===true,crosspost:row.crosspost===true||Boolean(row.crosspostParent||row.crosspost_parent),contentHash,queryIds,queryFamilies,
      ...(backfillIds.length?{backfillIds,backfillId:row.backfillId||prior?.backfillId||backfillIds[0]}:{}),...(previousHash===contentHash&&previous?{qualification:previous}:{})};
    saved.set(id,record);bySource.set(key,record);
  }
  data.conversationEvidence[product.id]=[...saved.values()];
  // The raw archive is the durable queue. Bounded AI batches select pending rows
  // from it; no second text copy or sample eviction can block fresh collection.
  data.conversationReviewQueue[product.id]=[];
}
function trimEvidence(data){
  if(durableEvidenceEnabled(data))return;
  const all=Object.entries(data.conversationEvidence).flatMap(([p,rs])=>rs.map(r=>({p,r}))).sort((a,b)=>b.r.collectedAt.localeCompare(a.r.collectedAt));
  for(const {p,r} of all.slice(600))data.conversationEvidence[p]=data.conversationEvidence[p].filter(x=>x.id!==r.id);
  for(const {p,r} of all.slice(0,600).reverse()){if(Buffer.byteLength(JSON.stringify(data.conversationEvidence))<=2000000)break;data.conversationEvidence[p]=data.conversationEvidence[p].filter(x=>x.id!==r.id);}
}
export function evidenceFor(data,product){return data.conversationEvidence?.[product.id]||[];}
// Recover only a bounded set of named saved conversations evicted by the old
// sample archive. Read-only synthesis preserves their original review and
// historical flag; it never invents backfill authority or recurring eligibility.
export function savedItemIdentityEvidence(data,product){
  const present=new Set([...(data.conversationEvidence?.[product.id]||[]),...(data.conversationReviewQueue?.[product.id]||[])].map(row=>conversationSourceKey(row.url)));
  return (data.items||[]).filter(item=>item.productId===product.id&&item.url&&!present.has(conversationSourceKey(item.url))&&needsEntityReview(product,item)).slice(0,24).map(item=>{
    const title=String(item.title||''),text=String(item.snippet||''),context=String(item.context||''),contentHash=hash(context?[title,text,context]:[title,text]),thread=new URL(item.url).pathname.match(/\/comments\/([a-z0-9]+)/i)?.[1];
    const id=/^[a-f0-9]{24}$/.test(item.qualification?.evidenceId||'')?item.qualification.evidenceId:hash([product.id,conversationSourceKey(item.url)]).slice(0,24);
    return {...item,id,text,title,context,contentHash,retention:'durable',savedItemIdentityReview:true,threadId:item.threadId||(thread?`reddit:${thread}`:item.postId||item.url),collectedAt:item.collectedAt||item.lastSeenAt||item.foundAt||item.qualification?.qualifiedAt||'1970-01-01T00:00:00.000Z'};
  });
}
export function findEvidence(data,product,id){return data.conversationReviewQueue?.[product.id]?.find(r=>r.id===id)||evidenceFor(data,product).find(r=>r.id===id)||data.conversationReviewFailures?.[product.id]?.[id]?.row||savedItemIdentityEvidence(data,product).find(row=>row.id===id);}

export function currentReviewFailure(data,product,row){const failure=data.conversationReviewFailures?.[product.id]?.[row.id];return failure?.profileHash===qualificationInputHash(product)&&failure.contentHash===row.contentHash?failure:null;}
export function reviewEvidenceFor(data,product){const saved=evidenceFor(data,product),rows=new Map(saved.map(row=>[row.id,row]));for(const failure of Object.values(data.conversationReviewFailures?.[product.id]||{}))if(!rows.has(failure.row.id)&&currentReviewFailure(data,product,failure.row))rows.set(failure.row.id,failure.row);return [...rows.values()].sort((a,b)=>Number(Boolean(currentReviewFailure(data,product,b)))-Number(Boolean(currentReviewFailure(data,product,a))));}
export function failedEvidenceCount(data,product){return reviewEvidenceFor(data,product).filter(row=>currentReviewFailure(data,product,row)).length;}
export function recordReviewFailure(data,product,row,reason,at){
  data.conversationReviewFailures ||= {};const failures=data.conversationReviewFailures[product.id] ||= {};
  failures[row.id]={profileHash:qualificationInputHash(product),contentHash:row.contentHash,failedAt:at,reason:String(reason).slice(0,300),row:structuredClone(row)};
  if(!durableEvidenceEnabled(data))for(const id of Object.keys(failures).slice(0,Math.max(0,Object.keys(failures).length-150)))delete failures[id];
  data.conversationReviewQueue ||= {};data.conversationReviewQueue[product.id]=(data.conversationReviewQueue?.[product.id]||[]).filter(r=>r.id!==row.id);
}
function unqualifiedEvidence(data,product){const h=qualificationInputHash(product),rows=new Map();for(const r of [...(data.conversationReviewQueue?.[product.id]||[]),...evidenceFor(data,product),...savedItemIdentityEvidence(data,product)])if((r.qualification?.profileHash!==h||needsEntityReview(product,r))&&!currentReviewFailure(data,product,r)&&!rows.has(r.id))rows.set(r.id,r);const priority=row=>Math.max(commentThreadPriority(product,row),row.type==='comment'&&row.context&&commentThreadPriority(product,{text:row.context})>=3?3:0);return [...rows.values()].sort((a,b)=>priority(b)-priority(a)||a.collectedAt.localeCompare(b.collectedAt)||a.id.localeCompare(b.id));}
export function pendingEvidenceAll(data,product){return unqualifiedEvidence(data,product);}
export function pendingEvidence(data,product){return pendingEvidenceAll(data,product).slice(0,REVIEW_BATCH_LIMIT);}
export function pendingEvidenceCount(data,product){return unqualifiedEvidence(data,product).length;}
export function reviewQueueBlock(data,product){
  if(product.listeningVersion!=='v2'||durableEvidenceEnabled(data))return null;
  const pending=pendingEvidenceCount(data,product),shared=data.products.filter(p=>p.listeningVersion==='v2').reduce((n,p)=>n+pendingEvidenceCount(data,p),0);
  // Leave room for the largest provider page (100 comments) before dispatch.
  return pending>REVIEW_QUEUE_LIMIT-100||shared>REVIEW_WORKSPACE_LIMIT-100?'awaiting_ai_review':null;
}
export function qualificationDue(data,product,now=Date.now()){
  const rows=unqualifiedEvidence(data,product);if(!rows.length)return false;
  const collecting=[data.collection?.cycles?.[product.id],data.collection?.backfills?.[product.id]].some(j=>j?.status==='running'&&!j.blocked);
  return rows.length>=REVIEW_BATCH_LIMIT||!collecting||now-Date.parse(rows[0].collectedAt)>=60000;
}
export function saveConversationReview(data,product,row,decision,at,model){
  if(data.conversationReviewFailures?.[product.id])delete data.conversationReviewFailures[product.id][row.id];
  row.qualification={...decision,profileHash:qualificationInputHash(product),qualifiedAt:at,...(row.retention==='durable'?{sourceTextTruncated:qualificationEvidence(row).sourceTextTruncated}:{})};
  data.conversationReviewQueue ||= {};data.conversationReviewQueue[product.id]=(data.conversationReviewQueue[product.id]||[]).filter(r=>r.id!==row.id);
  data.conversationEvidence ||= {};const sample=data.conversationEvidence[product.id] ||= [];
  const index=sample.findIndex(r=>r.id===row.id);if(index>=0)sample.splice(index,1);sample.unshift(structuredClone(row));if(!durableEvidenceEnabled(data))sample.splice(EVIDENCE_LIMIT);trimEvidence(data);
  data.conversationReviewReceipts ||= {};const history=data.conversationReviewReceipts[product.id] ||= {};
  history[row.id]={contentHash:row.contentHash,qualification:row.qualification};
  if(!durableEvidenceEnabled(data)){
  for(const id of Object.keys(history).slice(0,Math.max(0,Object.keys(history).length-1500)))delete history[id];
  const receipts=Object.entries(data.conversationReviewReceipts).flatMap(([p,rs])=>Object.entries(rs).map(([id,r])=>({p,id,at:r.qualification.qualifiedAt}))).sort((a,b)=>a.at.localeCompare(b.at));
  let count=receipts.length;
  for(const r of receipts){if(count<=1500&&Buffer.byteLength(JSON.stringify(data.conversationReviewReceipts))<=2000000)break;delete data.conversationReviewReceipts[r.p][r.id];count--;}
  }
  const existing=data.items.find(i=>i.productId===product.id&&conversationSourceKey(i.url)===conversationSourceKey(row.url));
  if(decision.relevant){
    const item={...existing,...sourceProvenance(row),id:existing?.id||hash([product.id,conversationSourceKey(row.url)]).slice(0,24),productId:product.id,url:row.url,title:row.title,snippet:row.text,context:row.context||'',author:row.author,source:row.source,type:row.type,publishedAt:row.publishedAt,historical:row.historical,discussionClosed:row.discussionClosed,kind:existing?.kind==='mention'?'mention':decision.directFit?'opportunity':'conversation',status:existing?.status||'new',note:existing?.note||'',draft:existing?.draft||'',foundAt:existing?.foundAt||at,lastSeenAt:at,reason:decision.reason,matchedTerms:decision.offeringIds.map(id=>product.businessProfileV2.offerings.find(o=>o.id===id).label),qualification:{model,promptVersion:QUALIFY_PIPELINE_VERSION,contentHash:row.contentHash,...row.qualification}};
    if(row.retention==='durable')Object.assign(item,{retention:'durable',queryIds:row.queryIds||[],queryFamilies:row.queryFamilies||[],...(row.backfillId?{backfillId:row.backfillId,backfillIds:row.backfillIds||[row.backfillId]}:{})});
    data.items=[item,...data.items.filter(i=>i.id!==item.id)];
  }else if(existing?.qualification)existing.qualification={...existing.qualification,model,promptVersion:QUALIFY_PIPELINE_VERSION,contentHash:row.contentHash,...row.qualification};
}
function evidenceBySource(data,product,url){const key=conversationSourceKey(url);return [...(data.conversationReviewQueue?.[product.id]||[]),...evidenceFor(data,product),...Object.values(data.conversationReviewFailures?.[product.id]||{}).map(f=>f.row)].find(r=>conversationSourceKey(r.url)===key);}
export function conversationSourceKey(value){const social=canonicalSocialSource({source:'TikTok',url:value})||canonicalSocialSource({source:'Instagram',url:value});return social?.identity||canonicalSourceUrl(value);}
export function canonicalSourceUrl(value){const review=canonicalReviewURL(value);if(review)return review;const social=canonicalSocialSource({source:'TikTok',url:value})||canonicalSocialSource({source:'Instagram',url:value});if(social)return social.url;try{const url=new URL(value);for(const key of [...url.searchParams.keys()])if(/^utm_|^(fbclid|gclid|ref|tracking)$/i.test(key))url.searchParams.delete(key);url.hash='';const match=url.pathname.match(/^\/r\/([a-z0-9_]+)\/comments\/([a-z0-9]+)(?:\/[^/]+)?(?:\/([a-z0-9]+))?\/?$/i);if(/(^|\.)(x\.com|twitter\.com|linkedin\.com)$/.test(url.hostname))url.search='';if(/(^|\.)reddit\.com$/.test(url.hostname)&&match){url.search='';url.hostname='www.reddit.com';url.pathname=`/r/${match[1].toLowerCase()}/comments/${match[2]}/${match[3]?`_/${match[3]}/`:''}`;}return url.href;}catch{return value;}}
export function currentConversationRelevant(data,item){
  const p=data.products.find(p=>p.id===item.productId);if(!p||p.listeningVersion!=='v2')return true;
  const row=evidenceBySource(data,p,item.url);
  const q=row?row.qualification:item.qualification;
  if(item.kind==='mention'&&!row&&!q)return true;
  return q?.profileHash===qualificationInputHash(p)&&q.relevant===true;
}
export function currentOpportunityFit(data,item){
  const product=data.products.find(p=>p.id===item.productId);
  if(!product||product.listeningVersion!=='v2')return true;
  const row=evidenceBySource(data,product,item.url),decision=row?row.qualification:item.qualification;
  return conversationSignals(product,row||item,decision,{current:decision?.profileHash===qualificationInputHash(product)}).some(signal=>signal.purpose==='potential_customer');
}
export function relevantEvidence(data,product){const h=qualificationInputHash(product);return evidenceFor(data,product).filter(x=>x.qualification?.profileHash===h&&x.qualification.relevant);}
export function validateEvidence(value,products,{durable=false,limit=durable?Number.MAX_SAFE_INTEGER:EVIDENCE_LIMIT,totalLimit=durable?Number.MAX_SAFE_INTEGER:600}={}){
  if(value===undefined)return {};
  if(!value||typeof value!=='object'||Array.isArray(value))problem('Invalid conversation evidence.');
  const result={};let total=0;
  for(const product of products){
    const rows=array(value[product.id]||[],limit);total+=rows.length;
    result[product.id]=rows.map(r=>{
      const url=publicUrl(r.url).href;
      if(!/^[a-f0-9]{24}$/.test(r.id)||!Number.isFinite(Date.parse(r.collectedAt)))problem('Invalid conversation evidence.');
      const fullText=value=>{if(typeof value!=='string')problem('Invalid conversation source text.');return value;};
      const title=durable?fullText(r.title):string(r.title,500,0),text=durable?fullText(r.text):string(r.text,2200,0),context=durable?fullText(r.context||''):string(r.context||'',1500,0);
      // Imported classification is deliberately re-run against the active business.
      const provenance=sourceProvenance(r);delete provenance.businessReview; // Imported listing attribution requires provider re-verification.
      return {...provenance,id:r.id,url,title,text,...(context?{context}:{}),...(durable?{retention:'durable',queryFamilies:array(r.queryFamilies||[],1000).map(x=>string(x,100)),backfillIds:array(r.backfillIds||[],1000).map(x=>string(x,100)),...(typeof r.backfillId==='string'?{backfillId:string(r.backfillId,100)}:{})}:{}),author:r.author===null?null:string(r.author,120,0),community:r.community===null?null:string(r.community,21,0),threadId:string(r.threadId,2048),type:oneOf(r.type,['post','comment']),source:string(r.source,80,0),publishedAt:Number.isFinite(Date.parse(r.publishedAt))?r.publishedAt:null,collectedAt:r.collectedAt,historical:r.historical===true,discussionClosed:r.discussionClosed===true,crosspost:r.crosspost===true,contentHash:hash(context?[title,text,context]:[title,text]),queryIds:array(r.queryIds||[],durable?Number.MAX_SAFE_INTEGER:12).map(x=>string(x,100))};
    });
    if(new Set(result[product.id].map(x=>x.id)).size!==rows.length)problem('Duplicate conversation evidence.');
  }
  if(total>totalLimit)problem('Too many saved conversations.');return result;
}

function sourceProvenance(row){const value=Object.fromEntries(['provider','sourceId','postId','parentId','discoverySource','discoveryURL','contentOrigin','sourceLinkKind'].filter(k=>row[k]===null||typeof row[k]==='string'&&row[k].length<=2048).map(k=>[k,row[k]]));if(row.businessReview?.version===1)value.businessReview=structuredClone(row.businessReview);if(Number.isFinite(row.rating))value.rating=row.rating;return value;}
