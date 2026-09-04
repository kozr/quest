import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JWSTransactionDecodedPayload } from '@apple/app-store-server-library';
import type { VerifiedAppleNotification } from '../src/apple.js';
import { normalizeAppleNotification } from '../src/normalize.js';

const signedDate = 1_750_000_000_000;
function notification(
  type: string,
  transaction: Partial<JWSTransactionDecodedPayload> | null = {},
  subtype?: string,
): VerifiedAppleNotification {
  return {
    context: { bundleId: 'com.example.timer', appleId: 123456, environment: 'Production' },
    notification: { notificationType: type, subtype, notificationUUID: 'notification-1', version: '2.0', signedDate },
    transaction: transaction === null ? null : {
      bundleId: 'com.example.timer', environment: 'Production', inAppOwnershipType: 'PURCHASED',
      transactionId: 'transaction-1', productId: 'annual', price: 9_990, currency: 'USD',
      purchaseDate: signedDate - 60_000, ...transaction,
    },
    renewal: null,
  };
}

test('paid subscription is a gross sale with integer milliunits and original purchase time', () => {
  const event = normalizeAppleNotification(notification('SUBSCRIBED', {}, 'INITIAL_BUY'));
  assert.equal(event.kind, 'sale');
  assert.equal(event.amountMilliunits, 9_990);
  assert.equal(event.currency, 'USD');
  assert.equal(event.isMonetary, true);
  assert.equal(event.economicKey, 'sale:transaction-1');
  assert.equal(event.occurredAt, new Date(signedDate - 60_000).toISOString());
  assert.equal(event.signedDate, signedDate);
});

test('one-time consumable price already includes quantity and is not multiplied again', () => {
  const event = normalizeAppleNotification(notification('ONE_TIME_CHARGE', { quantity: 5, price: 24_950 }));
  assert.equal(event.kind, 'sale');
  assert.equal(event.amountMilliunits, 24_950);
});

test('renewals are not called trial conversions without subscription history', () => {
  const event = normalizeAppleNotification(notification('DID_RENEW'));
  assert.equal(event.kind, 'renewal');
  assert.equal(event.title, 'Subscription renewed');
  assert.doesNotMatch(event.detail, /trial conversion/i);
});

test('a FREE_TRIAL offer is not revenue even if an unexpected nonzero price is present', () => {
  for (const price of [0, undefined, 9_990]) {
    const event = normalizeAppleNotification(notification('SUBSCRIBED', { price, offerDiscountType: 'FREE_TRIAL' }));
    assert.equal(event.kind, 'trial');
    assert.equal(event.amountMilliunits, 0);
    assert.equal(event.isMonetary, false);
  }
});

test('zero-price non-trial offers are free transactions, not fabricated free trials or sales', () => {
  const event = normalizeAppleNotification(notification('SUBSCRIBED', { price: 0 }));
  assert.equal(event.kind, 'other');
  assert.equal(event.isMonetary, false);
  assert.equal(event.amountMilliunits, 0);
});

test('a paid introductory offer remains a sale', () => {
  const event = normalizeAppleNotification(notification('SUBSCRIBED', { price: 990, offerDiscountType: 'PAY_AS_YOU_GO', offerType: 1 }));
  assert.equal(event.kind, 'sale');
  assert.equal(event.amountMilliunits, 990);
});

