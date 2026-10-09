// ScrapeBadger public search adapters. No media downloads or inferred image text.
export const SOCIAL_PLATFORMS=['tiktok','instagram'];
export const SOCIAL_INTERVAL_MS=24*60*60*1000;
export const SOCIAL_LABELS={tiktok:'TikTok',instagram:'Instagram'};
const numeric=/^\d{1,30}$/,shortcode=/^[A-Za-z0-9_-]{1,64}$/;
const string=value=>typeof value==='string'?value.trim():'';
const id=value=>typeof value==='string'?value:Number.isSafeInteger(value)?String(value):'';
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;

export function socialDue(product,data,platform,now=Date.now()){
  if(product[platform]!==true)return false;
  const search=data.searches?.[product.id];
  const check=search?.lastChecks?.[platform]||search?.sources?.find(s=>s.name===SOCIAL_LABELS[platform])?.checkedAt;
  const last=Math.max(Date.parse(check)||0,Date.parse(product.monitorAttempts?.[platform])||0);
  return !last||now-last>=SOCIAL_INTERVAL_MS;
}

// The query parameter is source identity, not a tracking parameter. Keep it
// across evidence storage and backup so comments never collapse into a post.
export function canonicalSocialSource(row){
  let url;try{url=new URL(row?.url);}catch{return null;}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port)return null;
  const platform=row.source?.startsWith('TikTok')?'tiktok':row.source?.startsWith('Instagram')?'instagram':null;
  if(!platform)return null;
  let post,match;
  if(platform==='tiktok'){
    if(!['tiktok.com','www.tiktok.com'].includes(url.hostname))return null;
    match=url.pathname.match(/^\/@([A-Za-z0-9._]{1,64})\/video\/(\d{1,30})\/?$/);
    if(!match)return null;post=match[2];url.pathname=`/@${match[1]}/video/${post}`;
  }else{
    if(!['instagram.com','www.instagram.com'].includes(url.hostname))return null;
    match=url.pathname.match(/^\/(p|reel|tv)\/([A-Za-z0-9_-]{1,64})\/?$/);
    if(!match)return null;post=match[2];url.pathname=`/${match[1]}/${post}/`;
  }
  const comment=url.searchParams.get('comment_id');
  if(comment!==null&&!numeric.test(comment))return null;
  if(row.type==='comment'&&!comment||row.type==='post'&&comment)return null;
  url.protocol='https:';url.hostname=`www.${platform}.com`;url.search='';url.hash='';
  if(comment)url.searchParams.set('comment_id',comment);
  return {identity:`${platform}:${comment?`comment:${post}:${comment}`:post}`,platform,url:url.href,post,comment};
}

