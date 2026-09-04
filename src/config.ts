import { resolve } from 'node:path';

export interface ApnsConfiguration {
  teamId: string;
  keyId: string;
  topic: string;
  privateKeyPath?: string;
  privateKey?: string;
}
export interface Configuration {
  port: number;
  host: string;
  publicUrl: string;
  firebaseProjectId: string;
  firebaseWebApiKey: string;
  production: boolean;
  registrationEnabled: boolean;
  demoEnabled: boolean;
  appleRootDirectory: string;
  apns: ApnsConfiguration | null;
}

export function readConfiguration(env = process.env): Configuration {
  const production = env.NODE_ENV === 'production';
  const port = Number(env.PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port.');
  const publicUrl = new URL(env.PUBLIC_URL ?? `http://localhost:${port}`);
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
    throw new Error('PUBLIC_URL must be an origin, without a path, credentials, query, or fragment.');
  }
  if (!['http:', 'https:'].includes(publicUrl.protocol) || (production && publicUrl.protocol !== 'https:')) {
    throw new Error('PUBLIC_URL must use HTTPS in production.');
  }
  const firebaseProjectId=env.FIREBASE_PROJECT_ID ?? env.GCLOUD_PROJECT ?? env.GOOGLE_CLOUD_PROJECT;
  if (!firebaseProjectId) throw new Error('Set FIREBASE_PROJECT_ID. Local development requires a demo- project and Firebase emulators.');
  const emulated=!!(env.FIRESTORE_EMULATOR_HOST || env.FIREBASE_AUTH_EMULATOR_HOST);
  if (emulated && (production || !firebaseProjectId.startsWith('demo-') || !env.FIRESTORE_EMULATOR_HOST || !env.FIREBASE_AUTH_EMULATOR_HOST)) throw new Error('Local mode requires BOTH Firebase emulators, a demo- project ID, and NODE_ENV=development.');
  if (!emulated && !env.IAP_FIREBASE_WEB_API_KEY) throw new Error('Set IAP_FIREBASE_WEB_API_KEY for Firebase authentication.');
  const fields = [env.APNS_TEAM_ID, env.APNS_KEY_ID, env.APNS_TOPIC, env.APNS_PRIVATE_KEY ?? env.APNS_PRIVATE_KEY_PATH];
  if (fields.some(Boolean) && !fields.every(Boolean)) throw new Error('Set all four APNS_* values, or leave all four empty.');
  return {
    port,
    host: env.HOST ?? '127.0.0.1',
    publicUrl: publicUrl.origin,
    firebaseProjectId,
    firebaseWebApiKey: env.IAP_FIREBASE_WEB_API_KEY ?? 'demo-key',
    production,
    registrationEnabled: env.ALLOW_REGISTRATION ? env.ALLOW_REGISTRATION === 'true' : !production,
    demoEnabled: env.ENABLE_DEMO ? env.ENABLE_DEMO === 'true' : !production,
    appleRootDirectory: env.APPLE_ROOT_CERTS_DIR ?? resolve('certificates'),
    apns: fields.every(Boolean) ? {
      teamId: env.APNS_TEAM_ID!, keyId: env.APNS_KEY_ID!, topic: env.APNS_TOPIC!,
      ...(env.APNS_PRIVATE_KEY ? {privateKey:env.APNS_PRIVATE_KEY} : {privateKeyPath:resolve(env.APNS_PRIVATE_KEY_PATH!)}),
    } : null,
  };
}
