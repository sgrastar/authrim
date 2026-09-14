import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = wranglerRequire('miniflare') as typeof import('miniflare');
const { buildSync } = wranglerRequire('esbuild') as typeof import('esbuild');
const bundled = buildSync({
  stdin: {
    resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
    contents: `
      import {encodeTenantBundle,decodeTenantBundle} from './packages/ar-lib-core/src/services/tenant-portability/bundle-codec.ts';
      export default {async fetch() {
        // Fixture-only content key. Passphrase KDF runs in browser/CLI, not workerd.
        const raw=crypto.getRandomValues(new Uint8Array(32));
        const contentKey=await crypto.subtle.importKey('raw',raw,'HKDF',false,['deriveKey']);
        raw.fill(0);
        const envelope=new Uint8Array(93); envelope[0]=1;
        const key={envelope,contentKey};
        const expected={bundleId:'00'.repeat(16),
          source:{tenantId:'tenant-a',issuer:'https://fixture.example',productVersion:'0.4.2'},
          selection:{settings:true,users:false,admin:false,logs:{audit:false,other:false,sensitive:false,period:'all'},artifacts:false},
          datasets:[{id:'assets',module:'flows-ui',kind:'settings',store:'object',schemaVersion:1,disposition:'include'}]};
        const manifest={formatVersion:1,bundleId:expected.bundleId,source:expected.source,
          selection:expected.selection,snapshotId:'fixture',boundaryUnixMs:1,
          inventoryDigestSha256:'ab'.repeat(32),datasets:expected.datasets};
        const chunkBytes=1024*1024-64, chunkCount=160;
        let produced=0,consumed=0,maxAhead=0;
        async function* chunks(){
          for(let i=0;i<chunkCount;i++){
            produced++;
            maxAhead=Math.max(maxAhead,produced-consumed);
            yield new Uint8Array(chunkBytes).fill(i);
          }
        }
        async function* datasets(){yield {datasetId:'assets',chunks:chunks()};}
        let completed=false,decodedBytes=0;
        for await(const event of decodeTenantBundle(encodeTenantBundle(manifest,datasets(),key,expected),key,expected,
            {maxFrames:chunkCount+10,maxTotalBytes:200*1024*1024})){
          if(event.kind==='chunk'){
            if(event.bytes.length!==chunkBytes || !event.bytes.every(byte=>byte===consumed))
              throw new Error('fixture_payload_mismatch');
            consumed++; decodedBytes+=event.bytes.length;
          }
          if(event.kind==='complete') completed=true;
        }
        return Response.json({completed,produced,consumed,decodedBytes,maxAhead});
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
  script: bundled.outputFiles[0].text,
  compatibilityDate: '2026-07-08',
  host: '127.0.0.1',
});
try {
  const response = await runtime.dispatchFetch('https://fixture.example/');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result, {
    completed: true,
    produced: 160,
    consumed: 160,
    decodedBytes: 160 * (1024 * 1024 - 64),
    maxAhead: 1,
  });
  process.stdout.write(
    `${JSON.stringify({ scope: 'local-workerd-bundle-stream', result, passphraseKdfInWorker: false, productionMemoryLimitVerified: false }, null, 2)}\n`
  );
} finally {
  await runtime.dispose();
}
