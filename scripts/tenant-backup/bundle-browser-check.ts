import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const require = createRequire(import.meta.url);
const { buildSync } = createRequire(require.resolve('wrangler/package.json'))(
  'esbuild'
) as typeof import('esbuild');
const bundled = buildSync({
  stdin: {
    resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
    contents: `
      import {createTenantBundleKeyEnvelope,unlockTenantBundleKeyEnvelope} from './packages/ar-lib-core/src/services/tenant-portability/bundle-key-envelope.ts';
      import {encodeTenantBundle,decodeTenantBundle} from './packages/ar-lib-core/src/services/tenant-portability/bundle-codec.ts';
      import {decodeTenantBundleFrames} from './packages/ar-lib-core/src/services/tenant-portability/bundle-framing.ts';
      const passphrase='browser fixture only passphrase 2026';
      const limits={maxTotalBytes:1048576,maxFrames:100};
      async function* source(items){yield* items;}
      function expectation(envelope){return {
        bundleId:[...envelope.slice(1,17)].map(x=>x.toString(16).padStart(2,'0')).join(''),
        source:{tenantId:'fixture',issuer:'https://fixture.example',productVersion:'0.4.2'},
        selection:{settings:true,users:false,admin:false,logs:{audit:false,other:false,sensitive:false,period:'all'},artifacts:false},
        datasets:[{id:'branding',module:'flows-ui',kind:'settings',store:'object',schemaVersion:1,disposition:'include'}]};}
      globalThis.createFixture=async()=>{
        const key=await createTenantBundleKeyEnvelope(passphrase);
        const expected=expectation(key.envelope);
        const manifest={formatVersion:1,bundleId:expected.bundleId,source:expected.source,
          selection:expected.selection,snapshotId:'fixture',boundaryUnixMs:123,
          inventoryDigestSha256:'ab'.repeat(32),datasets:expected.datasets};
        const artifact=[];
        for await(const bytes of encodeTenantBundle(manifest,source([{datasetId:'branding',
            chunks:source([new Uint8Array([0,1,2,255])])}]),key,expected)) artifact.push([...bytes]);
        return artifact;
      };
      globalThis.restoreFixture=async(artifact)=>{
        const bytes=artifact.map(part=>new Uint8Array(part));
        let envelope;
        for await(const frame of decodeTenantBundleFrames(source(bytes),limits)){envelope=frame.slice(0,93);break;}
        let rejected=false;
        try{await unlockTenantBundleKeyEnvelope(envelope,passphrase+'wrong');}catch{rejected=true;}
        const key=await unlockTenantBundleKeyEnvelope(envelope,passphrase);
        let restored=[],complete=false;
        for await(const event of decodeTenantBundle(source(bytes),key,expectation(envelope),limits)){
          if(event.kind==='chunk') restored.push(...event.bytes);
          if(event.kind==='complete') complete=true;
        }
        return {restored,complete,rejected,extractable:key.contentKey.extractable};
      };
    `,
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  write: false,
});
const server = createServer((request, response) => {
  if (request.url === '/fixture.js') {
    response.writeHead(200, { 'content-type': 'application/javascript' });
    response.end(bundled.outputFiles[0].text);
  } else {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><script src="/fixture.js"></script>');
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
try {
  const browser = await chromium.launch({
    headless: true,
    ...(process.argv.includes('--chrome') ? { channel: 'chrome' } : {}),
  });
  try {
    const sourceContext = await browser.newContext();
    const first = await sourceContext.newPage();
    await first.goto(`http://127.0.0.1:${address.port}`);
    const artifact: unknown = await first.evaluate('globalThis.createFixture()');
    await sourceContext.close(); // Destroy all source keys and runtime state.
    const targetContext = await browser.newContext();
    const second = await targetContext.newPage();
    await second.goto(`http://127.0.0.1:${address.port}`);
    const result: unknown = await second.evaluate(
      `globalThis.restoreFixture(${JSON.stringify(artifact)})`
    );
    assert.deepEqual(result, {
      restored: [0, 1, 2, 255],
      complete: true,
      rejected: true,
      extractable: false,
    });
    await targetContext.close();
    process.stdout.write(
      `${JSON.stringify({ scope: 'isolated-browser-context-bundle-roundtrip', result }, null, 2)}\n`
    );
  } finally {
    await browser.close();
  }
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}
