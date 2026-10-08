import {Button} from '@/components/ui/button';
import {api,date,safeURL} from './api';
import {PageHeading,WorkspaceEmpty,WorkspaceNotice} from './WorkspacePage';
import {explorationSections,patternsForPurpose} from './purpose-analysis.mjs';

const explorationCopy={
 feedback:'Find needs, problems and workarounds beyond your monitored conversations.',
 competitors:'Explore competing products, alternatives and the workarounds people use.',
 opportunities:'Find public discussions from people describing needs your offering may help with.'
};

export function PurposeAnalysis({state,purpose,mode,productId,action,busy,onAdd,onEdit}){
 const product=state.products.find(p=>p.id===productId);
 if(!product)return <div className="workspace-page"><PageHeading title={purpose.label}/><WorkspaceEmpty title="Add your first product" description="Set up a business profile to explore conversations for this purpose."><Button onClick={onAdd}>Add product</Button></WorkspaceEmpty></div>;
 return mode==='explore'?<PurposeExplore state={state} purpose={purpose} product={product} action={action} busy={busy}/>:<PurposePatterns state={state} purpose={purpose} product={product} action={action} busy={busy} onEdit={onEdit}/>;
}

function PurposePatterns({state,purpose,product,action,busy,onEdit}){
 const {record,patterns,evidence}=patternsForPurpose(state,product.id,purpose),summary=state.pipeline?.products?.[product.id]||{};
 const reviewed=product.profileVersion==='v2'&&product.businessProfileV2?.reviewed;
 const ready=reviewed&&product.listeningVersion==='v2'&&summary.ready;
 const available=ready&&evidence.length>0&&state.pipeline?.available;
 return <div className="workspace-page"><PageHeading title={purpose.label} description="Patterns supported by collected conversations for this purpose." action={<Button disabled={!!busy||!available} onClick={()=>action('stage-insights',()=>api(`/products/${product.id}/stages/insights`,{method:'POST',body:{refresh:Boolean(record)}}),'Patterns saved')}>{busy==='stage-insights'?'Finding patterns…':record?'Refresh patterns':'Find patterns'}</Button>}/>
  {!reviewed?<WorkspaceNotice title="Review your business profile" description="Confirm what your product offers before finding patterns."><Button onClick={()=>onEdit(product)}>Review business profile</Button></WorkspaceNotice>:!ready?<WorkspaceNotice title="Review your monitoring settings" description="Activate a current search plan before collecting conversations for this purpose."><Button asChild><a href="#settings/monitoring">Monitoring settings</a></Button></WorkspaceNotice>:null}
  <p className="muted purpose-analysis-note">Uses the shared AI allowance when you run it. One conversation can support several purposes.</p>
  {!state.pipeline?.available&&<p className="pipeline-notice">Pattern generation is currently unavailable. Saved patterns remain available to review. <a href="#settings">View workspace status</a></p>}
  {record&&<p className={record.stale?'pipeline-notice':'muted'}>{record.stale?'The supporting information changed. Refresh before using these patterns.':`Patterns saved ${date(record.generatedAt)}`}</p>}
  {!patterns.length&&<WorkspaceEmpty title={record?'No supported patterns for this purpose yet':'Your patterns will appear here'} description={!evidence.length?'Collect and review conversations for this purpose first.':record?'The current sample has not established a pattern whose supporting conversations all match this purpose.':'Find recurring needs and questions in your collected conversations.'}/>}
  {patterns.map(insight=><article className="insight-card" key={insight.id}><small>{insight.kind.replaceAll('_',' ')}{insight.community?` · r/${insight.community}`:''}</small><h2>{insight.title}</h2><p>{insight.outcome}</p><p>{insight.explanation}</p>{insight.independentThreadCount!==undefined&&<p className="muted">{insight.independentThreadCount} independent threads in this sample · {date(insight.firstSeen)} – {date(insight.lastSeen)}</p>}<div className="insight-sources">{(insight.sources||insight.evidenceIds.map(id=>summary.conversations?.find(row=>row.id===id)).filter(Boolean).map(row=>({...row,quote:row.text}))).map(source=><div key={source.id}><a href={safeURL(source.url)} target="_blank" rel="noreferrer">{source.title}</a><p className="muted">{date(source.publishedAt)}{source.author?` · ${source.author}`:''}{source.discussionClosed?' · Closed discussion':''}</p><blockquote>{source.quote}</blockquote></div>)}</div><Notes values={insight.unknowns}/></article>)}
  <Notes values={record?.data.limitations}/>
 </div>;
}

function PurposeExplore({state,purpose,product,action,busy}){
 const record=state.research?.[product.id],section=explorationSections[purpose.id],rows=record?.[section]||[];
 return <div className="workspace-page research-view"><PageHeading title={purpose.label} description={explorationCopy[purpose.id]} action={<Button disabled={!!busy||!state.analysis?.available} onClick={()=>action('research',()=>api(`/products/${product.id}/research`,{method:'POST',body:{refresh:Boolean(record)}}),'Exploration saved')}>{busy==='research'?'Exploring…':record?'Refresh exploration':'Explore sources'}</Button>}/>
  <p className="muted purpose-analysis-note">A separate web search, beyond your collected conversations. Uses the shared AI allowance when you run it.</p>
  {record&&<p className="muted">Sources explored {date(record.generatedAt)}{record.stale?' · Product details changed; refresh these findings.':''}{record.expired?' · Over 30 days old; refresh these findings.':''} {record.coverage}</p>}
  {!rows.length&&<WorkspaceEmpty title={!state.analysis?.available?'Exploration is currently unavailable':record?'No supported findings for this purpose':'Explore more sources for this purpose'} description={!state.analysis?.available?'Check your workspace status before exploring sources.':record?'The inspected sources did not provide enough evidence for this purpose.':'Find relevant public evidence beyond the conversations already collected.'}>{!state.analysis?.available&&<Button variant="outline" asChild><a href="#settings">View workspace status</a></Button>}</WorkspaceEmpty>}
  {rows.map((row,index)=><article className="research-result" key={index}>{section==='people'?<><h2>u/{row.handle}</h2><p>{row.problem}</p><blockquote>{row.excerpt}</blockquote><p>{row.fitReason}</p><p className="muted">{row.needStatus.replaceAll('_',' ')} · {date(row.publishedAt)}</p><a href={safeURL(row.sourceUrl)} target="_blank" rel="noopener noreferrer">Open discussion</a></>:<><h2>{row.title}</h2><p>{row.summary}</p><ul>{row.sources?.map((source,i)=><li key={i}><a href={safeURL(source.url)} target="_blank" rel="noopener noreferrer">{source.title}</a></li>)}</ul></>}</article>)}
 </div>;
}
function Notes({values}){return values?.length?<ul className="pipeline-notes">{values.map((value,index)=><li key={index}>{value}</li>)}</ul>:null;}
