import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuth} from '../auth.mjs';
import {googleClientId,googleAllowedEmails,sessionSecret,verifyGoogleIdToken,credential} from './google-fixture.mjs';

const options={clientId:googleClientId,allowedEmails:googleAllowedEmails,secret:sessionSecret,verifyIdToken:verifyGoogleIdToken};
const request=(cookie='',nonce,token)=>({headers:{cookie},get:()=>nonce,body:{credential:token}});
const response=()=>({cookies:[],append(_name,value){this.cookies.push(value);}});
async function signIn(auth,claims={}) {
  const c=response(),challenge=auth.challenge(request(),c),login=response();
  await auth.login(request(c.cookies[0].split(';')[0],challenge.nonce,credential(challenge.nonce,claims)),login);
  return login.cookies[0].split(';')[0];
}

test('only a verified signed session exposes an account principal',async()=>{
  const auth=createAuth(options),cookie=await signIn(auth);
  const principal=auth.principal(request(cookie));
  assert.equal(principal.email,googleAllowedEmails);
  assert.equal(principal.authoritativeEmail,true);
  assert.match(principal.sub,/^\d+$/);
  assert.equal(principal.nonce,undefined);
  assert.equal(principal.expiresAt,undefined);
  assert.equal(auth.principal(request(cookie+'tampered')),null);
  assert.equal(auth.principal(request()),null);
  const revoked=createAuth({...options,allowedEmails:'somebody-else@gmail.com'});
  assert.equal(revoked.principal(request(cookie)),null);
});

test('hosted-domain authority is preserved from verified claims, not inferred from an email domain',async()=>{
  const email='owner@business.example';
  const hosted=createAuth({...options,allowedEmails:email});
  const verifiedCookie=await signIn(hosted,{email,hd:'business.example'});
  assert.equal(hosted.principal(request(verifiedCookie)).authoritativeEmail,true);
  const pinned=createAuth({...options,allowedEmails:'',allowedSubjects:'123456789012345678901'});
  const pinnedCookie=await signIn(pinned,{email});
  assert.equal(pinned.principal(request(pinnedCookie)).authoritativeEmail,false);
  assert.equal(pinned.principal(request(pinnedCookie)).subjectPinned,true);
});


test('account mode accepts verified Google identities without granting workspace membership',async()=>{
  const auth=createAuth({...options,allowedEmails:'',allowVerifiedAccounts:true});
  const cookie=await signIn(auth,{sub:'303',email:'new@business.example'});
  assert.equal(auth.principal(request(cookie)).sub,'303');
  assert.equal(auth.principal(request(cookie)).authoritativeEmail,false);
  await assert.rejects(()=>signIn(auth,{sub:'303',email_verified:false}));
  assert.throws(()=>createAuth({...options,allowedEmails:''}));
});
