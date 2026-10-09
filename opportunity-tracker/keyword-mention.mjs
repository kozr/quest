import {mentionEvidence} from './conversation-purpose.mjs';

// A literal source match is independent of an AI decision about the business.
// A comment's copied discussion title/context cannot establish what its author
// mentioned. The full original evidence remains stored separately.
export function keywordMentionEvidence(product,source){
  if(!product||!source)return null;
  const ownSource=source.type==='comment'?{...source,title:''}:source;
  const evidence=mentionEvidence(product,ownSource);
  return evidence?{matchType:'literal',reference:evidence.reference,quote:evidence.quote}:null;
}
