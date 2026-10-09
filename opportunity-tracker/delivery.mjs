import {lookup} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';
import {isIP} from 'node:net';
import {createHmac} from 'node:crypto';
import {claimNotification, validateNotificationDelivery, markNotificationDispatched, finishNotification, validateIntegrationURL, publicAddress} from './notifications.mjs';

const failure = (code,permanent=false) => Object.assign(new Error('The notification could not be delivered.'),{code,permanent});
export async function resolvePublicDestination(endpoint,{resolver=lookup}={}) {
  const url=new URL(validateIntegrationURL(endpoint)),host=url.hostname.replace(/^\[|\]$/g,'');
  let rows;
  try { rows=isIP(host)?[{address:host,family:isIP(host)}]:await resolver(host,{all:true,verbatim:true}); } catch { throw failure('destination_dns_unavailable'); }
  if(!Array.isArray(rows)||!rows.length||rows.some(row=>!publicAddress(row.address)||![4,6].includes(row.family)||isIP(row.address)!==row.family))throw failure('destination_not_public',true);
  return {endpoint:url.href,address:rows[0].address,family:rows[0].family};
}
// DNS is resolved once, checked, then pinned into the actual TLS connection.
// Redirects are never followed; response bodies and provider errors are not logged.
export function pinnedHttpsRequest({endpoint,address,family,headers,body,timeoutMs=15000}) {
  return new Promise((resolve,reject)=>{
    const url=new URL(endpoint);
    const req=httpsRequest(url,{method:'POST',headers,agent:false,servername:isIP(url.hostname)?undefined:url.hostname,lookup:(_host,options,callback)=>options?.all?callback(null,[{address,family}]):callback(null,address,family)},res=>{
      const chunks=[];let size=0;
      res.on('data',part=>{size+=part.length;if(size>65536){res.destroy();req.destroy();reject(failure('provider_response_too_large'));}else chunks.push(part);});
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString('utf8')}));
      res.on('error',()=>reject(failure('provider_connection_failed')));
    });
    req.setTimeout(timeoutMs,()=>req.destroy(failure('provider_timeout')));
    req.on('error',()=>reject(failure('provider_connection_failed')));req.end(body);
  });
}
const safeText = value => String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
function notificationText(packet) {
  const rows=packet.payload.rows,lines=[`${safeText(packet.payload.workspace)} — ${rows.length} conversation${rows.length===1?'':'s'}`,packet.payload.window?`Daily digest: ${packet.payload.window.from} to ${packet.payload.window.to}`:'New conversation alert',''];
  for(const row of rows.slice(0,100))lines.push(`${safeText(row.product)} · ${safeText(row.source)} · ${safeText(row.author)||'Author unavailable'}`,safeText(row.title),safeText(row.text).slice(0,2000),row.url,'');
  if(rows.length>100)lines.push(`${rows.length-100} additional conversations are available in your workspace.`);
  return lines.join('\n');
}
function sender(value) {
  if(typeof value!=='string'||value.length>320||/[\r\n]/.test(value))return null;
  return /^(?:[^<>\r\n]+ <)?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/.test(value)?value:null;
}
export function createDeliveryAdapters({env=process.env,resolver=lookup,request=pinnedHttpsRequest}={}) {
  const enabled=env.TRACKER_NOTIFICATIONS_ENABLED==='true',from=sender(env.TRACKER_EMAIL_FROM),key=typeof env.RESEND_API_KEY==='string'&&env.RESEND_API_KEY?env.RESEND_API_KEY:null;
  const make=channel=>({
    configured:enabled&&(channel!=='email'||Boolean(from&&key)),
    async prepare(packet) {
      if(!this.configured)throw failure('delivery_not_configured',true);
      if(packet.channel!==channel)throw failure('delivery_channel_invalid',true);
      let body=packet.request?.body;
      const endpoint=packet.request?.endpoint||packet.endpoint;
      if(channel==='email'&&endpoint!=='https://api.resend.com/emails')throw failure('email_endpoint_invalid',true);
      if(channel==='slack')validateIntegrationURL(endpoint,'slack');
      if(!body) {
        if(channel==='email')body=JSON.stringify({from,to:[packet.recipient],subject:`HearWhispers: ${packet.payload.rows.length} conversation${packet.payload.rows.length===1?'':'s'}`,text:notificationText(packet)});
        else if(channel==='slack')body=JSON.stringify({text:notificationText(packet).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),unfurl_links:false,unfurl_media:false});
        else {
          const rows=packet.payload.rows.slice(0,100).map(row=>({...row,text:row.text.slice(0,2000),textIsExcerpt:row.text.length>2000}));
          body=JSON.stringify({version:1,id:packet.id,idempotencyKey:packet.idempotencyKey,...packet.payload,rows,totalConversations:packet.payload.rows.length,includedConversations:rows.length});
        }
      }
      const destination=await resolvePublicDestination(endpoint,{resolver});
      return {...destination,body};
    },
    async send(packet,prepared) {
      const headers={'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(prepared.body)),'Idempotency-Key':packet.idempotencyKey};
      if(channel==='email')headers.Authorization=`Bearer ${key}`;
      if(channel==='webhook'&&packet.signingSecret)headers['X-HearWhispers-Signature']=`sha256=${createHmac('sha256',packet.signingSecret).update(prepared.body).digest('hex')}`;
      let response;try{response=await request({...prepared,headers,timeoutMs:15000,redirect:'error'});}catch{return {outcome:channel==='email'?'retry':'uncertain',errorCode:'provider_outcome_unknown',notSent:false};}
      if(response.status>=200&&response.status<300) {
        let providerId=null;
        if(channel==='slack'&&String(response.body).trim()!=='ok')return {outcome:'uncertain',errorCode:'provider_receipt_missing',notSent:false};
        if(channel==='email') { try{providerId=JSON.parse(response.body).id;}catch{} if(typeof providerId!=='string'||providerId.length>200)return {outcome:'retry',errorCode:'provider_receipt_missing',notSent:false}; }
        return {outcome:'sent',providerId};
      }
      if(response.status>=300&&response.status<400)return {outcome:'failed',errorCode:'provider_redirect_rejected',notSent:false};
      if(response.status===429) {
        const raw=response.headers?.['retry-after']??response.headers?.get?.('retry-after'),seconds=Number(raw);
        return {outcome:'retry',errorCode:'provider_rate_limited',notSent:true,retryAfterMs:Number.isFinite(seconds)?seconds*1000:0};
      }
      if(response.status>=500)return {outcome:channel==='email'?'retry':'uncertain',errorCode:'provider_server_error',notSent:false};
      return {outcome:'failed',errorCode:'provider_rejected',notSent:true};
    },
  });
  return {email:make('email'),slack:make('slack'),webhook:make('webhook')};
}

