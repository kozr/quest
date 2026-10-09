import {createHash} from 'node:crypto';
import {canonicalSocialSource} from './social-search.mjs';

export const CHECKPOINT_OVERLAP_MS=15*60000;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function sourceIdentity(row){
  const social=canonicalSocialSource(row);if(social)return social.identity;
  try{
    const url=new URL(row.url),parts=url.pathname.split('/').filter(Boolean);if(url.hostname==='news.ycombinator.com'&&url.pathname==='/item'&&/^\d+$/.test(url.searchParams.get('id')||''))return `hn:${url.searchParams.get('id')}`;for(const key of [...url.searchParams.keys()])if(/^utm_|^(fbclid|gclid|ref|tracking)$/i.test(key))url.searchParams.delete(key);url.hash='';
    if(/(^|\.)reddit\.com$/.test(url.hostname)&&parts[0]==='r'&&parts[2]==='comments'&&/^[a-z0-9]+$/i.test(parts[3]||''))return `reddit:${parts[5]?`t1_${parts[5]}`:`t3_${parts[3]}`}`;
    if(/(^|\.)(x\.com|twitter\.com)$/.test(url.hostname)&&/\/status\/\d+/.test(url.pathname))return `x:${url.pathname.match(/\/status\/(\d+)/)[1]}`;
    if(/(^|\.)linkedin\.com$/.test(url.hostname)){const id=url.pathname.match(/activity[-:](\d{10,20})/)||url.pathname.match(/-(\d{10,20})-/);if(id)return `linkedin:${id[1]}`;}
    return url.href;
  }catch{return null;}
}
export function publicationTime(row){return typeof row.publishedAt==='number'?row.publishedAt*(row.publishedAt<1e12?1000:1):Date.parse(row.publishedAt);}
export function checkpointKey(source,query){return `${source}:${hash(query)}`;}
export function checkpointCutoff(watermarks,key,fallback=null){const time=Date.parse(watermarks?.[key]);return Number.isFinite(time)?time-CHECKPOINT_OVERLAP_MS:fallback;}

// Checkpoints reduce old results; stable identities also suppress overlap,
// undated results and the same conversation returned by multiple queries/APIs.
// Content changes remain updates to that conversation, never new identities.
export function freshRows(data,product,rows,{cutoff=null,at,profileHash=hash([product.businessProfileV2,product.searchPlanV2,product.capabilities,product.keywords,product.aliases,product.competitorNames,product.exclusions])}={}){
  data.ingestion ||= {};const seen=data.ingestion,unique=new Map();
  for(const row of rows){
    const identity=sourceIdentity(row);if(!identity)continue;
    const durable=Boolean(data.subscription),key=hash([product.id,identity]),contentHash=hash(durable?[String(row.title||''),String(row.snippet??row.text??''),String(row.context||''),row.kind||'']:[String(row.title||'').slice(0,500),String(row.snippet??row.text??'').slice(0,3000),row.kind||'']),previous=seen[key];
    const known=previous?.profileHash===profileHash,time=publicationTime(row);
    if(cutoff!=null&&Number.isFinite(time)&&time<cutoff&&!(known&&previous.contentHash!==contentHash))continue;
    if(known&&previous.contentHash===contentHash)continue;
    const collectedAt=at||new Date().toISOString();
    seen[key]={contentHash,profileHash,at:collectedAt};unique.set(identity,row);
  }
  const keys=Object.keys(seen);if(!data.subscription&&keys.length>2000)for(const key of keys.sort((a,b)=>seen[a].at.localeCompare(seen[b].at)).slice(0,keys.length-2000))delete seen[key];
  return [...unique.values()];
}
