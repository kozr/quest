import {useEffect,useRef,useState} from 'react';
import {ArrowUpRight,Bookmark,Check,ChevronLeft,ChevronRight,Inbox,Search,SlidersHorizontal,X} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Skeleton} from '@/components/ui/skeleton';
import {DropdownMenu,DropdownMenuContent,DropdownMenuLabel,DropdownMenuRadioGroup,DropdownMenuRadioItem,DropdownMenuSeparator,DropdownMenuTrigger} from '@/components/ui/dropdown-menu';
import {Sheet,SheetContent,SheetTitle} from '@/components/ui/sheet';
import {ConversationSource} from './ConversationSource';
import {useConversationPage} from './useConversationPage';
import {date,safeURL,sourceLabel} from './api';
import {adjacentMention,localMentionLane,MENTION_LANES,MENTION_PAGE_SIZE} from './mention-board.mjs';
import './mentions-board.css';

function useSourcePages(state,options,pages,platformFilter){
 const read=id=>({...options,enabled:options.enabled&&(platformFilter==='all'||platformFilter===id),platform:id,page:pages[id]||0,limit:MENTION_PAGE_SIZE,relevance:'mentions'});
 // Fixed hooks share the existing request coalescing and post-save invalidation.
 const reddit=useConversationPage(state,read('reddit'));
 const instagram=useConversationPage(state,read('instagram'));
 const reviews=useConversationPage(state,read('reviews'));
 const web=useConversationPage(state,read('web'));
 const x=useConversationPage(state,read('x'));
 const linkedin=useConversationPage(state,read('linkedin'));
 const tiktok=useConversationPage(state,read('tiktok'));
 const other=useConversationPage(state,read('other'));
 return {reddit,instagram,reviews,web,x,linkedin,tiktok,other};
}

