import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import AccountActivityWidget from './AccountActivityWidget.svelte';
import { FIXTURE_NOW, operation } from './fixtures';
import { HYDRATION_MARKERS } from '$lib/testing/ssr-html';

function renderActivity(props: Partial<Parameters<typeof AccountActivityWidget>[1]> = {}) {
	return render(AccountActivityWidget, { props }).body.replace(HYDRATION_MARKERS, '');
}

const operations = () => [
	operation({ action: 'account.guest.upgraded' }),
	operation({ id: 'operation-2', action: 'account.totp.reauthenticated' }),
	operation({ id: 'operation-3', action: 'account.custom.audit_event' })
];

describe('AccountActivityWidget', () => {
	it('describes known actions in the UI language and shows others as recorded', () => {
		setLocale('ja');
		const ja = renderActivity({ operations: operations() });
		expect(ja).toContain('ゲストアカウント登録完了');
		expect(ja).toContain('認証アプリで再認証');
		expect(ja).toContain('account.custom.audit_event');

		setLocale('en');
		const en = renderActivity({ operations: operations() });
		expect(en).toContain('Guest account registered');
		expect(en).toContain('Re-authenticated by authenticator');
	});

	it('marks each time up as a machine-readable time', () => {
		setLocale('en');
		const body = renderActivity({ operations: [operation({ created_at: FIXTURE_NOW })] });

		expect(body).toContain(`datetime="${new Date(FIXTURE_NOW).toISOString()}"`);
	});

	it('shows a skeleton while loading and an empty state after', () => {
		setLocale('en');
		const loading = renderActivity({ loading: true });
		expect(loading).toContain('aria-busy="true"');
		expect(loading).toContain('account-section-skeleton');
		expect(loading).not.toContain('No items');

		expect(renderActivity()).toContain('No items');
	});

	it('shows an incomplete error instead of a false empty activity list', () => {
		setLocale('en');
		const html = renderActivity({
			error: 'Activity results are incomplete.',
			hasMore: true,
			onmore: () => {}
		});
		expect(html).toContain('role="alert"');
		expect(html).toContain('Activity results are incomplete.');
		expect(html).not.toContain('No items');
		expect(html).not.toContain('Load older activity');
	});

	it('keeps loaded rows while loading the next page and disables another request', () => {
		setLocale('en');
		const html = renderActivity({
			operations: operations(),
			loading: true,
			hasMore: true,
			onmore: () => {}
		});
		expect(html).toContain('Load older activity');
		expect(html).toMatch(/<button[^>]*disabled/);
		expect(html).toContain('Guest account registered');
		expect(html).not.toContain('account-section-skeleton');
	});
});
