import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Auth} from 'firebase-admin/auth';
import {FirebaseIdentity} from '../src/firebase.js';
import {appleCredential} from './apple-auth-fixture.js';

test('Firebase exchange pins Apple and sends the raw nonce; a verified Firebase ID token is still required',async t=>{
  const credential=appleCredential('fixture@example.test');
  let verified=false;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const request=JSON.parse(String(options?.body));const form=new URLSearchParams(request.postBody);
    assert.equal(form.get('providerId'),'apple.com');assert.equal(form.get('nonce'),credential.rawNonce);
    assert.equal(form.get('id_token'),credential.idToken);assert.equal(request.returnSecureToken,true);
    assert.equal(request.idToken,undefined);assert.equal(request.pendingToken,undefined);
    return new Response(JSON.stringify({idToken:'firebase-result'}));
  });
  const auth={verifyIdToken:async(token:string,checkRevoked:boolean)=>{
    assert.equal(token,'firebase-result');assert.equal(checkRevoked,true);verified=true;
    return {uid:'fixture',email:'fixture@example.test',email_verified:true,auth_time:123,firebase:{sign_in_provider:'apple.com'}};
  }} as unknown as Auth;
  assert.equal((await new FirebaseIdentity(auth,'test-key').signInWithApple(credential.idToken,credential.rawNonce)).user.id,'fixture');
  assert(verified);
});

test('non-Apple Firebase identities, unverified email and revoked tokens cannot mint sessions',async t=>{
  const credential=appleCredential('fixture@example.test');
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({idToken:'firebase-result'})));
  for(const claim of [{firebase:{sign_in_provider:'password'}},{email_verified:false},{email:undefined},{revoked:true}]) {
    const auth={verifyIdToken:async()=>{
      if('revoked' in claim) throw new Error('revoked');
      return {uid:'fixture',email:'fixture@example.test',email_verified:true,auth_time:123,firebase:{sign_in_provider:'apple.com'},...claim};
    }} as unknown as Auth;
    await assert.rejects(new FirebaseIdentity(auth,'test-key').signInWithApple(credential.idToken,credential.rawNonce),{status:401});
  }
});
