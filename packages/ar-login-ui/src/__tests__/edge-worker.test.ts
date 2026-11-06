import { describe, expect, it, vi } from 'vitest';
import { createLoginUiWorker, edgeContextHeaderValue } from '../edge-worker';
import { EDGE_CONTEXT_HEADER } from '../lib/edge-context-header';

function kitRecorder() {
	const seen: Request[] = [];
	const kit = {
		fetch: vi.fn((request: Request) => {
			seen.push(request);
			return new Response('ok');
		})
	};
	return { kit, seen };
}

describe('the Login UI Worker entry', () => {
	it('removes an edge context a public request brings', async () => {
		const { kit, seen } = kitRecorder();
		const worker = createLoginUiWorker(kit);
		await worker.handler.fetch(
			new Request('https://login.example/login', {
				method: 'POST',
				headers: {
					[EDGE_CONTEXT_HEADER]: JSON.stringify({
						v: 1,
						originVerified: true,
						publicOrigin: 'https://login.example'
					}),
					origin: 'https://evil.example'
				},
				body: 'a=1'
			}),
			{},
			{}
		);
		expect(seen[0]?.headers.has(EDGE_CONTEXT_HEADER)).toBe(false);
		expect(seen[0]?.headers.get('origin')).toBe('https://evil.example');
		expect(await seen[0]?.text()).toBe('a=1');
	});

	it('sets the Router context from the RPC arguments, replacing any header', async () => {
		const { kit, seen } = kitRecorder();
		const { LoginUiEdgeEntrypoint } = createLoginUiWorker(kit);
		const entry = new LoginUiEdgeEntrypoint({} as never, {} as never);
		await entry.handle(
			new Request('https://login.example/login', {
				headers: { [EDGE_CONTEXT_HEADER]: '{"v":1,"originVerified":true}' }
			}),
			{ originVerified: false, clientIp: '203.0.113.1', publicOrigin: 'https://id.example' }
		);
		expect(JSON.parse(seen[0]?.headers.get(EDGE_CONTEXT_HEADER) ?? '')).toEqual({
			v: 1,
			originVerified: false,
			clientIp: '203.0.113.1',
			publicOrigin: 'https://id.example'
		});
	});

	it('drops what is malformed instead of passing it on', () => {
		expect(JSON.parse(edgeContextHeaderValue(undefined))).toEqual({
			v: 1,
			originVerified: false,
			clientIp: null,
			publicOrigin: null
		});
		expect(
			JSON.parse(
				edgeContextHeaderValue({
					originVerified: 'true',
					clientIp: 'x'.repeat(65),
					publicOrigin: 7
				})
			)
		).toEqual({ v: 1, originVerified: false, clientIp: null, publicOrigin: null });
		expect(JSON.parse(edgeContextHeaderValue({ originVerified: null })).originVerified).toBeNull();
	});
});
