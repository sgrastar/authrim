import { render } from 'svelte/server';
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import AccountRegistrationState from './AccountRegistrationState.svelte';

afterEach(() => {
	setLocale('en');
});
describe('account registration display', () => {
	it.each([
		['en', 'guest', 'Guest'],
		['en', 'registered', 'Registered'],
		['ja', 'guest', 'ゲスト'],
		['ja', 'registered', '登録済み']
	] as const)('renders %s / %s', (locale, state, label) => {
		setLocale(locale);
		const { body } = render(AccountRegistrationState, { props: { state } });
		expect(body).toContain(label);
	});
	it('does not classify a missing registration state as registered', () => {
		const { body } = render(AccountRegistrationState, { props: {} });
		expect(body).toContain('>-</span>');
	});
});
