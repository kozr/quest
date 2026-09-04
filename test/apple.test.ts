import assert from 'node:assert/strict';
import { randomUUID, sign, X509Certificate } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { rootCertificates } from 'node:tls';
import { test } from 'node:test';
import {
  SignedDataVerifier, VerificationException, VerificationStatus,
  type ResponseBodyV2DecodedPayload,
} from '@apple/app-store-server-library';
import { AppleVerificationError, loadAppleRootCertificates, verifyAppleNotification } from '../src/apple.js';

const context = { bundleId: 'com.example.timer', appleId: '123456', environment: 'Production' as const };
// A public built-in CA is enough for construction in mocked binding tests. Never
// replace the production trust roots or add a test-only verifier factory to src/.
const testRoots = [new X509Certificate(rootCertificates[0]!).raw];
const jws = (body: unknown, header: unknown = { alg: 'ES256', x5c: [] }) =>
  `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(body)).toString('base64url')}.${Buffer.alloc(64).toString('base64url')}`;
const outer = jws({});
const nestedTransaction = jws({ tag: 'transaction' });
const nestedRenewal = jws({ tag: 'renewal' });

function notification(overrides: Partial<ResponseBodyV2DecodedPayload> = {}): ResponseBodyV2DecodedPayload {
  return {
    notificationType: 'DID_RENEW', notificationUUID: 'notification-1', version: '2.0', signedDate: 1_750_000_000_000,
    data: { bundleId: context.bundleId, appAppleId: 123456, environment: 'Production' },
    ...overrides,
  };
}

function hasCode(code: AppleVerificationError['code']) {
  return (error: unknown) => error instanceof AppleVerificationError && error.code === code;
}

test('malformed, unsigned, non-ES256, and overlarge JWS inputs fail before infrastructure is consulted', async () => {
  for (const value of ['', 'hello', 'a.b.c', jws({}, { alg: 'none' }), `${outer}.extra`, 'a'.repeat(131_073)]) {
    await assert.rejects(verifyAppleNotification(value, context, []), hasCode('invalid_signature'));
  }
});

test('a syntactically valid forged JWS is rejected by the real Apple verifier', async () => {
  await assert.rejects(verifyAppleNotification(outer, context, testRoots), hasCode('invalid_signature'));
});

test('missing or invalid local trust roots report recoverable unavailability', async () => {
  await assert.rejects(loadAppleRootCertificates(`/private/tmp/iap-missing-roots-${randomUUID()}`), hasCode('verifier_unavailable'));
  await assert.rejects(verifyAppleNotification(outer, context, []), hasCode('verifier_unavailable'));
  await assert.rejects(verifyAppleNotification(outer, context, [Buffer.from('not a certificate')]), hasCode('verifier_unavailable'));
});

test('invalid configured identifiers fail closed instead of accepting an unintended app/environment', async () => {
  for (const appleId of ['00123456', '123.4', '0', 'NaN', '9007199254740992']) {
    await assert.rejects(verifyAppleNotification(outer, { ...context, appleId }, testRoots), hasCode('verifier_unavailable'));
  }
  await assert.rejects(verifyAppleNotification(outer, { ...context, environment: 'Xcode' as 'Production' }, testRoots), hasCode('verifier_unavailable'));
});

test('outer, transaction, and renewal are all independently verified with online checks enabled', async (t) => {
  const calls: string[] = [];
  t.mock.method(SignedDataVerifier.prototype, 'verifyAndDecodeNotification', async function(this: SignedDataVerifier, value: string) {
    calls.push(value);
    assert.equal((this as unknown as { enableOnlineChecks: boolean }).enableOnlineChecks, true);
    return notification({ data: { bundleId: context.bundleId, appAppleId: 123456, environment: 'Production', signedTransactionInfo: nestedTransaction, signedRenewalInfo: nestedRenewal } });
  });
  t.mock.method(SignedDataVerifier.prototype, 'verifyAndDecodeTransaction', async (value: string) => {
    calls.push(value);
    return { bundleId: context.bundleId, environment: 'Production', originalTransactionId: 'original-1' };
  });
  t.mock.method(SignedDataVerifier.prototype, 'verifyAndDecodeRenewalInfo', async (value: string) => {
    calls.push(value);
    return { environment: 'Production', originalTransactionId: 'original-1' };
  });
  const verified = await verifyAppleNotification(outer, context, testRoots);
  assert.deepEqual(calls, [outer, nestedTransaction, nestedRenewal]);
  assert.deepEqual(verified.context, { ...context, appleId: 123456 });
});

