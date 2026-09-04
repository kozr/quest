import {randomBytes,createHash} from 'node:crypto';

/** Unsigned IdP credentials are accepted ONLY by Firebase's Auth emulator.
 * Never imported by application code or exposed as a development HTTP bypass. */
export function appleCredential(email:string,claims:Record<string,unknown>={}) {
  const rawNonce=randomBytes(32).toString('base64url');
  const now=Math.floor(Date.now()/1000);
  const payload={iss:'https://appleid.apple.com',aud:'com.example.IAPNotifications',sub:createHash('sha256').update(email).digest('hex'),
    email,email_verified:true,iat:now,exp:now+600,nonce:createHash('sha256').update(rawNonce).digest('hex'),...claims};
  const idToken=`${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.`;
  return {idToken,rawNonce,client:'ios' as const};
}
