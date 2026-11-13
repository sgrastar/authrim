import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock('$app/state', () => ({
	page: {
		route: { id: '/(main)/login' },
		get data() {
			return state.data;
		}
	}
}));

import Layout from './+layout.svelte';
import { load } from './+layout.server';

const children = createRawSnippet(() => ({ render: () => '<main>page</main>' }));
const draw = () => render(Layout, { props: { children } as never });

describe('root layout environment banner', () => {
	beforeEach(() => {
		state.data = {};
	});

	it('draws the band above the page, and no robots meta by default', () => {
		state.data = {
			environmentBanner: {
				text: 'This is the staging environment.',
				textLocalizations: {},
				noindex: false
			}
		};
		const { body, head } = draw();
		expect(body).toContain('This is the staging environment.');
		expect(body.indexOf('environment-banner')).toBeLessThan(body.indexOf('<main>page</main>'));
		expect(head).not.toContain('robots');
	});

	it('adds the robots meta when noindex is on, even with no text', () => {
		state.data = { environmentBanner: { text: '', textLocalizations: {}, noindex: true } };
		const { body, head } = draw();
		expect(head).toContain('<meta name="robots" content="noindex, nofollow"');
		expect(body).not.toContain('environment-banner');
		expect(body).toContain('<main>page</main>');
	});

	it('draws nothing without a banner (null answer: the common entry host)', () => {
		state.data = { environmentBanner: null };
		const { body, head } = draw();
		expect(body).not.toContain('environment-banner');
		expect(head).not.toContain('robots');
	});
});

describe('root layout load', () => {
	it('reads the banner from the request answer in the request language', () => {
		const data = load({
			locals: {
				locale: 'ja',
				authenticationMethods: {
					environmentBanner: {
						text: 'Staging',
						textLocalizations: { ja: 'ステージング環境です。' },
						noindex: true
					}
				}
			}
		} as never) as { environmentBanner: unknown };
		expect(data.environmentBanner).toEqual({
			text: 'Staging',
			textLocalizations: { ja: 'ステージング環境です。' },
			noindex: true,
			locale: 'ja'
		});
	});

	it('has no banner without an answer', () => {
		expect(
			(load({ locals: { authenticationMethods: null } } as never) as { environmentBanner: unknown })
				.environmentBanner
		).toBeNull();
	});
});
