import { describe, expect, it, vi } from 'vitest';
import { load } from './+page.server';

function event(
	sourceId: string,
	search = '',
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = async () =>
		new Response(
			JSON.stringify({
				sourceId,
				displayName: 'Research Federation',
				items: [{ entityId: 'https://idp.example/idp', displayName: 'Example U', logoUrl: null }],
				truncated: false
			}),
			{ status: 200 }
		)
) {
	const fetch = vi.fn(fetchImpl);
	return {
		fetch,
		params: { sourceId },
		url: new URL(`https://tenant.example/login/federation/${sourceId}${search}`),
		request: new Request(`https://tenant.example/login/federation/${sourceId}`),
		cookies: { get: () => undefined }
	};
}

async function run(e: ReturnType<typeof event>) {
	return (load as unknown as (e: unknown) => Promise<Record<string, unknown>>)(e);
}

describe('federation picker load', () => {
	it('rejects a source id that is not a plain identifier without calling the backend', async () => {
		const e = event('bad id');
		await expect(run(e)).rejects.toMatchObject({ status: 404 });
		expect(e.fetch).not.toHaveBeenCalled();
	});

	it('reads the first page and keeps only the whitelisted, bounded start parameters', async () => {
		const e = event(
			'fed_1',
			`?purpose=signup&return_url=${encodeURIComponent('https://tenant.example/')}&evil=1&invite_token=${'x'.repeat(5000)}`
		);
		const data = await run(e);
		expect(String(e.fetch.mock.calls[0]?.[0])).toBe('/saml/sp/federation/fed_1/idps?limit=20');
		expect(data).toMatchObject({ displayName: 'Research Federation', loadFailed: false });
		const forwarded = data.forwarded as Record<string, string>;
		expect(Object.keys(forwarded).sort()).toEqual(['invite_token', 'purpose', 'return_url']);
		expect(forwarded.invite_token).toHaveLength(2048);
	});

	it('is not a page when the backend does not offer the source', async () => {
		const e = event('fed_1', '', async () => new Response('', { status: 404 }));
		await expect(run(e)).rejects.toMatchObject({ status: 404 });
	});

	it('shows a failure state, not an error page, when the backend is unavailable', async () => {
		const down = event('fed_1', '', async () => {
			throw new Error('network');
		});
		await expect(run(down)).resolves.toMatchObject({ loadFailed: true, items: [] });
		const broken = event('fed_1', '', async () => new Response('', { status: 503 }));
		await expect(run(broken)).resolves.toMatchObject({ loadFailed: true, items: [] });
	});
});
