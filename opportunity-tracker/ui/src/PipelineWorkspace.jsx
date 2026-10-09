import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {api,date,safeURL,lines} from './api';
import {toast} from 'sonner';
import {CollectedConversations} from './CollectedConversations';
import {planIntervals,monitoringTiming} from './plan-timing.mjs';
import {WorkspaceEmpty,WorkspaceNotice} from './WorkspacePage';

const labels={search_plan:'Generate search plan',qualify:'Qualify next batch',actions:'Recommend actions',drafts:'Prepare drafts'};
export function PipelineWorkspace({state,view,productId,action,busy,buffers,setBuffer,onAdd,onEdit}){
 if(view==='content')return <WorkspaceEmpty title="Videos & captions are coming soon" description="Template videos with captions will be available here."/>;
 const product=state.products.find(p=>p.id===productId);
 if(!product)return <WorkspaceEmpty title="Set up your product" description="Add a product and review its business profile to start."><Button onClick={onAdd}>Add product</Button></WorkspaceEmpty>;
 const records=state.pipeline?.stages?.[product.id]||{},summary=state.pipeline?.products?.[product.id]||{};
 const draftView=['actions','replies'].includes(view),draftType=view==='replies'?'answer':'fresh_post';
 const draftActions=(records.actions?.data.actions||[]).filter(a=>a.type===draftType);
 const draftIds=new Set(draftActions.map(a=>a.id));
 const reviewed=product.profileVersion==='v2'&&product.businessProfileV2?.reviewed;
 const plan=product.searchPlanV2||records.search_plan?.data;
 const ready=reviewed&&summary.ready&&product.listeningVersion==='v2';
 const newPlan=!records.search_plan?.stale&&Date.parse(records.search_plan?.generatedAt)>Date.parse(product.updatedAt);
 const primaryStage=view==='listening'?(!ready?(plan?null:'search_plan'):buffers[`plan:${product.id}`]||newPlan?null:summary.pending?'qualify':'collect'):buffers[`drafts:${product.id}`]?null:view==='actions'?'actions':'drafts';
 const nextStep=!reviewed?{title:'Review your business profile',description:'Confirm what your product offers before generating a search plan.',label:'Review business profile',edit:true}:view==='actions'&&(!records.insights||records.insights.stale)?{title:'Start with current patterns',description:'Find or refresh conversation patterns before recommending useful actions.',label:'Review patterns',href:'#insights'}:view==='replies'&&(!draftActions.length||records.actions?.stale)?{title:'Choose conversations to answer',description:'Recommend actions for recent, open conversations before preparing replies.',label:'Open Actions',href:'#actions'}:null;
 const run=stage=>action(`stage-${stage}`,()=>api(`/products/${product.id}/stages/${stage}`,{method:'POST',body:{refresh:Boolean(records[stage])}}),`${stage==='qualify'?'Qualification':stage.replaceAll('_',' ')} saved`);
 const button=(stage,disabled=false)=><Button variant={!nextStep&&stage===primaryStage&&!disabled&&state.pipeline?.available?'default':'outline'} disabled={!!busy||!state.pipeline?.available||disabled} onClick={()=>run(stage)}>{busy===`stage-${stage}`?'Working…':labels[stage]}</Button>;
 return <div className="pipeline-workspace">
  {nextStep&&<WorkspaceNotice title={nextStep.title} description={nextStep.description}>{nextStep.edit?<Button onClick={()=>onEdit(product)}>{nextStep.label}</Button>:<Button asChild><a href={nextStep.href}>{nextStep.label}</a></Button>}</WorkspaceNotice>}
  {!state.pipeline?.available&&<p className="pipeline-notice">Generation is currently paused. Saved plans and results remain available. <a href="#settings">View workspace status</a></p>}
  {view==='listening'&&<>
   <section className="pipeline-section"><div className="pipeline-section-heading"><div><h2>What to listen for</h2><p>Review customer tasks and search wording before activating the plan.</p></div>{button('search_plan',!reviewed||!!buffers[`plan:${product.id}`])}</div>
    <SearchPlanEditor key={`${product.id}:${product.updatedAt}:${records.search_plan?.generatedAt}`} product={product} generated={records.search_plan} enabled={reviewed} action={action} busy={busy} buffered={buffers[`plan:${product.id}`]} setBuffered={value=>setBuffer(`plan:${product.id}`,value)}/>
   </section>
   <section className="pipeline-section"><div className="pipeline-section-heading"><div><h2>Collect conversations</h2><p>Search results and selected comments, with original text, dates and links.{planIntervals(state,product.id)&&<> {monitoringTiming(state,product.id)}.</>}</p></div><div className="pipeline-controls"><Button variant={!nextStep&&primaryStage==='collect'&&state.collection?'default':'outline'} disabled={!!busy||!ready||!state.collection} onClick={()=>action('collection',()=>api(`/products/${product.id}/search`,{method:'POST',body:{}}),'Collection advanced')}>Collect conversations</Button><Button variant="outline" disabled={!!busy||product.listeningVersion!=='v2'||!summary.ready||!state.collection} onClick={()=>action('backfill',()=>api(`/products/${product.id}/backfill`,{method:'POST',body:{}}),'Historical collection queued')}>Search past year</Button></div></div>
    {product.listeningVersion==='v2'&&!summary.ready&&<p className="pipeline-notice">The active plan needs review after a profile or source change. Collection is paused.</p>}
    {!state.collection&&<p className="muted">Collection is unavailable. <a href="#settings">View workspace status</a></p>}
    <p className="muted">{summary.retained||0} retained conversations{planIntervals(state,product.id)?<>. Search results are available below before AI review. Mentions shows confirmed references to this business. <a href="#settings">View collection and AI allowances</a>.</>:<> · up to 120 per business and 600 per workspace. This sample supports insights. Qualified conversations also appear in your conversation views.</>}</p>
    {state.collection?.cycles?.[product.id]&&<p className="muted">Current collection: {state.collection.cycles[product.id].blocked?'waiting':state.collection.cycles[product.id].status} · {state.collection.cycles[product.id].remaining} requests queued</p>}
    {state.collection?.backfills?.[product.id]&&<p className="muted">Past-year search: {state.collection.backfills[product.id].blocked?'waiting':state.collection.backfills[product.id].status} · {state.collection.backfills[product.id].remaining} requests queued</p>}
    {[state.collection?.cycles?.[product.id],state.collection?.backfills?.[product.id]].some(job=>job?.blocked==='daily_scraper_budget')&&<p className="pipeline-notice">Collection is waiting for the daily scraper allowance. Queued searches have not finished.</p>}
   </section>
   {(state.conversationPaging||state.account)&&<CollectedConversations key={product.id} productId={product.id} state={state} action={action} busy={busy} buffers={buffers} setBuffer={setBuffer}/>}
   <section className="pipeline-section"><div className="pipeline-section-heading"><div><h2>Qualify relevance and fit</h2><p>{summary.pending||0} waiting · {summary.relevant||0} relevant · {summary.failed||0} need manual review. Each batch reviews up to {summary.batchSize||12} conversations. Waiting conversations stay queued even when the analysis sample changes.</p></div>{button('qualify',!summary.pending||!summary.ready||product.listeningVersion!=='v2')}</div>
    {(summary.conversations||[]).slice(0,30).map(row=><details className="evidence-row" key={row.id}><summary>{row.title||'Conversation'} <span>{row.reviewFailure?'Needs manual review':row.classificationCurrent?row.qualification.directFit?'Direct fit':row.qualification.relevant?'Relevant insight':'Not relevant':row.qualification?'Needs requalification':'Awaiting qualification'}</span></summary><p>{row.text}</p>{row.reviewFailure&&<p>{row.reviewFailure}</p>}{row.qualification&&<p>{row.qualification.reason}</p>}<a href={safeURL(row.url)} target="_blank" rel="noreferrer">{date(row.publishedAt)} · Open original</a></details>)}
   </section>
  </>}
  {['actions','replies','content'].includes(view)&&<>
   {!state.pipeline?.actionsEnabled?<WorkspaceEmpty title="Actions are currently unavailable" description="Saved patterns remain available to review."><Button variant="outline" asChild><a href="#insights">Review patterns</a></Button></WorkspaceEmpty>:<>
    {view==='actions'&&<section className="pipeline-section"><div className="pipeline-section-heading"><div><h2>Choose a useful contribution</h2><p>A fresh guide, a relevant answer, clearer information, or an offering improvement.</p></div>{button('actions',!records.insights||records.insights.stale)}</div><RecordStatus record={records.actions}/>
     {!records.actions&&<p className="view-note">Find conversation patterns first, then recommend useful actions.</p>}
     {records.actions?.data.actions?.map(a=><article className="insight-card" key={a.id}><small>{a.type.replaceAll('_',' ')}</small><h3>{a.title}</h3><p>{a.reason}</p><p><strong>What to add:</strong> {a.usefulAddition}</p>{a.affiliation&&<p className="muted">Disclosure: {a.affiliation}</p>}{a.targetURL&&<a href={safeURL(a.targetURL)} target="_blank" rel="noreferrer">Open target conversation</a>}</article>)}<NotesList values={records.actions?.data.limitations}/>
    </section>}
    {draftView&&(view==='replies'||draftActions.length>0)&&<section className="pipeline-section"><div className="pipeline-section-heading"><div><h2>{view==='replies'?'Replies to conversations':'Post drafts'}</h2><p>{view==='replies'?'Generate editable replies for recent, open conversations.':'Generate editable posts from the needs and questions in your insights.'}</p></div>{button('drafts',!!buffers[`drafts:${product.id}`]||!records.actions||records.actions.stale||!draftActions.length)}</div><RecordStatus record={records.drafts}/>
     {!draftActions.length&&<p className="view-note">{view==='replies'?'No reply actions yet. Recommend actions for recent, open conversations first.':'No content actions yet. Recommend actions to find useful post ideas first.'}</p>}
     {draftActions.length>0&&!records.drafts&&<p className="view-note">Prepare drafts from your recommended actions, then review and edit them here.</p>}
     {records.drafts&&<DraftEditor key={`${product.id}:${view}:${records.drafts.generatedAt}:${records.drafts.editedAt}`} product={product} record={records.drafts} visibleIds={draftIds} action={action} busy={busy} buffered={buffers[`drafts:${product.id}`]} setBuffered={value=>setBuffer(`drafts:${product.id}`,value)}/>}
    </section>}
   </>}
  </>}
 </div>;
}
function RecordStatus({record}){return record?<p className={record.stale?'pipeline-notice':'muted'}>{record.stale?'Inputs changed or restored from backup. Regenerate before using this result in the next stage.':`Saved ${date(record.generatedAt)}`}</p>:null;}
function NotesList({values}){return values?.length?<ul className="pipeline-notes">{values.map((v,i)=><li key={i}>{v}</li>)}</ul>:null;}
function SearchPlanEditor({product,generated,enabled,action,busy,buffered,setBuffered}){
 const initial=generated&&!generated.stale&&(!product.searchPlanV2||Date.parse(generated.generatedAt)>Date.parse(product.updatedAt))?generated.data:product.searchPlanV2||generated?.data;
 const [plan,updatePlan]=useState(buffered||(initial?structuredClone(initial):null));
 const usingGenerated=initial===generated?.data;
 const needsActivation=product.listeningVersion!=='v2'||Boolean(buffered)||(generated&&!generated.stale&&Date.parse(generated.generatedAt)>Date.parse(product.updatedAt));
 const setPlan=change=>{const next=typeof change==='function'?change(plan):change;updatePlan(next);setBuffered(next);};
 if(!plan)return <p className="view-note">Your search themes and queries will appear here.</p>;
 const edit=(index,patch)=>setPlan(p=>({...p,reviewed:false,themes:p.themes.map((t,i)=>i===index?{...t,...patch}:t)}));
 const save=()=>action('plan-save',async()=>{const r=await api(`/products/${product.id}/search-plan`,{method:'PUT',body:{version:'v2',plan}});setBuffered(undefined);return r;},'Search plan activated');
 return <div className="search-plan-editor">
  {usingGenerated&&generated?.stale&&<p className="pipeline-notice">The generated plan used older inputs. Generate a fresh plan before activating it.</p>}
  {plan.themes.map((t,index)=><article className="search-theme" key={t.id}><label>Customer task<Input value={t.title} maxLength={120} onChange={e=>edit(index,{title:e.target.value})}/></label><label>Need<Textarea value={t.need} maxLength={240} onChange={e=>edit(index,{need:e.target.value})}/></label><div className="pipeline-fields"><PhraseList label="Keywords · one per line" values={t.keywords} onChange={keywords=>edit(index,{keywords})}/><PhraseList label="Long-tail questions · one per line" values={t.longTail} onChange={longTail=>edit(index,{longTail})}/></div><p className="muted">Purposes: {(t.purposes||['potential_customer']).map(id=>({mention:'Mentions',potential_customer:'Potential customers',feedback:'Feedback',competitor:'Competitors'}[id]||id)).join(', ')}</p><p className="muted">Connected offerings: {t.offeringIds.map(id=>product.businessProfileV2?.offerings.find(o=>o.id===id)?.label||id).join(', ')}</p>
   {t.queries.map((q,qi)=><div className="query-editor" key={q.id}><span>{q.platform}</span><label><span className="sr-only">Search query {q.id}</span><Input value={q.query} maxLength={160} onChange={e=>edit(index,{queries:t.queries.map((row,i)=>i===qi?{...row,query:e.target.value}:row)})}/></label>{q.platform==='reddit'&&<label><span className="sr-only">Subreddit for {q.id}</span><Input placeholder="Any subreddit" value={q.community||''} maxLength={21} onChange={e=>edit(index,{queries:t.queries.map((row,i)=>i===qi?{...row,community:e.target.value||null}:row)})}/></label>}</div>)}
   <Button variant="ghost" size="sm" disabled={plan.themes.length===1} onClick={()=>setPlan(p=>({...p,reviewed:false,themes:p.themes.filter((_,i)=>i!==index)}))}>Remove theme</Button>
  </article>)}
  <NotesList values={plan.limitations}/><p className="muted">Suggested communities are unverified. Queries run through the configured collectors.</p>
  <label className="pipeline-review"><input type="checkbox" checked={plan.reviewed===true} onChange={e=>setPlan(p=>({...p,reviewed:e.target.checked}))}/> I reviewed the customer tasks and search queries.</label>
  <div className="pipeline-controls">{buffered&&<Button variant="ghost" disabled={!!busy} onClick={()=>{updatePlan(initial?structuredClone(initial):null);setBuffered(undefined);}}>Discard edits</Button>}<Button variant={needsActivation?'default':'outline'} disabled={!!busy||!enabled||!plan.reviewed||usingGenerated&&generated?.stale||!needsActivation} onClick={save}>{busy==='plan-save'?'Activating…':product.listeningVersion==='v2'?'Save and activate plan':'Activate search plan'}</Button></div>
 </div>;
}
function DraftEditor({product,record,visibleIds,action,busy,buffered,setBuffered}){
 const [drafts,setDrafts]=useState(buffered||record.data.drafts),[dirty,setDirty]=useState(Boolean(buffered));
 function edit(i,patch){const next=drafts.map((r,n)=>n===i?{...r,...patch}:r);setDrafts(next);setBuffered(next);setDirty(true);}
 return <div>{drafts.map((r,i)=>visibleIds.has(r.actionId)&&<article className="insight-card" key={r.actionId}>{r.targetURL&&<p><a href={safeURL(r.targetURL)} target="_blank" rel="noreferrer">Open target conversation</a></p>}{record.data.drafts[i].title!==''&&<label>Post title<Input value={r.title} maxLength={180} onChange={e=>edit(i,{title:e.target.value})}/></label>}<label>Draft<Textarea value={r.body} maxLength={3500} onChange={e=>edit(i,{body:e.target.value})} className="pipeline-draft"/></label><NotesList values={r.reviewNotes}/><Button variant="outline" onClick={async()=>{try{await navigator.clipboard.writeText([r.title,r.body].filter(Boolean).join('\n\n'));toast.success('Draft copied');}catch{toast.error('Select the draft text and copy it.');}}}>Copy draft</Button></article>)}{drafts.some(r=>visibleIds.has(r.actionId))&&<Button disabled={!!busy||!dirty||record.stale} onClick={()=>action('draft-save',async()=>{const r=await api(`/products/${product.id}/stages/drafts`,{method:'PUT',body:{drafts}});setBuffered(undefined);return r;},'Draft edits saved')}>Save draft edits</Button>}{dirty&&<Button variant="ghost" disabled={!!busy} onClick={()=>{setDrafts(record.data.drafts);setDirty(false);setBuffered(undefined);}}>Discard draft edits</Button>}</div>;
}

function PhraseList({label,values,onChange}){const [text,setText]=useState(values.join('\n'));useEffect(()=>setText(values.join('\n')),[values.join('\n')]);return <label>{label}<Textarea value={text} maxLength={1500} onChange={e=>{setText(e.target.value);onChange(lines(e.target.value));}}/></label>;}
