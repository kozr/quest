import {createHash} from 'node:crypto';
import {z} from 'zod';

export const prospectCandidateSchema=z.object({
 sourceUrl:z.string().url().max(2048),relationship:z.enum(['potential_user','creator_partner']),
 sourceEvidence:z.string().max(4000).optional(),publishedAt:z.string().datetime().nullable().optional(),
 problem:z.string().min(3).max(300),fitReason:z.string().min(3).max(400),
 publicHandle:z.string().max(100).nullable().optional(),displayName:z.string().max(200).nullable().optional(),profileUrl:z.string().url().max(2048).nullable().optional(),
 excerpt:z.string().min(5).max(400),matchedCapabilityIds:z.array(z.string().uuid()).max(8),
 matchType:z.enum(['exact','similar']).optional(),
 needStatus:z.enum(['unresolved_at_posting','subsequently_resolved','unclear']).optional(),
}).strict();
export type ProspectCandidate=z.infer<typeof prospectCandidateSchema>;
export const researchProspectSchema=z.object({
 id:z.string().regex(/^[a-f0-9]{40}$/),provider:z.enum(['reddit','x','youtube']),publicHandle:z.string().max(100),
 displayName:z.string().min(1).max(200),profileUrl:z.union([z.literal(''),z.string().url().max(2048)]),
 relationship:z.enum(['potential_user','creator_partner']),status:z.literal('needs_review'),
 problem:z.string().min(3).max(300),fitReason:z.string().min(3).max(400),matchedCapabilityIds:z.array(z.string().uuid()).max(8),
 matchType:z.enum(['exact','similar']).optional(),
 needStatus:z.enum(['unresolved_at_posting','subsequently_resolved','unclear']).optional(),
 evidence:z.array(z.object({url:z.string().url().max(2048),title:z.string().max(500),excerpt:z.string().min(5).max(400),
  publishedAt:z.string().datetime().nullable(),verifiedAt:z.string().datetime(),verification:z.enum(['public_post','public_embed','video_metadata','web_search'])}).strict()).min(1).max(8),
}).strict();
export type ResearchProspect=z.infer<typeof researchProspectSchema>;
const bounded=(min:number,max:number)=>({type:'string',pattern:`^[\\s\\S]{${min},${max}}$`});
export const prospectCandidateJSONSchema={type:'array',maxItems:20,items:{type:'object',additionalProperties:false,
 properties:{sourceEvidence:{type:'string',maxLength:4000},sourceUrl:{type:'string',pattern:'^https://[^\\s]{1,2040}$'},relationship:{type:'string',enum:['potential_user']},
 matchType:{type:'string',enum:['exact','similar']},needStatus:{type:'string',enum:['unresolved_at_posting','subsequently_resolved','unclear']},publishedAt:{type:['string','null'],format:'date-time'},
 publicHandle:{type:['string','null'],maxLength:100},displayName:{type:['string','null'],maxLength:200},profileUrl:{type:['string','null'],maxLength:2048},
 problem:bounded(3,300),fitReason:bounded(3,400),excerpt:bounded(5,400),matchedCapabilityIds:{type:'array',minItems:0,maxItems:8,items:{type:'string',format:'uuid'}}},
 required:['matchType','needStatus','publishedAt','sourceEvidence','sourceUrl','relationship','problem','fitReason','excerpt','matchedCapabilityIds','publicHandle','displayName','profileUrl']}};

