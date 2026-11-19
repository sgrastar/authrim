// @vitest-environment jsdom
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import type { GuestUpgradeStatus } from '#lib/api/account.js';

const mocks = vi.hoisted(() => ({
	status: vi.fn(),
	start: vi.fn(),
	complete: vi.fn(),
	register: vi.fn()
}));

vi.mock('@simplewebauthn/browser', () => ({ startRegistration: mocks.register }));
vi.mock('#lib/api/account.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/api/account.js')>();
	return {
		...actual,
		accountAPI: {
			...actual.accountAPI,
			getGuestUpgrade: mocks.status,
			startGuestUpgrade: mocks.start,
			completeGuestUpgrade: mocks.complete
		}
	};
});

import AccountUpgradeSection from './AccountUpgradeSection.svelte';
import { rememberedPasskeyUserHandles } from '#lib/webauthn/deleted-tenant.js';

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
const registered: GuestUpgradeStatus = { ...guest, registration_state: 'registered' };

async function upgradeWithPasskey() {
	const onCompleted = vi.fn();
	const view = render(AccountUpgradeSection, { props: { initialStatus: guest, onCompleted } });
	await waitFor(() => expect(mocks.status).toHaveBeenCalled());
	await fireEvent.click(view.getByRole('button', { name: /register with a passkey/i }));
	await waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(1));
	return onCompleted;
}

describe('guest upgrade by passkey', () => {
	beforeEach(() => {
		setLocale('en');
		window.localStorage.clear();
		mocks.status.mockReset().mockResolvedValue({ data: guest, error: null });
		mocks.start.mockReset().mockResolvedValue({
			data: { attempt_id: 'attempt-1', method: 'passkey', options: { user: { id: 'Z3Vlc3QtMQ' } } },
			error: null
		});
		mocks.register.mockReset().mockResolvedValue({ id: 'credential-1' });
		mocks.complete.mockReset();
	});

	it('remembers the owner once the server confirms the upgrade', async () => {
		mocks.complete.mockResolvedValue({ data: { success: true }, error: null });

		const onCompleted = await upgradeWithPasskey();

		await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
		expect(rememberedPasskeyUserHandles()).toEqual(['Z3Vlc3QtMQ']);
	});

	it('remembers the owner when the answer was lost but the upgrade went through', async () => {
		mocks.complete.mockImplementation(async () => {
			mocks.status.mockResolvedValue({ data: registered, error: null });
			return { data: null, error: { error: 'network_error' } };
		});

		const onCompleted = await upgradeWithPasskey();

		await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
		expect(rememberedPasskeyUserHandles()).toEqual(['Z3Vlc3QtMQ']);
	});

	it('remembers nobody when the upgrade is refused', async () => {
		mocks.complete.mockResolvedValue({ data: null, error: { error: 'verification_failed' } });

		const onCompleted = await upgradeWithPasskey();

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(onCompleted).not.toHaveBeenCalled();
		expect(rememberedPasskeyUserHandles()).toEqual([]);
	});
});
