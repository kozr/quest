import {reviewListingEvidence} from './review-identity.mjs';
// Business identity is independent of usefulness and customer intent.
export const ENTITY_MATCH_VERSION='entity-identity-v1';
const folded=value=>String(value).normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
const word=value=>Boolean(value&&/[\p{L}\p{N}_]/u.test(value));
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function namedReference(text,name){
  if(typeof text!=='string'||typeof name!=='string'||!name.trim())return false;
  const source=folded(text),needle=folded(name.trim());
  for(const match of source.matchAll(new RegExp(escape(needle).replace(/\s+/g,'\\s+'),'g'))){const end=match.index+match[0].length;if(word(source[match.index-1])||word(source[end])||needle.includes('.')&&source[end]==='.'&&word(source[end+1]))continue;return true;}return false;
}
export const ownSourceTexts=source=>(source?.type==='comment'?[source.text??source.snippet]:[source?.title,source?.text??source?.snippet]).filter(value=>typeof value==='string');
export const ownsSourceQuote=(source,quote)=>Boolean(quote&&ownSourceTexts(source).some(text=>text.includes(quote)));
const sharedHosts=new Set(['apps.apple.com','play.google.com','x.com','twitter.com','instagram.com','tiktok.com','facebook.com','linkedin.com','youtube.com','linktr.ee']);
function urlIdentity(value){
  let url;try{url=new URL(value);}catch{return null;}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port)return null;
  const host=url.hostname.toLowerCase().replace(/^www\./,''),path=url.pathname;
  if(host==='apps.apple.com'){const id=path.match(/\/id(\d+)(?:\/|$)/)?.[1];return id?{kind:'app',host,value:`id${id}`,key:`apple:${id}`}:null;}
  if(host==='play.google.com'){const id=path==='/store/apps/details'&&url.searchParams.get('id');return id&&/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/i.test(id)?{kind:'app',host,value:id,key:`android:${id}`}:null;}
  if(['x.com','twitter.com','instagram.com','tiktok.com'].includes(host)){
    const handle=path.split('/').filter(Boolean)[0]?.replace(/^@/,'').toLowerCase();
    return handle&&/^[a-z0-9_.]{1,50}$/.test(handle)&&!['i','home','search','explore','reel','reels','p','hashtag','intent','share'].includes(handle)?{kind:'handle',host:host==='twitter.com'?'x.com':host,value:`@${handle}`,key:`${host==='twitter.com'?'x.com':host}:${handle}`}:null;
  }
  if(sharedHosts.has(host))return null;
  return {kind:'domain',host,value:host,key:`domain:${host}`};
}
export function trustedBusinessIdentifiers(product){const identity=urlIdentity(product?.url);return identity?[identity]:[];}
// Preserve the long-lived search-plan input contract. Shared hosts are retrieval
// references only; they never become identity proof.
export function businessReferences(product){
  const names=[product?.name,...(product?.aliases||[])];
  try{const url=new URL(product.url);if(url.hostname==='apps.apple.com'){const id=url.pathname.match(/id\d+/)?.[0];if(id)names.push(id);}else names.push(url.hostname.replace(/^www\./,''));}catch{}
  return [...new Set(names.filter(name=>typeof name==='string'&&name.trim()))];
}
export function entityBusinessReferences(product){return [...new Set([product?.name,...(product?.aliases||[]),...trustedBusinessIdentifiers(product).map(identity=>identity.value)].filter(name=>typeof name==='string'&&name.trim()))];}
function passage(text,reference){
  const short=text.split(/(?<=[.!?])\s+|\n+/).find(sentence=>sentence.length<=400&&namedReference(sentence,reference));if(short)return short.trim();
  for(let start=0;start<text.length;start+=200){const part=text.slice(start,start+400);if(namedReference(part,reference))return part;}return null;
}
export function literalMentionEvidence(product,source){for(const reference of entityBusinessReferences(product))for(const text of ownSourceTexts(source)){if(!namedReference(text,reference))continue;const quote=passage(text,reference);if(quote)return {purpose:'mention',reference,quote,reason:`Names ${product.name} in the source.`,offeringIds:[]};}return null;}
function textURLs(text){
  const results=[],pattern=/https?:\/\/[^\s<>"\[\]]+|(?<![\p{L}\p{N}_@/])(?:www\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}(?:\/[^\s<>"\[\]]*)?/giu;
  for(const match of text.matchAll(pattern)){
    const raw=match[0].replace(/[),.;!?]+$/,''),token=text.slice(0,match.index).match(/\S+$/)?.[0]||'';
    if(!/^https?:/i.test(raw)&&(/https?:\/\/|@|\/$/.test(token)))continue;
    try{const parsed=new URL(/^https?:/i.test(raw)?raw:`https://${raw}`);if(!parsed.username&&!parsed.password&&!parsed.port)results.push({raw,url:parsed.href});}catch{}
  }return results;
}
function directIdentifierEvidence(product,source){
  const trusted=trustedBusinessIdentifiers(product);
  for(const text of ownSourceTexts(source))for(const link of textURLs(text)){
    const found=urlIdentity(link.url),identifier=trusted.find(value=>value.key===found?.key);if(!identifier||link.raw.length>400)continue;
    return {reference:identifier.value,quote:link.raw,reason:`The author's text includes this business's ${identifier.kind==='app'?'exact app listing':identifier.kind==='handle'?'official profile':'official domain'}.`,basis:'identifier'};
  }
  // An exact standalone App Store ID is unique too, but never extract it from
  // the path, query, credentials or fragment of an unrelated URL.
  for(const identifier of trusted.filter(value=>value.key.startsWith('apple:')))for(const text of ownSourceTexts(source))for(const token of text.split(/\s+/)){
    const bare=token.replace(/^[([{'"]+|[)\]}",.;!?]+$/g,'');
    if(bare===identifier.value)return {reference:identifier.value,quote:bare,reason:'The author gives this exact App Store identifier.',basis:'identifier'};
  }
  return null;
}
export function businessIdentityContext(product){
  const profile=product.businessProfileV2?.reviewed?product.businessProfileV2:product;
  return [...new Set([...(profile.constraints||[]),...(profile.offerings||[])].map(row=>row.quote).filter(value=>typeof value==='string'&&value.trim()))];
}
const genericWords=new Set('a an the this that these those i you we it its my your our and or of to in on at for from with as is are was be been have has had app application tool tracker track tracking blind box cafe café business product collector collection collections collectibles figures figure use using called named name free like good best place software website official coffee tea lunch dinner breakfast brunch food drinks drink menu restaurant iphone android phone mobile ios spreadsheet checklist wishlist lists list share sharing shared image images export exports feature features reviews review shopping cart store service services helpful useful nice love loved like liked online order ordering download downloaded downloaded appstore play google apple'.split(' '));
function contextTokens(text,product){const names=entityBusinessReferences(product).flatMap(name=>folded(name).match(/[\p{L}\p{N}]+/gu)||[]);return [...new Set(folded(text).match(/[\p{L}\p{N}]+/gu)||[])].filter(token=>!genericWords.has(token)&&!names.includes(token)&&(token.length>=4||/^\d{2,}$/.test(token)));}
export function validEntityMatch(product,source,decision){
  if(!decision||decision.version!==ENTITY_MATCH_VERSION||!['confirmed','different','uncertain','not_mentioned'].includes(decision.status))return false;
  if(decision.status!=='confirmed')return decision.basis==='none'&&!decision.quote&&!decision.reference&&!decision.identityQuote&&!decision.businessQuote&&decision.contextSource==='none';
  if(!['identifier','business_context'].includes(decision.basis)||!ownsSourceQuote(source,decision.quote)||!entityBusinessReferences(product).some(name=>namedReference(decision.reference,name)&&namedReference(decision.quote,name)))return false;
  if(decision.basis==='identifier')return !decision.identityQuote&&!decision.businessQuote&&decision.contextSource==='none'&&Boolean(directIdentifierEvidence(product,{type:'comment',text:decision.quote}));
  if(!['own','parent'].includes(decision.contextSource)||!decision.identityQuote||!decision.businessQuote)return false;
  if(decision.contextSource==='own'?!ownsSourceQuote(source,decision.identityQuote):source.type!=='comment'||!source.context?.includes(decision.identityQuote)||!source.threadId&&!source.postId&&!source.parentId)return false;
  const businessFacts=businessIdentityContext(product);
  if(!businessFacts.some(text=>text.includes(decision.businessQuote)))return false;
  // A parent cannot erase an explicitly different place named by the reply.
  if(decision.contextSource==='parent'){
    const known=contextTokens(businessFacts.join(' '),product);
    for(const text of ownSourceTexts(source))for(const match of text.matchAll(/\b(?:in|at|near|from)\s+([^.!?\n,;]+)/gi)){
      const stated=contextTokens(match[1],product);
      if(stated.length&&!stated.some(token=>known.includes(token)))return false;
    }
  }
  const profile=product.businessProfileV2?.reviewed?product.businessProfileV2:product;
  const locationFacts=(profile.constraints||[]).filter(row=>/\b(?:located|location|address|street|avenue|road|neighborhood|neighbourhood|city|postal|zip)\b/i.test(`${row.text||''} ${row.quote||''}`)).map(row=>row.quote);
  const facts=contextTokens(decision.businessQuote,product),evidence=contextTokens(decision.identityQuote,product),shared=facts.filter(token=>evidence.includes(token));
  if(locationFacts.length){const location=contextTokens(locationFacts.join(' '),product);return shared.some(token=>location.includes(token));}
  // Non-local products need more than a single generic feature/topic term.
  return shared.length>=2;

}
export function entityMentionEvidence(product,source,{decision,current=false}={}){
  if(!product||!source)return null;
  const review=reviewListingEvidence(product,source);if(review)return review;
  const direct=directIdentifierEvidence(product,source);if(direct)return direct;
  const verdict=decision?.entityMatch;
  if(!current||!literalMentionEvidence(product,source)||!validEntityMatch(product,source,verdict)||verdict.status!=='confirmed')return null;
  return {reference:verdict.reference,quote:verdict.quote,reason:verdict.reason||`Source context identifies ${product.name}.`,basis:verdict.basis,identityQuote:verdict.identityQuote};
}
export function needsEntityReview(product,row){return Boolean(literalMentionEvidence(product,row)&&!directIdentifierEvidence(product,row)&&!validEntityMatch(product,row,row.qualification?.entityMatch));}
