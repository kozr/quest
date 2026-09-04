import { createHash, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
  type JWSRenewalInfoDecodedPayload,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from '@apple/app-store-server-library';
import type { AppleEnvironment } from './types.js';

export interface AppleNotificationContext {
  bundleId: string;
  appleId: string | number;
  environment: AppleEnvironment;
}

export interface VerifiedAppleNotification {
  notification: ResponseBodyV2DecodedPayload;
  transaction: JWSTransactionDecodedPayload | null;
  renewal: JWSRenewalInfoDecodedPayload | null;
  context: { bundleId: string; appleId: number; environment: AppleEnvironment };
}

export class AppleVerificationError extends Error {
  constructor(
    public readonly code: 'invalid_signature' | 'verifier_unavailable',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AppleVerificationError';
  }
}

export const APPLE_ROOT_CERTIFICATE_FILENAMES = [
  'AppleIncRootCertificate.cer',
  'AppleRootCA-G2.cer',
  'AppleRootCA-G3.cer',
] as const;

/** Read local public trust anchors, never a certificate supplied by a webhook. */
export async function loadAppleRootCertificates(
  directory = process.env.APPLE_ROOT_CERTS_DIR || resolve(process.cwd(), 'certificates'),
): Promise<Buffer[]> {
  try {
    const certificates = await Promise.all(
      APPLE_ROOT_CERTIFICATE_FILENAMES.map((name) => readFile(resolve(directory, name))),
    );
    validateRootCertificates(certificates);
    return certificates;
  } catch (cause) {
    throw new AppleVerificationError(
      'verifier_unavailable',
      'Apple root certificates are unavailable. Run npm run certificates and configure APPLE_ROOT_CERTS_DIR if needed.',
      { cause },
    );
  }
}

function invalid(message = 'Invalid Apple signed notification.'): never {
  throw new AppleVerificationError('invalid_signature', message);
}

function validateRootCertificates(certificates: Buffer[]): void {
  if (certificates.length === 0) throw new Error('Missing Apple root certificates.');
  for (const bytes of certificates) {
    const certificate = new X509Certificate(bytes);
    if (!certificate.ca || !certificate.checkIssued(certificate) || !certificate.verify(certificate.publicKey)) {
      throw new Error('A configured certificate is not a self-signed CA root.');
    }
  }
}

function validateContext(context: AppleNotificationContext): VerifiedAppleNotification['context'] {
  const appleId = Number(context.appleId);
  if (
    !Number.isSafeInteger(appleId) || appleId <= 0 ||
    (typeof context.appleId === 'string' && !/^[1-9][0-9]*$/.test(context.appleId)) ||
    !context.bundleId || context.bundleId.length > 255 ||
    (context.environment !== 'Production' && context.environment !== 'Sandbox')
  ) {
    throw new AppleVerificationError('verifier_unavailable', 'The connected app has invalid Apple identifiers or environment.');
  }
  return { bundleId: context.bundleId, appleId, environment: context.environment };
}

/** Cheap rejection only; decoding here never authenticates any payload field. */
function assertCompactJws(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 131_072 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    invalid();
  }
  try {
    const header: unknown = JSON.parse(Buffer.from(value.split('.')[0], 'base64url').toString('utf8'));
    if (!header || typeof header !== 'object' || !('alg' in header) || header.alg !== 'ES256') invalid();
  } catch {
    invalid();
  }
}

const verifiers = new Map<string, SignedDataVerifier>();

function getVerifier(context: VerifiedAppleNotification['context'], roots: Buffer[]): SignedDataVerifier {
  const fingerprint = createHash('sha256');
  for (const root of roots) fingerprint.update(root);
  const key = JSON.stringify([context.bundleId, context.appleId, context.environment, fingerprint.digest('hex')]);
  const cached = verifiers.get(key);
  if (cached) return cached;
  validateRootCertificates(roots);
  // There is intentionally no environment variable, HTTP parameter, or development
  // switch that disables signature, certificate revocation, or expiry checks.
  const verifier = new SignedDataVerifier(
    roots,
    true,
    context.environment === 'Production' ? Environment.PRODUCTION : Environment.SANDBOX,
    context.bundleId,
    context.appleId,
  );
  // Retain the library's verified-key/OCSP cache without unbounded per-app growth.
  if (verifiers.size >= 100) verifiers.delete(verifiers.keys().next().value!);
  verifiers.set(key, verifier);
  return verifier;
}

function assertTimestamp(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    invalid('Apple notification has an invalid signed date.');
  }
}

