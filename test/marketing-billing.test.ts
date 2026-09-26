import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {JWSTransactionDecodedPayload} from '@apple/app-store-server-library';
import {marketingBillingEnabled,marketingTransaction,mergeMarketingTransaction} from '../src/marketing-billing.js';
const env={MARKETING_BILLING_ENABLED:'true',MARKETING_APP_APPLE_ID:'123456789'};
const now=Date.now();
const fixture=(patch:Partial<JWSTransactionDecodedPayload>={}):JWSTransactionDecodedPayload=>({bundleId:'com.kozr.quest',environment:'Production',
  type:'Auto-Renewable Subscription',inAppOwnershipType:'PURCHASED',productId:'com.kozr.quest.marketing.one.monthly',
  originalTransactionId:'100000000001',transactionId:'100000000002',appAccountToken:randomUUID(),purchaseDate:now-10000,expiresDate:now+86400000,signedDate:now,...patch});

test('marketing billing is opt-in and requires Quest’s own valid App Store ID',()=>{
  assert.equal(marketingBillingEnabled({}),false);
  assert.equal(marketingBillingEnabled({MARKETING_BILLING_ENABLED:'true'}),false);
  assert.equal(marketingBillingEnabled({...env,MARKETING_APP_APPLE_ID:'NaN'}),false);
  assert.equal(marketingBillingEnabled(env),true);
});
test('signed transaction semantics reject other apps, products, family sharing, and unbound purchases',()=>{
  for(const patch of [{bundleId:'some.customer.app'},{productId:'com.kozr.quest.marketing.unknown'},
    {type:'Consumable'},{inAppOwnershipType:'FAMILY_SHARED'},{appAccountToken:undefined},{expiresDate:now-20000},
    {signedDate:now+600000},{environment:'Sandbox'}]) {
    assert.throws(()=>marketingTransaction(fixture(patch),env,now));
  }
  assert.equal(marketingTransaction(fixture(),env,now).revoked,false);
  assert.equal(marketingTransaction(fixture({environment:'Sandbox'}),{...env,MARKETING_ALLOW_SANDBOX:'true'},now).environment,'Sandbox');
});
test('out-of-order restores cannot revive refunds/upgrades or replace a newer renewal',()=>{
  const initial=marketingTransaction(fixture(),env,now);
  const refund={...initial,signedDate:now+1,revoked:true};
  assert.equal(mergeMarketingTransaction(refund,initial).revoked,true);
  assert.equal(mergeMarketingTransaction(refund,{...initial,signedDate:now+2}).revoked,true);
  const renewal={...initial,transactionID:'100000000003',purchaseDate:now,expiresAt:now+172800000};
  assert.deepEqual(mergeMarketingTransaction(renewal,refund),renewal);
  assert.deepEqual(mergeMarketingTransaction(refund,renewal),renewal);
  assert.throws(()=>mergeMarketingTransaction(initial,{...initial,originalID:'999999999999'}));
});