type PublicSource={provider:ResearchProspect['provider'];publicHandle:string;displayName:string;profileUrl:string;url:string;title:string;text:string;publishedAt:string|null;verification:ResearchProspect['evidence'][number]['verification']};
const clean=(text:string)=>text.normalize('NFKC').replace(/\s+/g,' ').trim();
function safeURL(raw:string):URL|null {try {const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port?u:null;}catch{return null;}}
function htmlText(raw:string):string {
 return raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<[^>]+>/g,' ').replace(/&quot;/g,'"').replace(/&#39;|&#x27;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>Number(n)<=0x10ffff?String.fromCodePoint(Number(n)):'');
}
async function readJSON(url:string,request:typeof fetch):Promise<any> {
 // URLs are constructed exclusively from validated platform IDs below. No user-selected host or redirects.
 const r=await request(url,{redirect:'error',signal:AbortSignal.timeout(6000),headers:{Accept:'application/json','User-Agent':'QuestMarket/1.0'}});
 if(!r.ok||!r.body)throw new Error('PUBLIC_SOURCE_UNAVAILABLE');
 const reader=r.body.getReader();let size=0;const chunks:Uint8Array[]=[];
 try {while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>512000)throw new Error('PUBLIC_SOURCE_TOO_LARGE');chunks.push(part.value);}}
 finally {await reader.cancel();}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function publicSource(raw:string,request:typeof fetch):Promise<PublicSource|null> {
 const u=safeURL(raw);if(!u)return null;const host=u.hostname.replace(/^www\./,'');
 if(host==='reddit.com') {
  const match=u.pathname.match(/^\/r\/([a-z0-9_]{2,21})\/comments\/([a-z0-9]{1,20})(?:\/[^/]+)?(?:\/([a-z0-9]{1,20}))?\/?$/i);if(!match)return null;
  const [,community,post,comment]=match;
  const data=await readJSON(`https://www.reddit.com/r/${community}/comments/${post}.json?raw_json=1&limit=100${comment?'&comment='+comment:''}`,request);
  if(!Array.isArray(data))return null;
  const entries:any[]=[];function walk(list:any,depth=0){if(depth>8||entries.length>500)return;for(const row of list?.data?.children??[]){if(row?.data)entries.push(row);if(row?.data?.replies)walk(row.data.replies,depth+1);}}
  for(const list of data)walk(list);
  const item=entries.find(r=>r.kind===(comment?'t1':'t3')&&r.data.id===(comment??post))?.data;
  if(!item||typeof item.author!=='string'||! /^[a-z0-9_-]{1,32}$/i.test(item.author)||['[deleted]','[removed]','AutoModerator'].includes(item.author))return null;
  const title=typeof item.title==='string'?item.title:'Reddit comment',body=typeof item.body==='string'?item.body:typeof item.selftext==='string'?item.selftext:'';
  if(!body||body==='[deleted]'||body==='[removed]')return null;
  const time=typeof item.created_utc==='number'?new Date(item.created_utc*1000):null;
  return {provider:'reddit',publicHandle:item.author,displayName:item.author,profileUrl:`https://www.reddit.com/user/${item.author}/`,url:`https://www.reddit.com/r/${community}/comments/${post}/${comment?'_/'+comment+'/':''}`,title:title.slice(0,500),text:clean(title+' '+body),publishedAt:time&&Number.isFinite(time.getTime())?time.toISOString():null,verification:'public_post'};
 }
 if(host==='x.com'||host==='twitter.com') {
  const m=u.pathname.match(/^\/([a-z0-9_]{1,15})\/status\/(\d{1,25})\/?$/i);if(!m)return null;
  const url=`https://x.com/${m[1]}/status/${m[2]}`;
  const data=await readJSON('https://publish.twitter.com/oembed?omit_script=true&url='+encodeURIComponent(url),request);
  const author=safeURL(data.author_url??'');if(!author||!['twitter.com','x.com'].includes(author.hostname.replace(/^www\./,''))||author.pathname.replace(/\//g,'').toLowerCase()!==m[1]!.toLowerCase()||typeof data.html!=='string')return null;
  const paragraph=data.html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1];if(!paragraph)return null;
  return {provider:'x',publicHandle:m[1]!,displayName:typeof data.author_name==='string'?data.author_name.slice(0,200):m[1]!,profileUrl:`https://x.com/${m[1]}`,url,title:'Public X post',text:clean(htmlText(paragraph)),publishedAt:null,verification:'public_embed'};
 }
 if(host==='youtube.com'||host==='youtu.be') {
  const id=host==='youtu.be'?u.pathname.slice(1):u.pathname==='/watch'?u.searchParams.get('v'):u.pathname.match(/^\/shorts\/([\w-]{11})\/?$/)?.[1];
  if(!id||! /^[\w-]{11}$/.test(id))return null;
  const url=`https://www.youtube.com/watch?v=${id}`;
  const data=await readJSON('https://www.youtube.com/oembed?format=json&url='+encodeURIComponent(url),request);
  const profile=safeURL(data.author_url??'');if(!profile||profile.hostname.replace(/^www\./,'')!=='youtube.com'||! /^\/(?:@[^/]+|channel\/UC[\w-]+|user\/[^/]+)\/?$/.test(profile.pathname)||typeof data.author_name!=='string'||typeof data.title!=='string')return null;
  return {provider:'youtube',publicHandle:profile.pathname.replace(/^\/(?:channel\/|user\/)?/,'').replace(/\/$/,''),displayName:data.author_name.slice(0,200),profileUrl:profile.href,url,title:data.title.slice(0,500),text:clean(data.title),publishedAt:null,verification:'video_metadata'};
 }
 return null;
}

export async function verifyResearchProspects(candidates:ProspectCandidate[],capabilityIDs:string[],request:typeof fetch=fetch,now=new Date()):Promise<ResearchProspect[]> {
 const verified:ResearchProspect[]=[];
 // Four parallel bounded public lookups; eight candidates maximum. No new paid provider call.
 for(let offset=0;offset<Math.min(candidates.length,8);offset+=4) {
  const rows=await Promise.all(candidates.slice(offset,offset+4).map(async candidate=>{
   try {
    const parsed=prospectCandidateSchema.safeParse(candidate);if(!parsed.success)return null;
    const matched=candidate.matchedCapabilityIds.filter(id=>capabilityIDs.includes(id));if(!matched.length)return null;
    const source=await publicSource(candidate.sourceUrl,request);if(!source)return null;
    // Metadata verifies channel attribution and topic, not a personal need or spoken quotation.
    if(source.provider==='youtube'&&candidate.relationship!=='creator_partner')return null;
    const excerpt=clean(candidate.excerpt);if(!source.text.includes(excerpt))return null;
    const id=createHash('sha256').update(source.provider+'|'+(source.provider==='youtube'?source.profileUrl:source.profileUrl.toLowerCase())+'|'+candidate.relationship).digest('hex').slice(0,40);
    return researchProspectSchema.parse({id,provider:source.provider,publicHandle:source.publicHandle,displayName:source.displayName,profileUrl:source.profileUrl,
     relationship:candidate.relationship,status:'needs_review',problem:candidate.problem,fitReason:candidate.fitReason,matchedCapabilityIds:matched,
     evidence:[{url:source.url,title:source.title,excerpt,publishedAt:source.publishedAt,verifiedAt:now.toISOString(),verification:source.verification}]});
   }catch{return null;}
  }));
  for(const row of rows)if(row)verified.push(row);
 }
 const unique=new Map<string,ResearchProspect>();
 for(const row of verified){const prior=unique.get(row.id);if(!prior)unique.set(row.id,row);else for(const e of row.evidence)if(!prior.evidence.some(p=>p.url===e.url))prior.evidence.push(e);}
 return [...unique.values()];
}

/** Public metadata supports a conservative creator-topic match, independently of model-proposed author fields. */
export async function discoverVideoProspects(urls:string[],capabilities:Array<{id:string;text:string}>,request:typeof fetch=fetch,now=new Date()):Promise<ResearchProspect[]> {
 const stop=new Set('the and for with that this your from into app users user using use track tracks tracking manage management daily simple easily help helps allow allows enable enables records record'.split(' '));
 const words=(text:string)=>new Set((text.toLowerCase().match(/\p{L}{3,}/gu)??[]).filter(w=>!stop.has(w)));
 const videos=[...new Set(urls)].filter(raw=>{const u=safeURL(raw);return u&&['youtube.com','youtu.be'].includes(u.hostname.replace(/^www\./,''));}).slice(0,4);
 const rows=await Promise.all(videos.map(async url=>{
  try {
   const source=await publicSource(url,request);if(!source||source.provider!=='youtube')return null;
   const titleWords=words(source.title),matched=capabilities.filter(c=>[...words(c.text)].some(w=>titleWords.has(w)));
   const overlap=[...new Set(matched.flatMap(c=>[...words(c.text)].filter(w=>titleWords.has(w))))];
   if(overlap.length<2||!matched.length)return null;
   const id=createHash('sha256').update(source.provider+'|'+source.profileUrl+'|creator_partner').digest('hex').slice(0,40);
   return researchProspectSchema.parse({id,provider:'youtube',publicHandle:source.publicHandle,displayName:source.displayName,profileUrl:source.profileUrl,
    relationship:'creator_partner',status:'needs_review',problem:'Creator discusses '+overlap.slice(0,5).join(', '),
    fitReason:'The verified video title overlaps with the app’s capabilities ('+overlap.slice(0,5).join(', ')+'). Review the channel’s audience and content before considering a partnership.',
    matchedCapabilityIds:matched.map(c=>c.id).slice(0,8),evidence:[{url:source.url,title:source.title,excerpt:source.title.slice(0,400),publishedAt:null,verifiedAt:now.toISOString(),verification:'video_metadata'}]});
  }catch{return null;}
 }));
 const unique=new Map<string,ResearchProspect>();for(const row of rows)if(row){const prior=unique.get(row.id);if(!prior)unique.set(row.id,row);else if(!prior.evidence.some(e=>e.url===row.evidence[0]!.url))prior.evidence.push(row.evidence[0]!);}
 return [...unique.values()];
}

/** Discovery records grounded in searched URLs; no claim of independent author verification. */
export function searchResearchProspects(candidates:ProspectCandidate[],capabilityIDs:string[],now=new Date()):ResearchProspect[] {
 const unique=new Map<string,ResearchProspect>();
 for(const c of candidates){
  const u=safeURL(c.sourceUrl);if(!u)continue;
  const host=u.hostname.replace(/^www\./,'');
  const provider=host==='reddit.com'?'reddit':['x.com','twitter.com'].includes(host)?'x':['youtube.com','youtu.be'].includes(host)?'youtube':null;
  if(!provider)continue;
  if(provider==='reddit'&&!/^\/r\/[^/]+\/comments\/[a-z0-9]+(?:\/|$)/i.test(u.pathname))continue;
  if(provider==='x'&&!/^\/[a-z0-9_]+\/status\/\d+/i.test(u.pathname))continue;
  if(provider==='youtube'&&c.relationship!=='creator_partner')continue;
  const matched=c.matchedCapabilityIds.filter(id=>capabilityIDs.includes(id));
  if(c.matchedCapabilityIds.length&&!matched.length)continue;
  if(!c.matchType&&!matched.length)continue;
  const handle=(c.publicHandle??'').trim();
  // New problem-based People records require an attributable Reddit author. Legacy records remain readable.
  if(c.matchType){
   const name=handle.replace(/^u\//i,'');
   const evidence=clean(c.sourceEvidence??'');
   if(provider!=='reddit'||c.relationship!=='potential_user'||!c.needStatus||
      !/^[a-z0-9_-]{1,32}$/i.test(name)||name.toLowerCase()==='automoderator'||
      !new RegExp('(^|[^a-z0-9_-])'+name+'([^a-z0-9_-]|$)','i').test(evidence)||!evidence.includes(clean(c.excerpt)))continue;
  }
  let profile='';
  if(provider==='reddit'&&/^(?:u\/)?[a-z0-9_-]{1,32}$/i.test(handle))profile='https://www.reddit.com/user/'+handle.replace(/^u\//i,'')+'/';
  if(provider==='x'&&/^@?[a-z0-9_]{1,15}$/i.test(handle)&&u.pathname.split('/')[1]?.toLowerCase()===handle.replace(/^@/,'').toLowerCase())profile='https://x.com/'+handle.replace(/^@/,'');
  if(provider==='youtube'&&c.profileUrl){const p=safeURL(c.profileUrl);if(p&&p.hostname.replace(/^www\./,'')==='youtube.com'&&/^\/(?:@[^/]+|channel\/UC[\w-]+|user\/[^/]+)\/?$/.test(p.pathname))profile=p.href;}
  const id=createHash('sha256').update(provider+'|'+(profile?(provider==='reddit'?profile.toLowerCase():profile):u.href)+'|'+c.relationship).digest('hex').slice(0,40);
  const row=researchProspectSchema.parse({...(c.matchType?{matchType:c.matchType}:{}),...(c.needStatus?{needStatus:c.needStatus}:{}),id,provider,publicHandle:handle,displayName:c.displayName||handle||'Author not identified',profileUrl:profile,relationship:c.relationship,status:'needs_review',problem:c.problem,fitReason:c.fitReason,matchedCapabilityIds:matched,evidence:[{url:u.href,title:'Source found in web search',excerpt:c.excerpt,publishedAt:c.publishedAt??null,verifiedAt:now.toISOString(),verification:'web_search'}]});
  const prior=unique.get(id);
  if(!prior)unique.set(id,row);
  else {
   if(!prior.evidence.some(e=>e.url===u.href)&&prior.evidence.length<8)prior.evidence.push(row.evidence[0]!);
   if(row.needStatus==='subsequently_resolved'){
    prior.needStatus=row.needStatus;prior.fitReason=row.fitReason;
   }
  }
 }
 return [...unique.values()];
}
