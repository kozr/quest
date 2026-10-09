import {conversationSourceKey,qualificationInputHash,reviewEvidenceFor} from './conversation-evidence.mjs';
import {entityMentionEvidence} from './entity-mention.mjs';
import {qualificationCurrent} from './conversation-feed.mjs';
import {conversationSignals} from './conversation-purpose.mjs';

const purposeIds={mentions:'mention',opportunities:'potential_customer',feedback:'feedback',competitors:'competitor',all:null};
const insightFields=['id','kind','title','outcome','community','evidenceIds','explanation','offeringIds','unknowns','independentThreadCount','firstSeen','lastSeen'];
const sourceFields=['id','url','title','author','publishedAt','quote','threadId','discussionClosed','resolved'];
const pick=(row,fields)=>Object.fromEntries(fields.filter(key=>row?.[key]!==undefined).map(key=>[key,row[key]]));

function sourceFor(insight,row){
  const saved=insight.sources?.find(source=>source.id===row.id);
  // Saved attribution is retained verbatim. Imported older insights may omit
  // sources; reconstruct only the same named source and its reviewed quote.
  return pick(saved||{id:row.id,url:row.url,title:row.title,author:row.author,publishedAt:row.publishedAt,quote:row.qualification?.quote,threadId:row.threadId,discussionClosed:row.discussionClosed,resolved:row.qualification?.resolved},sourceFields);
}

// Call with the full authorized product state, before bounding HTTP evidence.
// Counts are complete; source excerpts are limited to the saved insight schema.
export function projectPurposePatterns(data,product){
  const profileHash=qualificationInputHash(product),items=new Map((data.items||[]).filter(item=>item.productId===product.id&&item.url).map(item=>[conversationSourceKey(item.url),item]));
  const current=new Map(reviewEvidenceFor(data,product).filter(row=>row.url).map(row=>[conversationSourceKey(row.url),row]));
  for(const row of data.conversationReviewQueue?.[product.id]||[])if(row.url)current.set(conversationSourceKey(row.url),row);
  const entries=[...current.values()].map(row=>{
    const current=qualificationCurrent(data,product,row,items.get(conversationSourceKey(row.url)),profileHash);
    return {row,current,relevant:current&&row.qualification.relevant===true,entityMention:entityMentionEvidence(product,row,{decision:row.qualification,current}),signals:conversationSignals(product,row,row.qualification,{current})};
  });
  const saved=data.pipelineStages?.[product.id]?.insights?.data?.insights||[];
  const purposes=Object.fromEntries(Object.entries(purposeIds).map(([name,purpose])=>{
    const matching=entries.filter(entry=>purpose==='mention'?Boolean(entry.entityMention):entry.relevant&&(!purpose||entry.signals.some(signal=>signal.purpose===purpose)));
    const rows=matching.map(entry=>entry.row),byId=new Map(matching.filter(entry=>entry.current).map(entry=>[entry.row.id,entry.row]));
    const patterns=saved.slice(0,8).filter(insight=>Array.isArray(insight.evidenceIds)&&insight.evidenceIds.length>0&&insight.evidenceIds.length<=12&&insight.evidenceIds.every(id=>byId.has(id))).map(insight=>({...pick(insight,insightFields),sources:insight.evidenceIds.map(id=>sourceFor(insight,byId.get(id)))}));
    const dates=rows.map(row=>row.publishedAt).filter(value=>typeof value==='string'&&Number.isFinite(Date.parse(value))).sort();
    return [name,{evidenceCount:rows.length,patterns,firstSeen:dates[0]||null,lastSeen:dates.at(-1)||null}];
  }));
  return structuredClone({version:1,purposes});
}
