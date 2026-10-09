const PURPOSE_LABELS={potential_customer:'Potential customer',mention:'Mention',feedback:'Feedback',competitor:'Competitor'};
import {useEffect,useState} from 'react';
import {ArrowLeft,ArrowUpRight,Bookmark,Check,ChevronLeft,ChevronRight,Inbox,PanelLeft,RefreshCw,Search,SlidersHorizontal,X} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Skeleton} from '@/components/ui/skeleton';
import {DropdownMenu,DropdownMenuContent,DropdownMenuLabel,DropdownMenuRadioGroup,DropdownMenuRadioItem,DropdownMenuSeparator,DropdownMenuTrigger} from '@/components/ui/dropdown-menu';
import {CollectionProgress} from './WorkspaceViews';
import {date,platform,safeURL,sourceLabel} from './api';
import {purposeEvidence} from './feed.mjs';

export function ConversationsDesk({title="Conversations",relevance="all",state,filtered,visible,selected,pageIndex,pageSize,onPage,onSelect,mobileDetail,onMobileDetail,detailHeading,query,onQuery,platformFilter,onPlatform,statusFilter,onStatus,products,busy,find,action,updateReview,showPlaceholders,addProduct,renderNotes,renderDraft}) {
 const [queueOpen,setQueueOpen]=useState(false);
 const [mobileTab,setMobileTab]=useState('source');
 const [narrow,setNarrow]=useState(()=>matchMedia('(max-width: 900px)').matches);
 const evidence=purposeEvidence(selected,relevance);
 const selectedIndex=filtered.findIndex(item=>item.id===selected?.id);
 const queueVisible=narrow?!mobileDetail:queueOpen||!selected;
 useEffect(()=>{
  const media=matchMedia('(max-width: 900px)'),change=()=>setNarrow(media.matches);
  media.addEventListener('change',change);
  return()=>media.removeEventListener('change',change);
 },[]);
 useEffect(()=>{
  if(narrow&&mobileDetail)requestAnimationFrame(()=>document.getElementById(mobileTab==='source'?'desk-conversation-title':'draft-heading')?.focus());
 },[narrow,mobileDetail,selected?.id]);
 useEffect(()=>{
  const move=event=>{
   if(event.defaultPrevented||event.metaKey||event.ctrlKey||event.altKey||event.target.closest('input,textarea,select,[contenteditable="true"],[role="menu"],[role="dialog"]'))return;
   const offset=event.key==='j'?1:event.key==='k'?-1:0;
   if(!offset)return;
   const item=filtered[selectedIndex+offset];
   if(item){event.preventDefault();onSelect(item);}
  };
  window.addEventListener('keydown',move);
  return()=>window.removeEventListener('keydown',move);
 },[filtered,selectedIndex,onSelect]);
 function toggleQueue(){
  if(narrow){onMobileDetail(false);requestAnimationFrame(()=>document.getElementById(`conversation-${selected?.id}`)?.focus());}
  else setQueueOpen(open=>!open);
 }
 function select(item){onSelect(item);}
 function navigateTab(event){
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();
  const next=event.key==='Home'?'source':event.key==='End'?'draft':mobileTab==='source'?'draft':'source';
  setMobileTab(next);
  event.currentTarget.parentElement.querySelector(`[aria-controls="conversation-${next}"]`)?.focus();
 }
 const filters=(statusFilter!=='active'?1:0)+(platformFilter!=='all'?1:0);
 return <div className={`conversations-desk ${queueVisible?'queue-open':''} ${mobileDetail?'show-detail':''}`}>
  <header className="desk-toolbar">
   <h1>{title}</h1>
   <Button className="desk-queue-toggle" variant="outline" onClick={toggleQueue} aria-controls="conversation-queue" aria-expanded={queueVisible} hidden={narrow&&!mobileDetail}>
    {narrow?<ArrowLeft/>:<PanelLeft/>}{narrow?'All conversations':queueVisible?'Hide conversations':'Show conversations'}
   </Button>
   <nav className="desk-selection" aria-label="Navigate conversations">
    <span role="status" aria-live="polite">{selectedIndex>=0?selectedIndex+1:0} of {filtered.length}</span>
    <Button variant="outline" size="icon" aria-label="Previous conversation" title="Previous conversation (K)" disabled={selectedIndex<=0} onClick={()=>select(filtered[selectedIndex-1])}><ChevronLeft/></Button>
    <Button variant="outline" size="icon" aria-label="Next conversation" title="Next conversation (J)" disabled={selectedIndex<0||selectedIndex>=filtered.length-1} onClick={()=>select(filtered[selectedIndex+1])}><ChevronRight/></Button>
   </nav>
   <div className="search-field"><Search aria-hidden="true"/><Input value={query} onChange={event=>onQuery(event.target.value)} placeholder="Search conversations" aria-label="Search conversations"/></div>
   <DropdownMenu>
    <DropdownMenuTrigger asChild><Button variant="outline" className="desk-filters" aria-label={`Filter conversations${filters?` (${filters} active)`:''}`}><SlidersHorizontal/><span>Filters{filters?` (${filters})`:''}</span></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="desk-filter-menu">
     <DropdownMenuLabel>Status</DropdownMenuLabel>
     <DropdownMenuRadioGroup value={statusFilter} onValueChange={onStatus}>{[['active','All active'],['new','New'],['dismissed','Dismissed']].map(([value,label])=><DropdownMenuRadioItem key={value} value={value}>{label}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup>
     <DropdownMenuSeparator/><DropdownMenuLabel>Platform</DropdownMenuLabel>
     <DropdownMenuRadioGroup value={platformFilter} onValueChange={onPlatform}>{[['all','All platforms'],['reddit','Reddit'],['x','X'],['linkedin','LinkedIn'],['other','Other']].filter(([id])=>id!=='other'||state.items.some(item=>platform(item)==='other')).map(([value,label])=><DropdownMenuRadioItem key={value} value={value}>{label}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup>

    </DropdownMenuContent>
   </DropdownMenu>
   <details className="desk-updates"><summary>Updates</summary><div className="desk-update-content"><CollectionProgress state={state} products={products} action={action} busy={busy}/><Button variant="outline" size="sm" onClick={find} disabled={!!busy||!products.length}><RefreshCw className={busy==='collection'?'spin':''}/>{busy==='collection'?'Checking…':'Check now'}</Button><p className="muted">Reddit and X monitoring every two hours</p></div></details>
   <span className="workspace-date">{date(new Date().toISOString())}</span>
  </header>
  {narrow&&mobileDetail&&<div className="desk-mobile-tabs" role="tablist" aria-label="Conversation workspace"><button role="tab" tabIndex={mobileTab==='source'?0:-1} aria-selected={mobileTab==='source'} aria-controls="conversation-source" onKeyDown={navigateTab} onClick={()=>setMobileTab('source')}>Source and context</button><button role="tab" tabIndex={mobileTab==='draft'?0:-1} aria-selected={mobileTab==='draft'} aria-controls="conversation-draft" onKeyDown={navigateTab} onClick={()=>setMobileTab('draft')}>Draft response</button></div>}
  <div className="desk-panes">
   <aside id="conversation-queue" className="desk-queue" aria-label="Conversation queue" hidden={!queueVisible}>
    <div className="desk-queue-heading"><h2>Conversation queue</h2><span>{filtered.length} {filtered.length===1?'conversation':'conversations'}</span></div>
    <div className="conversation-list" aria-label="Conversations">
     {visible.length?visible.map(item=><button id={`conversation-${item.id}`} key={item.id} className={`conversation-row ${item.id===selected?.id?'selected':''}`} onClick={()=>select(item)} aria-pressed={item.id===selected?.id}>
      <span className="row-title"><span>{item.title}{item.conversationSignals?.length>0&&<small className={`row-fit ${item.currentOpportunityFit===true?'direct':''}`}>{[...new Set(item.conversationSignals.map(signal=>PURPOSE_LABELS[signal.purpose]))].join(' · ')}</small>}</span>{item.status==='saved'&&<Bookmark className="size-3.5 fill-current" aria-label="Saved"/>}</span>
      <span className="row-source">{sourceLabel(item)}</span><span className="row-date">{date(item.publishedAt)}</span>
     </button>):showPlaceholders?<div aria-label="Finding conversations" aria-busy="true">{[0,1,2].map(number=><div key={number} className="conversation-placeholder" aria-hidden="true"><Skeleton className="placeholder-title"/><Skeleton className="placeholder-source"/><Skeleton className="placeholder-date"/></div>)}</div>:<div className="list-empty"><Inbox className="size-5 text-muted-foreground"/><p>{!state.products.length?'Add your first product':'No conversations in this view'}</p><span>{!state.products.length?'Tell HearWhispers what your product does to start finding relevant discussions.':query||filters?'Try a different filter or search phrase.':'New conversations will appear here as we find them.'}</span><Button variant="outline" onClick={!state.products.length?addProduct:()=>{onQuery('');onPlatform('all');onStatus('active');}}>{!state.products.length?'Add product':'View all active'}</Button></div>}
    </div>
    <footer className="desk-queue-footer"><span>{filtered.length?`${pageIndex*pageSize+1}–${Math.min((pageIndex+1)*pageSize,filtered.length)} of ${filtered.length}`:'0 conversations'}</span><Button variant="ghost" size="icon" disabled={!pageIndex} aria-label="Previous conversations" onClick={()=>onPage(pageIndex-1)}><ChevronLeft/></Button><Button variant="ghost" size="icon" disabled={(pageIndex+1)*pageSize>=filtered.length} aria-label="Next conversations" onClick={()=>onPage(pageIndex+1)}><ChevronRight/></Button></footer>
   </aside>
   {selected?<article className="review-workspace desk-review" aria-label={selected.title} hidden={narrow&&!mobileDetail}>
    <section id="conversation-source" className="source-context" aria-labelledby="context-heading" role={narrow?'tabpanel':undefined} hidden={narrow&&mobileTab!=='source'}>
     <div className="desk-source-heading"><h2 id="context-heading" ref={detailHeading} tabIndex={-1}>Source and context</h2></div>
     <div className="desk-source-scroll" tabIndex={0} aria-label="Conversation source and context">
      <h3 id="desk-conversation-title" className="desk-conversation-title" tabIndex={-1}>{selected.title}</h3>
      <p className="detail-byline">{selected.author&&<><span>{platform(selected)==='reddit'?'u/':''}{selected.author}</span><span aria-hidden="true">·</span></>}<span>{sourceLabel(selected)}</span><span aria-hidden="true">·</span><span>{date(selected.publishedAt)}</span></p>
      {selected.currentConversationRelevant===false&&<p className="historical-note">This saved conversation needs review against the current business profile.</p>}
      {(selected.historical||selected.publishedAt&&Date.parse(selected.publishedAt)<Date.now()-30*86400000||selected.discussionClosed)&&<p className="historical-note">{selected.discussionClosed?'Archived or locked discussion · replies are closed.':'Earlier conversation · check whether the need is still current.'}</p>}
      {selected.snippet&&<figure className="source-quote"><figcaption>{(selected.qualification?.intentQuote||selected.qualification?.quote)?'Evidence from the author':`From the ${selected.type==='comment'?'comment':'post'}`}</figcaption><blockquote>“{evidence.quote}”</blockquote></figure>}
      <details className="relevance match-details" key={`match:${selected.id}:${relevance}`}><summary>Match details</summary>{evidence.signals.length?evidence.signals.map(signal=><p key={signal.purpose}><strong>{PURPOSE_LABELS[signal.purpose]}.</strong> {signal.reason}</p>):<p>{selected.qualification?.whyItFits||selected.reason||'Review this saved source against the current business profile.'}</p>}</details>
      {selected.context&&<details className="context-detail"><summary>Parent discussion</summary><p>{selected.context}</p></details>}
      {renderNotes(selected)}
     </div>
     <div className="detail-actions"><Button asChild variant="ghost" className="source-button"><a href={safeURL(selected.url)} target="_blank" rel="noopener noreferrer">Open original {selected.type==='comment'?'comment':'post'}<ArrowUpRight/></a></Button><Button variant={selected.status==='saved'?'secondary':'ghost'} disabled={!!busy} onClick={()=>updateReview(selected,selected.status==='saved'?'new':'saved')}><Bookmark className={selected.status==='saved'?'fill-current':''}/>{selected.status==='saved'?'Saved':'Save'}</Button><Button variant="ghost" disabled={!!busy} onClick={()=>updateReview(selected,selected.status==='dismissed'?'new':'dismissed')}>{selected.status==='dismissed'?<><Check/>Restore</>:<><X/>Dismiss</>}</Button></div>
    </section>
    <div id="conversation-draft" className="desk-draft-pane" role={narrow?'tabpanel':undefined} aria-labelledby="draft-heading" hidden={narrow&&mobileTab!=='draft'}>{renderDraft(selected)}</div>
   </article>:<div className="desk-no-selection" hidden={narrow}><Inbox/><p>{showPlaceholders?'Finding conversations…':'Select a conversation to review its source and prepare a response.'}</p></div>}
  </div>
 </div>;
}
