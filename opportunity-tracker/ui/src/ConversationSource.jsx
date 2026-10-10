import {ArrowUpRight,Lock} from 'lucide-react';
import {date,platform,safeURL,sourceLabel} from './api';
import {conversationSource} from './source-context.mjs';
import redditIcon from './assets/reddit.svg';

function Byline({item,type,optional=false}){
 const author=typeof item.author==='string'?item.author.trim():'';
 if(optional&&!author&&!item.publishedAt)return null;
 return <p className="detail-byline source-byline">
  {author&&<><span>{platform(item)==='reddit'?`u/${author.replace(/^u\//,'')}`:author}</span><span aria-hidden="true">·</span></>}
  <span>{type}</span>{(!optional||item.publishedAt)&&<><span aria-hidden="true">·</span><span>{date(item.publishedAt)}</span></>}
 </p>;
}

export function ConversationSource({item,items}){
 const source=conversationSource(item,items),reddit=platform(item)==='reddit';
 const label=sourceLabel(item).replace(/ · comment$/,'');
 const provider=reddit?`Reddit${label.startsWith('r/')?` · ${label}`:''}`:label;
 const earlier=item.historical||item.publishedAt&&Date.parse(item.publishedAt)<Date.now()-30*86400000;
 const discussionURL=safeURL(source.discussion.url);
 const discussionBody=source.isComment?source.discussion.body:source.body;
 const captionInTitle=['tiktok','instagram'].includes(platform(item))&&Boolean(source.discussion.body)&&source.discussion.body===source.discussion.title;
 return <div className="desk-source-content">
  <div className="desk-source-identity">
   <span className="desk-source-provider">{reddit&&<img src={redditIcon} alt="" width="22" height="22"/>}<span>{provider}</span></span>
   {item.discussionClosed&&<span className="desk-source-status"><Lock aria-hidden="true"/>Replies closed</span>}
  </div>
  {item.currentConversationRelevant===false&&<p className="historical-note">This saved conversation needs review against the current business profile.</p>}
  {earlier&&!item.discussionClosed&&<p className="historical-note">Earlier conversation · check whether the need is still current.</p>}
  <section className="desk-discussion" aria-labelledby="desk-conversation-title">
   <p className="desk-source-label">{source.isComment?'Discussion':'Original post'}</p>
   <h3 id="desk-conversation-title" className="desk-discussion-title" tabIndex={-1}>{source.discussion.title}</h3>
   <Byline item={source.isComment?{...source.discussion,source:item.source}:item} type="Post" optional={source.isComment}/>
   {discussionBody&&!captionInTitle?<p className="desk-discussion-body">{discussionBody}</p>:captionInTitle?null:<p className="desk-source-unavailable">Post text unavailable</p>}
   {source.isComment&&discussionURL&&<a className="desk-discussion-link" href={discussionURL} target="_blank" rel="noopener noreferrer"><ArrowUpRight aria-hidden="true"/>Open discussion</a>}
  </section>
  {source.isComment&&<section className="desk-selected-comment" aria-labelledby="desk-comment-label">
   <h4 id="desk-comment-label" className="desk-source-label">Selected comment</h4>
   <Byline item={item} type="Comment"/>
   <div className="desk-comment-thread">{source.body?<blockquote className="desk-comment-body">{source.body}</blockquote>:<p className="desk-source-unavailable">Comment text unavailable</p>}</div>
  </section>}
 </div>;
}