function checkOuterBinding(notification: ResponseBodyV2DecodedPayload, context: VerifiedAppleNotification['context']): void {
  const envelopes = [notification.data, notification.summary, notification.appData, notification.externalPurchaseToken];
  if (envelopes.filter((value) => value !== undefined).length !== 1) {
    invalid('Apple notification has missing or conflicting app metadata.');
  }
  const payload = notification.data ?? notification.summary ?? notification.appData ?? notification.externalPurchaseToken;
  if (!payload || payload.bundleId !== context.bundleId) invalid('Apple notification does not match this app.');
  // Apple may omit appAppleId in Sandbox. If present, never accept a mismatch.
  if ((context.environment === 'Production' || payload.appAppleId !== undefined) && payload.appAppleId !== context.appleId) {
    invalid('Apple notification does not match this App Store ID.');
  }
  const environment = 'environment' in payload ? payload.environment
    : notification.externalPurchaseToken?.externalPurchaseId?.startsWith('SANDBOX') ? 'Sandbox' : 'Production';
  if (environment !== context.environment) invalid('Apple notification does not match this environment.');
  if (notification.version !== '2.0' || typeof notification.notificationUUID !== 'string' ||
      !notification.notificationUUID || notification.notificationUUID.length > 128 ||
      typeof notification.notificationType !== 'string' || !notification.notificationType) {
    invalid('Apple notification is missing required V2 metadata.');
  }
  assertTimestamp(notification.signedDate);
}

/** Verify the outer JWS AND every included nested JWS using Apple's official library. */
export async function verifyAppleNotification(
  signedPayload: string,
  expected: AppleNotificationContext,
  rootCerts?: Buffer[],
): Promise<VerifiedAppleNotification> {
  assertCompactJws(signedPayload);
  const context = validateContext(expected);
  let verifier: SignedDataVerifier;
  try {
    verifier = getVerifier(context, rootCerts ?? await loadAppleRootCertificates());
  } catch (cause) {
    if (cause instanceof AppleVerificationError) throw cause;
    throw new AppleVerificationError('verifier_unavailable', 'Apple signature verification is not configured correctly.', { cause });
  }

  try {
    const notification = await verifier.verifyAndDecodeNotification(signedPayload);
    checkOuterBinding(notification, context);
    let transaction: JWSTransactionDecodedPayload | null = null;
    let renewal: JWSRenewalInfoDecodedPayload | null = null;

    if (notification.data?.signedTransactionInfo !== undefined) {
      assertCompactJws(notification.data.signedTransactionInfo);
      transaction = await verifier.verifyAndDecodeTransaction(notification.data.signedTransactionInfo);
      if (transaction.bundleId !== context.bundleId || transaction.environment !== context.environment) {
        invalid('Apple transaction does not match this app and environment.');
      }
    }
    if (notification.data?.signedRenewalInfo !== undefined) {
      assertCompactJws(notification.data.signedRenewalInfo);
      renewal = await verifier.verifyAndDecodeRenewalInfo(notification.data.signedRenewalInfo);
      if (renewal.environment !== context.environment) invalid('Apple renewal does not match this environment.');
    }
    // RESCIND_CONSENT is not a revenue event, but its distinct app transaction
    // must still be verified before acknowledging the signed notification.
    if (notification.appData?.signedAppTransactionInfo !== undefined) {
      assertCompactJws(notification.appData.signedAppTransactionInfo);
      const appTransaction = await verifier.verifyAndDecodeAppTransaction(notification.appData.signedAppTransactionInfo);
      if (appTransaction.bundleId !== context.bundleId || appTransaction.receiptType !== context.environment ||
          ((context.environment === 'Production' || appTransaction.appAppleId !== undefined) && appTransaction.appAppleId !== context.appleId)) {
        invalid('Apple app transaction does not match this app and environment.');
      }
    }
    if (transaction?.originalTransactionId && renewal?.originalTransactionId &&
        transaction.originalTransactionId !== renewal.originalTransactionId) {
      invalid('Apple transaction and renewal refer to different subscriptions.');
    }
    return { notification, transaction, renewal, context };
  } catch (cause) {
    if (cause instanceof AppleVerificationError) throw cause;
    if (cause instanceof VerificationException) {
      if (cause.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) {
        throw new AppleVerificationError('verifier_unavailable', 'Apple certificate status checking is temporarily unavailable. Retry this notification.', { cause });
      }
      throw new AppleVerificationError('invalid_signature', 'Apple signature or app/environment verification failed.', { cause });
    }
    // Unknown verifier failures must not acknowledge or permanently discard delivery.
    throw new AppleVerificationError('verifier_unavailable', 'Apple signature verification is temporarily unavailable.', { cause });
  }
}
