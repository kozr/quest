import type { ActivityEvent, EventKind } from './types.js';
import type { VerifiedAppleNotification } from './apple.js';

export interface NormalizedAppleEvent extends Omit<ActivityEvent, 'id' | 'appId' | 'appName' | 'receivedAt'> {
  /** Scope this key by app and environment in storage. Null means UUID-only dedupe. */
  economicKey: string | null;
  signedDate: number;
  notificationUUID: string;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function validPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function nonempty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * This is an event classifier, not an accounting ledger. Apple's transaction price
 * is already the quantity-inclusive total, in 1/1000 currency units, before fees.
 * Unknown/absent prices are kept null; no currency conversion or net proceeds guess.
 */
export function normalizeAppleNotification(verified: VerifiedAppleNotification): NormalizedAppleEvent {
  const { notification, transaction, context } = verified;
  if (!notification.notificationUUID || !validTimestamp(notification.signedDate)) {
    throw new Error('Only verified Apple V2 notifications can be normalized.');
  }
  const notificationType = notification.notificationType || 'UNKNOWN';
  const subtype = nonempty(notification.subtype);
  const productId = nonempty(transaction?.productId);
  const transactionId = nonempty(transaction?.transactionId);
  const price = validPrice(transaction?.price) ? transaction.price : null;
  // Retain future ISO-shaped codes without using Intl's supported-currency list.
  const currency = typeof transaction?.currency === 'string' && /^[A-Z]{3}$/.test(transaction.currency)
    ? transaction.currency : null;
  const purchased = transaction?.inAppOwnershipType === 'PURCHASED';
  const familyShared = transaction?.inAppOwnershipType === 'FAMILY_SHARED' || transaction?.revocationType === 'FAMILY_REVOKE';
  const signedDate = notification.signedDate;
  let occurred = signedDate;
  let kind: EventKind = 'other';
  let title = 'App Store update';
  let detail = `Received ${notificationType}${subtype ? ` · ${subtype}` : ''}.`;
  let amountMilliunits: number | null = null;
  let isMonetary = false;
  let economicKey: string | null = null;

  function classifyPurchase(renewal: boolean, upgrade = false): void {
    if (!transaction || !transactionId) {
      title = 'Purchase update';
      detail = 'Apple sent a purchase update without transaction details. No sale amount was recorded.';
      return;
    }
    if (!purchased || familyShared) {
      title = familyShared ? 'Family Sharing update' : 'Purchase ownership unconfirmed';
      detail = familyShared ? 'Shared access is not a new sale.' : 'Apple did not confirm purchased ownership. No sale amount was recorded.';
      return;
    }
    if (transaction.isUpgraded === true) {
      title = 'Previous subscription replaced';
      detail = 'This transaction belongs to the subscription replaced by an upgrade; no new sale was recorded.';
      return;
    }
    if (transaction.offerDiscountType === 'FREE_TRIAL') {
      kind = 'trial';
      title = 'Free trial started';
      detail = 'The transaction uses a free-trial offer; no sale was recorded.';
      economicKey = `trial:${transactionId}`;
      amountMilliunits = 0;
    } else if (price === 0) {
      title = 'Free transaction';
      detail = 'Apple recorded a zero-price transaction; no sale was recorded.';
      amountMilliunits = 0;
      economicKey = `free:${transactionId}`;
    } else {
      kind = renewal ? 'renewal' : 'sale';
      title = renewal ? 'Subscription renewed' : upgrade ? 'Subscription upgraded' : 'New sale';
      detail = price === null || currency === null
        ? 'Apple reported a purchase; its sale amount or currency is unavailable.'
        : 'Gross transaction price before Apple fees and other adjustments.';
      // This flag identifies an economic transition even when its amount is unknown.
      isMonetary = true;
      amountMilliunits = currency === null ? null : price;
      economicKey = `sale:${transactionId}`;
    }
    if (validTimestamp(transaction.purchaseDate)) occurred = transaction.purchaseDate;
  }

  switch (notificationType) {
    case 'SUBSCRIBED':
    case 'ONE_TIME_CHARGE':
      classifyPurchase(false);
      break;
    case 'DID_RENEW':
      // A paid renewal is not labelled a trial conversion without prior history.
      classifyPurchase(true);
      break;
    case 'DID_CHANGE_RENEWAL_PREF':
      if (subtype === 'UPGRADE') classifyPurchase(false, true);
      else {
        title = 'Renewal preference changed';
        detail = subtype === 'DOWNGRADE' ? 'A downgrade is scheduled for a later renewal; no new sale was recorded.'
          : 'The subscription renewal preference changed; no new sale was recorded.';
      }
      break;
    case 'OFFER_REDEEMED':
      // A DOWNGRADE changes the next renewal. The attached existing transaction
      // must not be counted as a fresh purchase just because it has a price.
      if (subtype === 'INITIAL_BUY' || subtype === 'RESUBSCRIBE' || subtype === 'UPGRADE') {
        classifyPurchase(false, subtype === 'UPGRADE');
      } else {
        title = 'Offer redeemed';
        detail = 'An offer changed the subscription. Awaiting a purchase or renewal event before recording a sale.';
      }
      break;
    case 'REFUND':
      if (familyShared || !purchased || !transactionId) {
        title = familyShared ? 'Family Sharing access revoked' : 'Refund update';
        detail = 'No purchased transaction was confirmed; no monetary refund was recorded.';
        break;
      }
      kind = 'refund';
      title = transaction?.revocationType === 'REFUND_PRORATED' ? 'Partial refund issued' : 'Refund issued';
      isMonetary = true;
      // A transaction can be refunded again after a reversal. Distinguish a new
      // revocation from redelivery of the same one when Apple supplies its date.
      economicKey = `refund:${transactionId}${validTimestamp(transaction?.revocationDate) ? `:${transaction.revocationDate}` : ''}`;
      if (validTimestamp(transaction?.revocationDate)) occurred = transaction.revocationDate;
      if (price !== null && currency !== null) {
        const percentage = transaction?.revocationPercentage;
        if (typeof percentage === 'number' && Number.isInteger(percentage) && percentage >= 0 && percentage <= 100_000 &&
            (transaction?.revocationType === undefined || transaction.revocationType === 'REFUND_FULL' || transaction.revocationType === 'REFUND_PRORATED')) {
          // 100% = 100,000 milli-percent. BigInt avoids precision loss on products.
          amountMilliunits = -Number((BigInt(price) * BigInt(percentage) + 50_000n) / 100_000n);
        } else if (transaction?.revocationType === 'REFUND_FULL' && percentage === undefined) {
          amountMilliunits = -price;
        }
      }
      detail = amountMilliunits === null
        ? 'Apple confirmed a refund but not a reliable amount. The full purchase price was not assumed.'
        : 'Refund amount derived from Apple’s transaction price and revocation information; not an accounting payout.';
      break;
    case 'REFUND_REVERSED':
      if (familyShared || !purchased || !transactionId) {
        title = 'Refund reversal update';
        detail = 'No purchased transaction was confirmed; no monetary reversal was recorded.';
        break;
      }
      kind = 'refund_reversed';
      title = 'Refund reversed';
      detail = 'Apple reversed a refund. The amount is unavailable without the original refund record.';
      isMonetary = true;
      economicKey = `refund_reversed:${transactionId}`;
      // revocationPercentage disappears on reversal. The original full purchase
      // price would be wrong if the reversed refund was partial.
      break;
    case 'DID_CHANGE_RENEWAL_STATUS':
      if (subtype === 'AUTO_RENEW_DISABLED') {
        kind = 'auto_renew_disabled';
        title = 'Auto-renew turned off';
        detail = 'The subscription will not renew automatically. This is not a refund or an immediate expiry.';
      } else if (subtype === 'AUTO_RENEW_ENABLED') {
        kind = 'auto_renew_enabled';
        title = 'Auto-renew turned on';
        detail = 'Automatic renewal is enabled. No new sale was recorded.';
      }
      break;
    case 'DID_FAIL_TO_RENEW':
      kind = 'billing_issue';
      title = 'Renewal payment failed';
      detail = subtype === 'GRACE_PERIOD' ? 'Apple is retrying payment during the billing grace period.'
        : 'Apple could not collect the renewal payment. This is not a refund.';
      break;
    case 'EXPIRED':
    case 'GRACE_PERIOD_EXPIRED':
      kind = 'expired';
      title = notificationType === 'GRACE_PERIOD_EXPIRED' ? 'Billing grace period ended' : 'Subscription expired';
      detail = 'Subscription access ended. No sale or refund was recorded.';
      if (validTimestamp(transaction?.expiresDate)) occurred = transaction.expiresDate;
      break;
    case 'REVOKE':
      title = 'Shared access revoked';
      detail = 'Family Sharing access changed. This is not a new sale or monetary refund.';
      break;
    case 'TEST':
      kind = 'test';
      title = 'Apple connection verified';
      detail = 'A signed Apple test notification reached this endpoint. It is not a purchase.';
      break;
  }

  return {
    kind, title, detail, amountMilliunits, currency, productId, transactionId,
    environment: context.environment, occurredAt: new Date(occurred).toISOString(),
    notificationType, subtype, isMonetary, economicKey, signedDate,
    notificationUUID: notification.notificationUUID,
  };
}
