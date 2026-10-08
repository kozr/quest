import {conversationSignals,commentThreadPriority} from './conversation-purpose.mjs';
import {hash,problem,string,array,oneOf} from './pipeline-contract.mjs';
import {publicUrl} from './metadata.mjs';

export const EVIDENCE_LIMIT=120;
export const REVIEW_BATCH_LIMIT=12;
export const REVIEW_QUEUE_LIMIT=150,REVIEW_WORKSPACE_LIMIT=600;
export const QUALIFY_PIPELINE_VERSION='listening-qualification-v3';
export const qualificationInputHash=product=>hash([QUALIFY_PIPELINE_VERSION,product.businessProfileV2,product.searchPlanV2,product.aliases||[],product.competitorNames||[]]);
export function qualificationEvidence(row){return Object.fromEntries(['id','url','title','text','author','community','threadId','type','source','publishedAt','discussionClosed','crosspost','context'].map(k=>[k,row[k]]));}
export function captureEvidence(data,product,rows,at){
  if(product.listeningVersion!=='v2')return;
  data.conversationEvidence ||= {};
  const saved=data.conversationEvidence[product.id] ||= [];
  data.conversationReviewQueue ||= {};const queue=data.conversationReviewQueue[product.id] ||= [];
  // Protect unreviewed samples from every business before shared sample eviction.
  for(const p of data.products.filter(p=>p.listeningVersion==='v2')){
    const pending=data.conversationReviewQueue[p.id] ||= [];
    for(const old of evidenceFor(data,p))if(old.qualification?.profileHash!==qualificationInputHash(p)&&!pending.some(r=>r.id===old.id)){
      if(pending.length>=REVIEW_QUEUE_LIMIT||Object.values(data.conversationReviewQueue).reduce((n,rs)=>n+rs.length,0)>=REVIEW_WORKSPACE_LIMIT)problem('Conversation review is catching up. Try collecting again shortly.',409);
      pending.push(structuredClone(old));
    }
  }
  for(const row of rows){
    let url;try{url=new URL(publicUrl(row.url));}catch{continue;}
    if(!/(^|\.)(reddit\.com|x\.com|twitter\.com|linkedin\.com)$/.test(url.hostname))continue;
    url.search='';url.hash='';
    const thread=url.pathname.match(/\/comments\/([a-z0-9]+)/i)?.[1];
    const author=typeof row.author==='string'?row.author.slice(0,120):null;
    const title=String(row.title||'').slice(0,500),text=String(row.snippet||'').slice(0,2200);
    const context=typeof row.context==='string'?row.context.slice(0,1500):'';
    const id=hash([product.id,url.href]).slice(0,24),prior=findEvidence(data,product,id),contentHash=hash(context?[title,text,context]:[title,text]);
    const receipt=data.conversationReviewReceipts?.[product.id]?.[id],item=data.items.find(i=>i.productId===product.id&&canonicalSourceUrl(i.url)===url.href);
    const previous=prior?.qualification||receipt?.qualification||item?.qualification;
    const previousHash=prior?.qualification?prior.contentHash:receipt?.contentHash||item?.qualification?.contentHash;
    const record={id,url:url.href,title,text,...(context?{context}:{}),author,community:url.pathname.match(/\/r\/([^/]+)/i)?.[1]?.toLowerCase()||String(row.community||row.subreddit||'').replace(/^r\//,'').toLowerCase().slice(0,21)||null,
      threadId:thread?`reddit:${thread}`:String(row.postId||row.parentId||url.href),type:row.type==='comment'?'comment':'post',source:String(row.source||'').slice(0,80),publishedAt:Number.isFinite(Date.parse(row.publishedAt))?new Date(row.publishedAt).toISOString():null,
      collectedAt:at,historical:row.historical===true||prior?.historical===true,discussionClosed:row.discussionClosed===true,crosspost:row.crosspost===true||Boolean(row.crosspostParent||row.crosspost_parent),contentHash,
      queryIds:[...new Set([...(prior?.queryIds||[]),...(row.queryId?[row.queryId]:[])])].slice(0,12),
      ...(previousHash===contentHash&&previous?{qualification:previous}:{})};
    const queued=queue.findIndex(r=>r.id===id);
    if(record.qualification?.profileHash!==qualificationInputHash(product)){
      if(queued>=0)queue[queued]={...record,collectedAt:queue[queued].collectedAt};
      else {if(queue.length>=REVIEW_QUEUE_LIMIT||Object.values(data.conversationReviewQueue).reduce((n,rows)=>n+rows.length,0)>=REVIEW_WORKSPACE_LIMIT)problem('Conversation review is catching up. Try collecting again shortly.',409);queue.push(record);}
    }else if(queued>=0)queue.splice(queued,1);
    const index=saved.findIndex(r=>r.id===id);if(index>=0)saved.splice(index,1);saved.unshift(record);
  }
  saved.sort((a,b)=>b.collectedAt.localeCompare(a.collectedAt));saved.splice(EVIDENCE_LIMIT);
  trimEvidence(data);
}
function trimEvidence(data){
  const all=Object.entries(data.conversationEvidence).flatMap(([p,rs])=>rs.map(r=>({p,r}))).sort((a,b)=>b.r.collectedAt.localeCompare(a.r.collectedAt));
  for(const {p,r} of all.slice(600))data.conversationEvidence[p]=data.conversationEvidence[p].filter(x=>x.id!==r.id);
  for(const {p,r} of all.slice(0,600).reverse()){if(Buffer.byteLength(JSON.stringify(data.conversationEvidence))<=2000000)break;data.conversationEvidence[p]=data.conversationEvidence[p].filter(x=>x.id!==r.id);}
}
export function evidenceFor(data,product){return data.conversationEvidence?.[product.id]||[];}
export function findEvidence(data,product,id){return data.conversationReviewQueue?.[product.id]?.find(r=>r.id===id)||evidenceFor(data,product).find(r=>r.id===id);}
function unqualifiedEvidence(data,product){const h=qualificationInputHash(product),rows=new Map();for(const r of [...(data.conversationReviewQueue?.[product.id]||[]),...evidenceFor(data,product)])if(r.qualification?.profileHash!==h&&!rows.has(r.id))rows.set(r.id,r);const priority=row=>Math.max(commentThreadPriority(product,row),row.type==='comment'&&row.context&&commentThreadPriority(product,{text:row.context})>=3?3:0);return [...rows.values()].sort((a,b)=>priority(b)-priority(a)||a.collectedAt.localeCompare(b.collectedAt)||a.id.localeCompare(b.id));}
export function pendingEvidence(data,product){return unqualifiedEvidence(data,product).slice(0,REVIEW_BATCH_LIMIT);}
export function pendingEvidenceCount(data,product){return unqualifiedEvidence(data,product).length;}
export function reviewQueueBlock(data,product){
  if(product.listeningVersion!=='v2')return null;
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
  row.qualification={...decision,profileHash:qualificationInputHash(product),qualifiedAt:at};
  data.conversationReviewQueue ||= {};data.conversationReviewQueue[product.id]=(data.conversationReviewQueue[product.id]||[]).filter(r=>r.id!==row.id);
  data.conversationEvidence ||= {};const sample=data.conversationEvidence[product.id] ||= [];
  const index=sample.findIndex(r=>r.id===row.id);if(index>=0)sample.splice(index,1);sample.unshift(structuredClone(row));sample.splice(EVIDENCE_LIMIT);trimEvidence(data);
  data.conversationReviewReceipts ||= {};const history=data.conversationReviewReceipts[product.id] ||= {};
  history[row.id]={contentHash:row.contentHash,qualification:row.qualification};
  for(const id of Object.keys(history).slice(0,Math.max(0,Object.keys(history).length-1500)))delete history[id];
  const receipts=Object.entries(data.conversationReviewReceipts).flatMap(([p,rs])=>Object.entries(rs).map(([id,r])=>({p,id,at:r.qualification.qualifiedAt}))).sort((a,b)=>a.at.localeCompare(b.at));
  let count=receipts.length;
  for(const r of receipts){if(count<=1500&&Buffer.byteLength(JSON.stringify(data.conversationReviewReceipts))<=2000000)break;delete data.conversationReviewReceipts[r.p][r.id];count--;}
  const existing=data.items.find(i=>i.productId===product.id&&canonicalSourceUrl(i.url)===canonicalSourceUrl(row.url));
  if(decision.relevant){
    const item={...existing,id:existing?.id||hash([product.id,row.url]).slice(0,24),productId:product.id,url:row.url,title:row.title,snippet:row.text,context:row.context||'',author:row.author,source:row.source,type:row.type,publishedAt:row.publishedAt,historical:row.historical,discussionClosed:row.discussionClosed,kind:existing?.kind==='mention'?'mention':decision.directFit?'opportunity':'conversation',status:existing?.status||'new',note:existing?.note||'',draft:existing?.draft||'',foundAt:existing?.foundAt||at,lastSeenAt:at,reason:decision.reason,matchedTerms:decision.offeringIds.map(id=>product.businessProfileV2.offerings.find(o=>o.id===id).label),qualification:{model,promptVersion:QUALIFY_PIPELINE_VERSION,contentHash:row.contentHash,...row.qualification}};
    data.items=[item,...data.items.filter(i=>i.id!==item.id)];
  }else if(existing?.qualification)existing.qualification={...existing.qualification,model,promptVersion:QUALIFY_PIPELINE_VERSION,contentHash:row.contentHash,...row.qualification};
}
export function canonicalSourceUrl(value){try{const url=new URL(value);url.search='';url.hash='';return url.href;}catch{return value;}}
export function currentConversationRelevant(data,item){
  const p=data.products.find(p=>p.id===item.productId);if(!p||p.listeningVersion!=='v2')return true;
  const row=findEvidence(data,p,hash([p.id,canonicalSourceUrl(item.url)]).slice(0,24));
  const q=row?row.qualification:item.qualification;
  if(item.kind==='mention'&&!row&&!q)return true;
  return q?.profileHash===qualificationInputHash(p)&&q.relevant===true;
}
export function currentOpportunityFit(data,item){
  const product=data.products.find(p=>p.id===item.productId);
  if(!product||product.listeningVersion!=='v2')return true;
  const row=findEvidence(data,product,hash([product.id,canonicalSourceUrl(item.url)]).slice(0,24)),decision=row?row.qualification:item.qualification;
  return conversationSignals(product,row||item,decision,{current:decision?.profileHash===qualificationInputHash(product)}).some(signal=>signal.purpose==='potential_customer');
}
export function relevantEvidence(data,product){const h=qualificationInputHash(product);return evidenceFor(data,product).filter(x=>x.qualification?.profileHash===h&&x.qualification.relevant);}
export function validateEvidence(value,products,{limit=EVIDENCE_LIMIT,totalLimit=600}={}){
  if(value===undefined)return {};
  if(!value||typeof value!=='object'||Array.isArray(value))problem('Invalid conversation evidence.');
  const result={};let total=0;
  for(const product of products){
    const rows=array(value[product.id]||[],limit);total+=rows.length;
    result[product.id]=rows.map(r=>{
      const url=publicUrl(r.url).href;
      if(!/^[a-f0-9]{24}$/.test(r.id)||!Number.isFinite(Date.parse(r.collectedAt)))problem('Invalid conversation evidence.');
      const title=string(r.title,500,0),text=string(r.text,2200,0),context=string(r.context||'',1500,0);
      // Imported classification is deliberately re-run against the active business.
      return {id:r.id,url,title,text,...(context?{context}:{}),author:r.author===null?null:string(r.author,120,0),community:r.community===null?null:string(r.community,21,0),threadId:string(r.threadId,2048),type:oneOf(r.type,['post','comment']),source:string(r.source,80,0),publishedAt:Number.isFinite(Date.parse(r.publishedAt))?r.publishedAt:null,collectedAt:r.collectedAt,historical:r.historical===true,discussionClosed:r.discussionClosed===true,crosspost:r.crosspost===true,contentHash:hash(context?[title,text,context]:[title,text]),queryIds:array(r.queryIds||[],12).map(x=>string(x,20))};
    });
    if(new Set(result[product.id].map(x=>x.id)).size!==rows.length)problem('Duplicate conversation evidence.');
  }
  if(total>totalLimit)problem('Too many saved conversations.');return result;
}
