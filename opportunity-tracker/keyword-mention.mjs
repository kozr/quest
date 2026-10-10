import {literalMentionEvidence,entityMentionEvidence,ownSourceTexts} from './entity-mention.mjs';

export const CONVERSATION_MATCH_RULES='keywords-direct-v1';
function keywordQueries(product,source){
  const ids=new Set([...(source?.queryIds||[]),source?.queryId].filter(Boolean));
  return (product?.searchPlanV2?.themes||[]).flatMap(theme=>(theme.queries||[]).filter(query=>ids.has(query.id)&&(query.loop||query.queryFamily||'keyword')==='keyword').map(query=>({...query,purposes:theme.purposes||[]})));
}

// A literal source match is independent of an AI decision about the business.
// A comment's copied discussion title/context cannot establish what its author
// mentioned. The full original evidence remains stored separately.
export function keywordMentionEvidence(product,source){
  if(!product||!source)return null;
  const ownSource=source.type==='comment'?{...source,title:''}:source;
  const evidence=literalMentionEvidence(product,ownSource);
  if(evidence)return {matchType:'literal',reference:evidence.reference,quote:evidence.quote};
  // Keep every original result from a saved mention keyword query. Selected
  // replies still need their own keyword text; their parent is only context.
  const query=source.type!=='comment'&&keywordQueries(product,source).find(query=>query.purposes.includes('mention'));
  const quote=ownSourceTexts(source).find(text=>text.trim())?.slice(0,400);
  return query&&quote?{matchType:'search',reference:query.query,quote}:null;
}

export function isKeywordResult(product,source){
  const families=new Set([...(source?.queryFamilies||[]),source?.queryFamily].filter(Boolean));
  if(families.has('keyword')||keywordQueries(product,source).length)return true;
  if(families.has('long_tail'))return false;
  // Older saved sources may predate query-family attribution. Recover direct
  // keyword matches from their original text without rewriting their receipts.
  return Boolean(keywordMentionEvidence(product,source)||entityMentionEvidence(product,source));
}

export function keywordPurposeSignals(product,source){
  if(!isKeywordResult(product,source))return [];
  const quote=ownSourceTexts(source).find(text=>text.trim())?.slice(0,400);
  if(!quote)return [];
  const signals=new Map();
  for(const query of keywordQueries(product,source))for(const purpose of query.purposes){
    if(purpose==='mention')continue;
    if(['potential_customer','feedback','competitor'].includes(purpose))signals.set(purpose,{purpose,reference:query.query,quote,reason:`Returned by keyword search: ${query.query}`,offeringIds:[],basis:'keyword'});
  }
  return [...signals.values()];
}
