import {createRequestGate} from './request-gate.mjs';
import {useConversationPage} from './useConversationPage';
import {matchesConversation} from './feed.mjs';
import {feedProgress} from './progress.mjs';
import {PipelineWorkspace} from './PipelineWorkspace';
import {ConversationsDesk} from './ConversationsDesk';
import {PurposePicker} from '@/components/purpose-picker';
import {loadActivePurpose,loadPurposes,purposes,saveActivePurpose,savePurposes} from './purposes.mjs';
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Copy} from 'lucide-react';
import {toast} from 'sonner';
import {AppSidebar} from '@/components/hearwhispers-sidebar';
import {SidebarInset,SidebarProvider,SidebarTrigger} from '@/components/ui/sidebar';
import {Button} from '@/components/ui/button';
import {Breadcrumb,BreadcrumbItem,BreadcrumbList,BreadcrumbPage,BreadcrumbSeparator} from '@/components/ui/breadcrumb';
import {Textarea} from '@/components/ui/textarea';
import {Separator} from '@/components/ui/separator';
import {Toaster} from '@/components/ui/sonner';
import {api,platform,setToken,sourceLabel} from './api';
import {Login} from './Login';
import {WorkspaceStartup} from './WorkspaceStartup';
import {ProductEditor} from './ProductEditor';
import {Settings} from './WorkspaceViews';
import {PurposeAnalysis} from './PurposeAnalysis';
import {workspaceViews as views,resolveWorkspaceRoute} from './navigation.mjs';
import {Tabs,TabsList,TabsTrigger,TabsContent} from '@/components/ui/tabs';
import {PageHeading} from './WorkspacePage';
const route=(enabled=loadPurposes())=>resolveWorkspaceRoute(location.hash,enabled,loadActivePurpose(enabled));

export function App(){
 const [state,setState]=useState(null),[auth,setAuth]=useState(null),[error,setError]=useState(''),stateRequests=useRef(null),clientRefreshEpoch=useRef(0);
 stateRequests.current ||= createRequestGate();
 const reload=useCallback(({coalesce=false}={})=>{if(!coalesce){stateRequests.current.cancel();clientRefreshEpoch.current++;}const epoch=clientRefreshEpoch.current;return stateRequests.current.run('state',signal=>api('/state',{signal}),next=>{setToken(next.token);setState({...next,_clientRefreshEpoch:epoch});setError('');});},[]);
 const signIn=useCallback(async()=>{await reload();setAuth(null);},[reload]);
 const boot=useCallback(async()=>{setError('');try{const a=await api('/auth');if(a.authenticated)await signIn();else setAuth(a);}catch(e){setError(e.message);}},[signIn]);
 useEffect(()=>{boot();const expired=()=>{stateRequests.current.cancel();setState(null);setToken('');boot();};window.addEventListener('tracker:unauthorized',expired);return()=>{window.removeEventListener('tracker:unauthorized',expired);stateRequests.current.cancel();};},[boot]);
 const finding=Object.values(state?.discovery||{}).some(p=>p.phase==='finding');
 useEffect(()=>{if(!state)return;const refresh=()=>{if(document.visibilityState==='visible')reload({coalesce:true}).catch(e=>{if(e.name!=='AbortError')setError(e.message);});};const timer=setInterval(refresh,finding?10000:60000);document.addEventListener('visibilitychange',refresh);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};},[Boolean(state),finding,reload]);
 async function logout(){await api('/logout',{method:'POST',body:{}});stateRequests.current.cancel();setState(null);setToken('');await boot();}
 if(!state)return auth?<Login configuration={auth} onSignedIn={signIn}/>:<WorkspaceStartup error={error} onRetry={boot}/>;
 return <Dashboard state={state} reload={reload} logout={logout} error={error}/>;
}

