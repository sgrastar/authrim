import { describe, expect, it, vi } from 'vitest';
import { logoutWithGuestWarning } from '../guest-logout';
import en from '$i18n/en';
import ja from '$i18n/ja';

describe('guest logout warning', () => {
	it.each([en, ja])(
		'warns in the selected locale and leaves the account accessible on cancel',
		async (translation) => {
			const confirm = vi.fn(() => false);
			const logout = vi.fn();
			expect(
				await logoutWithGuestWarning({
					amr: ['anon'],
					warning: translation.account_guestLogoutWarning,
					confirm,
					logout
				})
			).toBe(false);
			expect(confirm).toHaveBeenCalledWith(translation.account_guestLogoutWarning);
			expect(logout).not.toHaveBeenCalled();
		}
	);
	it('waits for consent before invoking logout', async () => {
		const calls: string[] = [];
		expect(
			await logoutWithGuestWarning({
				amr: ['anon'],
				warning: 'warning',
				confirm: () => {
					calls.push('confirm');
					return true;
				},
				logout: async () => {
					calls.push('logout');
				}
			})
		).toBe(true);
		expect(calls).toEqual(['confirm', 'logout']);
	});
	it('logs registered users out without a guest warning', async () => {
		const confirm = vi.fn();
		const logout = vi.fn();
		expect(
			await logoutWithGuestWarning({ amr: ['otp'], warning: 'warning', confirm, logout })
		).toBe(true);
		expect(confirm).not.toHaveBeenCalled();
		expect(logout).toHaveBeenCalledOnce();
	});
	it('propagates logout failure so the page cannot navigate away', async () => {
		await expect(
			logoutWithGuestWarning({
				amr: ['anon'],
				warning: 'warning',
				confirm: () => true,
				logout: async () => {
					throw new Error('unavailable');
				}
			})
		).rejects.toThrow('unavailable');
	});
});
