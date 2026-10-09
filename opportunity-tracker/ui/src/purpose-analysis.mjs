import {matchesConversation} from './feed.mjs';

const sourceKey=url=>{try{const parsed=new URL(url);parsed.search='';parsed.hash='';return parsed.href;}catch{return url;}};
export const explorationSections={feedback:'findings',competitors:'landscape',opportunities:'people'};

export function patternsForPurpose(state,productId,purpose){
 const summary=state.pipeline?.products?.[productId],record=state.pipeline?.stages?.[productId]?.insights;
 const projection=summary?.purposePatterns;
 if(projection?.version===1){
  const key={mentions:'mentions',direct:'opportunities',opportunities:'opportunities',feedback:'feedback',competitors:'competitors',all:'all'}[purpose.relevance]||'all';
  const selected=projection.purposes?.[key],patterns=selected?.patterns||[];
  // Only saved supporting sources travel with a bounded projection. The full
  // qualified-evidence count remains authoritative, including an explicit zero.
  const evidence=[...new Map(patterns.flatMap(pattern=>pattern.sources||[]).map(source=>[source.id,source])).values()];
  return {record,patterns,evidence,evidenceCount:selected?.evidenceCount||0,firstSeen:selected?.firstSeen||null,lastSeen:selected?.lastSeen||null,authoritative:true};
 }

 const items=new Map(state.items.filter(item=>item.productId===productId).map(item=>[sourceKey(item.url),item]));
 const evidence=(summary?.conversations||[]).filter(row=>{
  if(row.classificationCurrent!==true||row.qualification?.relevant!==true)return false;
  if(purpose.relevance==='direct'&&(row.qualification.directFit!==true||row.qualification.resolved==='yes'||row.discussionClosed))return false;
  const existing=items.get(sourceKey(row.url));
  const item=existing||{...row,status:'new',currentConversationRelevant:true,currentOpportunityFit:row.qualification.directFit===true&&row.qualification.resolved!=='yes'&&!row.discussionClosed};
  return matchesConversation({...item,keywordMention:null,status:'new'},{relevance:purpose.relevance});
 });
 const ids=new Set(evidence.map(row=>row.id));
 // Keep the original counts and claims intact: every supporting source must
 // belong to this purpose rather than relabelling a mixed-purpose summary.
 const patterns=(record?.data.insights||[]).filter(insight=>insight.evidenceIds?.length>0&&insight.evidenceIds.every(id=>ids.has(id)));
 return {record,patterns,evidence,evidenceCount:evidence.length};
}
