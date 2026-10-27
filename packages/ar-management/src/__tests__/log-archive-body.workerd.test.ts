import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createGunzip, gzipSync } from 'node:zlib';
import { encodeLogRecordBlocks } from '@authrim/ar-lib-logging/chunks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boundedLogArchiveBytes } from '../log-archive-body';

interface LocalWorker {
  dispatchFetch(url: string): Promise<Response>;
  dispose(): Promise<void>;
}
const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = require('miniflare') as {
  Miniflare: new (options: unknown) => LocalWorker;
  convertV4MiniflareOptions: (options: Record<string, unknown>) => unknown;
};
const { buildSync } = require('esbuild') as {
  buildSync: (options: Record<string, unknown>) => { outputFiles: Array<{ text: string }> };
};

describe.each(['2024-09-23', '2026-07-08'])(
  'archive body decoding in Workers %s',
  (compatibilityDate) => {
    let worker: LocalWorker | undefined;
    beforeAll(async () => {
      const codec = fileURLToPath(new URL('../log-archive-body.ts', import.meta.url));
      const encoded = await encodeLogRecordBlocks(
        Array.from({ length: 3 }, (_, index) => ({
          id: `writer-${index}`,
          eventAt: index,
          payload: { id: `writer-${index}`, content: 'x'.repeat(180_000) },
        }))
      );
      expect(encoded.blocks.length).toBeGreaterThan(1);
      const source = `
      import { decodeLogArchiveBody } from ${JSON.stringify(codec)};
      export default { async fetch(request) {
        const mode = new URL(request.url).searchParams.get('case');
        const gzip = async value => new Uint8Array(await new Response(
          new Blob([value]).stream().pipeThrough(new CompressionStream('gzip'))
        ).arrayBuffer());
        const first = await gzip('one\\n'), last = await gzip('two\\n');
        let body = new Uint8Array(first.length + last.length);
        body.set(first); body.set(last, first.length);
        if (mode === 'truncated') body = body.slice(0, -2);
        if (mode === 'corrupt') body[body.length - 1] ^= 0xff;
        if (mode === 'none') body = new TextEncoder().encode('plain');
        if (mode === 'writer') body = new Uint8Array(${JSON.stringify(Array.from(encoded.body))});
        try {
          const result = await decodeLogArchiveBody(body, mode === 'none' ? 'none' : 'gzip_block', mode === 'budget' ? 4 : 1024*1024);
          if (mode === 'writer') return Response.json({ rows: new TextDecoder().decode(result).split('\\n').map(line => { const row=JSON.parse(line);return {id:row.id,length:row.content.length};}) });
          return Response.json({ value: new TextDecoder().decode(result) });
        } catch { return Response.json({ error:'log_query_incomplete',complete:false }, {status:503}); }
      }};
    `;
      const built = buildSync({
        stdin: { contents: source, loader: 'js', resolveDir: dirname(codec) },
        bundle: true,
        platform: 'neutral',
        format: 'esm',
        external: ['node:stream', 'node:zlib'],
        write: false,
      });
      const script = built.outputFiles[0]?.text;
      if (!script) throw new Error('missing archive runtime fixture');
      worker = new Miniflare(
        convertV4MiniflareOptions({
          name: 'archive-body-runtime',
          modules: true,
          script,
          host: '127.0.0.1',
          cf: false,
          compatibilityDate,
          compatibilityFlags: ['nodejs_compat'],
        })
      );
    });
    afterAll(async () => {
      await worker?.dispose();
    });

    it('decodes every member produced by the real writer above its default block boundary', async () => {
      if (!worker) throw new Error('missing worker');
      const response = await worker.dispatchFetch('http://localhost/?case=writer');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        rows: Array.from({ length: 3 }, (_, index) => ({ id: `writer-${index}`, length: 180_000 })),
      });
    });

    it.each(['healthy', 'none'] as const)(
      'decodes %s bodies through the real production helper',
      async (mode) => {
        if (!worker) throw new Error('missing worker');
        const response = await worker.dispatchFetch(`http://localhost/?case=${mode}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ value: mode === 'none' ? 'plain' : 'one\ntwo\n' });
      }
    );
    it.each(['truncated', 'corrupt', 'budget'] as const)(
      'rejects %s bodies without publishing partial decoded data',
      async (mode) => {
        if (!worker) throw new Error('missing worker');
        const response = await worker.dispatchFetch(`http://localhost/?case=${mode}`);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'log_query_incomplete', complete: false });
      }
    );
    it('cancels malformed streams before retaining non-byte values', async () => {
      let cancelled = false;
      const stream = new ReadableStream<unknown>({
        start(controller) {
          controller.enqueue('not bytes');
        },
        cancel() {
          cancelled = true;
        },
      });
      await expect(boundedLogArchiveBytes(stream, 1024)).rejects.toThrow(
        'log_archive_body_chunk_invalid'
      );
      expect(cancelled).toBe(true);
    });
  }
);

it('destroys the gzip stream when its decoded byte budget is exceeded', async () => {
  const gzip = createGunzip();
  const stream = Readable.toWeb(Readable.from([gzipSync('x'.repeat(100_000))]).pipe(gzip));
  await expect(boundedLogArchiveBytes(stream, 4)).rejects.toThrow('log_archive_body_limit');
  expect(gzip.destroyed).toBe(true);
});
