import test from 'node:test';
import assert from 'node:assert/strict';
import {READY_TEMPLATES,readyTemplates,templateAsset,templateVideo,mergeVideoCatalog,switchVideoTemplate} from '../ready-template-catalog.mjs';
import {normalizeTemplateDraft,readTemplateDraft,writeTemplateDraft,templateDraftKey} from '../ui/src/ready-template-drafts.mjs';
import {validateVideoLibrary} from '../video-library.mjs';
import {videoDuration,videoSubtitles} from '../ui/src/video-render.mjs';
import {loadReactionMedia} from '../ui/src/video-media.mjs';
import {drawReactionFrame} from '../ui/src/reaction-render.mjs';

test('reference preview footage stays out of the published owner library',()=>{
 assert.deepEqual(readyTemplates(),[]);assert.deepEqual(readyTemplates({fixture:true}),READY_TEMPLATES);
 assert.ok(READY_TEMPLATES.every(row=>row.status==='preview'&&row.provenance.includes('Reference')));
 assert.deepEqual(validateVideoLibrary(READY_TEMPLATES.map(templateAsset)),READY_TEMPLATES.map(templateAsset));
});
test('choosing a complete template fixes its background and timing while preserving the customer captions',()=>{
 const draft={headline:'when your usual order is already waiting',caption:'i have a routine'},video=templateVideo(READY_TEMPLATES[0],draft);
 assert.equal(video.reaction.backgroundId,'');assert.equal(video.reaction.clipStart,0);assert.equal(videoDuration(video),6);assert.equal(video.scenes.length,1);
 assert.equal(video.scenes[0].headline,draft.headline);assert.equal(video.caption,draft.caption);assert.deepEqual(video.sources,[]);
 assert.match(videoSubtitles(video),/00:00:00,000 --> 00:00:06,000/);
 const next=templateVideo(READY_TEMPLATES[1],draft);assert.equal(next.caption,video.caption);assert.notEqual(next.reaction.clipId,video.reaction.clipId);
});
test('template captions persist with workspace/member/product isolation and tolerate corrupt or unavailable storage',()=>{
 const data=new Map(),storage={getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value)},a='workspace-a:member-a:product-a',b='workspace-b:member-a:product-a';
 const draft={templateId:READY_TEMPLATES[1].id,headline:'a'.repeat(300),caption:'b'.repeat(2500),captionStyle:'snapchat'};
 assert.equal(writeTemplateDraft(a,draft,storage),true);assert.equal(readTemplateDraft(a,READY_TEMPLATES,storage).captionStyle,'snapchat');assert.equal(readTemplateDraft(a,READY_TEMPLATES,storage).headline.length,240);assert.equal(readTemplateDraft(a,READY_TEMPLATES,storage).caption.length,2200);
 assert.equal(readTemplateDraft(b,READY_TEMPLATES,storage).headline,'');assert.notEqual(templateDraftKey(a),templateDraftKey(b));
 data.set(templateDraftKey('corrupt'),'{broken');assert.equal(readTemplateDraft('corrupt',READY_TEMPLATES,storage).templateId,READY_TEMPLATES[0].id);
 const blocked={getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('blocked');}};
 assert.equal(writeTemplateDraft('blocked',draft,blocked),false);assert.equal(readTemplateDraft('blocked',READY_TEMPLATES,blocked).templateId,READY_TEMPLATES[1].id);
 assert.deepEqual(normalizeTemplateDraft({templateId:'unknown',headline:123,caption:[]},READY_TEMPLATES),{templateId:READY_TEMPLATES[0].id,headline:'',caption:'',captionStyle:'instagram'});
});
test('changing a source-backed template updates the documented action while keeping its source identity and captions',()=>{
 const video={...templateVideo(READY_TEMPLATES[0],{headline:'a familiar moment',caption:'an extra beat',captionStyle:'snapchat'}),insightId:'topic',evidenceIds:['source'],sources:[{id:'source',quote:'original evidence'}]},next=switchVideoTemplate(video,READY_TEMPLATES[1]);
 assert.equal(next.template,'snapchat');assert.equal(next.reaction.action,READY_TEMPLATES[1].action);assert.equal(next.reaction.clipCriteria,READY_TEMPLATES[1].description);assert.equal(next.reaction.backgroundId,'');assert.equal(next.reaction.clipStart,0);
 for(const key of ['id','insightId','evidenceIds','sources','caption'])assert.deepEqual(next[key],video[key]);assert.equal(next.scenes[0].headline,video.scenes[0].headline);
});
test('adding ready templates does not drop referenced legacy media or exceed stage catalog limits',()=>{
 const clip=templateAsset(READY_TEMPLATES[0]),local=Array.from({length:12},(_,index)=>({...clip,id:'local-'+index})),backgrounds=Array.from({length:12},(_,index)=>({...clip,id:'bg-'+index,kind:'background',mode:'image',duration:0}));
 const merged=mergeVideoCatalog(READY_TEMPLATES,[...local,...backgrounds],[],[{reaction:{clipId:'local-11',backgroundId:'bg-11'}}]);
 assert.equal(merged.length,24);assert.ok(merged.some(row=>row.id==='local-11'));assert.ok(merged.some(row=>row.id==='bg-11'));assert.ok(READY_TEMPLATES.every(row=>merged.some(asset=>asset.id===row.id)));
 assert.deepEqual(validateVideoLibrary(merged),merged);
});
test('ready masters load directly without browser imports or an IndexedDB dependency',async()=>{
 const priorDocument=globalThis.document,priorDB=globalThis.indexedDB;let source='';
 globalThis.indexedDB=undefined;
 const clip={pause(){},load(){},removeAttribute(){},set src(value){source=value;queueMicrotask(()=>this.onloadeddata());}};
 globalThis.document={createElement:()=>clip};
 try{const media=await loadReactionMedia('new-browser',templateVideo(READY_TEMPLATES[0],{}),[templateAsset(READY_TEMPLATES[0])],READY_TEMPLATES);assert.equal(source,READY_TEMPLATES[0].mediaUrl);assert.equal(media.assembled,true);assert.equal(media.background,null);media.close();}
 finally{globalThis.document=priorDocument;globalThis.indexedDB=priorDB;}
});
test('assembled reaction masters fill the vertical frame rather than being shrunk into a custom-media box',()=>{
 const calls=[],ctx={fillRect(){},drawImage(...args){calls.push(args);},fillText(){},strokeText(){},save(){},restore(){}},clip={readyState:2},video=templateVideo(READY_TEMPLATES[0],{headline:'a familiar moment'});
 drawReactionFrame(ctx,video,{clip,assembled:true},{fitted:()=>({lines:['a familiar moment'],size:70})});
 assert.deepEqual(calls,[[clip,0,0,1080,1920]]);
});
