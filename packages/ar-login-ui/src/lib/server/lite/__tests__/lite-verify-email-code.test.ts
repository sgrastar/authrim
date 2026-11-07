import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { load } from '../../../../routes/__lite/verify-email-code/+page.server';

const run = (search: string) =>
	(load as unknown as (e: RequestEvent) => unknown)({
		url: new URL(`https://id.example/verify-email-code${search}`)
	} as RequestEvent);

describe('/verify-email-code in lite mode', () => {
	it('goes to the sign-in page for the same request, without the address', () => {
		expect(() =>
			run(
				'?challenge_id=ch-1&email=person%40example.com&return_to=%2Faccount&runtime_interaction_id=i'
			)
		).toThrow(
			expect.objectContaining({
				status: 303,
				location: '/login?challenge_id=ch-1&return_to=%2Faccount'
			})
		);
	});

	it('goes to the plain sign-in page without a request', () => {
		expect(() => run('')).toThrow(expect.objectContaining({ status: 303, location: '/login' }));
	});
});
