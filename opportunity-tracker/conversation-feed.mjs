import {entityMentionEvidence} from './entity-mention.mjs';
import {keywordMentionEvidence,isKeywordResult} from './keyword-mention.mjs';
import {conversationSignals} from './conversation-purpose.mjs';
import {hash} from './pipeline-contract.mjs';
import {evidenceFor,qualificationInputHash,QUALIFY_PIPELINE_VERSION,currentReviewFailure,conversationSourceKey} from './conversation-evidence.mjs';

const sourceURL=conversationSourceKey;
function evidenceForItem(data,product,item){return [...(data.conversationReviewQueue?.[product.id]||[]),...evidenceFor(data,product),...Object.values(data.conversationReviewFailures?.[product.id]||{}).map(failure=>failure.row)].find(row=>sourceURL(row.url)===sourceURL(item.url));}

// Validate the actual current body as well as its stored hash. Item-only rows
// retain their reviewed content hash after bounded evidence/sample eviction.
export function qualificationContentCurrent(data,product,row,item){
  const source=row||item,decision=row?row.qualification:item?.qualification;
  if(!source||!decision)return false;
  const context=source.context||'',title=source.title||'',text=source.text??source.snippet??'';
  const actual=hash(context?[title,text,context]:[title,text]);
  if(row?.contentHash!==undefined&&row.contentHash!==actual)return false;
  const receipt=row&&data.conversationReviewReceipts?.[product.id]?.[row.id];
  const reviewed=decision.contentHash||(receipt?.qualification?.profileHash===decision.profileHash?receipt?.contentHash:null)||(item?.qualification?.profileHash===decision.profileHash?item?.qualification?.contentHash:null);
  return Boolean(reviewed&&reviewed===actual);
}
export function qualificationCurrent(data,product,row,item,profileHash=qualificationInputHash(product)){
  const decision=row?row.qualification:item?.qualification;
  return product.listeningVersion==='v2'&&decision?.profileHash===profileHash&&qualificationContentCurrent(data,product,row,item)&&!(row&&currentReviewFailure(data,product,row));
}

// Keep a single review record for each source, including relevant unmet needs.
export function syncConversationItems(data,product){
  if(product.listeningVersion!=='v2')return;
  const profileHash=qualificationInputHash(product);
  for(const row of evidenceFor(data,product)){
    const decision=row.qualification;
    const existing=data.items.find(item=>item.productId===product.id&&sourceURL(item.url)===sourceURL(row.url));
    if(!qualificationCurrent(data,product,row,existing,profileHash))continue;
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
  if(!product)return {keywordMention:null,entityMention:null};
  const row=evidenceForItem(data,product,item),source=row||item,keywordMention=keywordMentionEvidence(product,source);
  const decision=row?row.qualification:item.qualification,current=qualificationCurrent(data,product,row,item);
  const entityMention=entityMentionEvidence(product,source,{decision,current});
  if(product.listeningVersion!=='v2')return {keywordMention,entityMention};
  const signals=conversationSignals(product,source,decision,{current});
  return {keywordMention,entityMention,keywordResult:isKeywordResult(product,source),...(isKeywordResult(product,source)?{analysisStatus:'not_required'}:{}),conversationSignals:signals,currentConversationRelevant:isKeywordResult(product,source)||current&&decision.relevant===true,currentOpportunityFit:signals.some(signal=>signal.purpose==='potential_customer')};
}
