import {setTimeout as pause} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';

export async function monitorCycle({baseURL, token, fetchImpl = fetch, signal} = {}) {
  const url = new URL(baseURL);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Use an HTTPS tracker origin.');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || typeof token !== 'string' || token.length < 32) throw new Error('Configure the tracker monitor origin and token.');
  const authorization={Authorization:`Bearer ${token}`};
  const validIds=ids=>Array.isArray(ids)&&ids.length<=1000&&new Set(ids).size===ids.length&&ids.every(id=>typeof id==='string'&&/^[-a-zA-Z0-9_]{1,100}$/.test(id)&&!['__proto__','prototype','constructor'].includes(id));
  const directory=await fetchImpl(new URL('/api/monitor/workspaces',url),{headers:authorization,redirect:'error',signal:signal||AbortSignal.timeout(15000)});
  let workspaceIds=[null],accountMode=false;
  if(directory.ok){const listed=await directory.json();if(!validIds(listed.ids)||typeof listed.accountMode!=='boolean')throw new Error('Invalid workspace monitor response');workspaceIds=listed.ids;accountMode=listed.accountMode;}
  else if(directory.status===404)await directory.body?.cancel();
  else throw new Error(`Workspace monitor list returned ${directory.status}`);
  const results=[];
  for(const workspaceId of workspaceIds){
    const headers={...authorization,...(workspaceId?{'X-Workspace-ID':workspaceId}:{})};
    const report=row=>results.push({...row,...(accountMode?{workspaceId}:{})});
    let response;
    try{response=await fetchImpl(new URL('/api/monitor',url),{headers,redirect:'error',signal:signal||AbortSignal.timeout(15000)});}
    catch{if(!accountMode)throw new Error('Monitor list unavailable');report({id:'monitor',status:'unavailable'});continue;}
    if(!response.ok){if(!accountMode)throw new Error(`Monitor list returned ${response.status}`);report({id:'monitor',status:response.status});await response.body?.cancel();continue;}
    const {ids,qualifications,notifications}=await response.json();
    if(!validIds(ids)||ids.length>100)throw new Error('Invalid monitor response');
    for(const id of ids){
      try{
        const result=await fetchImpl(new URL(`/api/monitor/${encodeURIComponent(id)}`,url),{method:'POST',headers,redirect:'error',signal:signal||AbortSignal.timeout(60000)});
        report({id,status:result.status});await result.body?.cancel();
      }catch{report({id,status:'unavailable'});}
    }
    // A workspace owns its leases and budgets. Each short request resumes a
    // bounded batch in the existing durable cycle, without reopening cadence.
    if(qualifications?.available===true)for(let index=0;index<2;index++){
      try{
        const result=await fetchImpl(new URL('/api/monitor/qualifications',url),{method:'POST',headers,redirect:'error',signal:signal||AbortSignal.timeout(110000)});
        const receipt=result.ok?await result.json():null;report({id:'qualification',status:result.status});
        if(!receipt||['idle','disabled','not_due','blocked','complete','archived','plan_capacity','subscription_inactive'].includes(receipt.status))break;
      }catch{report({id:'qualification',status:'unavailable'});break;}
    }
    if(accountMode&&notifications?.available===true){
      try{const result=await fetchImpl(new URL('/api/monitor/notifications',url),{method:'POST',headers,redirect:'error',signal:signal||AbortSignal.timeout(60000)});report({id:'notifications',status:result.status});await result.body?.cancel();}
      catch{report({id:'notifications',status:'unavailable'});}
    }
  }
  return results;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  for (;;) {
    try {
      const results = await monitorCycle({baseURL: process.env.TRACKER_MONITOR_URL, token: process.env.TRACKER_MONITOR_TOKEN});
      console.log(JSON.stringify({at: new Date().toISOString(),checked:results.length,failed:results.filter(result => ![200,204,409].includes(result.status)).length}));
    } catch { console.error('Tracker monitoring unavailable; retrying in one minute.'); }
    await pause(60000);
  }
}
