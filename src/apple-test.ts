import {createPrivateKey,sign} from 'node:crypto';
import {z} from 'zod';
import {ServiceError} from './firebase.js';

// Credentials are request-scoped. Never persist them, include them in URLs, or log Apple responses.
export const appleTestInput=z.object({
  environment:z.enum(['Production','Sandbox']),
  keyId:z.string().trim().regex(/^[A-Z0-9]{10}$/),
  issuerId:z.string().trim().uuid(),
  privateKey:z.string().trim().min(1).max(8192),
}).strict();
export type AppleTestInput=z.infer<typeof appleTestInput>;
export const appleTestStatusInput=appleTestInput.extend({testNotificationToken:z.string().regex(/^[A-Za-z0-9_-]{1,256}$/)});
const statusResponse=z.object({signedPayload:z.string().max(131072).optional(),sendAttempts:z.array(z.object({sendAttemptResult:z.string().max(100).optional()})).max(6).optional()});
export type AppleTestResponse=z.infer<typeof statusResponse> & {testNotificationToken?:string};

export async function callAppleTest(input:AppleTestInput,bundleId:string,testNotificationToken?:string,request:typeof fetch=fetch):Promise<AppleTestResponse> {
  let jwt:string;
  try {
    if(!input.privateKey.startsWith('-----BEGIN PRIVATE KEY-----')) throw new Error();
    const key=createPrivateKey(input.privateKey);
    if(key.asymmetricKeyType!=='ec' || key.asymmetricKeyDetails?.namedCurve!=='prime256v1') throw new Error();
    const now=Math.floor(Date.now()/1000);
    const encode=(value:object)=>Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned=`${encode({alg:'ES256',kid:input.keyId,typ:'JWT'})}.${encode({iss:input.issuerId,iat:now,exp:now+300,aud:'appstoreconnect-v1',bid:bundleId})}`;
    jwt=`${unsigned}.${sign('sha256',Buffer.from(unsigned),{key,dsaEncoding:'ieee-p1363'}).toString('base64url')}`;
  } catch {throw new ServiceError(400,'Choose a valid In-App Purchase .p8 private key (ES256).');}
  const origin=input.environment==='Sandbox' ? 'https://api.storekit-sandbox.apple.com' : 'https://api.storekit.apple.com';
  const path='/inApps/v1/notifications/test'+(testNotificationToken ? `/${encodeURIComponent(testNotificationToken)}` : '');
  try {
    const response=await request(origin+path,{method:testNotificationToken ? 'GET' : 'POST',headers:{Authorization:`Bearer ${jwt}`,Accept:'application/json'},signal:AbortSignal.timeout(10000),redirect:'error'});
    if(response.status===401 || response.status===403) throw new ServiceError(422,'Apple rejected the credentials. Check the In-App Purchase key, Key ID, Issuer ID, and this app’s Bundle ID.');
    if(response.status===404 && testNotificationToken) return {};
    if(response.status===404) throw new ServiceError(422,'Apple could not find the app or a notification URL for this environment. Check App Store Connect and save the Version 2 URL.');
    if(response.status===429) throw new ServiceError(429,'Apple is limiting test requests. Wait a minute and try again.');
    if(!response.ok) throw new ServiceError(502,'Apple could not process the test. Check your configuration and try again.');
    const body:unknown=await response.json();
    return testNotificationToken ? statusResponse.parse(body) : z.object({testNotificationToken:z.string().regex(/^[A-Za-z0-9_-]{1,256}$/)}).parse(body);
  } catch(error) {
    if(error instanceof ServiceError) throw error;
    throw new ServiceError(502,'Apple did not return a usable response in time. The test may still arrive; check activity before retrying.');
  }
}
