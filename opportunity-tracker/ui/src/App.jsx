import {matchesConversation} from './feed.mjs';
import {feedProgress} from './progress.mjs';
import {PipelineWorkspace} from './PipelineWorkspace';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {ArrowLeft,ArrowUpRight,Bookmark,Check,ChevronLeft,ChevronRight,Copy,Inbox,Package2,Plus,RefreshCw,Search,X} from 'lucide-react';
import {toast} from 'sonner';
import {AppSidebar} from '@/components/hearwhispers-sidebar';
import {SidebarInset,SidebarProvider,SidebarTrigger} from '@/components/ui/sidebar';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Separator} from '@/components/ui/separator';
import {Skeleton} from '@/components/ui/skeleton';
import {Tabs,TabsList,TabsTrigger} from '@/components/ui/tabs';
import {Toaster} from '@/components/ui/sonner';
import {api,date,platform,safeURL,setToken,sourceLabel} from './api';
import {Login} from './Login';
import {ProductEditor} from './ProductEditor';
import {CollectionProgress,Settings,Research} from './WorkspaceViews';
const views={conversations:'Conversations',saved:'Saved',products:'Products',research:'Research',listening:'Listening',insights:'Insights',actions:'Actions',replies:'Auto-draft replies',content:'Videos & captions',settings:'Settings'};
const route=()=>views[location.hash.slice(1)]?location.hash.slice(1):'conversations';

export function App(){
 const [state,setState]=useState(null),[auth,setAuth]=useState(null),[error,setError]=useState(''),generation=useRef(0);
 const reload=useCallback(async()=>{const n=++generation.current;const next=await api('/state');if(n===generation.current){setToken(next.token);setState(next);setError('');}return next;},[]);
 const signIn=useCallback(async()=>{await reload();setAuth(null);},[reload]);
 const boot=useCallback(async()=>{setError('');try{const a=await api('/auth');if(a.authenticated)await signIn();else setAuth(a);}catch(e){setError(e.message);}},[signIn]);
 useEffect(()=>{boot();const expired=()=>{generation.current++;setState(null);setToken('');boot();};window.addEventListener('tracker:unauthorized',expired);return()=>window.removeEventListener('tracker:unauthorized',expired);},[boot]);
 const finding=Object.values(state?.discovery||{}).some(p=>p.phase==='finding');
 useEffect(()=>{if(!state)return;const refresh=()=>{if(document.visibilityState==='visible')reload().catch(e=>setError(e.message));};const timer=setInterval(refresh,finding?10000:60000);document.addEventListener('visibilitychange',refresh);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};},[Boolean(state),finding,reload]);
 async function logout(){await api('/logout',{method:'POST',body:{}});generation.current++;setState(null);setToken('');await boot();}
 if(!state)return auth?<Login configuration={auth} onSignedIn={signIn}/>:<main className="login-page"><h1>HearWhispers</h1><p role={error?'alert':'status'}>{error||'Opening your workspace…'}</p>{error&&<Button onClick={boot}>Try again</Button>}</main>;
 return <Dashboard state={state} reload={reload} logout={logout} error={error}/>;
}

