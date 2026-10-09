import {canonicalReviewURL,reviewListingEvidence} from './review-identity.mjs';
export {canonicalReviewURL,reviewListingEvidence} from './review-identity.mjs';
import {load} from 'cheerio';
import {createHash} from 'node:crypto';
import {publicUrl} from './metadata.mjs';
import {plannedQueries} from './search-plan.mjs';
import {businessReferences,namedReference,trustedBusinessIdentifiers} from './entity-mention.mjs';
import {canonicalSocialSource,normalizeSocialPost} from './social-search.mjs';
import {normalizeScrapeBadgerPost} from './reddit/scrapebadger.mjs';

export const DISCOVERY_VERSION=2,DISCOVERY_INTERVAL_MS=86400000;
export const DISCOVERY_LABELS={google:'Google discovery',maps:'Google Maps reviews',app_store_reviews:'App Store reviews'};
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const iso=x=>new Date(x).toISOString();
const clean=x=>typeof x==='string'?x.trim():'';
const quote=x=>'"'+x.replace(/["\\\n\r]/g,' ').trim()+'"';
const dataID=/^0x[a-f0-9]+:0x[a-f0-9]+$/i;
export function mentionQueries(product){
  if(product.listeningVersion!=='v2')return [];
  const refs=businessReferences(product);
  return plannedQueries(product,'reddit',{loop:'keyword'}).filter(q=>q.purposes?.includes('mention')&&refs.some(r=>namedReference(q.query,r)));
}
export function googleQueries(product){
  const names=[...new Set(mentionQueries(product).map(q=>q.query))];
  if(!names.length)return [];
  const primary=quote(product.name);
  return [...new Set([...names,`${primary} site:reddit.com`,`${primary} site:instagram.com`])].slice(0,8).map((query,i)=>({kind:'google_search',query,queryId:`google_${hash(query).slice(0,12)}`,queryFamily:'keyword',purposes:['mention'],page:1,maxPages:5}));
}
export function localIdentity(product){
  const rows=(product.businessProfileV2?.constraints||[]).filter(r=>/\b(?:located|location|address|street|avenue|road|neighborhood|neighbourhood|city|postal|zip)\b/i.test(`${r.text} ${r.quote}`));
  return rows.map(r=>r.quote).join(' ').slice(0,240);
}
export function discoveryTasks(product,{settings={},historical=false,cutoff,until}={}){
  if(!settings.extendedDiscoveryEnabled||!mentionQueries(product).length)return [];
  const tasks=googleQueries(product).map(t=>({...t,maxPages:historical?5:1}));
  if(localIdentity(product)&&trustedBusinessIdentifiers(product).some(r=>r.kind==='domain'))tasks.push({kind:'maps_search',query:`${product.name} ${localIdentity(product)}`,queryId:'google_business_reviews',queryFamily:'keyword',purposes:['mention','feedback'],page:1});
  const app=trustedBusinessIdentifiers(product).find(r=>r.key.startsWith('apple:'));
  if(app)for(const country of [...new Set([new URL(product.url).pathname.split('/')[1]||'us','ca'])])tasks.push({kind:'app_store_reviews',appId:app.value.slice(2),country,queryId:`app_reviews_${country}`,queryFamily:'keyword',purposes:['mention','feedback'],page:1});
  return tasks.map(t=>({...t,...(historical?{historical:true,cutoff,until}:{})}));
}
export function discoveryPlatform(task){return task.kind.startsWith('maps_')?'maps':task.kind==='app_store_reviews'?'app_store_reviews':['google_search','reddit_post','instagram_post','web_page'].includes(task.kind)?'google':null;}
export function discoveryTaskURL(task){
  const url=new URL('https://scrapebadger.com/v1/'+({google_search:'google/search',maps_search:'google/maps/search',maps_place:'google/maps/place',maps_reviews:'google/maps/reviews',reddit_post:`reddit/posts/${task.postId}`,instagram_post:`instagram/media/${task.shortcode}`,web_page:'web/scrape',app_store_reviews:`app-store/apps/${task.appId}/reviews`}[task.kind]));
  const params=task.kind==='google_search'?{q:task.query,start:String((task.page-1)*10),hl:'en',filter:'0',nfpr:'1',...(task.historical?{tbs:`cdr:1,cd_min:${iso(task.cutoff).slice(0,10)},cd_max:${iso(task.until).slice(0,10)}`}:{tbs:'qdr:w'})}:task.kind==='maps_search'?{q:task.query}:task.kind==='maps_place'?{data_id:task.dataId}:task.kind==='maps_reviews'?{data_id:task.place.dataId,sort_by:'newestFirst',results:'20',offset:String((task.page-1)*20),...(task.cursor&&!task.cursor.startsWith('offset:')?{next_page_token:task.cursor}:{})}:task.kind==='app_store_reviews'?{country:task.country||'ca',page:String(task.page),sort:'mostRecent'}:{};
  url.search=new URLSearchParams(params).toString();return url.href;
}
export function discoveryReservation(task){return task.kind==='web_page'?6:task.kind==='reddit_post'?8:task.kind==='instagram_post'?105:task.kind==='app_store_reviews'?105:20;}
export function originalTask(candidate){
  let url;try{url=publicUrl(candidate.url);}catch{return null;}
  if(/(^|\.)reddit\.com$/.test(url.hostname)){
    const m=url.pathname.match(/^\/r\/([a-z0-9_]+)\/comments\/([a-z0-9]+)(?:\/[^/]+)?(?:\/([a-z0-9]+))?\/?$/i);
    return m?{kind:'reddit_post',postId:m[2],name:m[1].toLowerCase(),targetCommentId:m[3]||null}:null;
  }
  const social=canonicalSocialSource({source:'Instagram',url:url.href});
  if(social)return {kind:'instagram_post',shortcode:social.post};
  if(/(^|\.)(?:x\.com|twitter\.com|linkedin\.com|tiktok\.com|google\.com|youtube\.com|facebook\.com|instagram\.com)$/.test(url.hostname))return null;
  return {kind:'web_page',originalURL:url.href};
}
export function verifiedPlace(product,value,now){
  if(!value||!dataID.test(value.data_id||''))return null;
  let website;try{website=publicUrl(value.website).href;}catch{return null;}
  const host=new URL(website).hostname.replace(/^www\./,'').toLowerCase();
  if(!trustedBusinessIdentifiers(product).some(r=>r.kind==='domain'&&r.host===host)||!namedReference(value.title,product.name))return null;
  return {version:1,dataId:value.data_id,title:clean(value.title),address:clean(value.address),website,officialDomain:host,verifiedAt:iso(now),cid:BigInt(value.data_id.split(':')[1]).toString()};
}
export function parseDiscoveryPage(task,body,collectedAt,{preserveText=true}={}){
  if(task.kind==='google_search'){
    if(!Array.isArray(body.organic_results)||body.organic_results.length>100)throw Error('invalid_google_response');
    const discoveries=body.organic_results.flatMap(r=>{try{return [{url:publicUrl(r.link).href,title:clean(r.title).slice(0,500),searchSnippet:clean(r.snippet).slice(0,1500)}];}catch{return [];}});
    return {rows:[],discoveries,cursor:body.pagination?.next||body.organic_results.length>=10?String(task.page*10):null,rawCount:body.organic_results.length,oldest:null};
  }
  if(task.kind==='maps_search'){
    if(!Array.isArray(body.results)||body.results.length>100)throw Error('invalid_maps_response');
    return {rows:[],places:body.results.filter(p=>dataID.test(p.data_id||'')).slice(0,3),rawCount:body.results.length,cursor:null,oldest:null};
  }
  if(task.kind==='maps_place')return {rows:[],place:body.place,rawCount:0,cursor:null,oldest:null};
  if(task.kind==='maps_reviews'){
    if(!Array.isArray(body.reviews)||body.reviews.length>100||!body.location||!namedReference(body.location.title,task.place.title)||body.location.address&&task.place.address&&clean(body.location.address)!==task.place.address)throw Error('review_listing_mismatch');
    const rows=[],stamps=[];let invalid=0,ratingsOnly=0;
    for(const r of body.reviews){
      const text=clean(r.text),author=clean(r.user?.name),contributorId=String(r.user?.contributor_id||''),time=Date.parse(r.iso_date);
      if(Number.isFinite(time))stamps.push(time);
      if(!text){ratingsOnly++;continue;}
      if(!author||!/^\d{1,30}$/.test(contributorId)||!Number.isFinite(time)||time>Date.parse(collectedAt)+300000){invalid++;continue;}
      const key=hash([task.place.dataId,contributorId]).slice(0,32),url=`https://www.google.com/maps?cid=${task.place.cid}&review_key=${key}`;
      rows.push({source:'Google Maps review',provider:'scrapebadger',sourceId:`gm_${key}`,postId:task.place.dataId,parentId:null,type:'comment',url,title:text.slice(0,180),snippet:text,author,publishedAt:iso(time),collectedAt,rating:r.rating,sourceLinkKind:'listing',businessReview:{...task.place,contributorId},context:`${task.place.title}\n${task.place.address}\n${task.place.website}`});
    }
    const next=body.pagination?.next;let cursor=null;if(typeof next==='string'&&next){try{cursor=new URL(next).searchParams.get('next_page_token');}catch{cursor=next;}}
    return {rows,cursor,oldest:stamps.length?Math.min(...stamps):null,rawCount:body.reviews.length,omitted:invalid,ratingsOnly,offsetContinuation:!cursor&&body.reviews.length>=20};
  }
  if(task.kind==='app_store_reviews'){
    if(String(body.app_id)!==task.appId||body.country!==task.country||!Array.isArray(body.reviews)||body.reviews.length>50)throw Error('invalid_app_review_response');
    const rows=body.reviews.flatMap(r=>{const time=Date.parse(r.updated_at),id=String(r.review_id||''),text=clean(r.content),author=clean(r.user_name);if(!/^\d{1,30}$/.test(id)||!text||!author||!Number.isFinite(time)||time>Date.parse(collectedAt)+300000)return [];return [{source:'App Store review',provider:'scrapebadger',sourceId:`as_${id}`,postId:`id${task.appId}`,parentId:null,type:'comment',url:`https://apps.apple.com/${task.country}/app/id${task.appId}?review_id=${id}`,title:clean(r.title)||text.slice(0,180),snippet:text,author,publishedAt:iso(time),collectedAt,rating:r.rating,sourceLinkKind:'listing',businessReview:{version:1,appId:task.appId,reviewId:id,country:task.country}}];});
    const oldest=rows.length?Math.min(...rows.map(r=>Date.parse(r.publishedAt))):null,more=body.reviews.length===50&&!(oldest<task.cutoff);
    return {rows,cursor:more&&task.page<10?String(task.page+1):null,rawCount:body.reviews.length,oldest,omitted:body.reviews.length-rows.length,partial:more&&task.page>=10};
  }
  if(task.kind==='reddit_post'){
    const row=normalizeScrapeBadgerPost(body.post??body,collectedAt,{includeClosed:true,preserveText});
    if(!row||row.postId!==`t3_${task.postId}`)throw Error('invalid_discovered_reddit_post');
    return {rows:[row],rawCount:1,cursor:null,oldest:Date.parse(row.publishedAt)};
  }
  if(task.kind==='instagram_post'){
    const row=normalizeSocialPost('instagram',body.media??body,collectedAt,{preserveText});
    if(!row||row.sourceId!==`ig_${task.shortcode}`)throw Error('invalid_discovered_instagram_post');
    return {rows:[row],rawCount:1,cursor:null,oldest:Date.parse(row.publishedAt)};
  }
  if(task.kind==='web_page'){
    if(body.success===false||body.status_code!==200||typeof body.content!=='string'||body.content.length>1500000||body.is_binary)throw Error('original_page_unavailable');
    const parsedURL=publicUrl(body.url||task.originalURL);for(const key of [...parsedURL.searchParams.keys()])if(/^utm_|^(fbclid|gclid|ref|tracking)$/i.test(key))parsedURL.searchParams.delete(key);const url=parsedURL.href,$=load(body.content);
    const structured=[];$('script[type="application/ld+json"]').each((_,el)=>{try{const v=JSON.parse($(el).text());const values=Array.isArray(v)?v:[v];for(const x of values.slice(0,20))structured.push(...(Array.isArray(x['@graph'])?x['@graph'].slice(0,20):[x]));}catch{}});
    const articleData=structured.find(x=>x.datePublished&&/Article|Posting|Review/i.test(String(x['@type'])))||{};
    $('script,style,noscript,header,footer,nav,form,iframe,aside').remove();
    const article=$('article').first(),main=$('main').first(),text=(article.length?article:main.length?main:$('body')).text().replace(/\s+/g,' ').trim();
    if(!text)throw Error('original_page_text_missing');
    const title=clean($('meta[property="og:title"]').attr('content')||$('title').text()).slice(0,500),author=clean($('meta[name="author"]').attr('content')||articleData.author?.name||articleData.author?.[0]?.name)||null;
    const time=Date.parse($('meta[property="article:published_time"]').attr('content')||$('meta[itemprop="datePublished"]').attr('content')||$('time[datetime]').first().attr('datetime')||articleData.datePublished);
    return {rows:[{source:'Web',provider:'scrapebadger',sourceId:`web_${hash(url).slice(0,32)}`,postId:null,parentId:null,type:'post',url,title,snippet:text,author,publishedAt:Number.isFinite(time)&&time<=Date.parse(collectedAt)+300000?iso(time):null,collectedAt,contentOrigin:'original_page'}],rawCount:1,cursor:null,oldest:Number.isFinite(time)?time:null};
  }
  throw Error('unsupported_discovery_task');
}
export function applyDiscoveryPage(data,cycle,task,result,now){
  const product=data.products.find(p=>p.id===cycle.productId),s=data.collection;
  s.discoveries||={};const records=s.discoveries[cycle.productId]||={};
  const wrap=t=>({...t,queryFamily:task.queryFamily,queryId:task.queryId,purposes:task.purposes,page:1,cutoff:task.cutoff,until:task.until,historical:task.historical,branch:task.branch,loopRunId:task.loopRunId,runStartedAt:task.runStartedAt,discoverySource:task.discoverySource||'google'});
  for(const value of result.discoveries||[]){
    const key=hash(value.url),prior=records[key],original=originalTask(value),changed=prior?.status!=='retrieved'&&!cycle.queue.some(t=>t.discoveryKey===key);
    records[key]={...prior,...value,queryId:task.queryId,firstDiscoveredAt:prior?.firstDiscoveredAt||iso(now),lastDiscoveredAt:iso(now),status:prior?.status==='retrieved'?'retrieved':original?'awaiting_original':'unsupported_original'};
    if(original&&changed)cycle.queue.push({...wrap(original),discoveryKey:key,discoveryURL:value.url});
  }
  if(task.discoveryKey&&records[task.discoveryKey])records[task.discoveryKey]={...records[task.discoveryKey],status:'retrieved',lastFetchedAt:iso(now)};
  if(task.kind==='maps_search')for(const place of result.places||[])cycle.queue.push(wrap({kind:'maps_place',dataId:place.data_id}));
  if(task.kind==='maps_place'){
    const place=verifiedPlace(product,result.place,now);
    if(place&&!cycle.queue.some(t=>t.kind==='maps_reviews'&&t.place.dataId===place.dataId)){(s.reviewPlaces||={})[product.id]=place;cycle.queue.push(wrap({kind:'maps_reviews',place}));}
    else cycle.errors.push('maps_place:business_identity_unconfirmed');
  }
  if(task.kind==='reddit_post'&&result.rows[0])cycle.queue.push(wrap({kind:'comments',post:result.rows[0],includeClosed:true,discoveredThread:true}));
  if(task.discoverySource||task.kind==='maps_reviews')result.rows=result.rows.map(row=>({...row,...(task.discoverySource?{discoverySource:task.discoverySource||'google',discoveryURL:task.discoveryURL||row.url}:{})}));
  if(task.kind==='maps_reviews'&&result.offsetContinuation)result.cursor=`offset:${task.page*20}`;
  if(task.kind==='maps_reviews'&&Number.isFinite(result.oldest)&&result.oldest<task.cutoff)result.cursor=null;
  if(task.kind==='google_search'&&result.cursor&&task.page>=task.maxPages){result.cursor=null;result.partial=true;}
}