test('signed outer bundle ID, production app ID, and environment must each match', async (t) => {
  let current = notification();
  t.mock.method(SignedDataVerifier.prototype, 'verifyAndDecodeNotification', async () => current);
  for (const data of [
    { bundleId: 'com.someoneelse.app', appAppleId: 123456, environment: 'Production' },
    { bundleId: context.bundleId, appAppleId: 777777, environment: 'Production' },
    { bundleId: context.bundleId, environment: 'Production' },
    { bundleId: context.bundleId, appAppleId: 123456, environment: 'Sandbox' },
  ]) {
    current = notification({ data });
    await assert.rejects(verifyAppleNotification(outer, context, testRoots), hasCode('invalid_signature'));
  }
});

test('Sandbox can omit app ID but cannot supply the wrong ID', async (t) => {
  let current = notification({ data: { bundleId: context.bundleId, environment: 'Sandbox' } });
  t.mock.method(SignedDataVerifier.prototype, 'verifyAndDecodeNotification', async () => current);
  const sandbox = { ...context, environment: 'Sandbox' as const };
  const result = await verifyAppleNotification(outer, sandbox, testRoots);
  assert.equal(result.context.environment, 'Sandbox');
  current = notification({ data: { bundleId: context.bundleId, environment: 'Sandbox', appAppleId: 987654 } });
  await assert.rejects(verifyAppleNotification(outer, sandbox, testRoots), hasCode('invalid_signature'));
});

test('even a valid outer signature cannot bypass a bad nested transaction signature', async (t) => {
  t.mock.method(SignedDataVerifier.prototype, 'verifyAndDecodeNotification', async () => notification({
    data: { bundleId: context.bundleId, appAppleId: 123456, environment: 'Production', signedTransactionInfo: nestedTransaction },
  }));
  t.mock.method(SignedDataVerifier.prototype, 'verifyAndDecodeTransaction', async () => {
    throw new VerificationException(VerificationStatus.VERIFICATION_FAILURE);
  });
  await assert.rejects(verifyAppleNotification(outer, context, testRoots), hasCode('invalid_signature'));
});

test('nested transaction app/environment mismatch fails closed even after verification', async (t) => {
  t.mock.method(SignedDataVerifier.prototype, 'verifyAndDecodeNotification', async () => notification({
    data: { bundleId: context.bundleId, appAppleId: 123456, environment: 'Production', signedTransactionInfo: nestedTransaction },
  }));
  let nested = { bundleId: 'com.someoneelse.app', environment: 'Production' };
  t.mock.method(SignedDataVerifier.prototype, 'verifyAndDecodeTransaction', async () => nested);
  await assert.rejects(verifyAppleNotification(outer, context, testRoots), hasCode('invalid_signature'));
  nested = { bundleId: context.bundleId, environment: 'Sandbox' };
  await assert.rejects(verifyAppleNotification(outer, context, testRoots), hasCode('invalid_signature'));
});

test('nested renewal environment and subscription must match the verified transaction', async (t) => {
  t.mock.method(SignedDataVerifier.prototype, 'verifyAndDecodeNotification', async () => notification({
    data: { bundleId: context.bundleId, appAppleId: 123456, environment: 'Production', signedTransactionInfo: nestedTransaction, signedRenewalInfo: nestedRenewal },
  }));
  t.mock.method(SignedDataVerifier.prototype, 'verifyAndDecodeTransaction', async () => ({ bundleId: context.bundleId, environment: 'Production', originalTransactionId: 'original-1' }));
  let renewal = { environment: 'Sandbox', originalTransactionId: 'original-1' };
  t.mock.method(SignedDataVerifier.prototype, 'verifyAndDecodeRenewalInfo', async () => renewal);
  await assert.rejects(verifyAppleNotification(outer, context, testRoots), hasCode('invalid_signature'));
  renewal = { environment: 'Production', originalTransactionId: 'original-2' };
  await assert.rejects(verifyAppleNotification(outer, context, testRoots), hasCode('invalid_signature'));
});