function Dashboard({state,reload,logout,error}){
 const [view,setView]=useState(route),[query,setQuery]=useState(''),[productFilter,setProductFilter]=useState('all'),[platformFilter,setPlatformFilter]=useState('all'),[statusFilter,setStatusFilter]=useState('active'),[relevanceFilter,setRelevanceFilter]=useState('all'),[selectedId,setSelectedId]=useState(null),[page,setPage]=useState(0),[mobileDetail,setMobileDetail]=useState(false),[editing,setEditing]=useState(null),[formOpen,setFormOpen]=useState(false),[busy,setBusy]=useState('');
 const [draftEdits,setDraftEdits]=useState({}),[noteEdits,setNoteEdits]=useState({}),[pipelineEdits,setPipelineEdits]=useState({});
 const setBuffer=(setter,id,value)=>setter(old=>{const next={...old};if(value===undefined)delete next[id];else next[id]=value;return next;});
 const unsaved=Object.keys(draftEdits).length+Object.keys(noteEdits).length+Object.keys(pipelineEdits).length>0;
 useEffect(()=>{if(!unsaved)return;const warn=e=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[unsaved]);
 const heading=useRef(null);const isFeed=['conversations','saved'].includes(view);
 const singleProduct=['listening','insights','actions','replies','content','research'].includes(view);
 const productId=state.products.some(p=>p.id===productFilter)?productFilter:singleProduct?(state.products[0]?.id||'all'):'all';
 const section=['actions','replies','content'].includes(view)?'ActOnWhispers':'HearWhispers';
 useEffect(()=>{const change=()=>{if(location.hash==='#main-content')return;setView(route());setMobileDetail(false);};window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
 useEffect(()=>{document.title=`${views[view]} · ${section}`;},[view,section]);
 useEffect(()=>{setPage(0);setMobileDetail(false);},[query,productFilter,platformFilter,statusFilter,relevanceFilter,view]);
 useEffect(()=>{if(productFilter!==productId)setProductFilter(productId);},[productFilter,productId]);
 useEffect(()=>{if(mobileDetail&&matchMedia('(max-width: 900px)').matches)heading.current?.focus();},[mobileDetail,selectedId]);
 const filtered=useMemo(()=>state.items.filter(i=>(productFilter==='all'||i.productId===productFilter)&&(platformFilter==='all'||platform(i)===platformFilter)&&matchesConversation(i,{view,status:statusFilter,relevance:relevanceFilter})&&(!query||`${i.title} ${i.snippet} ${i.reason} ${sourceLabel(i)}`.toLowerCase().includes(query.toLowerCase()))).sort((a,b)=>(Date.parse(b.publishedAt||b.foundAt)||0)-(Date.parse(a.publishedAt||a.foundAt)||0)),[state.items,productFilter,platformFilter,statusFilter,relevanceFilter,query,view]);
 const pageSize=5,pageIndex=Math.min(page,Math.max(0,Math.ceil(filtered.length/pageSize)-1)),visible=filtered.slice(pageIndex*pageSize,(pageIndex+1)*pageSize),selected=filtered.find(i=>i.id===selectedId)||visible[0];
 useEffect(()=>{if(selected&&selected.id!==selectedId)setSelectedId(selected.id);},[selected?.id,selectedId]);
 function navigate(next){location.hash=next;setView(next);setMobileDetail(false);}
 function addProduct(){setEditing(null);setFormOpen(true);}
 async function action(key,operation,success){if(busy)return;setBusy(key);try{await operation();await reload();if(success)toast.success(success);}catch(e){toast.error(e.message);}finally{setBusy('');}}
 async function patch(item,update){const result=await api(`/items/${item.id}`,{method:'PATCH',body:update});await reload();return result.item;}
 function updateReview(item,status){action('review',()=>patch(item,{status}),status==='saved'?'Conversation saved':status==='dismissed'?'Conversation dismissed':'Conversation restored');}
 const selectedProducts=state.products.filter(p=>productFilter==='all'||p.id===productFilter);
 const find=()=>action('collection',async()=>{for(const p of selectedProducts)await api(`/products/${p.id}/search`,{method:'POST',body:{}});},'Finding conversations. Results will appear here.');
 const progress=feedProgress(state,selectedProducts);
 const showPlaceholders=view==='conversations'&&progress.phase==='finding'&&progress.ready===0&&!query&&platformFilter==='all'&&statusFilter==='active'&&relevanceFilter==='all';
 return <SidebarProvider className="review-desk" style={{'--sidebar-width':'15rem'}}>
  <a className="skip-link" href="#main-content">Skip to content</a>
  <AppSidebar view={view} navigate={navigate} products={state.products} productId={productId} allowAllProducts={!singleProduct} storage={state.storage} onAdd={addProduct} onProduct={id=>{setProductFilter(id);setStatusFilter('active');setQuery('');setMobileDetail(false);}}/>
  <SidebarInset className="min-w-0">
   <header className="workspace-header"><SidebarTrigger/><Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4"/><span className="text-sm text-muted-foreground hidden sm:inline">{section}</span><span className="text-muted-foreground/50 hidden sm:inline">/</span><span className="text-sm">{views[view]}</span><span className="workspace-account">{state.storage==='cloud'?'Private workspace':'Local workspace'}</span></header>
   <main id="main-content" className="workspace-main" tabIndex={-1}>
    <div className="page-heading"><div className="page-title"><h1>{views[view]}</h1>{isFeed&&<p className="feed-disclosure" role="status">{filtered.length} {filtered.length===1?'conversation':'conversations'}<span aria-hidden="true"> · </span>Reddit and X monitoring every two hours</p>}</div>
     <div className="feed-toolbar"><Button onClick={addProduct} variant="outline" className="add-product"><Plus/>Add product</Button>{isFeed&&<div className="search-field"><Search aria-hidden="true"/><Input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search conversations" aria-label="Search conversations"/></div>}</div>
    </div>
    {error&&<p className="form-error" role="alert">Refresh failed: {error} <button onClick={()=>reload().catch(e=>toast.error(e.message))}>Try again</button></p>}
    {isFeed&&<><div className="platform-bar" aria-label="Filter by platform">{[['all','All platforms'],['reddit','Reddit'],['x','X'],['linkedin','LinkedIn'],['other','Other']].filter(([id])=>id!=='other'||state.items.some(i=>platform(i)==='other')).map(([id,label])=><button key={id} aria-pressed={platformFilter===id} onClick={()=>setPlatformFilter(id)}>{label}</button>)}<Button variant="ghost" size="sm" className="check-now" onClick={find} disabled={!!busy||!selectedProducts.length}><RefreshCw className={busy==='collection'?'spin':''}/>{busy==='collection'?'Checking…':'Check now'}</Button></div>
    <CollectionProgress state={state} products={selectedProducts} action={action} busy={busy}/>
    {view==='conversations'&&<div className="relevance-filter"><label htmlFor="conversation-relevance">Show</label><select id="conversation-relevance" value={relevanceFilter} onChange={e=>setRelevanceFilter(e.target.value)}><option value="all">All relevant conversations</option><option value="direct">Direct fits</option><option value="mentions">Mentions</option></select></div>}
    <div className={`feed-view ${mobileDetail?'show-detail':''}`}>
     <div className="feed-subheader">{view==='conversations'?<Tabs value={statusFilter} onValueChange={setStatusFilter}><TabsList><TabsTrigger value="active">All active</TabsTrigger><TabsTrigger value="new">New</TabsTrigger><TabsTrigger value="dismissed">Dismissed</TabsTrigger></TabsList></Tabs>:<span className="muted">Saved conversations</span>}<span className="workspace-date">{date(new Date().toISOString())}</span></div>
     <div className="conversation-list" aria-label="Conversations">{visible.length?<><div className="conversation-columns" aria-hidden="true"><span>Conversation</span><span>Source</span><span>Posted</span></div>{visible.map(item=><button id={`conversation-${item.id}`} key={item.id} className={`conversation-row ${item.id===selected?.id?'selected':''}`} onClick={()=>{setSelectedId(item.id);setMobileDetail(true);}} aria-pressed={item.id===selected?.id}><span className="row-title"><span>{item.title}{item.qualification?.relevant&&item.currentConversationRelevant!==false&&<small className={`row-fit ${item.currentOpportunityFit===true?'direct':''}`}>{item.currentOpportunityFit===true?'Direct fit':'Relevant conversation'}</small>}</span>{item.status==='saved'&&<Bookmark className="size-3.5 fill-current" aria-label="Saved"/>}</span><span className="row-source">{sourceLabel(item)}</span><span className="row-date">{date(item.publishedAt)}</span></button>)}</>:showPlaceholders?<div className="conversation-placeholders" aria-label="Finding conversations" aria-busy="true">{[0,1,2].map(n=><div key={n} className="conversation-placeholder" aria-hidden="true"><Skeleton className="placeholder-title"/><Skeleton className="placeholder-source"/><Skeleton className="placeholder-date"/></div>)}</div>:<div className="list-empty"><Inbox className="size-5 text-muted-foreground"/><p>{!state.products.length?'Add your first product':'No conversations in this view'}</p><span>{!state.products.length?'Tell HearWhispers what your product does to start finding relevant discussions.':query||platformFilter!=='all'?'Try a different platform or search phrase.':view==='saved'?'Save a useful conversation to keep it here.':'New conversations will appear here as we find them.'}</span><Button variant="outline" onClick={!state.products.length?addProduct:()=>{setQuery('');setPlatformFilter('all');setStatusFilter('active');setRelevanceFilter('all');navigate('conversations');}}>{!state.products.length?'Add product':'View all active'}</Button></div>}</div>
     {filtered.length>pageSize&&<div className="queue-pagination"><span>{pageIndex*pageSize+1}–{Math.min((pageIndex+1)*pageSize,filtered.length)} of {filtered.length}</span><Button variant="ghost" size="sm" disabled={!pageIndex} aria-label="Previous conversations" onClick={()=>{setPage(pageIndex-1);setSelectedId(null);}}><ChevronLeft/></Button><Button variant="ghost" size="sm" disabled={(pageIndex+1)*pageSize>=filtered.length} aria-label="Next conversations" onClick={()=>{setPage(pageIndex+1);setSelectedId(null);}}><ChevronRight/></Button></div>}
     {selected&&<article className="review-workspace" aria-label={selected.title}>
      <Button variant="ghost" size="sm" className="back-to-list" onClick={()=>{setMobileDetail(false);requestAnimationFrame(()=>document.getElementById(`conversation-${selected.id}`)?.focus());}}><ArrowLeft/>All conversations</Button>
      <section className="source-context" aria-labelledby="context-heading"><h2 id="context-heading" ref={heading} tabIndex={-1}>Source and context</h2><p className="mobile-conversation-title">{selected.title}</p><p className="detail-byline">{selected.author&&<><span>{platform(selected)==='reddit'?'u/':''}{selected.author}</span><span aria-hidden="true">·</span></>}<span>{sourceLabel(selected)}</span><span aria-hidden="true">·</span><span>{date(selected.publishedAt)}</span></p>
       {selected.currentConversationRelevant===false&&<p className="historical-note">This saved conversation needs review against the current business profile.</p>}
       {(selected.historical||selected.publishedAt&&Date.parse(selected.publishedAt)<Date.now()-30*86400000||selected.discussionClosed)&&<p className="historical-note">{selected.discussionClosed?'Archived or locked discussion · replies are closed.':'Earlier conversation · check whether the need is still current.'}</p>}
       {selected.snippet&&<figure className="source-quote"><figcaption>{(selected.qualification?.intentQuote||selected.qualification?.quote)?'Evidence from the author':`From the ${selected.type==='comment'?'comment':'post'}`}</figcaption><blockquote>“{selected.qualification?.intentQuote||selected.qualification?.quote||selected.snippet}”</blockquote></figure>}
       {selected.context&&<details className="context-detail"><summary>Parent discussion</summary><p>{selected.context}</p></details>}
       <section className="relevance"><h3>{selected.currentOpportunityFit===true?'Direct fit':selected.qualification?.relevant?'Relevant conversation':'Potential fit'}</h3><p>{selected.qualification?.whyItFits||selected.reason||'Review the source discussion to judge the fit.'}</p>{selected.qualification&&<p className="muted">{selected.qualification.directFit===false?'Relevant to your audience. Your current offering may not solve this need.':'Matched to confirmed product features. Review the original before responding.'}</p>}</section>
       <div className="detail-actions"><Button asChild className="source-button"><a href={safeURL(selected.url)} target="_blank" rel="noopener noreferrer">Open original {selected.type==='comment'?'comment':'post'}<ArrowUpRight/></a></Button><Button variant={selected.status==='saved'?'secondary':'outline'} disabled={!!busy} onClick={()=>updateReview(selected,selected.status==='saved'?'new':'saved')}><Bookmark className={selected.status==='saved'?'fill-current':''}/>{selected.status==='saved'?'Saved':'Save'}</Button><Button variant="ghost" disabled={!!busy} onClick={()=>updateReview(selected,selected.status==='dismissed'?'new':'dismissed')}>{selected.status==='dismissed'?<><Check/>Restore</>:<><X/>Dismiss</>}</Button></div>
       <Notes key={selected.id} item={selected} patch={patch} buffered={noteEdits[selected.id]} setBuffered={value=>setBuffer(setNoteEdits,selected.id,value)}/>
      </section>
      <Draft key={selected.id} item={selected} buffered={draftEdits[selected.id]} setBuffered={value=>setBuffer(setDraftEdits,selected.id,value)} patch={patch} state={state} busy={busy} analyze={()=>action('analysis',()=>api(`/items/${selected.id}/analysis`,{method:'POST',body:{refresh:Boolean(selected.analysis)}}),'Reply suggestions saved')}/>
     </article>}
    </div></>}
    {view==='products'&&<div className="products-view"><div className="product-table-heading"><span>Product</span><span>Website</span><span/></div>{state.products.map(p=><div className="product-record" key={p.id}><div className="product-name"><div className="product-icon"><Package2/></div><div><strong>{p.name}</strong><span>{p.monitoring?'Monitoring every two hours':'Regular monitoring paused'}</span></div></div><a className="product-website" href={safeURL(p.url)} target="_blank" rel="noopener noreferrer">{new URL(p.url).hostname}</a><Button variant="outline" size="sm" onClick={()=>{setEditing(p);setFormOpen(true);}}>Edit</Button></div>)}{!state.products.length&&<p className="view-note">Add a product to begin its past-year search.</p>}</div>}
    {['listening','insights','actions','replies','content'].includes(view)&&<PipelineWorkspace state={state} view={view} productId={productId} action={action} busy={busy} buffers={pipelineEdits} setBuffer={(id,value)=>setBuffer(setPipelineEdits,id,value)}/>}
    {view==='settings'&&<Settings state={state} logout={async()=>{if(unsaved&&!confirm('Sign out and discard unsaved drafts and notes?'))return;await logout();}} reload={reload} action={action} busy={busy}/>}
    {view==='research'&&<Research state={state} productFilter={productId} action={action} busy={busy}/>}
   </main>
  </SidebarInset>
  {formOpen&&<ProductEditor key={editing?.id||'new'} open={formOpen} onOpenChange={setFormOpen} product={editing} state={state} onSaved={async p=>{await reload();setFormOpen(false);setProductFilter(p.id);navigate('conversations');toast.success(editing?'Product updated':'Product added. Its past-year search will run in the background.');}} onDeleted={async()=>{await reload();setFormOpen(false);toast.success('Product deleted');}}/>}
  <Toaster position="bottom-right" theme="light"/>
 </SidebarProvider>;
}

function Notes({item,patch,buffered,setBuffered}){
 const [value,setValue]=useState(buffered??item.note??''),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const dirty=value!==(item.note||'');
 return <details className="notes-editor"><summary>{item.note?'Your notes':'Add a note'}</summary><label htmlFor={`note-${item.id}`} className="sr-only">Your note</label><Textarea id={`note-${item.id}`} value={value} onChange={e=>{setValue(e.target.value);setBuffered(e.target.value===(item.note||'')?undefined:e.target.value);}} maxLength={3000} disabled={saving}/><Button variant="outline" size="sm" disabled={!dirty||saving} onClick={async()=>{setSaving(true);setError('');try{await patch(item,{note:value});setBuffered(undefined);toast.success('Note saved');}catch(e){setError(e.message);}finally{setSaving(false);}}}>{saving?'Saving…':'Save note'}</Button>{error&&<p role="alert" className="form-error">{error}</p>}</details>;
}
function Draft({item,patch,state,busy,analyze,buffered,setBuffered}){
 const [value,setValue]=useState(buffered??item.draft??''),[saving,setSaving]=useState(false),[error,setError]=useState('');const dirty=value!==(item.draft||'');
 useEffect(()=>{if(!dirty)return;const warn=e=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
 async function save(){setSaving(true);setError('');try{await patch(item,{draft:value});setBuffered(undefined);toast.success('Draft saved');}catch(e){setError(e.message);}finally{setSaving(false);}}
 return <section className="draft-section" aria-labelledby="draft-heading"><div className="draft-heading"><h2 id="draft-heading"><label htmlFor={`draft-${item.id}`}>Draft response</label></h2><span role="status">{saving?'Saving…':dirty?'Unsaved changes':item.draft?state.storage==='cloud'?'Saved to your workspace':'Saved locally':'Not started'}</span></div><Textarea id={`draft-${item.id}`} value={value} onChange={e=>{setValue(e.target.value);setBuffered(e.target.value===(item.draft||'')?undefined:e.target.value);}} disabled={saving} maxLength={5000} placeholder="Write a helpful response…" className="draft-input"/>{error&&<p role="alert" className="form-error">{error}</p>}<div className="draft-footer"><span>Review your draft before posting on {platform(item)==='reddit'?'Reddit':item.source||'the original site'}.</span><Button variant="outline" disabled={!dirty||saving} onClick={save}>Save draft</Button><Button variant="outline" disabled={!value.trim()} onClick={async()=>{try{await navigator.clipboard.writeText(value);toast.success('Draft copied');}catch{document.getElementById(`draft-${item.id}`)?.select();toast('Select and copy the draft from the text field.');}}}><Copy/>Copy draft</Button></div>
  <details className="reply-suggestions"><summary>Fit assessment & reply suggestions</summary><p className="muted">Generate suggestions using the collected excerpt and your confirmed product features.</p><Button variant="outline" disabled={!!busy||!state.analysis?.available} onClick={analyze}>{busy==='analysis'?'Analyzing…':item.analysis?'Refresh suggestions':'Analyze fit & replies'}</Button>{!state.analysis?.available&&<p className="muted">AI analysis is unavailable.</p>}{item.analysis&&<><p className="analysis-summary">{item.analysis.summary}</p><p className="muted">{item.analysis.limitations}</p>{item.analysis.replies?.map((r,index)=><div className="suggested-reply" key={index}><h3>{r.approach==='helpful'?'Helpful reply':'Reply with a product mention'}</h3><p>{r.body}</p><Button variant="ghost" onClick={()=>{if(dirty&&!confirm('Replace the unsaved draft with this suggestion?'))return;setValue(r.body);setBuffered(r.body===(item.draft||'')?undefined:r.body);}}>Use this draft</Button></div>)}</>}</details>
 </section>;
}
