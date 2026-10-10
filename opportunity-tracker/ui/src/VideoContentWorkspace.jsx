import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Copy,Download,Pause,Play,RotateCcw} from 'lucide-react';
import {toast} from 'sonner';
import {api,date,safeURL} from './api';
import {WorkspaceEmpty,WorkspaceNotice} from './WorkspacePage';
import {drawVideoFrame,videoDuration,sceneAt,videoSubtitles,videoFilename,downloadBlob,renderVideo,videoExportType} from './video-render.mjs';
import {VideoMediaLibrary} from './VideoMediaLibrary';
import {CaptionStylePicker} from './CaptionStylePicker';
import {listMedia,loadReactionMedia,seekClip} from './video-media.mjs';
import {ReadyTemplateWorkspace,TemplateGallery} from './ReadyTemplateWorkspace';
import {readyTemplates,mergeVideoCatalog,switchVideoTemplate} from '../../ready-template-catalog.mjs';
import './video-content.css';

export function VideoContentWorkspace({state,productId,action,busy,buffers,setBuffer,onAdd,onEdit}){
 const product=state.products.find(row=>row.id===productId);
 if(!product)return <WorkspaceEmpty title="Choose a product" description="Connect a product to its conversations to prepare videos."><Button onClick={onAdd}>Add product</Button></WorkspaceEmpty>;
 const scope=`${state.account?.id||'private'}:${state.account?.member?.sub||'local'}:${productId}`;
 return <VideoModes key={scope} {...{state,productId,product,action,busy,buffers,setBuffer,onEdit,scope}}/>;
}
function VideoModes(props){
 const [mode,setMode]=useState('templates'),templates=readyTemplates({fixture:props.state.fixture===true});
 return <div className="video-workspace"><div className="video-heading"><div><h2>Pick a template. Add your caption.</h2><p>Ready-made reactions with the background, scene and timing already set.</p></div></div><div className="ready-template-modes" role="group" aria-label="Video creation mode"><button type="button" aria-pressed={mode==='templates'} onClick={()=>setMode('templates')}>Templates</button><button type="button" aria-pressed={mode==='conversations'} onClick={()=>setMode('conversations')}>From conversations</button></div>{mode==='templates'?<ReadyTemplateWorkspace {...{templates}} scope={props.scope} readOnly={props.state.account?.permissions.write===false}/>:<VideoStudioWorkspace {...props} {...{templates}}/>}</div>;
}
function VideoStudioWorkspace({state,productId,product,action,busy,buffers,setBuffer,onEdit,scope,templates}){
 const records=state.pipeline?.stages?.[productId]||{},record=records.videos,buffered=buffers[`videos:${productId}`];
 const [library,setLibrary]=useState([]),[libraryReady,setLibraryReady]=useState(false),[libraryError,setLibraryError]=useState('');
 useEffect(()=>{let current=true;listMedia(scope).then(rows=>{if(current){setLibrary(rows);setLibraryReady(true);}}).catch(error=>{if(current){setLibraryError(error.message);setLibraryReady(true);}});return()=>{current=false;};},[scope]);
 const catalog=mergeVideoCatalog(templates,library,record?.videoLibrary||[],buffered?.videos||record?.data.videos||[]);
 const reviewed=product.profileVersion==='v2'&&product.businessProfileV2?.reviewed,hasTopics=records.insights&&!records.insights.stale&&records.insights.data.insights.length>0;
 const available=state.pipeline?.actionsEnabled!==false&&state.pipeline?.available,canWrite=state.account?.permissions.write!==false;
 return <div className="video-workspace">
  <div className="video-heading"><div><h2>Captions from your conversations</h2><p>Find a familiar customer moment and match it to a ready-made reaction.</p></div><Button disabled={(!libraryReady&&!templates.length)||!!busy||!available||!canWrite||!reviewed||!hasTopics||Boolean(buffered)} onClick={()=>action('stage-videos',()=>api(`/products/${productId}/stages/videos`,{method:'POST',body:{refresh:Boolean(record),expectedVersion:record?.editToken,videoLibrary:catalog}}),'Video drafts saved')}>{busy==='stage-videos'?'Preparing videos…':record?'Regenerate videos':'Generate videos'}</Button></div>
  <details className="video-legacy-library"><summary>Custom media for earlier drafts</summary><VideoMediaLibrary {...{scope,library}} onChange={setLibrary} disabled={!canWrite||!!busy}/>{libraryError&&<p className="form-error" role="alert">{libraryError}</p>}</details>
  {!reviewed?<WorkspaceNotice title="Confirm your product details" description="Review what your product offers so content uses supported claims."><Button variant="outline" onClick={()=>onEdit(product)}>Review business profile</Button></WorkspaceNotice>:!hasTopics?<WorkspaceNotice title="Start with collected topics" description="Identify current patterns in your conversations before preparing videos."><Button variant="outline" asChild><a href="#insights">Identify Patterns</a></Button></WorkspaceNotice>:null}
  {!available&&<p className="pipeline-notice">Video generation is currently paused. Saved drafts and downloads remain available. <a href="#settings">View workspace status</a></p>}
  {buffered&&<p className="pipeline-notice" role="status">Your video edits are kept when you switch tools or products. Save or discard them before regenerating.</p>}
  {record?.stale&&<p className="pipeline-notice">{record.imported?'This batch was restored from a backup. Its source details are historical.':'The source topics or product details changed.'} This saved batch remains available to export; regenerate to edit current drafts.</p>}
  {record?.data.videos.length?<VideoBatch key={`${productId}:${record.generatedAt}:${record.editVersion||0}`} {...{product,record,busy,action,buffered,scope,templates,library:catalog}} setBuffered={value=>setBuffer(`videos:${productId}`,value)} readOnly={!canWrite||record.stale||state.pipeline?.actionsEnabled===false}/>:<div className="video-empty"><div className="video-empty-frame" aria-hidden="true"><span>A familiar moment.</span><i/><span>A real reaction.</span><i/><span>One good line.</span></div><div><h3>{record?'No supported reaction ideas yet':'A reaction starts with a familiar customer moment'}</h3><p>{record?'Review your collected topics and refresh when there is a specific customer moment to work with.':'Generate up to three drafts from your current topics. Each includes a situation, clip match or brief, an editable caption, and its supporting conversations.'}</p><p className="muted">9:16 vertical · Ready-made scenes · Editable captions</p></div></div>}
  {record?.data.limitations?.length>0&&<details className="video-limitations"><summary>Batch notes</summary><ul>{record.data.limitations.map((note,index)=><li key={index}>{note}</li>)}</ul></details>}
  <p className="muted video-allowance">Writing drafts uses your shared AI allowance. Video rendering happens in this browser.</p>
 </div>;
}

