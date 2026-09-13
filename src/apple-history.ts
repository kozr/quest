import {createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {appleAuthorization,appleTestInput,type AppleTestInput} from './apple-test.js';
import {ServiceError} from './firebase.js';

export const historyInput=appleTestInput.extend({cursor:z.string().min(1).max(16384).optional()});
const windowSchema=z.object({startDate:z.number().int(),endDate:z.number().int(),environment:z.enum(['Production','Sandbox']),paginationToken:z.string().max(4096).optional()});
export type HistoryWindow=z.infer<typeof windowSchema>;
const pageSchema=z.object({hasMore:z.boolean(),paginationToken:z.string().min(1).max(4096).optional(),notificationHistory:z.array(z.object({signedPayload:z.string().min(1).max(131072)})).max(20).default([])});
export function historyWindow(environment:AppleTestInput['environment'],secret:string,cursor?:string,now=Date.now()):HistoryWindow {
  if (!cursor) return {environment,startDate:now-(environment==='Production'?180:30)*86400000,endDate:now};
  try {
    const [body,signature,...extra]=cursor.split('.');
    const expected=createHmac('sha256',secret).update(body).digest();
    const supplied=Buffer.from(signature,'base64url');
    if(extra.length || expected.length!==supplied.length || !timingSafeEqual(expected,supplied)) throw new Error();
    const result=windowSchema.parse(JSON.parse(Buffer.from(body,'base64url').toString()));
    if(result.environment!==environment || result.endDate>now || now-result.endDate>86400000) throw new Error();
    return result;
  } catch {throw new ServiceError(400,'This import session has expired or is invalid. Start the import again; duplicates will be skipped.');}
}
export function historyCursor(window:HistoryWindow,secret:string):string {
  const body=Buffer.from(JSON.stringify(window)).toString('base64url');
  return `${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
}
export async function callAppleHistory(input:AppleTestInput,bundleId:string,window:HistoryWindow,request:typeof fetch=fetch) {
  const jwt=appleAuthorization(input,bundleId);
  // Leave time within the API's 60-second limit to verify and store the page.
  const signal=AbortSignal.timeout(30000);
  const origin=input.environment==='Sandbox'?'https://api.storekit-sandbox.apple.com':'https://api.storekit.apple.com';
  const query=window.paginationToken?`?paginationToken=${encodeURIComponent(window.paginationToken)}`:'';
  try {
    const response=await request(`${origin}/inApps/v1/notifications/history${query}`,{
      method:'POST',headers:{Authorization:`Bearer ${jwt}`,Accept:'application/json','Content-Type':'application/json'},
      body:JSON.stringify({startDate:window.startDate,endDate:window.endDate}),signal,redirect:'error',
    });
    if(response.status===401 || response.status===403) throw new ServiceError(422,'Apple rejected the credentials. Check the In-App Purchase key, Key ID, Issuer ID, and Bundle ID.');
    if(response.status===429) throw new ServiceError(429,'Apple is limiting history requests. Wait a minute before retrying.');
    if(!response.ok) throw new ServiceError(502,'Apple could not retrieve notification history. Check the app and credentials, then try again.');
    let body:unknown;
    try {body=await response.json();} catch(error) {
      if(signal.aborted) throw error;
      throw new ServiceError(502,'Apple returned an unreadable notification history response.');
    }
    const result=pageSchema.safeParse(body);
    if(!result.success) throw new ServiceError(502,'Apple returned an unexpected notification history response.');
    const page=result.data;
    if(page.hasMore && (!page.paginationToken || page.paginationToken===window.paginationToken)) throw new ServiceError(502,'Apple returned an invalid continuation token for notification history.');
    return page;
  } catch(error) {
    if(error instanceof ServiceError) throw error;
    if(signal.aborted || (error instanceof Error && ['TimeoutError','AbortError'].includes(error.name))) {
      throw new ServiceError(504,'Apple took too long to return notification history.');
    }
    throw new ServiceError(502,'Could not reach Apple’s notification history service.');
  }
}
