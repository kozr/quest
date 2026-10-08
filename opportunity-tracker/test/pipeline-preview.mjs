// Disposable fixture preview: no external model, scraper, or publishing calls.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTrackerApp} from '../server.mjs';
import {pipelineProvider,v2Business,conversations} from './pipeline.fixture.mjs';
const directory=await mkdtemp(join(tmpdir(),'hearwhispers-pipeline-preview-'));
const tracker=createTrackerApp({dataDirectory:directory,qualificationEnv:{TRACKER_COLLECTION_PIPELINE:'experiment-v1',SCRAPEBADGER_API_KEY:'fixture'},stageProvider:pipelineProvider(),collectionProvider:{fetchPage:async()=>({credits:0,result:{rows:conversations(),cursor:null}})}});
const product=tracker.store.saveProduct(v2Business());
await tracker.runStage(product.id,'search_plan');
if(process.env.PREVIEW_COMPLETE==='true'){
  const plan=tracker.store.snapshot().pipelineStages[product.id].search_plan.data;
  tracker.store.saveSearchPlan(product.id,{...plan,reviewed:true},'v2');
  tracker.store.recordSearch(product.id,{items:[],semantic:true,candidates:conversations(),sources:[],searchedAt:new Date().toISOString()});
  for(const stage of ['qualify','insights','actions','drafts'])await tracker.runStage(product.id,stage);
}
const server=tracker.app.listen(0,'127.0.0.1',()=>console.log(`Fixture preview: http://127.0.0.1:${server.address().port}/#listening`));
async function close(){await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});process.exit(0);}
process.on('SIGINT',close);process.on('SIGTERM',close);
