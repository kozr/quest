const text=value=>typeof value==='string'?value.trim():'';

// A comment permalink identifies its discussion; never guess a parent on another host.
export function redditDiscussionURL(value){
 try{
  const url=new URL(value);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||!/(^|\.)reddit\.com$/i.test(url.hostname))return undefined;
  const match=url.pathname.match(/^\/(?:r\/[^/]+\/)?comments\/[a-z0-9]+(?:\/|$)/i);
  if(!match)return undefined;
  url.hostname='www.reddit.com';url.protocol='https:';url.port='';
  url.pathname=match[0].replace(/\/?$/,'/');url.search='';url.hash='';
  return url.href;
 }catch{return undefined;}
}

function socialDiscussionURL(item){
 try{const url=new URL(item.url);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port)return undefined;
  const tiktok=item.source?.startsWith('TikTok')&&['www.tiktok.com','tiktok.com'].includes(url.hostname)&&/^\/@[A-Za-z0-9._]{1,64}\/video\/\d{1,30}\/?$/.test(url.pathname);
  const instagram=item.source?.startsWith('Instagram')&&['www.instagram.com','instagram.com'].includes(url.hostname)&&/^\/(p|reel|tv)\/[A-Za-z0-9_-]{1,64}\/?$/.test(url.pathname);
  if(!tiktok&&!instagram)return undefined;url.protocol='https:';url.hostname=tiktok?'www.tiktok.com':'www.instagram.com';url.search='';url.hash='';return url.href;
 }catch{return undefined;}
}
export function conversationSource(item,items=[]){
 const isComment=item.type==='comment',body=text(item.snippet)|| (isComment?text(item.title):'');
 if(!isComment)return {isComment,body:body===text(item.title)?'':body,discussion:{title:text(item.title)||'Post',body,url:item.url,author:item.author,publishedAt:item.publishedAt}};
 const discussionURL=value=>redditDiscussionURL(value.url)||socialDiscussionURL(value);
 const url=discussionURL(item),context=text(item.context),[contextTitle='',...contextLines]=context.split(/\r?\n/);
 const parent=url?items.find(candidate=>candidate.type==='post'&&candidate.productId===item.productId&&discussionURL(candidate)===url):undefined;
 return {isComment,body,discussion:{title:text(parent?.title)||contextTitle.trim()||'Original discussion',body:text(parent?.snippet)||contextLines.join('\n').trim(),url,author:parent?.author,publishedAt:parent?.publishedAt}};
}