export function MentionsBoard({state,productId,paged,items,query,onQuery,platformFilter,onPlatform,statusFilter,onStatus,busy,updateReview,renderNotes,renderDraft,addProduct,reload}){
 const scope=JSON.stringify([productId,query,platformFilter,statusFilter]);
 const [paging,setPaging]=useState({scope,pages:{}}),pages=paging.scope===scope?paging.pages:{};
 const [reader,setReader]=useState(null),[pending,setPending]=useState(null);
 const trigger=useRef(null),sourceScroll=useRef(null),readerHeading=useRef(null);
 const remote=useSourcePages(state,{enabled:paged&&Boolean(productId),productId,query,status:statusFilter},pages,platformFilter);
 const lanes=MENTION_LANES.filter(lane=>platformFilter==='all'||platformFilter===lane.id).map(lane=>({...lane,page:pages[lane.id]||0,...(paged?remote[lane.id]:localMentionLane(items,productId,lane.id,pages[lane.id]||0))}));
 const loading=lanes.some(lane=>lane.loading),failed=lanes.some(lane=>lane.error),total=lanes.reduce((sum,lane)=>sum+lane.total,0);
 const visibleLanes=lanes.filter(lane=>lane.total||lane.error||platformFilter===lane.id);
 const current=reader&&reader.scope===scope?reader:null;
 const currentLane=lanes.find(lane=>lane.id===current?.lane);
 const selected=current&&(currentLane?.items.find(item=>item.id===current.item.id)||current.item);
 function changePage(id,page){setPaging(old=>({scope,pages:{...(old.scope===scope?old.pages:{}),[id]:page}}));}
 function open(item,lane){setReader({scope,lane,item});setPending(null);}
 function move(offset){
  const target=adjacentMention(lanes,current,offset);if(!target)return;
  const lane=lanes.find(lane=>lane.id===target.lane);
  if(lane.page===target.page&&!lane.loading&&lane.items[target.index])open(lane.items[target.index],lane.id);
  else{setPending({...target,scope});changePage(target.lane,target.page);}
 }
 const previous=current&&adjacentMention(lanes,current,-1),next=current&&adjacentMention(lanes,current,1);
 useEffect(()=>{setReader(null);setPending(null);},[scope]);
 useEffect(()=>{
  if(!pending||pending.scope!==scope)return;
  const lane=lanes.find(lane=>lane.id===pending.lane);
  if(lane?.page===pending.page&&!lane.loading&&!lane.error&&lane.items[pending.index])open(lane.items[pending.index],lane.id);
 },[pending,scope,lanes]);
 useEffect(()=>{
  for(const lane of lanes){const last=Math.max(0,Math.ceil(lane.total/MENTION_PAGE_SIZE)-1);if(!lane.loading&&!lane.error&&lane.page>last)changePage(lane.id,last);}
 },[scope,lanes]);
 useEffect(()=>{
  if(sourceScroll.current)sourceScroll.current.scrollTop=0;
  if(selected)requestAnimationFrame(()=>readerHeading.current?.focus());
 },[selected?.id]);
 function keyboard(event){
  if(event.defaultPrevented||event.metaKey||event.ctrlKey||event.altKey||event.target.closest('input,textarea,select,[contenteditable="true"]'))return;
  const offset=event.key==='j'?1:event.key==='k'?-1:0;
  if(offset&&!pending){event.preventDefault();move(offset);}
 }
 async function review(status){
  const saved=await updateReview(selected,status);
  if(saved)setReader(old=>old?.item.id===saved.id?{...old,item:{...old.item,...saved}}:old);
 }
 const currentIndex=currentLane?.items.findIndex(item=>item.id===selected?.id)??-1;
 const filters=(statusFilter==='active'?0:1)+(platformFilter==='all'?0:1);
 return <div className="mentions-workspace">
  <header className="mentions-heading"><h1>Mentions</h1><span role="status">{loading?'Loading…':`${total}${failed?' loaded':''}`}</span></header>
  <div className="mentions-toolbar">
   <div className="search-field"><Search aria-hidden="true"/><Input aria-label="Search mentions" placeholder="Search mentions" value={query} onChange={event=>onQuery(event.target.value)} maxLength={500}/></div>
   <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline"><SlidersHorizontal/>Filters{filters?` (${filters})`:''}</Button></DropdownMenuTrigger><DropdownMenuContent align="start">
    <DropdownMenuLabel>Status</DropdownMenuLabel><DropdownMenuRadioGroup value={statusFilter} onValueChange={onStatus}>{[['active','All active'],['new','New'],['saved','Saved'],['dismissed','Dismissed']].map(([id,label])=><DropdownMenuRadioItem key={id} value={id}>{label}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup>
    <DropdownMenuSeparator/><DropdownMenuLabel>Source</DropdownMenuLabel><DropdownMenuRadioGroup value={platformFilter} onValueChange={onPlatform}><DropdownMenuRadioItem value="all">All sources</DropdownMenuRadioItem>{MENTION_LANES.map(lane=><DropdownMenuRadioItem key={lane.id} value={lane.id}>{lane.label}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup>
   </DropdownMenuContent></DropdownMenu>
   <span className="mentions-sort">Newest first</span>
  </div>
  <div className="mentions-board" aria-label="Mentions by source" aria-busy={loading}>
   {visibleLanes.map(lane=><section className="mention-lane" key={lane.id} aria-labelledby={`mention-source-${lane.id}`}>
    <header className="mention-lane-heading"><h2 id={`mention-source-${lane.id}`}>{lane.label}</h2><span>{lane.loading?'…':lane.total}</span></header>
    <div className="mention-lane-cards">
     {lane.error?<p className="form-error" role="alert">{lane.error} <Button variant="outline" size="sm" onClick={()=>reload().catch(()=>{})}>Try again</Button></p>:lane.loading&&!lane.items.length?<LaneSkeleton/>:lane.items.length?lane.items.map(item=><button className="mention-card" key={item.id} onClick={event=>{trigger.current=event.currentTarget;open(item,lane.id);}} aria-label={`Read mention: ${item.title}`}>
      <span className="mention-card-source">{sourceLabel(item)}{item.status==='saved'&&<Bookmark className="size-3.5 fill-current" aria-label="Saved"/>}</span>
      <h3>{item.title||'Mention'}</h3><p>{item.snippet||item.title}</p>
      <span className="mention-card-byline">{item.author&&<span>{item.author}</span>}<time dateTime={item.publishedAt}>{date(item.publishedAt)}</time></span>
      <span className="mention-card-read">Read<ChevronRight aria-hidden="true"/></span>
     </button>):<p className="mention-lane-empty">No mentions in this source.</p>}
    </div>
    {lane.total>0&&<footer className="mention-lane-footer"><span>{lane.page*MENTION_PAGE_SIZE+1}–{Math.min((lane.page+1)*MENTION_PAGE_SIZE,lane.total)} of {lane.total}</span><Button variant="ghost" size="icon" aria-label={`Previous ${lane.label} mentions`} disabled={lane.loading||lane.page===0} onClick={()=>changePage(lane.id,lane.page-1)}><ChevronLeft/></Button><Button variant="ghost" size="icon" aria-label={`Next ${lane.label} mentions`} disabled={lane.loading||(lane.page+1)*MENTION_PAGE_SIZE>=lane.total} onClick={()=>changePage(lane.id,lane.page+1)}><ChevronRight/></Button></footer>}
   </section>)}
   {loading&&!visibleLanes.length&&[0,1,2].map(index=><section key={index} className="mention-lane" aria-hidden="true"><header className="mention-lane-heading"><Skeleton className="w-24 h-4"/></header><div className="mention-lane-cards"><LaneSkeleton/></div></section>)}
   {!loading&&!visibleLanes.length&&<div className="mentions-empty"><Inbox/><h2>{productId?'No mentions in this view':'Add your first product'}</h2><p>{productId?query||filters?'Try a different filter or search phrase.':'Keyword matches appear here as they are collected.':'Choose a product to start listening.'}</p><Button variant="outline" onClick={productId?()=>{onQuery('');onPlatform('all');onStatus('active');}:addProduct}>{productId?'Reset filters':'Add product'}</Button>{productId&&<Button variant="ghost" asChild><a href="#settings/monitoring">View collected conversations</a></Button>}</div>}
  </div>
  <Sheet open={Boolean(selected)} onOpenChange={value=>{if(!value){setReader(null);setPending(null);}}}>
   <SheetContent className="mention-reader" showCloseButton={false} aria-describedby={undefined} onKeyDown={keyboard} onCloseAutoFocus={event=>{event.preventDefault();trigger.current?.isConnected&&trigger.current.focus();}}>
    {selected&&<>
     <header className="mention-reader-header"><SheetTitle ref={readerHeading} tabIndex={-1}>Read mention</SheetTitle><Button variant="ghost" size="icon" aria-label="Close mention" onClick={()=>{setReader(null);setPending(null);}}><X/></Button></header>
     <nav className="mention-reader-nav" aria-label="Navigate mentions"><span role="status">{pending?'Loading next mention…':currentIndex>=0?`${currentLane.label} · ${currentLane.page*MENTION_PAGE_SIZE+currentIndex+1} of ${currentLane.total}`:currentLane?.label}</span><Button variant="outline" size="icon" aria-label="Previous mention" title="Previous mention (K)" disabled={!previous||Boolean(pending)} onClick={()=>move(-1)}><ChevronLeft/></Button><Button variant="outline" size="icon" aria-label="Next mention" title="Next mention (J)" disabled={!next||Boolean(pending)} onClick={()=>move(1)}><ChevronRight/></Button></nav>
     {pending&&lanes.find(lane=>lane.id===pending.lane)?.error&&<p className="form-error" role="alert">{lanes.find(lane=>lane.id===pending.lane).error}<Button variant="ghost" onClick={()=>setPending(null)}>Cancel</Button></p>}
     <div className="mention-reader-scroll" ref={sourceScroll} tabIndex={0} aria-label="Original mention and context">
      <ConversationSource key={`source:${selected.id}`} item={selected} items={[...state.items,...lanes.flatMap(lane=>lane.items)]}/>
      {renderNotes(selected)}
      <details className="mention-draft" key={`draft:${selected.id}`}><summary>Draft response<ChevronRight className="source-disclosure-chevron" aria-hidden="true"/></summary>{renderDraft(selected)}</details>
     </div>
     <footer className="mention-reader-actions"><Button variant="outline" asChild><a href={safeURL(selected.url)} target="_blank" rel="noopener noreferrer">{selected.sourceLinkKind==='listing'?'Open listing':'Open original'}<ArrowUpRight/></a></Button><Button variant={selected.status==='saved'?'secondary':'default'} disabled={Boolean(busy)||state.account?.permissions.write===false||selected.reviewEditable===false} onClick={()=>review(selected.status==='saved'?'new':'saved')}><Bookmark className={selected.status==='saved'?'fill-current':''}/>{selected.status==='saved'?'Saved':'Save'}</Button><Button variant="ghost" disabled={Boolean(busy)||state.account?.permissions.write===false||selected.reviewEditable===false} onClick={()=>review(selected.status==='dismissed'?'new':'dismissed')}>{selected.status==='dismissed'?<><Check/>Restore</>:<><X/>Dismiss</>}</Button></footer>
    </>}
   </SheetContent>
  </Sheet>
 </div>;
}

function LaneSkeleton(){return <>{[0,1,2].map(index=><div key={index} className="mention-card mention-card-skeleton" aria-hidden="true"><Skeleton className="h-3 w-20"/><Skeleton className="h-4 w-4/5"/><Skeleton className="h-3 w-full"/><Skeleton className="h-3 w-3/4"/></div>)}</>;}