function VideoBatch({product,record,busy,action,buffered,setBuffered,readOnly,scope,library,templates}){
 const videos=buffered?.videos||record.data.videos,dirty=Boolean(buffered);
 const [selectedId,setSelectedId]=useState(videos[0].id),[sceneIndex,setSceneIndex]=useState(0),[time,setTime]=useState(0),[playing,setPlaying]=useState(false),[exporting,setExporting]=useState(false),[progress,setProgress]=useState(0),[saveError,setSaveError]=useState(''),[media,setMedia]=useState(null),[mediaError,setMediaError]=useState('');
 const canvas=useRef(null),exportController=useRef(null),mediaRequest=useRef(0);
 const video=videos.find(row=>row.id===selectedId)||videos[0],duration=videoDuration(video),current=sceneAt(video,time);
 const scene=video.scenes[Math.min(sceneIndex,video.scenes.length-1)],exportType=videoExportType();
 const locked=readOnly||exporting||Boolean(busy),reaction=video.format==='reaction';
 const clip=library.find(row=>row.id===video.reaction?.clipId&&row.kind==='clip'),assembled=templates.find(row=>row.id===video.reaction?.clipId);
 useEffect(()=>{let active=true,loaded;setMedia(null);setMediaError('');if(reaction&&video.reaction.clipId)loadReactionMedia(scope,video,library,templates).then(value=>{loaded=value;if(active){setMedia(value);setMediaError('');}else value.close();}).catch(error=>{if(active)setMediaError(error.message);});return()=>{active=false;loaded?.close();};},[scope,reaction,video.reaction?.clipId,video.reaction?.backgroundId,clip?.mode]);
 useEffect(()=>()=>exportController.current?.abort(),[]);
 useEffect(()=>{let active=true;const request=++mediaRequest.current;const draw=async()=>{await document.fonts.ready;if(media&&media.clip.readyState>=2&&Number.isFinite(media.clip.duration)&&!playing&&!exporting)await seekClip(media.clip,Math.min(video.reaction.clipStart+time,media.clip.duration-0.001));if(active&&request===mediaRequest.current&&canvas.current)drawVideoFrame(canvas.current,video,time,media);};draw().catch(error=>{if(active)setMediaError(error.message);});return()=>{active=false;};},[video,time,media,playing,exporting]);
 useEffect(()=>{
  if(!playing)return;let frame,active=true;const started=performance.now()-time*1000;
  const tick=now=>{const next=(now-started)/1000;if(next>=duration){setTime(duration);setPlaying(false);return;}setTime(next);frame=requestAnimationFrame(tick);};
  const start=async()=>{try{if(media){await seekClip(media.clip,video.reaction.clipStart+time);await media.clip.play();}if(active)frame=requestAnimationFrame(tick);}catch(error){if(active){setMediaError(error.message);setPlaying(false);}}};start();return()=>{active=false;cancelAnimationFrame(frame);media?.clip?.pause();};
 },[playing,video,duration,media]);
 useEffect(()=>{if(playing)setSceneIndex(current.index);},[playing,current.index]);
 function editReaction(patch){edit({reaction:{...video.reaction,...patch}});}
 function edit(patch){setPlaying(false);setSaveError('');setBuffered({videos:videos.map(row=>row.id===video.id?{...row,...patch}:row),expectedVersion:buffered?.expectedVersion||record.editToken});}
 function selectScene(index){setPlaying(false);setSceneIndex(index);setTime(video.scenes.slice(0,index).reduce((total,row)=>total+Number(row.seconds),0));}
 function editScene(patch){edit({scenes:video.scenes.map((row,index)=>index===sceneIndex?{...row,...patch}:row)});}
 async function copyCaption(){try{await navigator.clipboard.writeText(video.caption);toast.success('Caption copied');}catch{toast.error('Select the caption text and copy it.');}}
 async function exportVideo(){
  setPlaying(false);setProgress(0);setExporting(true);const controller=new AbortController();exportController.current=controller;
  try{const result=await renderVideo(video,{signal:controller.signal,onProgress:setProgress,media});downloadBlob(result.blob,`${videoFilename(video)}.${result.extension}`);toast.success('Video downloaded');}
  catch(error){if(error.name!=='AbortError')toast.error(error.message);}
  finally{exportController.current=null;setExporting(false);}
 }
 return <>
  <div className="video-draft-tabs" role="group" aria-label="Video drafts">{videos.map(row=><button key={row.id} type="button" aria-pressed={row.id===video.id} disabled={exporting} onClick={()=>{setSelectedId(row.id);setSceneIndex(0);setTime(0);setPlaying(false);}}><span>{row.title}</span><small>{videoDuration(row)}s · {row.sources?.length||row.evidenceIds.length} sources</small></button>)}</div>
  <div className="video-studio">
   <section className="video-editor" aria-label="Video editor">
    <div className="video-editor-status"><span>{dirty?'Unsaved changes':`Saved ${date(record.editedAt||record.generatedAt)}`}</span><span>{reaction?'Reaction':`${video.scenes.length} scenes`} · {duration}s</span></div>
    <label className="video-field">Video title<Input value={video.title} maxLength={120} disabled={locked} onChange={event=>edit({title:event.target.value})}/></label>
    {reaction&&templates.length>0&&<TemplateGallery {...{templates}} selectedId={assembled?.id} disabled={locked} onSelect={row=>{setTime(0);edit(switchVideoTemplate(video,row));}}/>}
    {reaction&&!assembled&&<details className="video-legacy-library"><summary>Custom clip settings</summary><ReactionBrief video={video} locked={locked} editReaction={editReaction} library={library} localClip={clip}/></details>}
    {!reaction&&<div className="video-scene-tabs" role="group" aria-label="Scenes">{video.scenes.map((row,index)=><button type="button" key={index} aria-pressed={sceneIndex===index} onClick={()=>selectScene(index)} disabled={exporting}><span>{index+1}</span>{row.role==='hook'?'Hook':row.role==='close'?'Takeaway':`Step ${index}`}<small>{row.seconds}s</small></button>)}</div>}
    {reaction&&<CaptionStylePicker value={video.template} disabled={locked} onChange={template=>edit({template})}/>}
    <div className="video-scene-editor"><label className="video-field">On-screen headline<Input value={scene.headline} maxLength={reaction?240:90} disabled={locked} onChange={event=>editScene({headline:event.target.value})}/></label>{!reaction&&<label className="video-field">On-screen text<Textarea value={scene.body} maxLength={240} rows={4} disabled={locked} onChange={event=>editScene({body:event.target.value})}/></label>}{!assembled&&<label className="video-duration">Scene duration<select value={scene.seconds} disabled={locked} onChange={event=>{editScene({seconds:event.target.value});selectScene(sceneIndex);}}><option value="4">4 seconds</option><option value="6">6 seconds</option><option value="8">8 seconds</option>{reaction&&<><option value="10">10 seconds</option><option value="12">12 seconds</option></>}</select></label>}<p className="muted">{(scene.headline+' '+scene.body).trim().split(/\s+/).length} words · Keep the text comfortable to read.</p></div>
    <label className="video-field video-caption">Social caption<Textarea value={video.caption} maxLength={2200} disabled={locked} onChange={event=>edit({caption:event.target.value})} rows={5}/><span>{video.caption.length} / 2,200 characters</span></label>
    {video.affiliation&&<p className="video-disclosure">Disclosure shown on the video: {video.affiliation}</p>}
    {video.reviewNotes?.length>0&&<details className="video-review-notes"><summary>Review before sharing</summary><ul>{video.reviewNotes.map((note,index)=><li key={index}>{note}</li>)}</ul></details>}
    {saveError&&<p role="alert" className="form-error">{saveError}</p>}
    <div className="video-save-bar"><Button disabled={!dirty||locked} onClick={()=>action('video-save',async()=>{try{await api(`/products/${product.id}/stages/videos`,{method:'PUT',body:{videos,limitations:record.data.limitations,expectedVersion:buffered.expectedVersion,videoLibrary:library}});setBuffered(undefined);setSaveError('');}catch(error){setSaveError(error.message);throw error;}},'Video edits saved')}>{busy==='video-save'?'Saving…':'Save edits'}</Button>{dirty&&<Button variant="ghost" disabled={exporting||!!busy} onClick={()=>{setBuffered(undefined);setSaveError('');setPlaying(false);setSceneIndex(0);setTime(0);}}>Discard edits</Button>}<Button variant="outline" onClick={copyCaption} disabled={exporting}><Copy/>Copy caption</Button></div>
   </section>
   <aside className="video-preview-column" aria-label="Video preview and exports">
    <div className="video-preview-heading"><h3>Preview</h3><span>1080 × 1920</span></div>
    {mediaError&&<p className="form-error" role="alert">{mediaError}</p>}
    <canvas ref={canvas} width="1080" height="1920" className="video-preview" role="img" aria-label={`Scene ${current.index+1}: ${current.scene.headline}. ${current.scene.body}`}/>
    <div className="video-playback"><Button variant="ghost" size="sm" aria-label={playing?'Pause preview':'Play preview'} disabled={exporting||reaction&&!media} onClick={()=>{if(time>=duration)setTime(0);setPlaying(!playing);}}>{playing?<Pause/>:<Play/>}{playing?'Pause':'Play'}</Button><Button variant="ghost" size="icon" aria-label="Restart preview" disabled={exporting} onClick={()=>{setPlaying(false);setTime(0);setSceneIndex(0);}}><RotateCcw/></Button><span>{Math.floor(time)}s / {duration}s</span></div>
    {!reaction&&<label className="video-template">Template<select value={video.template} disabled={locked} onChange={event=>edit({template:event.target.value})}><option value="paper">Paper</option><option value="charcoal">Charcoal</option></select></label>}
    <div className="video-exports">{exporting?<><p role="status">Rendering video… {Math.round(progress*100)}%</p><progress value={progress} max="1" aria-label="Video export progress"/><Button variant="outline" onClick={()=>exportController.current?.abort()}>Cancel export</Button></>:<><Button disabled={dirty||!exportType||reaction&&(!media||mediaError||video.reaction.clipStart+duration>(media.clip.duration+0.02))} onClick={exportVideo}><Download/>Download video{exportType?` (${exportType.startsWith('video/mp4')?'MP4':'WebM'})`:''}</Button><p className="muted">{dirty?'Save edits to download the updated video.':reaction&&!media?'Choose a clip from this browser to export the finished reaction.':exportType?'Silent video with your overlay built in. Keep this tab visible during export.':'Video export is unavailable in this browser. Scripts and subtitles are available below.'}</p></>}
     <div className="video-export-extras"><Button variant="outline" size="sm" disabled={exporting} onClick={()=>downloadBlob(new Blob([videoSubtitles(video)],{type:'text/plain;charset=utf-8'}),`${videoFilename(video)}.srt`)}>Subtitles (.srt)</Button><Button variant="outline" size="sm" disabled={exporting} onClick={()=>downloadBlob(new Blob([JSON.stringify({...video,format:{width:1080,height:1920},durationSeconds:duration},null,2)],{type:'application/json'}),`${videoFilename(video)}.json`)}>Script & sources</Button></div>
    </div>
   </aside>
  </div>
  <section className="video-evidence"><h3>Where this idea came from</h3><p>{video.sources?.length||0} collected conversations. Source quotes stay here for review; the video uses original wording.</p>{video.sources?.length?video.sources.map(source=><details key={source.id}><summary>{source.title||'Collected conversation'}</summary><p className="muted">{[source.author,date(source.publishedAt)].filter(Boolean).join(' · ')}</p>{source.quote&&<blockquote>{source.quote}</blockquote>}{safeURL(source.url)&&<a href={safeURL(source.url)} target="_blank" rel="noopener noreferrer">Open original conversation</a>}</details>):<p className="muted">This imported batch has no saved source detail. Regenerate from current topics to restore attribution.</p>}</section>
 </>;
}

