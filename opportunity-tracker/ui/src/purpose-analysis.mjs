import {matchesConversation} from './feed.mjs';

const sourceKey=url=>{try{const parsed=new URL(url);parsed.search='';parsed.hash='';return parsed.href;}catch{return url;}};
export const explorationSections={feedback:'findings',competitors:'landscape',opportunities:'people'};

export function patternsForPurpose(state,productId,purpose){
 const summary=state.pipeline?.products?.[productId],record=state.pipeline?.stages?.[productId]?.insights;
 const items=new Map(state.items.filter(item=>item.productId===productId).map(item=>[sourceKey(item.url),item]));
 const evidence=(summary?.conversations||[]).filter(row=>{
  if(row.classificationCurrent!==true||row.qualification?.relevant!==true)return false;
  if(purpose.relevance==='direct'&&(row.qualification.directFit!==true||row.qualification.resolved==='yes'||row.discussionClosed))return false;
  const existing=items.get(sourceKey(row.url));
  const item=existing||{...row,status:'new',currentConversationRelevant:true,currentOpportunityFit:row.qualification.directFit===true&&row.qualification.resolved!=='yes'&&!row.discussionClosed};
  return matchesConversation({...item,status:'new'},{relevance:purpose.relevance});
 });
 const ids=new Set(evidence.map(row=>row.id));
 // Keep the original counts and claims intact: every supporting source must
 // belong to this purpose rather than relabelling a mixed-purpose summary.
 const patterns=(record?.data.insights||[]).filter(insight=>insight.evidenceIds?.length>0&&insight.evidenceIds.every(id=>ids.has(id)));
 return {record,patterns,evidence};
}
