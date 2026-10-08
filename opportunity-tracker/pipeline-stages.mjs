import {hash,problem,PIPELINE_VERSION} from './pipeline-contract.mjs';
import {searchPlanInput,SEARCH_PLAN_SCHEMA,SEARCH_PLAN_PROMPT,validateSearchPlan,reviewedBusiness} from './search-plan.mjs';
import {qualificationInput,QUALIFY_V2_SCHEMA,QUALIFY_V2_PROMPT,validateV2Qualification} from './listening-qualification.mjs';
import {insightsInput,INSIGHTS_SCHEMA,INSIGHTS_PROMPT,validateInsights} from './listening-insights.mjs';
import {ACTION_SCHEMA,ACTION_PROMPT,validateActions,DRAFT_SCHEMA,DRAFT_PROMPT,validateDrafts} from './action-stages.mjs';

function currentRecord(data,p,stage){
  const row=data.pipelineStages?.[p.id]?.[stage];
  if(!row||row.imported||row.inputHash!==stageContext(data,p.id,stage).inputHash)problem(`Run the current ${stage.replaceAll('_',' ')} stage first.`,409);
  return row.data;
}
export const STAGE_DEFINITIONS={
  search_plan:{number:2,promptVersion:'search-plan-v1',prompt:SEARCH_PLAN_PROMPT,schema:SEARCH_PLAN_SCHEMA,maxOutput:5000,input:(data,p)=>searchPlanInput(p),validate:(value,p,input)=>validateSearchPlan(value,p)},
  qualify:{number:4,promptVersion:'listening-qualification-v2',prompt:QUALIFY_V2_PROMPT,schema:QUALIFY_V2_SCHEMA,maxOutput:8000,input:qualificationInput,validate:validateV2Qualification},
  insights:{number:5,promptVersion:'listening-insights-v1',prompt:INSIGHTS_PROMPT,schema:INSIGHTS_SCHEMA,maxOutput:5000,input:insightsInput,validate:validateInsights},
  actions:{number:6,promptVersion:'actions-v2',prompt:ACTION_PROMPT,schema:ACTION_SCHEMA,maxOutput:5000,input:(data,p)=>({business:reviewedBusiness(p),insights:currentRecord(data,p,'insights').insights,asOf:new Date().toISOString().slice(0,10)}),validate:validateActions},
  drafts:{number:7,promptVersion:'advice-first-drafts-v1',prompt:DRAFT_PROMPT,schema:DRAFT_SCHEMA,maxOutput:7000,input:(data,p)=>{
    const actions=currentRecord(data,p,'actions').actions.filter(a=>['answer','fresh_post'].includes(a.type));
    if(!actions.length)problem('The current recommendations contain no post or reply to draft.',409);
    return {business:reviewedBusiness(p),insights:currentRecord(data,p,'insights').insights,actions};
  },validate:validateDrafts}
};
export function stageContext(data,productId,stage){
  const definition=STAGE_DEFINITIONS[stage];if(!Object.hasOwn(STAGE_DEFINITIONS,stage))problem('Unknown listening stage.');
  const product=data.products.find(p=>p.id===productId);if(!product)problem('Business not found.',404);
  const input=definition.input(data,product);
  return {product,definition,input,inputHash:hash([PIPELINE_VERSION,stage,definition.promptVersion,input])};
}
export function stageSnapshot(data){
  return Object.fromEntries(data.products.map(product=>[product.id,Object.fromEntries(Object.entries(data.pipelineStages?.[product.id]||{}).map(([stage,record])=>{
    let stale=true;try{stale=Boolean(record.imported)||stage!=='qualify'&&record.inputHash!==stageContext(data,product.id,stage).inputHash;}catch{}
    return [stage,{...record,stale}];
  }))]));
}
// Imported stage outputs are historical, never authority to dispatch a later
// stage. Validate their declared shape before showing them in the workspace.
function declared(value,schema){
  if(Array.isArray(schema.type)&&value===null&&schema.type.includes('null'))return null;
  const type=Array.isArray(schema.type)?schema.type.find(x=>x!=='null'):schema.type;
  if(schema.enum&&!schema.enum.includes(value))problem('Invalid imported stage value.');
  if(type==='string'){if(typeof value!=='string'||value.length>(schema.maxLength||5000))problem('Invalid imported stage text.');return value;}
  if(type==='boolean'){if(typeof value!=='boolean')problem('Invalid imported stage value.');return value;}
  if(type==='array'){if(!Array.isArray(value)||value.length>(schema.maxItems||120)||value.length<(schema.minItems||0))problem('Invalid imported stage entries.');return value.map(v=>declared(v,schema.items));}
  if(type==='object'){if(!value||typeof value!=='object'||Array.isArray(value))problem('Invalid imported stage output.');return Object.fromEntries(Object.entries(schema.properties).map(([k,s])=>[k,declared(value[k],s)]));}
  problem('Invalid imported stage schema.');
}
export function validateStageRecords(value,products){
  if(value===undefined)return {};
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>100)problem('Invalid saved listening stages.');
  const records={};
  for(const product of products){
    const saved=value[product.id];if(!saved)continue;
    if(!saved||typeof saved!=='object'||Array.isArray(saved)||Object.keys(saved).length>5)problem('Invalid saved listening stages.');
    records[product.id]={};
    for(const [stage,row] of Object.entries(saved)){
      if(!STAGE_DEFINITIONS[stage]||row.version!==PIPELINE_VERSION||row.stage!==stage||!/^[a-f0-9]{64}$/.test(row.inputHash)||!Number.isFinite(Date.parse(row.generatedAt))||JSON.stringify(row).length>100000)problem('Invalid saved stage record.');
      records[product.id][stage]={version:PIPELINE_VERSION,stage,inputHash:row.inputHash,generatedAt:row.generatedAt,model:String(row.model||'imported').slice(0,80),data:declared(row.data,STAGE_DEFINITIONS[stage].schema),imported:true};
    }
  }return records;
}
