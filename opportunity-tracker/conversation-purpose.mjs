import {entityMentionEvidence,businessReferences,namedReference,ownSourceTexts,ownsSourceQuote,literalMentionEvidence} from './entity-mention.mjs';
import {keywordMentionEvidence,keywordPurposeSignals} from './keyword-mention.mjs';
export {businessReferences,namedReference} from './entity-mention.mjs';
export const PURPOSE_LABELS={potential_customer:'Potential customer',mention:'Mention',feedback:'Feedback',competitor:'Competitor'};
export const PURPOSE_IDS=Object.keys(PURPOSE_LABELS);
export const ownTexts=ownSourceTexts;
export const ownsQuote=ownsSourceQuote;
export const mentionEvidence=literalMentionEvidence;
export function conversationSignals(product,source,qualification,{current=false}={}){
  const keyword=keywordMentionEvidence(product,source),mention=keyword||entityMentionEvidence(product,source,{decision:qualification,current}),signals=keywordPurposeSignals(product,source);
  if(mention)signals.unshift({purpose:'mention',...mention,reason:keyword?`Matches keyword: ${keyword.reference}`:mention.reason,offeringIds:[],...(keyword?{basis:'keyword'}:{})});
  // Legacy decisions can use a verified name match. An explicitly reviewed
  // purpose list, including an empty one, must remain authoritative.
  if(!current||qualification?.relevant!==true)return signals;
  for(const signal of qualification.purposes||[]){
    if(!PURPOSE_IDS.includes(signal.purpose)||!ownsQuote(source,signal.quote))continue;
    if(signal.purpose==='mention'){
      // Identity is computed above; old name-only purpose labels cannot affirm it.
    }else if(signals.some(existing=>existing.purpose===signal.purpose))continue;
    else if(signal.purpose==='potential_customer'){
      if(qualification.directFit&&qualification.resolved!=='yes'&&!source.discussionClosed)signals.push(signal);
    }else signals.push(signal);
  }
  // Explicit older direct-fit decisions remain reviewable. Generic categories
  // never create Feedback or Competitors; those purposes need their own proof.
  if(!qualification.purposes&&qualification.directFit&&qualification.resolved!=='yes'&&!source.discussionClosed&&ownsQuote(source,qualification.quote)&&qualification.offeringIds?.length&&!['promotion','recommendation','other'].includes(qualification.category)){
    signals.push({purpose:'potential_customer',quote:qualification.quote,reason:qualification.reason,offeringIds:qualification.offeringIds,reference:''});
  }
  return signals;
}
export function commentThreadPriority(product,post,purposes=[]){
  const text=ownTexts(post).join('\n');
  if(businessReferences(product).some(name=>namedReference(text,name)))return 4;
  if((product.competitorNames||[]).some(name=>namedReference(text,name)))return 3;
  if(purposes.some(purpose=>['mention','feedback','competitor'].includes(purpose)))return 2;
  if(/\?|how|where|help|recommend|track|wish.?list|checklist|workaround|missing|dupli/i.test(text))return 1;
  return (product.keywords||[]).some(term=>namedReference(text,term))?1:0;
}
