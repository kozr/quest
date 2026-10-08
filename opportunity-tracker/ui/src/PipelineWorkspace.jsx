import {useEffect,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {api,date,safeURL,lines} from './api';
import {toast} from 'sonner';

const labels={search_plan:'Generate search plan',qualify:'Qualify next batch',insights:'Find insights',actions:'Recommend actions',drafts:'Prepare drafts'};
export function PipelineWorkspace({state,view,productId,action,busy,buffers,setBuffer}){
 if(view==='content')return <div className="pipeline-workspace"><section className="pipeline-section"><h2>Template videos with captions</h2><p className="view-note">Coming soon.</p></section></div>;
 const product=state.products.find(p=>p.id===productId);
 if(!product)return <p className="view-note">Add a business and review its v2 profile to start.</p>;
 const records=state.pipeline?.stages?.[product.id]||{},summary=state.pipeline?.products?.[product.id]||{};
 const draftView=['actions','replies'].includes(view),draftType=view==='replies'?'answer':'fresh_post';
 const draftActions=(records.actions?.data.actions||[]).filter(a=>a.type===draftType);
 const draftIds=new Set(draftActions.map(a=>a.id));
 const reviewed=product.profileVersion==='v2'&&product.businessProfileV2?.reviewed;
 const run=stage=>action(`stage-${stage}`,()=>api(`/products/${product.id}/stages/${stage}`,{method:'POST',body:{refresh:Boolean(records[stage])}}),`${stage==='qualify'?'Qualification':stage.replaceAll('_',' ')} saved`);
 const button=(stage,disabled=false)=><Button variant="outline" disabled={!!busy||!state.pipeline?.available||disabled} onClick={()=>run(stage)}>{busy===`stage-${stage}`?'Working…':labels[stage]}</Button>;
 return <div className="pipeline-workspace">
  <div className="pipeline-toolbar"><span className="pipeline-badge">{product.listeningVersion==='v2'?'V2 listening':'V1 listening'}</span></div>
  {!reviewed&&<p className="pipeline-notice">Start in Products → Edit: generate, review and activate the v2 business profile.</p>}
  {!state.pipeline?.available&&<p className="pipeline-notice">AI stages are paused. Saved plans and results remain available. Check the server’s AI key and daily allowance.</p>}
  {view==='listening'&&<>
   <section className="pipeline-section"><div className="pipeline-section-heading"><div><small>Stage 2</small><h2>What to listen for</h2><p>Review customer tasks and search wording before activating the plan.</p></div>{button('search_plan',!reviewed||!!buffers[`plan:${product.id}`])}</div>
    <SearchPlanEditor key={`${product.id}:${product.updatedAt}:${records.search_plan?.generatedAt}`} product={product} generated={records.search_plan} action={action} busy={busy} buffered={buffers[`plan:${product.id}`]} setBuffered={value=>setBuffer(`plan:${product.id}`,value)}/>
   </section>
   <section className="pipeline-section"><div className="pipeline-section-heading"><div><small>Stage 3</small><h2>Collect conversations</h2><p>Search results and selected comments, with original text, dates and links.</p></div><div className="pipeline-controls"><Button variant="outline" disabled={!!busy||product.listeningVersion!=='v2'||!summary.ready||!state.collection} onClick={()=>action('collection',()=>api(`/products/${product.id}/search`,{method:'POST',body:{}}),'Collection advanced')}>Collect current conversations</Button><Button variant="outline" disabled={!!busy||product.listeningVersion!=='v2'||!summary.ready||!state.collection} onClick={()=>action('backfill',()=>api(`/products/${product.id}/backfill`,{method:'POST',body:{}}),'Historical collection queued')}>Search past year</Button></div></div>
    {product.listeningVersion==='v2'&&!summary.ready&&<p className="pipeline-notice">The active plan needs review after a profile or source change. Collection is paused.</p>}
    {!state.collection&&<p className="muted">V2 collection requires the server’s ScrapeBadger collection pipeline.</p>}
    <p className="muted">{summary.retained||0} retained conversations · up to 120 per business and 600 per workspace. This sample supports insights. Relevant conversations are saved separately in Conversations.</p>
    {state.collection?.cycles?.[product.id]&&<p className="muted">Current collection: {state.collection.cycles[product.id].blocked?'waiting':state.collection.cycles[product.id].status} · {state.collection.cycles[product.id].remaining} requests queued</p>}
    {state.collection?.backfills?.[product.id]&&<p className="muted">Past-year search: {state.collection.backfills[product.id].blocked?'waiting':state.collection.backfills[product.id].status} · {state.collection.backfills[product.id].remaining} requests queued</p>}
    {[state.collection?.cycles?.[product.id],state.collection?.backfills?.[product.id]].some(job=>job?.blocked==='daily_scraper_budget')&&<p className="pipeline-notice">Collection is waiting for the daily scraper allowance. Queued searches have not finished.</p>}
   </section>
   <section className="pipeline-section"><div className="pipeline-section-heading"><div><small>Stage 4</small><h2>Qualify relevance and fit</h2><p>{summary.pending||0} waiting · {summary.relevant||0} relevant. Each batch reviews up to 30 conversations. Waiting conversations stay queued even when the analysis sample changes.</p></div>{button('qualify',!summary.pending||!summary.ready||product.listeningVersion!=='v2')}</div>
    {(summary.conversations||[]).slice(0,30).map(row=><details className="evidence-row" key={row.id}><summary>{row.title||'Conversation'} <span>{row.classificationCurrent?row.qualification.directFit?'Direct fit':row.qualification.relevant?'Relevant insight':'Not relevant':row.qualification?'Needs requalification':'Awaiting qualification'}</span></summary><p>{row.text}</p>{row.qualification&&<p>{row.qualification.reason}</p>}<a href={safeURL(row.url)} target="_blank" rel="noreferrer">{date(row.publishedAt)} · Open original</a></details>)}
   </section>
  </>}
  {view==='insights'&&<section className="pipeline-section"><div className="pipeline-section-heading"><div><small>Stage 5 · HearWhispers</small><h2>What keeps coming up</h2><p>Patterns in relevant conversations, including needs the business cannot currently solve.</p></div>{button('insights',!summary.relevant||!summary.ready||product.listeningVersion!=='v2')}</div>
   <RecordStatus record={records.insights}/>
   {!records.insights&&<p className="view-note">Collect and qualify conversations in Listening first.</p>}
   {records.insights?.data.insights?.length===0&&<p className="view-note">No defensible patterns found in this sample. Expand or refine the search plan.</p>}
   {records.insights?.data.insights?.map(insight=><article className="insight-card" key={insight.id}><small>{insight.kind.replaceAll('_',' ')}{insight.community?` · r/${insight.community}`:''}</small><h3>{insight.title}</h3><p>{insight.outcome}</p><p>{insight.explanation}</p>{insight.independentThreadCount!==undefined&&<p className="muted">{insight.independentThreadCount} independent threads in this sample · {date(insight.firstSeen)} – {date(insight.lastSeen)}</p>}<div className="insight-sources">{(insight.sources||insight.evidenceIds.map(id=>summary.conversations?.find(r=>r.id===id)).filter(Boolean).map(r=>({...r,quote:r.text}))).map(source=><div key={source.id}><a href={safeURL(source.url)} target="_blank" rel="noreferrer">{source.title}</a><p className="muted">{date(source.publishedAt)}{source.author?` · ${source.author}`:''}{source.discussionClosed?' · Closed discussion':''}</p><blockquote>{source.quote}</blockquote></div>)}</div><NotesList values={insight.unknowns}/></article>)}
   <NotesList values={records.insights?.data.limitations}/>
  </section>}
  {['actions','replies','content'].includes(view)&&<>
   {!state.pipeline?.actionsEnabled?<p>The action tier is disabled on this server.</p>:<>
    {view==='actions'&&<section className="pipeline-section"><div className="pipeline-section-heading"><div><small>Stage 6</small><h2>Choose a useful contribution</h2><p>A fresh guide, a relevant answer, clearer information, or an offering improvement.</p></div>{button('actions',!records.insights||records.insights.stale)}</div><RecordStatus record={records.actions}/>
     {!records.actions&&<p className="view-note">Find insights first, then recommend useful actions.</p>}
     {records.actions?.data.actions?.map(a=><article className="insight-card" key={a.id}><small>{a.type.replaceAll('_',' ')}</small><h3>{a.title}</h3><p>{a.reason}</p><p><strong>What to add:</strong> {a.usefulAddition}</p>{a.affiliation&&<p className="muted">Disclosure: {a.affiliation}</p>}{a.targetURL&&<a href={safeURL(a.targetURL)} target="_blank" rel="noreferrer">Open target conversation</a>}</article>)}<NotesList values={records.actions?.data.limitations}/>
    </section>}
    {draftView&&(view==='replies'||draftActions.length>0)&&<section className="pipeline-section"><div className="pipeline-section-heading"><div><small>Stage 7</small><h2>{view==='replies'?'Replies to conversations':'Post drafts'}</h2><p>{view==='replies'?'Generate editable replies for recent, open conversations.':'Generate editable posts from the needs and questions in your insights.'}</p></div>{button('drafts',!!buffers[`drafts:${product.id}`]||!records.actions||records.actions.stale||!draftActions.length)}</div><RecordStatus record={records.drafts}/>
     {!draftActions.length&&<p className="view-note">{view==='replies'?'No reply actions yet. Recommend actions for recent, open conversations first.':'No content actions yet. Recommend actions to find useful post ideas first.'} <a href="#actions">Open Actions</a></p>}
     {draftActions.length>0&&!records.drafts&&<p className="view-note">Prepare drafts from your recommended actions, then review and edit them here.</p>}
     {records.drafts&&<DraftEditor key={`${product.id}:${view}:${records.drafts.generatedAt}:${records.drafts.editedAt}`} product={product} record={records.drafts} visibleIds={draftIds} action={action} busy={busy} buffered={buffers[`drafts:${product.id}`]} setBuffered={value=>setBuffer(`drafts:${product.id}`,value)}/>}
    </section>}
   </>}
  </>}
 </div>;
}
function RecordStatus({record}){return record?<p className={record.stale?'pipeline-notice':'muted'}>{record.stale?'Inputs changed or restored from backup. Regenerate before using this result in the next stage.':`Saved ${date(record.generatedAt)}`}</p>:null;}
function NotesList({values}){return values?.length?<ul className="pipeline-notes">{values.map((v,i)=><li key={i}>{v}</li>)}</ul>:null;}
function SearchPlanEditor({product,generated,action,busy,buffered,setBuffered}){
 const initial=generated&&!generated.stale&&(!product.searchPlanV2||Date.parse(generated.generatedAt)>Date.parse(product.updatedAt))?generated.data:product.searchPlanV2||generated?.data;
 const [plan,updatePlan]=useState(buffered||(initial?structuredClone(initial):null));
 const setPlan=change=>{const next=typeof change==='function'?change(plan):change;updatePlan(next);setBuffered(next);};
 if(!plan)return <p className="view-note">Generate a plan after reviewing the business profile. Your v1 keyword settings remain saved.</p>;
 const edit=(index,patch)=>setPlan(p=>({...p,reviewed:false,themes:p.themes.map((t,i)=>i===index?{...t,...patch}:t)}));
 const save=version=>action('plan-save',async()=>{const r=await api(`/products/${product.id}/search-plan`,{method:'PUT',body:{version,plan}});setBuffered(undefined);return r;},version==='v2'?'V2 listening activated':'Plan saved; v1 listening active');
 return <div className="search-plan-editor">
  {generated?.stale&&<p className="pipeline-notice">The generated plan used older inputs. Generate a fresh plan before activating v2.</p>}
  {plan.themes.map((t,index)=><article className="search-theme" key={t.id}><label>Customer task<Input value={t.title} maxLength={120} onChange={e=>edit(index,{title:e.target.value})}/></label><label>Need<Textarea value={t.need} maxLength={240} onChange={e=>edit(index,{need:e.target.value})}/></label><div className="pipeline-fields"><PhraseList label="Keywords · one per line" values={t.keywords} onChange={keywords=>edit(index,{keywords})}/><PhraseList label="Long-tail questions · one per line" values={t.longTail} onChange={longTail=>edit(index,{longTail})}/></div><p className="muted">Connected offerings: {t.offeringIds.map(id=>product.businessProfileV2?.offerings.find(o=>o.id===id)?.label||id).join(', ')}</p>
   {t.queries.map((q,qi)=><div className="query-editor" key={q.id}><span>{q.platform}</span><label><span className="sr-only">Search query {q.id}</span><Input value={q.query} maxLength={160} onChange={e=>edit(index,{queries:t.queries.map((row,i)=>i===qi?{...row,query:e.target.value}:row)})}/></label>{q.platform==='reddit'&&<label><span className="sr-only">Subreddit for {q.id}</span><Input placeholder="Any subreddit" value={q.community||''} maxLength={21} onChange={e=>edit(index,{queries:t.queries.map((row,i)=>i===qi?{...row,community:e.target.value||null}:row)})}/></label>}</div>)}
   <Button variant="ghost" size="sm" disabled={plan.themes.length===1} onClick={()=>setPlan(p=>({...p,reviewed:false,themes:p.themes.filter((_,i)=>i!==index)}))}>Remove theme</Button>
  </article>)}
  <NotesList values={plan.limitations}/><p className="muted">Suggested communities are unverified. Queries run through the configured collectors.</p>
  <label className="pipeline-review"><input type="checkbox" checked={plan.reviewed===true} onChange={e=>setPlan(p=>({...p,reviewed:e.target.checked}))}/> I reviewed the customer tasks and search queries.</label>
  <div className="pipeline-controls">{buffered&&<Button variant="ghost" disabled={!!busy} onClick={()=>{updatePlan(initial?structuredClone(initial):null);setBuffered(undefined);}}>Discard edits</Button>}<Button disabled={!!busy||!plan.reviewed} onClick={()=>save('v2')}>Activate v2 listening</Button><Button variant="outline" disabled={!!busy} onClick={()=>save('v1')}>Save plan and use v1</Button></div>
 </div>;
}
function DraftEditor({product,record,visibleIds,action,busy,buffered,setBuffered}){
 const [drafts,setDrafts]=useState(buffered||record.data.drafts),[dirty,setDirty]=useState(Boolean(buffered));
 function edit(i,patch){const next=drafts.map((r,n)=>n===i?{...r,...patch}:r);setDrafts(next);setBuffered(next);setDirty(true);}
 return <div>{drafts.map((r,i)=>visibleIds.has(r.actionId)&&<article className="insight-card" key={r.actionId}>{r.targetURL&&<p><a href={safeURL(r.targetURL)} target="_blank" rel="noreferrer">Open target conversation</a></p>}{record.data.drafts[i].title!==''&&<label>Post title<Input value={r.title} maxLength={180} onChange={e=>edit(i,{title:e.target.value})}/></label>}<label>Draft<Textarea value={r.body} maxLength={3500} onChange={e=>edit(i,{body:e.target.value})} className="pipeline-draft"/></label><NotesList values={r.reviewNotes}/><Button variant="outline" onClick={async()=>{try{await navigator.clipboard.writeText([r.title,r.body].filter(Boolean).join('\n\n'));toast.success('Draft copied');}catch{toast.error('Select the draft text and copy it.');}}}>Copy draft</Button></article>)}{drafts.some(r=>visibleIds.has(r.actionId))&&<Button disabled={!!busy||!dirty||record.stale} onClick={()=>action('draft-save',async()=>{const r=await api(`/products/${product.id}/stages/drafts`,{method:'PUT',body:{drafts}});setBuffered(undefined);return r;},'Draft edits saved')}>Save draft edits</Button>}{dirty&&<Button variant="ghost" disabled={!!busy} onClick={()=>{setDrafts(record.data.drafts);setDirty(false);setBuffered(undefined);}}>Discard draft edits</Button>}</div>;
}

function PhraseList({label,values,onChange}){const [text,setText]=useState(values.join('\n'));useEffect(()=>setText(values.join('\n')),[values.join('\n')]);return <label>{label}<Textarea value={text} maxLength={1500} onChange={e=>{setText(e.target.value);onChange(lines(e.target.value));}}/></label>;}
