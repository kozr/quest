import {generateKeyPairSync, sign} from 'node:crypto';
import {OAuth2Client} from 'google-auth-library';
export const googleClientId='123456789-fixture.apps.googleusercontent.com';
export const googleAllowedEmails='owner@gmail.com';
export const sessionSecret='test-only-session-secret-that-is-at-least-32-chars';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const verifier=new OAuth2Client();
export const verifyGoogleIdToken=async credential=>(await verifier.verifySignedJwtWithCertsAsync(credential,{'fixture':publicKey.export({type:'spki',format:'pem'})},googleClientId,['https://accounts.google.com','accounts.google.com'])).getPayload();
export const googleOptions={googleClientId,googleAllowedEmails,sessionSecret,verifyGoogleIdToken};
export function credential(nonce,overrides={}) {
  const claims={iss:'https://accounts.google.com',aud:googleClientId,sub:'123456789012345678901',email:googleAllowedEmails,email_verified:true,nonce,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,...overrides};
  const body=[{alg:'RS256',kid:'fixture'},claims].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  return body+'.'+sign('RSA-SHA256',Buffer.from(body),privateKey).toString('base64url');
}
