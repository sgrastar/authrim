// After `vite build`: makes the deployed Worker (`.svelte-kit/cloudflare/_worker.js`, wrangler's
// `main`) the wrapper of src/edge-worker.ts around the SvelteKit Worker the adapter wrote there.
//
// The adapter writes its Worker to wrangler's `main`, so `main` cannot point at the wrapper
// itself. The SvelteKit Worker moves next to its server bundle in `.svelte-kit/cloudflare-tmp`
// (outside the static assets directory, so it is never served); its one relative import
// (`./../cloudflare-tmp/server.js`) resolves the same from there.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = join(root, '.svelte-kit/cloudflare/_worker.js');
const kitWorkerPath = join(root, '.svelte-kit/cloudflare-tmp/kit-worker.js');
const MARKER = '// authrim-login-ui-edge-wrapper';

const current = existsSync(workerPath) ? readFileSync(workerPath, 'utf8') : null;
if (current === null) throw new Error('wrap-worker: .svelte-kit/cloudflare/_worker.js is missing');
if (current.startsWith(MARKER)) throw new Error('wrap-worker: _worker.js is already wrapped');
if (!current.includes("from './../cloudflare-tmp/server.js'")) {
	throw new Error('wrap-worker: _worker.js is not the SvelteKit Worker this script expects');
}

renameSync(workerPath, kitWorkerPath);
writeFileSync(
	workerPath,
	[
		MARKER,
		"import kit from '../cloudflare-tmp/kit-worker.js';",
		"import { createLoginUiWorker } from '../../src/edge-worker.ts';",
		'',
		'const worker = createLoginUiWorker(kit);',
		'export default worker.handler;',
		'export const LoginUiEdgeEntrypoint = worker.LoginUiEdgeEntrypoint;',
		''
	].join('\n')
);
