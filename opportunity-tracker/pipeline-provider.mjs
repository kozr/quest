import {qualificationSettings,solCost} from './qualification.mjs';
import {readText} from './reddit/http.mjs';
import {problem} from './pipeline-contract.mjs';
import {STAGE_DEFINITIONS} from './pipeline-stages.mjs';

export function stageRequest(stage,input){const d=STAGE_DEFINITIONS[stage];if(!d)problem('Unknown listening stage.');const count=Array.isArray(input?.evidence)?Math.max(1,input.evidence.length):1,maxOutput=stage==='qualify'?Math.min(d.maxOutput,4096+1024*(count-1)):d.maxOutput;return {model:'gpt-6.1-sol',service_tier:'default',store:false,reasoning:{effort:'medium'},max_output_tokens:maxOutput,input:[{role:'system',content:d.prompt},{role:'user',content:JSON.stringify(input)}],text:{format:{type:'json_schema',name:`listening_${stage}`,strict:true,schema:d.schema}}};}
export function stageReservation(stage,input){const r=stageRequest(stage,input);return Math.ceil((Buffer.byteLength(JSON.stringify(r))+r.max_output_tokens)*2.5+r.max_output_tokens*10);}
export function createStageProvider({env=process.env,request=fetch}={}){
  return {available:qualificationSettings(env).active,async run(stage,input){
    const payload=stageRequest(stage,input);
    try{
      const response=await request('https://api.openai.com/v1/responses',{method:'POST',redirect:'error',signal:AbortSignal.timeout(90000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.TRACKER_OPENAI_API_KEY}`},body:JSON.stringify(payload)});
      const result=JSON.parse(await readText(response,1048576));
      if(!response.ok||result.status!=='completed'||!(result.model===payload.model||result.model?.startsWith(`${payload.model}-`))||result.service_tier&&result.service_tier!=='default'||result.usage?.output_tokens>payload.max_output_tokens)throw Error('invalid_response');
      const output=result.output_text||result.output?.filter(x=>x.type==='message'&&x.role==='assistant').flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('');
      return {value:JSON.parse(output),model:payload.model,costMicroUsd:solCost(result.usage)};
    }catch{problem('The stage could not finish. Saved results are still available; no automatic retry was made.',502);}
  }};
}
