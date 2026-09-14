import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  createTenantBundleKeyEnvelope,
  deriveTenantBundleStreamKey,
} from '../../packages/ar-lib-core/src/services/tenant-portability/bundle-key-envelope.js';

const require = createRequire(import.meta.url);
const runtimeRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = runtimeRequire('miniflare') as typeof import('miniflare');
const { buildSync } = runtimeRequire('esbuild') as typeof import('esbuild');
const context = {
  tenantId: 'tenant-a',
  operationId: 'operation-a',
  requestDigest: 'ab'.repeat(32),
  challengeId: 'challenge-a',
  expiresAt: 1000,
};
const script = buildSync({
  stdin: {
    resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
    contents: `
    import {openTenantBackupContentKey} from './packages/ar-lib-core/src/services/tenant-portability/operation-key-handoff.ts';
    import {deriveTenantBundleStreamKey} from './packages/ar-lib-core/src/services/tenant-portability/bundle-key-envelope.ts';
    // Isolated runtime fixture only; production challenge keys require encrypted durable storage.
    let pair;
    export default {async fetch(request) {
      if(request.method==='GET') {
        pair=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,
          publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},false,['encrypt','decrypt']);
        return Response.json(await crypto.subtle.exportKey('jwk',pair.publicKey));
      }
      const body=await request.json();
      const expected=${JSON.stringify(context)};
      const envelope=new Uint8Array(body.envelope), ciphertext=new Uint8Array(body.handoff);
      const received=await openTenantBackupContentKey(ciphertext,envelope,pair.privateKey,expected,999);
      const key=await deriveTenantBundleStreamKey(received.contentKey,new Uint8Array(32).fill(7));
      const plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(12)},key,new Uint8Array(body.probe)));
      let rejected=false;
      try {await openTenantBackupContentKey(ciphertext,envelope,pair.privateKey,{...expected,tenantId:'tenant-b'},999);}
      catch {rejected=true;}
      return Response.json({plain:Array.from(plain),rejected,extractable:received.contentKey.extractable});
    }};
  `,
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
});
const runtime = new Miniflare({
  modules: true,
  script: script.outputFiles[0].text,
  compatibilityDate: '2026-07-08',
  host: '127.0.0.1',
});
try {
  const published = await runtime.dispatchFetch('https://fixture.example/');
  assert.equal(published.status, 200);
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    (await published.json()) as JsonWebKey,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );
  const session = await createTenantBundleKeyEnvelope('fixture password for CLI to Worker', {
    publicKey,
    context,
  });
  assert(session.handoff);
  const key = await deriveTenantBundleStreamKey(session.contentKey, new Uint8Array(32).fill(7));
  const probe = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: new Uint8Array(12) },
      key,
      new Uint8Array([4, 5, 6])
    )
  );
  const response = await runtime.dispatchFetch('https://fixture.example/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      envelope: Array.from(session.envelope),
      handoff: Array.from(session.handoff),
      probe: Array.from(probe),
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { plain: [4, 5, 6], rejected: true, extractable: false });
  process.stdout.write(
    JSON.stringify(
      {
        scope: 'local-cli-to-workerd-key-handoff',
        passed: true,
        passphraseSentToWorker: false,
        durableChallengeConsumptionImplemented: false,
      },
      null,
      2
    ) + '\n'
  );
} finally {
  await runtime.dispose();
}