function ReactionBrief({video,locked,editReaction,library,localClip}){
 const brief=video.reaction;
 return <div className="video-reaction-editor">
  <details className="video-reaction-brief"><summary>The moment & clip fit</summary>{[['viewpoint','Whose point of view?'],['want','What do they want?'],['trigger','What happens?'],['action','What does the reaction do?'],['turn','Where is the payoff?'],['clipCriteria','What clip fits this moment?'],['backgroundCriteria','Why this background?']].map(([key,label])=><label className="video-field" key={key}>{label}<Textarea value={brief[key]} maxLength={key==='clipCriteria'?500:['trigger','action','turn','backgroundCriteria'].includes(key)?300:240} rows={2} disabled={locked} onChange={event=>editReaction({[key]:event.target.value})}/></label>)}</details>
  <label className="video-field">Reaction clip<select value={brief.clipId} disabled={locked} onChange={event=>editReaction({clipId:event.target.value,clipStart:0,backgroundId:''})}><option value="">Choose a matching clip</option>{library.filter(row=>row.kind==='clip').map(row=><option key={row.id} value={row.id}>{row.label} · {row.duration.toFixed(1)}s</option>)}</select></label>
  {localClip&&<p className="video-selected-action">{localClip.description}</p>}
  {brief.clipId&&<label className="video-field">Start clip at (seconds)<Input type="number" min="0" max={localClip?.duration||60} step="0.1" value={brief.clipStart} disabled={locked} onChange={event=>editReaction({clipStart:Number(event.target.value)})}/></label>}
  {localClip?.mode==='green'&&<label className="video-field">Background<select value={brief.backgroundId} disabled={locked} onChange={event=>editReaction({backgroundId:event.target.value})}><option value="">Plain template background</option>{library.filter(row=>row.kind==='background').map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</select></label>}
 </div>;
}
