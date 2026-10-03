import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import AccountActivityWidget from './AccountActivityWidget.svelte';
import { FIXTURE_NOW, operation } from './fixtures';

/** Svelte's SSR hydration comments, which split text from closing tags. */
const HYDRATION_MARKERS = /<!--[\s\S]*?-->/g;

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
});
