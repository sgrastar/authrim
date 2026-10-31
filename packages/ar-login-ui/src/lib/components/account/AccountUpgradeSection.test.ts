import { render } from 'svelte/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import type { GuestUpgradeStatus } from '$lib/api/account';
import AccountUpgradeSection from './AccountUpgradeSection.svelte';
const guest: GuestUpgradeStatus = {
	registration_state: 'guest',
	status: 'active',
	deletion_due_at: 1800000000,
	upgrade_hold_until: null,
	upgrade_eligible: true,
	allowed_methods: ['email', 'passkey'],
	upgrade_in_progress: false,
	profile_complete: false
};
describe('account guest registration widget', () => {
	beforeEach(() => setLocale('en'));
	it('shows a real deadline even when registration is disabled', () => {
		const { body } = render(AccountUpgradeSection, {
			props: { initialStatus: { ...guest, upgrade_eligible: false, allowed_methods: [] } }
		});
		expect(body).toContain('Eligible for automatic deletion from');
		expect(body).not.toContain('Register with email');
		expect(body).not.toContain('Register with a passkey');
	});
	it('shows only the permitted method and explains no automatic deletion', () => {
		const { body } = render(AccountUpgradeSection, {
			props: { initialStatus: { ...guest, deletion_due_at: null, allowed_methods: ['email'] } }
		});
		expect(body).toContain('No automatic deletion is scheduled.');
		expect(body).toContain('Register with email');
		expect(body).not.toContain('Register with a passkey');
	});
	it('does not render guest controls for registered accounts', () => {
		const { body } = render(AccountUpgradeSection, {
			props: { initialStatus: { ...guest, registration_state: 'registered' } }
		});
		expect(body).not.toContain('guest-registration');
		expect(body).not.toContain('automatic deletion');
	});
	it('renders recovery while preventing a second registration attempt', () => {
		const { body } = render(AccountUpgradeSection, {
			props: { initialStatus: { ...guest, upgrade_in_progress: true } }
		});
		expect(body).toContain('Registration is in progress.');
		expect(body).toContain('Retry');
		expect(body).not.toContain('Register with email');
	});
	it('renders Japanese registration guidance', () => {
		setLocale('ja');
		const { body } = render(AccountUpgradeSection, { props: { initialStatus: guest } });
		expect(body).toContain('アカウントを登録');
		expect(body).toContain('パスキーで登録');
		expect(body).toContain('自動削除の対象になります');
	});
});

it('renders a configured guest widget title', () => {
	const { body } = render(AccountUpgradeSection, {
		props: { initialStatus: guest, title: 'Save your progress' }
	});
	expect(body).toContain('Save your progress');
});
