import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Textarea} from '@/components/ui/textarea';
import {CaptionStylePicker} from './CaptionStylePicker';
import {Copy,Download,Pause,Play,RotateCcw,Check} from 'lucide-react';
import {toast} from 'sonner';
import {templateAsset,templateVideo} from '../../ready-template-catalog.mjs';
import {readTemplateDraft,writeTemplateDraft} from './ready-template-drafts.mjs';
import {loadReactionMedia,seekClip} from './video-media.mjs';
import {drawVideoFrame,downloadBlob,renderVideo,videoExportType,videoFilename} from './video-render.mjs';

export function TemplateGallery({templates,selectedId,onSelect,disabled=false}){
 return <div className="ready-template-gallery" role="group" aria-label="Ready-made reaction templates">{templates.map(template=><button type="button" key={template.id} disabled={disabled} aria-pressed={template.id===selectedId} aria-label={`Use ${template.label}`} onClick={()=>onSelect(template)}><div className="ready-template-poster"><img src={template.posterUrl} alt="" loading="lazy"/>{template.id===selectedId&&<span className="ready-template-check"><Check size={14}/></span>}<span className="ready-template-length">{template.seconds}s</span></div><strong>{template.label}</strong><span>{template.action}</span></button>)}</div>;
}

export function ReadyTemplateWorkspace({templates,scope,readOnly=false}){
 const [draft,setDraft]=useState(()=>readTemplateDraft(scope,templates)),[saved,setSaved]=useState(true),[media,setMedia]=useState(null),[error,setError]=useState(''),[time,setTime]=useState(0),[playing,setPlaying]=useState(false),[exporting,setExporting]=useState(false),[progress,setProgress]=useState(0);
 const canvas=useRef(null),controller=useRef(null),drawing=useRef(0);
 const template=templates.find(row=>row.id===draft.templateId)||templates[0],video=template&&templateVideo(template,draft),duration=template?.seconds||0,exportType=videoExportType();
 const words=draft.headline.trim().split(/\s+/).filter(Boolean).length,tooLong=words>duration*3,locked=readOnly||exporting;
 useEffect(()=>{let active=true,loaded;setPlaying(false);setTime(0);setMedia(null);setError('');if(template)loadReactionMedia(scope,templateVideo(template,draft),[templateAsset(template)],templates).then(value=>{loaded=value;if(active)setMedia(value);else value.close();}).catch(err=>{if(active)setError(err.message);});return()=>{active=false;loaded?.close();};},[scope,template?.id]);
 useEffect(()=>()=>controller.current?.abort(),[]);
 useEffect(()=>{if(!video)return;let active=true;const request=++drawing.current;const draw=async()=>{await document.fonts.ready;if(media&&!playing&&!exporting&&Number.isFinite(media.clip.duration))await seekClip(media.clip,Math.min(time,media.clip.duration-0.001));if(active&&request===drawing.current&&canvas.current)drawVideoFrame(canvas.current,{...video,scenes:[{...video.scenes[0],headline:draft.headline||'Your caption goes here'}]},time,media);};draw().catch(err=>{if(active)setError(err.message);});return()=>{active=false;};},[draft,time,media,playing,exporting,template?.id]);
 useEffect(()=>{if(!playing||!media)return;let active=true,frame,started;const tick=now=>{const next=(now-started)/1000;if(next>=duration){setTime(duration);setPlaying(false);return;}setTime(next);frame=requestAnimationFrame(tick);};const start=async()=>{try{await seekClip(media.clip,time);await media.clip.play();if(active){started=performance.now()-time*1000;frame=requestAnimationFrame(tick);}}catch(err){if(active){setError(err.message);setPlaying(false);}}};start();return()=>{active=false;cancelAnimationFrame(frame);media.clip.pause();};},[playing,media,duration]);
 function edit(patch){setPlaying(false);const next={...draft,...patch};setDraft(next);setSaved(writeTemplateDraft(scope,next));}
 async function copy(){try{await navigator.clipboard.writeText(draft.caption);toast.success('Caption copied');}catch{toast.error('Select the caption text and copy it.');}}
 async function exportVideo(){if(!media||!draft.headline.trim()||tooLong)return;setPlaying(false);setExporting(true);setProgress(0);const abort=new AbortController();controller.current=abort;try{const result=await renderVideo(video,{signal:abort.signal,onProgress:setProgress,media});downloadBlob(result.blob,`${videoFilename(video)}.${result.extension}`);toast.success('Video downloaded');}catch(err){if(err.name!=='AbortError')setError(err.message);}finally{setExporting(false);controller.current=null;}}
 if(!template)return <div className="ready-template-empty"><h3>Our reaction templates are being prepared</h3><p>Complete scenes will appear here with their reaction, background and timing already set. You’ll only add captions.</p></div>;
 return <>
  <div className="ready-template-intro"><span className="ready-template-step">1</span><div><h3>Choose your scene</h3><p>The reaction and background are already together.</p></div>{templates.some(row=>row.status==='preview')&&<span className="ready-template-preview-label">Preview templates</span>}</div>
  <TemplateGallery {...{templates}} selectedId={template.id} disabled={locked} onSelect={row=>{setTime(0);edit({templateId:row.id});}}/>
  <div className="video-studio ready-template-studio">
   <section className="video-editor" aria-label="Template captions">
    <div className="ready-template-intro"><span className="ready-template-step">2</span><div><h3>Make it yours</h3><p>Set up the moment. Let the reaction do the rest.</p></div></div>
    <CaptionStylePicker value={draft.captionStyle} disabled={locked} onChange={captionStyle=>edit({captionStyle})}/>
    <label className="video-field">On-video caption<Textarea value={draft.headline} rows={3} maxLength={240} disabled={locked} placeholder="when you said you were just getting a coffee" onChange={event=>edit({headline:event.target.value})}/><span className={tooLong?'form-error':'muted'}>{tooLong?`Keep this caption to ${duration*3} words for the ${duration}-second scene.`:`${words} / ${duration*3} words · ${duration}-second scene`}</span></label>
    <label className="video-field video-caption">Post caption<Textarea value={draft.caption} rows={3} maxLength={2200} disabled={locked} placeholder="the pastry had other plans" onChange={event=>edit({caption:event.target.value})}/><span>{draft.caption.length} / 2,200 characters</span></label>
    <Button variant="outline" onClick={copy} disabled={exporting||!draft.caption.trim()}><Copy/>Copy post caption</Button>
    <p className="ready-template-save" role="status">{saved?'Your captions are saved in this browser.':'Browser storage is unavailable. Your captions are kept until this page closes.'}</p>
    {template.status==='preview'&&<details className="video-review-notes"><summary>About this preview template</summary><p>{template.provenance}</p></details>}
   </section>
   <aside className="video-preview-column" aria-label="Finished template preview">
    <div className="video-preview-heading"><h3>{template.label}</h3><span>9:16</span></div>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <canvas ref={canvas} width="1080" height="1920" className="video-preview" role="img" aria-label={`${template.label}: ${draft.headline||'Your caption goes here'}`}/>
    <div className="video-playback"><Button variant="ghost" size="sm" disabled={exporting||!media} aria-label={playing?'Pause template preview':'Play template preview'} onClick={()=>{if(time>=duration)setTime(0);setPlaying(!playing);}}>{playing?<Pause/>:<Play/>}{playing?'Pause':'Play'}</Button><Button variant="ghost" size="icon" aria-label="Restart template preview" disabled={exporting} onClick={()=>{setPlaying(false);setTime(0);}}><RotateCcw/></Button><span>{Math.floor(time)}s / {duration}s</span></div>
    <div className="video-exports">{exporting?<><p role="status">Rendering video… {Math.round(progress*100)}%</p><progress value={progress} max="1" aria-label="Template export progress"/><Button variant="outline" onClick={()=>controller.current?.abort()}>Cancel export</Button></>:<><Button disabled={!media||!exportType||!draft.headline.trim()||tooLong} onClick={exportVideo}><Download/>Download video ({exportType?.startsWith('video/mp4')?'MP4':'WebM'})</Button><p className="muted">{!draft.headline.trim()?'Add your on-video caption to download.':'1080 × 1920 · Silent video with your caption built in. Keep this tab visible during export.'}</p></>}</div>
   </aside>
  </div>
 </>;
}
