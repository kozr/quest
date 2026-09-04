import { X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Fixed HTTPS endpoints linked from https://www.apple.com/certificateauthority/.
// Never accept a user/webhook-provided URL as a trust-anchor download source.
const roots = [
  ['AppleIncRootCertificate.cer', 'https://www.apple.com/appleca/AppleIncRootCertificate.cer'],
  ['AppleRootCA-G2.cer', 'https://www.apple.com/certificateauthority/AppleRootCA-G2.cer'],
  ['AppleRootCA-G3.cer', 'https://www.apple.com/certificateauthority/AppleRootCA-G3.cer'],
] as const;

const directory = resolve(process.env.APPLE_ROOT_CERTS_DIR || 'certificates');
await mkdir(directory, { recursive: true });
for (const [name, url] of roots) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Could not download ${name}: HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 65_536) throw new Error(`Unexpected certificate size for ${name}.`);
  const certificate = new X509Certificate(bytes);
  if (!certificate.ca || !certificate.checkIssued(certificate) || !certificate.verify(certificate.publicKey) ||
      !certificate.subject.includes('Apple') || Date.parse(certificate.validTo) <= Date.now()) {
    throw new Error(`Apple's ${name} endpoint did not return a valid current self-signed Apple CA.`);
  }
  const path = resolve(directory, name);
  let exists = false;
  try {
    const existing = await readFile(path);
    if (!existing.equals(bytes)) throw new Error(`${name} already exists with different contents. Review Apple's published roots before replacing it.`);
    exists = true;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (!exists) await writeFile(path, bytes, { flag: 'wx', mode: 0o644 });
  console.log(`${exists ? 'Verified' : 'Saved'} ${name} · SHA-256 ${certificate.fingerprint256}`);
}
