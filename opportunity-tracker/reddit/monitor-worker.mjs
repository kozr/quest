import {setTimeout as pause} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';

export async function monitorCycle({baseURL, token, fetchImpl = fetch, signal} = {}) {
  const url = new URL(baseURL);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Use an HTTPS tracker origin.');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || typeof token !== 'string' || token.length < 32) throw new Error('Configure the tracker monitor origin and token.');
  const headers = {Authorization: `Bearer ${token}`};
  const response = await fetchImpl(new URL('/api/monitor', url), {headers, redirect: 'error', signal: signal || AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`Monitor list returned ${response.status}`);
  const {ids,qualifications} = await response.json();
  if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^[-a-zA-Z0-9_]{1,100}$/.test(id))) throw new Error('Invalid monitor response');
  const results = [];
  for (const id of ids) {
    try {
      const result = await fetchImpl(new URL(`/api/monitor/${encodeURIComponent(id)}`, url), {method: 'POST', headers, redirect: 'error', signal: signal || AbortSignal.timeout(60000)});
      results.push({id, status: result.status});
      await result.body?.cancel();
    } catch { results.push({id, status: 'unavailable'}); }
  }
  // Separate short requests keep collection and qualification inside Vercel's
  // function deadline. The shared ledger enforces spend and one active job.
  if(qualifications?.available===true) for(let index=0;index<2;index++) {
    try {
      const result=await fetchImpl(new URL('/api/monitor/qualifications',url),{method:'POST',headers,redirect:'error',signal:signal||AbortSignal.timeout(25000)});
      const receipt=result.ok?await result.json():null;
      results.push({id:'qualification',status:result.status});
      if(!receipt||['idle','disabled'].includes(receipt.status))break;
    } catch {results.push({id:'qualification',status:'unavailable'});break;}
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
