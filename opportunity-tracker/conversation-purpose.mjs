export const PURPOSE_LABELS={potential_customer:'Potential customer',mention:'Mention',feedback:'Feedback',competitor:'Competitor'};
export const PURPOSE_IDS=Object.keys(PURPOSE_LABELS);
const folded=value=>String(value).normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
const word=value=>Boolean(value&&/[\p{L}\p{N}_]/u.test(value));
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

export function namedReference(text,name){
  if(typeof text!=='string'||typeof name!=='string'||!name.trim())return false;
  const source=folded(text),needle=folded(name.trim());
  for(const match of source.matchAll(new RegExp(escape(needle).replace(/\s+/g,'\\s+'),'g'))){
    const end=match.index+match[0].length;
    if(word(source[match.index-1])||word(source[end])||needle.includes('.')&&source[end]==='.'&&word(source[end+1]))continue;
    return true;
  }
  return false;
}
export function businessReferences(product){
  const names=[product.name,...(product.aliases||[])];
  try{const url=new URL(product.url);if(url.hostname==='apps.apple.com'){const id=url.pathname.match(/id\d+/)?.[0];if(id)names.push(id);}else names.push(url.hostname.replace(/^www\./,''));}catch{}
  return [...new Set(names.filter(name=>typeof name==='string'&&name.trim()))];
}
export const ownTexts=source=>[source.title,source.text??source.snippet].filter(text=>typeof text==='string');
export const ownsQuote=(source,quote)=>Boolean(quote&&ownTexts(source).some(text=>text.includes(quote)));
export function mentionEvidence(product,source){
  for(const reference of businessReferences(product))for(const text of ownTexts(source)){
    if(!namedReference(text,reference))continue;
    // Preserve an exact source passage rather than the normalised matching text.
    const sentences=text.match(/[^\n.!?]+(?:[.!?]|$)/g)||[text];
    const quote=sentences.find(sentence=>sentence.length<=400&&namedReference(sentence,reference))?.trim();
    if(quote)return {purpose:'mention',reference,quote,reason:`Names ${product.name} in the source.`,offeringIds:[]};
    for(let start=0;start<text.length;start+=200){const passage=text.slice(start,start+400);if(namedReference(passage,reference))return {purpose:'mention',reference,quote:passage,reason:`Names ${product.name} in the source.`,offeringIds:[]};}
  }
  return null;
}
export function conversationSignals(product,source,qualification,{current=false}={}){
  const signals=[],mention=mentionEvidence(product,source);
  // A name match alone cannot disambiguate a namesake business.
  if(mention&&current&&qualification?.relevant===true)signals.push(mention);
  if(!current||qualification?.relevant!==true)return signals;
  for(const signal of qualification.purposes||[]){
    if(!PURPOSE_IDS.includes(signal.purpose)||!ownsQuote(source,signal.quote))continue;
    if(signal.purpose==='mention'){
      if(businessReferences(product).some(name=>namedReference(signal.quote,name))){
        const index=signals.findIndex(row=>row.purpose==='mention');if(index>=0)signals[index]=signal;else signals.push(signal);
      }
    }else if(signal.purpose==='potential_customer'){
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