test('test and unknown future events are accepted only with valid V2 identity metadata', async (t) => {
  let current = notification({ notificationType: 'TEST' });
  t.mock.method(SignedDataVerifier.prototype, 'verifyAndDecodeNotification', async () => current);
  const verified = await verifyAppleNotification(outer, context, testRoots);
  assert.equal(verified.transaction, null);
  current = notification({ notificationType: 'FUTURE_NOTIFICATION' });
  assert.equal((await verifyAppleNotification(outer, context, testRoots)).notification.notificationType, 'FUTURE_NOTIFICATION');
  for (const fields of [{ notificationUUID: '' }, { version: '1.0' }, { signedDate: Number.NaN }, { signedDate: undefined }]) {
    current = notification(fields);
    await assert.rejects(verifyAppleNotification(outer, context, testRoots), hasCode('invalid_signature'));
  }
});

test('certificate network failures are retryable infrastructure errors, not bad signatures', async (t) => {
  t.mock.method(SignedDataVerifier.prototype, 'verifyAndDecodeNotification', async () => {
    throw new VerificationException(VerificationStatus.RETRYABLE_VERIFICATION_FAILURE);
  });
  await assert.rejects(verifyAppleNotification(outer, context, testRoots), hasCode('verifier_unavailable'));
});

test('conflicting wrapper metadata is rejected instead of selecting a convenient identity', async (t) => {
  t.mock.method(SignedDataVerifier.prototype, 'verifyAndDecodeNotification', async () => notification({
    summary: { bundleId: 'com.someoneelse.app', environment: 'Sandbox', appAppleId: 987654 },
  }));
  await assert.rejects(verifyAppleNotification(outer, context, testRoots), hasCode('invalid_signature'));
});

test('non-revenue appData notifications still require their nested app transaction signature', async (t) => {
  t.mock.method(SignedDataVerifier.prototype, 'verifyAndDecodeNotification', async () => notification({
    notificationType: 'RESCIND_CONSENT', data: undefined,
    appData: { bundleId: context.bundleId, environment: 'Production', appAppleId: 123456, signedAppTransactionInfo: nestedTransaction },
  }));
  const nested = t.mock.method(SignedDataVerifier.prototype, 'verifyAndDecodeAppTransaction', async () => {
    throw new VerificationException(VerificationStatus.VERIFICATION_FAILURE);
  });
  await assert.rejects(verifyAppleNotification(outer, context, testRoots), hasCode('invalid_signature'));
  assert.equal(nested.mock.callCount(), 1);
});

test('unexpected verifier failures fail closed and preserve retry eligibility', async (t) => {
  t.mock.method(SignedDataVerifier.prototype, 'verifyAndDecodeNotification', async () => { throw new Error('Unexpected verifier runtime failure'); });
  await assert.rejects(verifyAppleNotification(outer, context, testRoots), hasCode('verifier_unavailable'));
});

