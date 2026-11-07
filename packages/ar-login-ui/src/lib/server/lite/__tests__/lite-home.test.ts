/**
 * `/` in lite mode: the sign-in page without a session (the request it came with kept), else a
 * short signed-in page with the way to the account page when the tenant offers one.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { load } from '../../../../routes/__lite/home/+page.server';

function event(query: string, cookies: Record<string, string>, active: boolean) {
	const url = new URL(`https://id.example/${query ? `?${query}` : ''}`);
	return {
		url,
		request: new Request(url),
		cookies: { get: (name: string) => cookies[name], set: vi.fn() },
		locals: {
			locale: 'en',
			authenticationMethods: {
				ui: { selfService: { accountPageEnabled: true, accountPagePath: '/my-account' } }
			},
			edge: {
				source: 'router',
				originVerified: null,
				clientIp: null,
				publicOrigin: 'https://id.example'
			}
		},
		platform: {
			env: {
				AR_ROUTER: {
					fetch: vi.fn(
						async () =>
							new Response(
								JSON.stringify({
									active,
									user_id: active ? 'u1' : null,
									email: active ? 'person@example.com' : null
								}),
								{
									status: 200,
									headers: { 'Content-Type': 'application/json' }
								}
							)
					)
				}
			}
		}
	} as unknown as RequestEvent;
}

const view = (e: RequestEvent) => (load as unknown as (e: RequestEvent) => Promise<unknown>)(e);

describe('the lite home page', () => {
	it('sends a request with a challenge to the sign-in page for it', async () => {
		await expect(view(event('challenge_id=c1', {}, false))).rejects.toMatchObject({
			status: 303,
			location: '/login?challenge_id=c1'
		});
	});

	it('sends a visitor without an active session to the sign-in page', async () => {
		await expect(view(event('', {}, false))).rejects.toMatchObject({ location: '/login' });
		await expect(view(event('', { authrim_session: 's' }, false))).rejects.toMatchObject({
			location: '/login'
		});
	});

	it('draws a signed-in page with the account page the tenant offers', async () => {
		await expect(view(event('', { authrim_session: 's' }, true))).resolves.toMatchObject({
			accountHref: '/my-account',
			signedIn: 'Signed in as',
			email: 'person@example.com'
		});
	});
});
