// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	pageData: {} as Record<string, unknown>,
	fetchMethods: vi.fn()
}));

vi.mock('$app/state', () => ({
	page: {
		url: new URL('https://login.example.com/login'),
		params: {},
		get data() {
			return mocks.pageData;
		}
	}
}));
vi.mock('#lib/api/authentication-methods.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/api/authentication-methods.js')>();
	return { ...actual, fetchAuthenticationMethods: mocks.fetchMethods };
});

import { setLocale } from '$i18n/i18n-svelte';
import Layout from './+layout.svelte';

const answer = (environmentBanner: unknown) => ({
	data: {
		methods: {},
		ui: { theme: 'light', branding: { brandName: 'Acme', logoUrl: null } },
		environmentBanner,
		meta: { cacheTTL: 60, revision: 'test' }
	}
});
const children = createRawSnippet(() => ({ render: () => '<main>page</main>' }));
const mount = () =>
	render(Layout, {
		props: {
			children,
			data: {
				preferredLanguage: 'en',
				themeHint: null,
				shouldLoadTenantBranding: true,
				emailVerificationProtocolEnabled: false,
				authenticationMethods: null
			}
		} as never
	});

describe('(main) layout environment banner from the answer fetched in the browser', () => {
	beforeEach(() => {
		vi.stubGlobal(
			'matchMedia',
			vi.fn(() => ({
				matches: false,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn()
			}))
		);
		mocks.pageData = {};
		mocks.fetchMethods.mockReset();
		document.head.innerHTML = '';
	});

	it('draws the band once, and the robots meta, when page data has none', async () => {
		mocks.fetchMethods.mockResolvedValue(
			answer({
				text: 'Staging',
				textLocalizations: { en: 'This is the staging environment.' },
				noindex: true
			})
		);
		const { container } = mount();
		await waitFor(() => expect(container.querySelectorAll('.environment-banner')).toHaveLength(1));
		expect(container.querySelector('.environment-banner')?.textContent).toBe(
			'This is the staging environment.'
		);
		expect(document.head.querySelector('meta[name="robots"]')).not.toBeNull();
	});

	it('draws nothing when the page data already has the banner (the root layout draws it)', async () => {
		mocks.pageData = { environmentBanner: { text: 'Staging', noindex: true } };
		mocks.fetchMethods.mockResolvedValue(
			answer({ text: 'Staging', textLocalizations: {}, noindex: true })
		);
		const { container } = mount();
		await waitFor(() => expect(mocks.fetchMethods).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(container.querySelectorAll('.environment-banner')).toHaveLength(0);
		expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
	});

	it('draws nothing when the answer has no banner', async () => {
		mocks.fetchMethods.mockResolvedValue(answer(undefined));
		const { container } = mount();
		await waitFor(() => expect(mocks.fetchMethods).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(container.querySelectorAll('.environment-banner')).toHaveLength(0);
	});
});

describe('(main) layout environment banner and the language switch', () => {
	beforeEach(() => {
		vi.stubGlobal(
			'matchMedia',
			vi.fn(() => ({
				matches: false,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn()
			}))
		);
		mocks.pageData = {};
		mocks.fetchMethods.mockReset();
		document.head.innerHTML = '';
		setLocale('en');
	});

	it('shows nothing in English and the text in Japanese for an only-Japanese map', async () => {
		mocks.fetchMethods.mockResolvedValue(
			answer({ text: '', textLocalizations: { ja: 'ステージング環境です。' }, noindex: false })
		);
		const { container } = mount();
		await waitFor(() => expect(mocks.fetchMethods).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(container.querySelectorAll('.environment-banner')).toHaveLength(0);
		setLocale('ja');
		await waitFor(() =>
			expect(container.querySelector('.environment-banner')?.textContent).toBe(
				'ステージング環境です。'
			)
		);
	});

	it('switches between two languages with the page', async () => {
		mocks.fetchMethods.mockResolvedValue(
			answer({
				text: 'This is the staging environment.',
				textLocalizations: { ja: 'ステージング環境です。' },
				noindex: false
			})
		);
		const { container } = mount();
		await waitFor(() =>
			expect(container.querySelector('.environment-banner')?.textContent).toBe(
				'This is the staging environment.'
			)
		);
		setLocale('ja');
		await waitFor(() =>
			expect(container.querySelector('.environment-banner')?.textContent).toBe(
				'ステージング環境です。'
			)
		);
		setLocale('en');
		await waitFor(() =>
			expect(container.querySelector('.environment-banner')?.textContent).toBe(
				'This is the staging environment.'
			)
		);
	});
});
