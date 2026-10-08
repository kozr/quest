import {conversationSignals} from './conversation-purpose.mjs';
import {hash} from './pipeline-contract.mjs';
import {evidenceFor,qualificationInputHash,QUALIFY_PIPELINE_VERSION} from './conversation-evidence.mjs';

function sourceURL(value){try{const url=new URL(value);url.search='';url.hash='';return url.href;}catch{return value;}}
function evidenceForItem(data,product,item){return [...(data.conversationReviewQueue?.[product.id]||[]),...evidenceFor(data,product)].find(row=>sourceURL(row.url)===sourceURL(item.url));}

// Keep a single review record for each source, including relevant unmet needs.
export function syncConversationItems(data,product){
  if(product.listeningVersion!=='v2')return;
  const profileHash=qualificationInputHash(product);
  for(const row of evidenceFor(data,product)){
    const decision=row.qualification;
    if(decision?.profileHash!==profileHash)continue;
    const existing=data.items.find(item=>item.productId===product.id&&sourceURL(item.url)===sourceURL(row.url));
    const qualification={...existing?.qualification,model:existing?.qualification?.model||data.pipelineStages?.[product.id]?.qualify?.model,promptVersion:QUALIFY_PIPELINE_VERSION,contentHash:row.contentHash,...decision};
    if(!decision.relevant){if(existing)existing.qualification=qualification;continue;}
    const item={...existing,id:existing?.id||hash([product.id,row.url]).slice(0,24),productId:product.id,url:row.url,title:row.title,snippet:row.text,context:row.context||'',author:row.author,source:row.source,type:row.type,publishedAt:row.publishedAt,historical:row.historical===true||existing?.historical===true,discussionClosed:row.discussionClosed,
      kind:existing?.kind==='mention'?'mention':decision.directFit?'opportunity':'conversation',...(existing?{}:{status:'new',note:'',draft:'',foundAt:decision.qualifiedAt||row.collectedAt}),lastSeenAt:row.collectedAt,reason:decision.reason,
      matchedTerms:(decision.offeringIds||[]).flatMap(id=>{const offering=product.businessProfileV2.offerings.find(o=>o.id===id);return offering?[offering.label]:[];}),qualification};
    data.items=[item,...data.items.filter(previous=>previous.id!==item.id)];
  }
}

export function conversationCurrentState(data,item){
  const product=data.products.find(p=>p.id===item.productId);
  if(!product)return {};
  if(product.listeningVersion!=='v2')return {};
  const row=evidenceForItem(data,product,item),decision=row?row.qualification:item.qualification;
  const current=decision?.profileHash===qualificationInputHash(product);
  // Retain older brand mentions, clearly separate from qualified direct fits.
  const legacyMention=item.kind==='mention'&&!row&&!item.qualification;
  const signals=conversationSignals(product,row||item,decision,{current});
  return {conversationSignals:signals,currentConversationRelevant:legacyMention||(current&&decision.relevant===true),currentOpportunityFit:signals.some(signal=>signal.purpose==='potential_customer')};
}