function published(value,unix,collectedAt){
  const date=typeof value==='string'&&value.trim()?Date.parse(value):typeof unix==='number'?unix*1000:NaN;
  return Number.isFinite(date)&&date>0&&date<=Date.parse(collectedAt)+300000?new Date(date).toISOString():null;
}
function postRow(platform,value,collectedAt,{preserveText=false}={}){
  const isTikTok=platform==='tiktok';
  const post=id(isTikTok?value.id:value.code??value.shortcode);
  const author=string(isTikTok?value.author?.unique_id:value.user?.username??value.owner?.username);
  if(!(isTikTok?numeric:shortcode).test(post)||!author||!/^[A-Za-z0-9._]{1,64}$/.test(author)||value.is_private===true||value.user?.is_private===true||value.owner?.is_private===true)return null;
  const text=string(isTikTok?value.description??value.desc:value.caption_text??(typeof value.caption==='string'?value.caption:value.caption?.text));
  const supplied=string(value.url||value.share_url);
  const fallback=isTikTok?`https://www.tiktok.com/@${author}/video/${post}`:`https://www.instagram.com/${value.product_type==='clips'?'reel':'p'}/${post}/`;
  const source=SOCIAL_LABELS[platform],canonical=canonicalSocialSource({source,type:'post',url:supplied||fallback});
  if(!canonical||canonical.post!==post)return null;
  const at=published(isTikTok?value.create_time_at:value.taken_at,isTikTok?value.create_time_utc??value.create_time:value.taken_at_utc,collectedAt);
  if(!at)return null;
  return {source,provider:'scrapebadger',sourceId:`${isTikTok?'tt':'ig'}_${post}`,postId:`${isTikTok?'tt':'ig'}_${post}`,parentId:null,type:'post',url:canonical.url,title:text.slice(0,180)||`${source} post`,snippet:preserveText?text:text.slice(0,10000),author,publishedAt:at,collectedAt,commentCount:count(isTikTok?value.stats?.comment_count:value.comment_count),discussionClosed:value.comments_disabled===true};
}
export function normalizeSocialPost(platform,value,collectedAt,options={}){
  if(!SOCIAL_PLATFORMS.includes(platform)||!value||typeof value!=='object')return null;
  return postRow(platform,value.media&&typeof value.media==='object'?value.media:value,collectedAt,options);
}
export function normalizeSocialComment(platform,value,post,collectedAt,{preserveText=false}={}){
  if(!value||typeof value!=='object')return null;
  const parent=canonicalSocialSource(post),comment=id(value.id??value.pk),text=string(value.text);
  if(!parent||parent.platform!==platform||parent.comment||!numeric.test(comment)||!text)return null;
  if(platform==='tiktok'&&(id(value.aweme_id)!==parent.post||value.parent_comment_id!=null))return null;
  const author=string(platform==='tiktok'?value.author?.unique_id:value.user?.username);
  const at=published(platform==='tiktok'?value.create_time_at:value.created_at,platform==='tiktok'?value.create_time_utc:value.created_at_utc,collectedAt);
  if(!author||!/^[A-Za-z0-9._]{1,64}$/.test(author)||!at)return null;
  const url=new URL(parent.url);url.searchParams.set('comment_id',comment);
  return {source:`${SOCIAL_LABELS[platform]} comment`,provider:'scrapebadger',sourceId:`${platform==='tiktok'?'ttc':'igc'}_${comment}`,postId:post.postId,parentId:post.postId,type:'comment',url:url.href,title:text.slice(0,180),snippet:preserveText?text:text.slice(0,10000),author,publishedAt:at,collectedAt,context:preserveText?`${post.title}\n${post.snippet}`:`${post.title}\n${post.snippet}`.slice(0,1500),discussionClosed:post.discussionClosed===true};
}
export function socialTaskPlatform(task){
  return SOCIAL_PLATFORMS.find(p=>task.kind===p||task.kind===`${p}_comments`)||null;
}
export function socialTaskURL(task){
  const platform=socialTaskPlatform(task);if(!platform)return null;
  const comments=task.kind.endsWith('_comments');
  const post=comments?canonicalSocialSource(task.post):null;
  if(comments&&(!post||post.platform!==platform||post.comment))throw Error('invalid_social_post');
  const path=comments?platform==='tiktok'?`tiktok/videos/${post.post}/comments`:`instagram/media/${post.post}/comments`:platform==='tiktok'?'tiktok/search/videos':'instagram/search/top';
  const url=new URL(`https://scrapebadger.com/v1/${path}`);
  if(!comments){if(!string(task.query))throw Error('invalid_social_query');url.searchParams.set('query',task.query);}
  if(platform==='tiktok'){url.searchParams.set('region','US');url.searchParams.set('count',comments?'50':'30');if(task.cursor)url.searchParams.set('cursor',task.cursor);}
  else if(comments)url.searchParams.set('amount','50');
  // Instagram top search has no documented pagination input. Fetch one page.
  return url.href;
}
export function parseSocialPage(task,body,collectedAt,{preserveText=false}={}){
  const platform=socialTaskPlatform(task),comments=task.kind.endsWith('_comments');
  const values=platform==='tiktok'?body[comments?'comments':'videos']:body.items;
  if(!Array.isArray(values)||values.length>100)throw Error('invalid_social_response');
  const rows=values.map(value=>comments?normalizeSocialComment(platform,value,task.post,collectedAt,{preserveText}):normalizeSocialPost(platform,value,collectedAt,{preserveText})).filter(Boolean);
  let cursor=platform==='tiktok'&&body.pagination?.has_more===true?body.pagination.cursor:null;
  if(cursor!=null&&(typeof cursor!=='string'||!cursor.trim()||cursor.length>2048||/[\x00-\x1f]/.test(cursor)))throw Error('invalid_cursor');
  const incomplete=comments?platform==='tiktok'?body.pagination?.has_more===true:body.has_more===true:platform==='instagram'&&body.has_more===true;
  return {rows,cursor:comments?null:cursor,oldest:rows.length?Math.min(...rows.map(row=>Date.parse(row.publishedAt))):null,rawCount:values.length,...(incomplete?{partial:true}:{}),...(values.length>rows.length?{omitted:values.length-rows.length}:{})};
}