// store must provide snapshot() and mutate(fn); every durable mutation is a CAS
// replay, while DNS and HTTP occur outside transactions. A principal is a trusted
// authenticated member identity, never a worker HTTP request body.
export async function deliverNotification(store,{principal,id,adapters=createDeliveryAdapters(),workerId='notification-worker',now=Date.now}={}) {
  const clock=typeof now==='function'?now:()=>now;
  const initial=validateNotificationDelivery(await store.snapshot(),principal,{id,now:clock()}),adapter=adapters[initial.channel];
  if(!adapter?.configured)return {status:'unconfigured',id};
  const lease=await store.mutate(data=>claimNotification(data,principal,{id,workerId,now:clock()}));if(!lease)return {status:'not_due',id};
  let packet,prepared;
  try {
    packet=validateNotificationDelivery(await store.snapshot(),principal,{...lease,now:clock()});
    prepared=await adapter.prepare(packet);
    packet=await store.mutate(data=>markNotificationDispatched(data,principal,{...lease,request:{endpoint:prepared.endpoint,body:prepared.body},now:clock()}));
  } catch(error) {
    const code=/^[a-z0-9_-]{1,100}$/i.test(error.code||'')?error.code:'delivery_preflight_failed';
    return store.mutate(data=>finishNotification(data,{...lease,outcome:error.permanent||[400,403,404,409].includes(error.status)?'failed':'retry',notSent:true,errorCode:code,now:clock()}));
  }
  const result=await adapter.send(packet,prepared);
  // If a process dies after dispatch, the sending lease remains durable. Email
  // can retry the identical request within the bounded idempotency window;
  // Slack/webhook jobs become uncertain instead of risking duplicate messages.
  return store.mutate(data=>finishNotification(data,{...lease,...result,now:clock()}));
}