test('real ES256 chains verify both JWS layers and reject tampering, nested bad signatures, and untrusted roots', async (t) => {
  if (spawnSync('openssl', ['version']).status !== 0) {
    t.skip('OpenSSL is required to generate ephemeral cryptographic test fixtures.');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'iap-apple-chain-test-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const run = promisify(execFile);
  const openssl = async (...args: string[]) => run('openssl', args, { cwd: directory, timeout: 10_000 });
  await writeFile(join(directory, 'extensions.cnf'), [
    '[intermediate]', 'basicConstraints=critical,CA:TRUE,pathlen:0', 'keyUsage=critical,keyCertSign,cRLSign',
    '1.2.840.113635.100.6.2.1=DER:05:00', '[leaf]', 'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature', '1.2.840.113635.100.6.11.1=DER:05:00',
  ].join('\n'));
  await openssl('req', '-new', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
    '-subj', '/CN=IAP Ephemeral Test Root', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', 'root.key', '-out', 'root.pem');
  for (const [name, issuer, serial] of [['intermediate', 'root', '2'], ['leaf', 'intermediate', '3']] as const) {
    await openssl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-subj', `/CN=IAP Ephemeral Test ${name}`, '-keyout', `${name}.key`, '-out', `${name}.csr`);
    await openssl('x509', '-req', '-in', `${name}.csr`, '-CA', `${issuer}.pem`, '-CAkey', `${issuer}.key`,
      '-set_serial', serial, '-days', '2', '-extfile', 'extensions.cnf', '-extensions', name, '-out', `${name}.pem`);
  }
  const root = new X509Certificate(await readFile(join(directory, 'root.pem'))).raw;
  const intermediate = new X509Certificate(await readFile(join(directory, 'intermediate.pem'))).raw;
  const leaf = new X509Certificate(await readFile(join(directory, 'leaf.pem'))).raw;
  const key = await readFile(join(directory, 'leaf.key'));
  const signJws = (body: unknown) => {
    const header = { alg: 'ES256', x5c: [leaf, intermediate, root].map((certificate) => certificate.toString('base64')) };
    const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(body)).toString('base64url')}`;
    return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  // Only the test's network OCSP step is stubbed. The actual Apple verifier still
  // checks expiry, chain signatures, Apple OIDs, binding, and every ES256 signature.
  // Production's online checks remain permanently enabled in src/apple.ts.
  t.mock.method(SignedDataVerifier.prototype as unknown as { checkOCSPStatus(): Promise<void> }, 'checkOCSPStatus', async () => {});
  const signedTransaction = signJws({
    bundleId: context.bundleId, environment: 'Production', transactionId: 'signed-transaction',
    originalTransactionId: 'original-1', signedDate: Date.now(), inAppOwnershipType: 'PURCHASED', price: 9990, currency: 'USD',
  });
  const signedRenewal = signJws({ environment: 'Production', originalTransactionId: 'original-1', signedDate: Date.now() });
  const payload = notification({
    signedDate: Date.now(), data: {
      bundleId: context.bundleId, appAppleId: 123456, environment: 'Production',
      signedTransactionInfo: signedTransaction, signedRenewalInfo: signedRenewal,
    },
  });
  const signedNotification = signJws(payload);
  const verified = await verifyAppleNotification(signedNotification, context, [root]);
  assert.equal(verified.transaction?.transactionId, 'signed-transaction');
  assert.equal(verified.renewal?.originalTransactionId, 'original-1');

  const tamperSignature = (value: string) => {
    const parts = value.split('.');
    const signature = Buffer.from(parts[2]!, 'base64url');
    signature[0] = signature[0]! ^ 1;
    return `${parts[0]}.${parts[1]}.${signature.toString('base64url')}`;
  };
  await assert.rejects(verifyAppleNotification(tamperSignature(signedNotification), context, [root]), hasCode('invalid_signature'));
  await assert.rejects(verifyAppleNotification(signJws({ ...payload, data: { ...payload.data, signedTransactionInfo: tamperSignature(signedTransaction) } }), context, [root]), hasCode('invalid_signature'));
  await assert.rejects(verifyAppleNotification(signJws({ ...payload, data: { ...payload.data, signedRenewalInfo: tamperSignature(signedRenewal) } }), context, [root]), hasCode('invalid_signature'));
  await assert.rejects(verifyAppleNotification(signedNotification, context, testRoots), hasCode('invalid_signature'));
  await assert.rejects(verifyAppleNotification(signJws({ ...payload, data: { ...payload.data, bundleId: 'com.attacker.app' } }), context, [root]), hasCode('invalid_signature'));
});