function Dashboard({state,reload,logout,error}){
 const [path,setPath]=useState(()=>route()),[query,setQuery]=useState(''),[productFilter,setProductFilter]=useState('all'),[platformFilter,setPlatformFilter]=useState('all'),[statusFilter,setStatusFilter]=useState('active'),[selectedId,setSelectedId]=useState(null),[page,setPage]=useState(0),[pageSelection,setPageSelection]=useState('first'),[mobileDetail,setMobileDetail]=useState(false),[editing,setEditing]=useState(null),[formOpen,setFormOpen]=useState(false),[busy,setBusy]=useState('');
 const [view,subview='conversations']=path.split('/');
 const [draftEdits,setDraftEdits]=useState({}),[noteEdits,setNoteEdits]=useState({}),[pipelineEdits,setPipelineEdits]=useState({});
 const setBuffer=(setter,id,value)=>setter(old=>{const next={...old};if(value===undefined)delete next[id];else next[id]=value;return next;});
 const unsaved=Object.keys(draftEdits).length+Object.keys(noteEdits).length+Object.keys(pipelineEdits).length>0;
 useEffect(()=>{if(!unsaved)return;const warn=e=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[unsaved]);
 const [enabledPurposes,setEnabledPurposes]=useState(loadPurposes),[purposesOpen,setPurposesOpen]=useState(false);
 const purpose=purposes.find(purpose=>purpose.id===view);
 const heading=useRef(null);const isPurpose=Boolean(purpose),isFeed=isPurpose&&subview==='conversations';
 const singleProduct=['actions','replies','content'].includes(view)||isPurpose&&!isFeed||view==='settings'&&subview==='monitoring';
 const productId=state.products.some(p=>p.id===productFilter)?productFilter:singleProduct?(state.products[0]?.id||'all'):'all';
 const productName=state.products.find(p=>p.id===productId)?.name||(state.products.length?'All products':'Choose a product');
 const section=['actions','replies','content'].includes(view)?'ActOnWhispers':'HearWhispers';
 const currentLabel=view==='settings'&&subview==='monitoring'?'Monitoring settings':views[view];
 useEffect(()=>{const change=()=>{if(location.hash==='#main-content')return;const next=route(enabledPurposes);if(location.hash!==`#${next}`)history.replaceState(null,'',`#${next}`);setPath(next);setMobileDetail(false);};window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[enabledPurposes]);
 useEffect(()=>{document.title=`${currentLabel}${isPurpose&&!isFeed?` · ${subview==='patterns'?'Patterns':'Explore'}`:''} · ${section}`;},[path,currentLabel,section]);
 useEffect(()=>{if(purpose)saveActivePurpose(view);if(location.hash!=='#main-content'&&location.hash!==`#${path}`)history.replaceState(null,'',`#${path}`);},[path]);
 useEffect(()=>{setPage(0);setPageSelection('first');setMobileDetail(false);},[query,productFilter,platformFilter,statusFilter,path]);
 useEffect(()=>{if(productFilter!==productId)setProductFilter(productId);},[productFilter,productId]);
 useEffect(()=>{if(!isFeed&&mobileDetail&&matchMedia('(max-width: 900px)').matches)heading.current?.focus();},[mobileDetail,selectedId,isFeed]);
 const localFiltered=useMemo(()=>state.items.filter(i=>(productFilter==='all'||i.productId===productFilter)&&(platformFilter==='all'||platform(i)===platformFilter)&&matchesConversation(i,{status:statusFilter,relevance:purpose?.relevance})&&(!query||`${i.title} ${i.snippet} ${i.reason} ${sourceLabel(i)}`.toLowerCase().includes(query.toLowerCase()))).sort((a,b)=>(Date.parse(b.publishedAt||b.foundAt)||0)-(Date.parse(a.publishedAt||a.foundAt)||0)),[state.items,productFilter,platformFilter,statusFilter,query,purpose]);
 const pageSize=5,paged=Boolean(state.conversationPaging&&isFeed);
 const remote=useConversationPage(state,{enabled:paged,productId:productFilter,query,platform:platformFilter,status:statusFilter,relevance:purpose?.relevance,page,limit:pageSize});
 const filtered=paged?remote.items:localFiltered,total=paged?remote.total:filtered.length;
 const pageIndex=paged?page:Math.min(page,Math.max(0,Math.ceil(total/pageSize)-1)),visible=paged?filtered:filtered.slice(pageIndex*pageSize,(pageIndex+1)*pageSize),selected=filtered.find(i=>i.id===selectedId)||visible[pageSelection==='last'?visible.length-1:0];
 useEffect(()=>{if(paged&&!remote.loading&&page>Math.max(0,Math.ceil(total/pageSize)-1))setPage(Math.max(0,Math.ceil(total/pageSize)-1));},[paged,remote.loading,page,total]);
 useEffect(()=>{if(selected&&selected.id!==selectedId)setSelectedId(selected.id);},[selected?.id,selectedId]);
 function navigate(next,enabled=enabledPurposes){const resolved=resolveWorkspaceRoute(next,enabled,loadActivePurpose(enabled));location.hash=resolved;setPath(resolved);setMobileDetail(false);}
 function addProduct(){setEditing(null);setFormOpen(true);}
 function editProduct(product){setEditing(product);setFormOpen(true);}
 async function action(key,operation,success){if(busy)return;setBusy(key);try{await operation();await reload();if(success)toast.success(success);}catch(e){toast.error(e.message);}finally{setBusy('');}}
 async function patch(item,update){const result=await api(`/items/${item.id}`,{method:'PATCH',body:update});await reload();return result.item;}
 function updateReview(item,status){action('review',()=>patch(item,{status}),status==='saved'?'Conversation saved':status==='dismissed'?'Conversation dismissed':'Conversation restored');}
 const selectedProducts=state.products.filter(p=>productFilter==='all'||p.id===productFilter);
 const find=()=>action('collection',async()=>{for(const p of selectedProducts)await api(`/products/${p.id}/search`,{method:'POST',body:{}});},'Finding conversations. Results will appear here.');
 const progress=feedProgress(state,selectedProducts);
 const showPlaceholders=isFeed&&progress.phase==='finding'&&!filtered.length&&!query&&platformFilter==='all'&&statusFilter==='active';
 return <SidebarProvider className={`review-desk ${isPurpose?'conversations-layout':''}`} style={{'--sidebar-width':'15rem'}}>
  <a className="skip-link" href="#main-content">Skip to content</a>
  <AppSidebar view={view} navigate={navigate} products={state.products} productId={productId} allowAllProducts={!singleProduct} storage={state.storage} enabledPurposes={enabledPurposes} onPurposes={()=>setPurposesOpen(true)} onAdd={addProduct} onEdit={editProduct} onProduct={id=>{setProductFilter(id);setStatusFilter('active');setQuery('');setMobileDetail(false);}}/>
  <SidebarInset className="min-w-0">
   <header className="workspace-header">
    <SidebarTrigger/><Separator orientation="vertical" className="data-[orientation=vertical]:h-4"/>
    <Breadcrumb className="workspace-breadcrumb">
     <BreadcrumbList>
      <BreadcrumbItem><span className="truncate" title={productName}>{productName}</span></BreadcrumbItem>
      <BreadcrumbSeparator>/</BreadcrumbSeparator>
      <BreadcrumbItem className="workspace-breadcrumb-section"><span>{section}</span></BreadcrumbItem>
      <BreadcrumbSeparator className="workspace-breadcrumb-section">/</BreadcrumbSeparator>
      <BreadcrumbItem><BreadcrumbPage className="truncate" title={currentLabel}>{currentLabel}</BreadcrumbPage></BreadcrumbItem>
     </BreadcrumbList>
    </Breadcrumb>
    <span className="workspace-account">{state.storage==='cloud'?'Private workspace':'Local workspace'}</span>
   </header>
   <main id="main-content" className={`workspace-main ${isPurpose?'conversation-page':''}`} tabIndex={-1}>
    {isPurpose&&<Tabs value={subview} onValueChange={tab=>navigate(tab==='conversations'?view:`${view}/${tab}`)} className="purpose-workspace">
     <div className="purpose-tabs"><TabsList aria-label={`${purpose.label} views`}><TabsTrigger value="conversations">Conversations</TabsTrigger><TabsTrigger value="patterns">Patterns</TabsTrigger>{purpose.id!=='mentions'&&<TabsTrigger value="explore">Explore</TabsTrigger>}</TabsList></div>
     <TabsContent value={subview} className="purpose-panel">
     {error&&<p className="form-error" role="alert">Refresh failed: {error} <button onClick={()=>reload().catch(e=>toast.error(e.message))}>Try again</button></p>}
     {isFeed&&paged&&remote.error&&<p className="form-error" role="alert">{remote.error} <button onClick={()=>reload().catch(e=>toast.error(e.message))}>Try again</button></p>}
     {isFeed&&<ConversationsDesk key={view} title={purpose.label} relevance={purpose.relevance} state={state} total={total} paged={paged} pageLoading={paged&&remote.loading} filtered={filtered} visible={visible} selected={selected} pageIndex={pageIndex} pageSize={pageSize}
      onPage={(index,edge='first')=>{setPage(index);setPageSelection(edge);setSelectedId(null);}}
      onSelect={item=>{setSelectedId(item.id);if(!paged)setPage(Math.floor(filtered.findIndex(row=>row.id===item.id)/pageSize));setMobileDetail(true);}}
      mobileDetail={mobileDetail} onMobileDetail={setMobileDetail} detailHeading={heading}
      query={query} onQuery={setQuery} platformFilter={platformFilter} onPlatform={setPlatformFilter} statusFilter={statusFilter} onStatus={setStatusFilter}
      products={selectedProducts} busy={busy} find={find} action={action} updateReview={updateReview} showPlaceholders={showPlaceholders} addProduct={addProduct}
      renderNotes={item=><Notes key={item.id} item={item} patch={patch} buffered={noteEdits[item.id]} setBuffered={value=>setBuffer(setNoteEdits,item.id,value)}/>}
      renderDraft={item=><Draft key={item.id} item={item} paneLayout patch={patch} state={state} busy={busy} buffered={draftEdits[item.id]} setBuffered={value=>setBuffer(setDraftEdits,item.id,value)} analyze={()=>action('analysis',()=>api(`/items/${item.id}/analysis`,{method:'POST',body:{refresh:Boolean(item.analysis)}}),'Reply suggestions saved')}/>}/>}
     {!isFeed&&<div className="purpose-analysis-scroll"><PurposeAnalysis state={state} purpose={purpose} mode={subview} productId={productId} action={action} busy={busy} onAdd={addProduct} onEdit={editProduct}/></div>}
     </TabsContent>
    </Tabs>}
    {!isPurpose&&<>
    <div className="workspace-page">
    <PageHeading title={currentLabel} description={{actions:'Turn conversation patterns into useful contributions.',replies:'Prepare and review replies before sharing them.',content:'Create videos from templates with captions.',settings:subview==='monitoring'?'Choose where and how to find conversations.':'Manage your workspace, preferences and allowances.'}[view]}/>
    {error&&<p className="form-error" role="alert">Refresh failed: {error} <button onClick={()=>reload().catch(e=>toast.error(e.message))}>Try again</button></p>}
    {['actions','replies','content'].includes(view)&&<PipelineWorkspace state={state} view={view} productId={productId} action={action} busy={busy} buffers={pipelineEdits} setBuffer={(id,value)=>setBuffer(setPipelineEdits,id,value)} onAdd={addProduct} onEdit={editProduct}/>}
    {view==='settings'&&(subview==='monitoring'?<><Button variant="ghost" asChild className="monitoring-back"><a href="#settings">Back to Settings</a></Button><PipelineWorkspace state={state} view="listening" productId={productId} action={action} busy={busy} buffers={pipelineEdits} setBuffer={(id,value)=>setBuffer(setPipelineEdits,id,value)} onAdd={addProduct} onEdit={editProduct}/></>:<Settings onPurposes={()=>setPurposesOpen(true)} state={state} logout={async()=>{if(unsaved&&!confirm('Sign out and discard unsaved drafts and notes?'))return;await logout();}} reload={reload} action={action} busy={busy}/>)}
    </div>
    </>}
   </main>
  </SidebarInset>
  {formOpen&&<ProductEditor key={editing?.id||'new'} open={formOpen} onOpenChange={setFormOpen} product={editing} state={state} onSaved={async p=>{await reload();setFormOpen(false);setProductFilter(p.id);navigate(loadActivePurpose(enabledPurposes));toast.success(editing?'Product updated':'Product added. Its past-year search will run in the background.');}} onDeleted={async()=>{await reload();setFormOpen(false);toast.success('Product deleted');}}/>}
  <PurposePicker key={purposesOpen?'open':'closed'} open={purposesOpen} onOpenChange={setPurposesOpen} selected={enabledPurposes} onSave={chosen=>{setEnabledPurposes(chosen);setPurposesOpen(false);if(!savePurposes(chosen))toast('Purposes updated. This browser could not save your preference.');if(purpose&&!chosen.includes(purpose.id))navigate(chosen[0],chosen);}}/>
  <Toaster position="bottom-right" theme="light"/>
 </SidebarProvider>;
}

function Notes({item,patch,buffered,setBuffered}){
 const [value,setValue]=useState(buffered??item.note??''),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const dirty=value!==(item.note||'');
 return <details className="notes-editor"><summary>{item.note?'Your notes':'Add a note'}</summary><label htmlFor={`note-${item.id}`} className="sr-only">Your note</label><Textarea id={`note-${item.id}`} value={value} onChange={e=>{setValue(e.target.value);setBuffered(e.target.value===(item.note||'')?undefined:e.target.value);}} maxLength={3000} disabled={saving}/><Button variant="outline" size="sm" disabled={!dirty||saving} onClick={async()=>{setSaving(true);setError('');try{await patch(item,{note:value});setBuffered(undefined);toast.success('Note saved');}catch(e){setError(e.message);}finally{setSaving(false);}}}>{saving?'Saving…':'Save note'}</Button>{error&&<p role="alert" className="form-error">{error}</p>}</details>;
}
function Draft({item,patch,state,busy,analyze,buffered,setBuffered,paneLayout=false}){
 const [value,setValue]=useState(buffered??item.draft??''),[saving,setSaving]=useState(false),[error,setError]=useState('');const dirty=value!==(item.draft||'');
 useEffect(()=>{if(!dirty)return;const warn=e=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
 async function save(){setSaving(true);setError('');try{await patch(item,{draft:value});setBuffered(undefined);toast.success('Draft saved');}catch(e){setError(e.message);}finally{setSaving(false);}}
 const header=<div className="draft-heading"><h2 id="draft-heading" tabIndex={paneLayout?-1:undefined}><label htmlFor={`draft-${item.id}`}>Draft response</label></h2><span role="status">{saving?'Saving…':dirty?'Unsaved changes':item.draft?state.storage==='cloud'?'Saved to your workspace':'Saved locally':'Not started'}</span></div>;
 const editor=<Textarea id={`draft-${item.id}`} value={value} onChange={e=>{setValue(e.target.value);setBuffered(e.target.value===(item.draft||'')?undefined:e.target.value);}} disabled={saving} maxLength={5000} placeholder="Write a helpful response…" className="draft-input"/>;
 const help=<span>Review your draft before posting on {platform(item)==='reddit'?'Reddit':item.source||'the original site'}.</span>;
 const buttons=<><Button variant="outline" disabled={!dirty||saving} onClick={save}>Save draft</Button><Button variant={paneLayout?'default':'outline'} disabled={!value.trim()} onClick={async()=>{try{await navigator.clipboard.writeText(value);toast.success('Draft copied');}catch{document.getElementById(`draft-${item.id}`)?.select();toast('Select and copy the draft from the text field.');}}}><Copy/>Copy draft</Button></>;
 const suggestions=<details className="reply-suggestions"><summary>Fit assessment & reply suggestions</summary><p className="muted">Generate suggestions using the collected excerpt and your confirmed product features.</p><Button variant="outline" disabled={!!busy||!state.analysis?.available} onClick={analyze}>{busy==='analysis'?'Analyzing…':item.analysis?'Refresh suggestions':'Analyze fit & replies'}</Button>{!state.analysis?.available&&<p className="muted">AI analysis is unavailable.</p>}{item.analysis&&<><p className="analysis-summary">{item.analysis.summary}</p><p className="muted">{item.analysis.limitations}</p>{item.analysis.replies?.map((r,index)=><div className="suggested-reply" key={index}><h3>{r.approach==='helpful'?'Helpful reply':'Reply with a product mention'}</h3><p>{r.body}</p><Button variant="ghost" onClick={()=>{if(dirty&&!confirm('Replace the unsaved draft with this suggestion?'))return;setValue(r.body);setBuffered(r.body===(item.draft||'')?undefined:r.body);}}>Use this draft</Button></div>)}</>}</details>;
 return <section className="draft-section" aria-labelledby="draft-heading">{paneLayout?<><div className="desk-draft-scroll">{header}{editor}{error&&<p role="alert" className="form-error">{error}</p>}{suggestions}<p className="desk-draft-help">{help}</p></div><div className="draft-footer">{buttons}</div></>:<>{header}{editor}{error&&<p role="alert" className="form-error">{error}</p>}<div className="draft-footer">{help}{buttons}</div>{suggestions}</>}</section>;
}