test('missing or invalid prices are never guessed, clamped, or coerced', () => {
  for (const price of [undefined, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    const event = normalizeAppleNotification(notification('ONE_TIME_CHARGE', { price }));
    assert.equal(event.kind, 'sale');
    assert.equal(event.amountMilliunits, null);
    assert.equal(event.isMonetary, true);
  }
});

test('future uppercase currency codes are preserved; missing or malformed codes hide amounts', () => {
  const future = normalizeAppleNotification(notification('ONE_TIME_CHARGE', { currency: 'ZZZ' }));
  assert.equal(future.currency, 'ZZZ');
  assert.equal(future.amountMilliunits, 9_990);
  for (const currency of [undefined, '', 'usd', 'US', 'USD<script>']) {
    const event = normalizeAppleNotification(notification('ONE_TIME_CHARGE', { currency }));
    assert.equal(event.currency, null);
    assert.equal(event.amountMilliunits, null);
  }
});

test('Family Sharing never creates money across purchase/refund/reversal event types', () => {
  for (const type of ['SUBSCRIBED', 'DID_RENEW', 'ONE_TIME_CHARGE', 'REFUND', 'REFUND_REVERSED']) {
    const event = normalizeAppleNotification(notification(type, { inAppOwnershipType: 'FAMILY_SHARED', revocationType: 'REFUND_FULL' }));
    assert.equal(event.isMonetary, false, type);
    assert.equal(event.amountMilliunits, null, type);
    assert.equal(event.economicKey, null, type);
  }
});

test('a future or missing ownership enum cannot be silently treated as PURCHASED', () => {
  for (const ownership of [undefined, 'FUTURE_OWNERSHIP']) {
    const event = normalizeAppleNotification(notification('SUBSCRIBED', { inAppOwnershipType: ownership }));
    assert.equal(event.isMonetary, false);
    assert.equal(event.kind, 'other');
  }
});

test('no transaction or transaction identifier means no economic event', () => {
  for (const transaction of [null, { transactionId: undefined }]) {
    const event = normalizeAppleNotification(notification('SUBSCRIBED', transaction));
    assert.equal(event.isMonetary, false);
    assert.equal(event.economicKey, null);
  }
});

test('immediate paid upgrades are sales but scheduled downgrades are not', () => {
  const upgrade = normalizeAppleNotification(notification('DID_CHANGE_RENEWAL_PREF', {}, 'UPGRADE'));
  const downgrade = normalizeAppleNotification(notification('DID_CHANGE_RENEWAL_PREF', {}, 'DOWNGRADE'));
  assert.equal(upgrade.kind, 'sale');
  assert.equal(upgrade.title, 'Subscription upgraded');
  assert.equal(downgrade.kind, 'other');
  assert.equal(downgrade.isMonetary, false);
});

test('the replaced transaction of an upgraded subscription is not a new sale', () => {
  const event = normalizeAppleNotification(notification('DID_CHANGE_RENEWAL_PREF', { isUpgraded: true }, 'UPGRADE'));
  assert.equal(event.isMonetary, false);
  assert.equal(event.economicKey, null);
});

test('offer redemptions with a new purchase subtype deduplicate with subscription events', () => {
  const offer = normalizeAppleNotification(notification('OFFER_REDEEMED', {}, 'INITIAL_BUY'));
  const subscribed = normalizeAppleNotification(notification('SUBSCRIBED', {}, 'INITIAL_BUY'));
  assert.equal(offer.kind, 'sale');
  assert.equal(offer.economicKey, subscribed.economicKey);
  for (const subtype of [undefined, 'DOWNGRADE', 'FUTURE_SUBTYPE']) {
    const event = normalizeAppleNotification(notification('OFFER_REDEEMED', {}, subtype));
    assert.equal(event.isMonetary, false);
  }
});

test('full refund is negative and occurs at its revocation date', () => {
  const event = normalizeAppleNotification(notification('REFUND', { revocationType: 'REFUND_FULL', revocationDate: signedDate - 1_000 }));
  assert.equal(event.kind, 'refund');
  assert.equal(event.amountMilliunits, -9_990);
  assert.equal(event.economicKey, `refund:transaction-1:${signedDate - 1_000}`);
  assert.equal(event.occurredAt, new Date(signedDate - 1_000).toISOString());
});

test('a second genuine refund after reversal has a distinct economic key', () => {
  const first = normalizeAppleNotification(notification('REFUND', { revocationType: 'REFUND_FULL', revocationDate: signedDate - 10_000 }));
  const second = normalizeAppleNotification(notification('REFUND', { revocationType: 'REFUND_FULL', revocationDate: signedDate - 1_000 }));
  assert.notEqual(first.economicKey, second.economicKey);
});

test('partial refund uses milli-percent with integer-safe rounding', () => {
  const event = normalizeAppleNotification(notification('REFUND', { revocationType: 'REFUND_PRORATED', revocationPercentage: 33_333 }));
  assert.equal(event.amountMilliunits, -3_330);
  assert.equal(event.title, 'Partial refund issued');
});

test('an explicit refund percentage is honored even when the revocation type is absent', () => {
  const event = normalizeAppleNotification(notification('REFUND', { revocationPercentage: 25_000 }));
  assert.equal(event.amountMilliunits, -2_498);
});

test('unknown refund extent never assumes the full transaction price', () => {
  for (const attributes of [
    {}, { revocationType: 'REFUND_PRORATED' }, { revocationType: 'FUTURE_TYPE', revocationPercentage: 100_000 },
    { revocationType: 'REFUND_FULL', revocationPercentage: 100_001 },
    { revocationType: 'REFUND_PRORATED', revocationPercentage: -1 },
  ]) {
    const event = normalizeAppleNotification(notification('REFUND', attributes));
    assert.equal(event.kind, 'refund');
    assert.equal(event.amountMilliunits, null);
  }
});

test('a family revocation is never monetary even with PURCHASED ownership', () => {
  const event = normalizeAppleNotification(notification('REFUND', { revocationType: 'FAMILY_REVOKE', revocationPercentage: 100_000 }));
  assert.equal(event.isMonetary, false);
  assert.equal(event.amountMilliunits, null);
});

test('refund reversal uses its own transition and does not guess the reversed partial amount', () => {
  const event = normalizeAppleNotification(notification('REFUND_REVERSED'));
  assert.equal(event.kind, 'refund_reversed');
  assert.equal(event.isMonetary, true);
  assert.equal(event.amountMilliunits, null);
  assert.equal(event.economicKey, 'refund_reversed:transaction-1');
  assert.equal(event.occurredAt, new Date(signedDate).toISOString());
});

test('auto-renew off is not expiration, refund, or a new sale', () => {
  const event = normalizeAppleNotification(notification('DID_CHANGE_RENEWAL_STATUS', {}, 'AUTO_RENEW_DISABLED'));
  assert.equal(event.kind, 'auto_renew_disabled');
  assert.equal(event.isMonetary, false);
  assert.equal(event.amountMilliunits, null);
});

test('auto-renew on and billing lifecycle events are classified without re-counting transaction price', () => {
  const cases = [
    ['DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_ENABLED', 'auto_renew_enabled'],
    ['DID_FAIL_TO_RENEW', 'GRACE_PERIOD', 'billing_issue'],
    ['EXPIRED', 'BILLING_RETRY', 'expired'],
    ['GRACE_PERIOD_EXPIRED', undefined, 'expired'],
  ] as const;
  for (const [type, subtype, kind] of cases) {
    const event = normalizeAppleNotification(notification(type, {}, subtype));
    assert.equal(event.kind, kind);
    assert.equal(event.isMonetary, false);
    assert.equal(event.economicKey, null);
    assert.equal(event.amountMilliunits, null);
  }
});

test('test events do not need a transaction and remain visibly Sandbox when appropriate', () => {
  const data = notification('TEST', null);
  data.context.environment = 'Sandbox';
  const event = normalizeAppleNotification(data);
  assert.equal(event.kind, 'test');
  assert.equal(event.isMonetary, false);
  assert.equal(event.environment, 'Sandbox');
});

test('unknown future notification enums remain inspectable but not monetary', () => {
  const event = normalizeAppleNotification(notification('FUTURE_APPLE_TYPE', {}, 'FUTURE_SUBTYPE'));
  assert.equal(event.kind, 'other');
  assert.equal(event.notificationType, 'FUTURE_APPLE_TYPE');
  assert.equal(event.subtype, 'FUTURE_SUBTYPE');
  assert.equal(event.isMonetary, false);
});

test('invalid optional occurrence timestamps safely fall back to the verified signed date', () => {
  const event = normalizeAppleNotification(notification('ONE_TIME_CHARGE', { purchaseDate: Number.POSITIVE_INFINITY }));
  assert.equal(event.occurredAt, new Date(signedDate).toISOString());
});
