import {createHash} from 'node:crypto';
import {publicUrl} from './metadata.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const clean=x=>typeof x==='string'?x.trim():'';
const fold=x=>clean(x).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const dataID=/^0x[a-f0-9]+:0x[a-f0-9]+$/i;
function reviewIdentifiers(product){
 try{const u=publicUrl(product.url),host=u.hostname.replace(/^www\./,'');if(host==='apps.apple.com'){const id=u.pathname.match(/\/id(\d+)(?:\/|$)/)?.[1];return id?[{key:`apple:${id}`}]:[];}if(['google.com','instagram.com','x.com','twitter.com','tiktok.com','facebook.com','linkedin.com','youtube.com','linktr.ee','play.google.com'].includes(host))return [];return [{kind:'domain',host}];}catch{return [];}
}
export function canonicalReviewURL(value){
  try{const u=publicUrl(value);if(u.hostname==='www.google.com'&&u.pathname==='/maps'&&/^\d{1,25}$/.test(u.searchParams.get('cid')||'')&&/^[a-f0-9]{32}$/.test(u.searchParams.get('review_key')||'')){u.search=new URLSearchParams({cid:u.searchParams.get('cid'),review_key:u.searchParams.get('review_key')}).toString();return u.href;}}catch{}
  try{const u=publicUrl(value);if(u.hostname==='apps.apple.com'&&/\/id\d+/.test(u.pathname)&&/^\d{1,30}$/.test(u.searchParams.get('review_id')||'')){u.search=new URLSearchParams({review_id:u.searchParams.get('review_id')}).toString();return u.href;}}catch{}
  return null;
}
export function reviewListingEvidence(product,row){
  const p=row.businessReview;
  if(row.source==='App Store review'&&p?.version===1&&/^\d{1,30}$/.test(p.appId||'')&&canonicalReviewURL(row.url)&&reviewIdentifiers(product).some(r=>r.key===`apple:${p.appId}`)&&row.sourceId===`as_${p.reviewId}`&&new URL(row.url).pathname.match(/\/id(\d+)(?:\/|$)/)?.[1]===p.appId&&new URL(row.url).searchParams.get('review_id')===p.reviewId&&clean(row.text??row.snippet))return {reference:`id${p.appId}`,quote:String(row.text??row.snippet).slice(0,400),reason:'A written review on this exact App Store listing.',basis:'business_review'};
  if(row.source!=='Google Maps review'||p?.version!==1||!dataID.test(p.dataId||'')||!canonicalReviewURL(row.url)||!row.sourceId?.startsWith('gm_')||!clean(row.text??row.snippet))return null;
  let website;try{website=publicUrl(p.website);}catch{return null;}
  if(!reviewIdentifiers(product).some(r=>r.kind==='domain'&&r.host===website.hostname.replace(/^www\./,''))||![product.name,...(product.aliases||[])].some(name=>fold(p.title)===fold(name)))return null;
  const u=new URL(row.url),key=hash([p.dataId,p.contributorId]).slice(0,32);
  if(!/^\d{1,30}$/.test(p.contributorId||'')||row.sourceId!==`gm_${key}`||u.searchParams.get('review_key')!==key||u.searchParams.get('cid')!==BigInt(p.dataId.split(':')[1]).toString())return null;
  return {reference:p.title,quote:String(row.text??row.snippet).slice(0,400),reason:'A written review on the listing verified against this business’s official website.',basis:'business_review'};
}
