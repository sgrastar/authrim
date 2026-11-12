// @vitest-environment jsdom
import { render } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import VerifyEmailCodeView from './VerifyEmailCodeView.svelte';

const base = {
	email: 'person@example.com',
	code: '',
	countdown: 30,
	canResend: false,
	onCodeChange: vi.fn(),
	onVerify: vi.fn(),
	onResend: vi.fn(),
	onDismissError: vi.fn(),
	onDismissSuccess: vi.fn(),
	onDismissResendNotice: vi.fn()
};

describe('the email-code page, Back to the app (real DOM)', () => {
	it('offers it only when the Flow allows leaving, and reports the click', async () => {
		const onCancel = vi.fn();
		const none = render(VerifyEmailCodeView, { props: { ...base, onCancel } });
		expect(none.queryByRole('button', { name: /back to the app/iu })).toBeNull();
		none.unmount();

		const user = userEvent.setup();
		const { getByRole } = render(VerifyEmailCodeView, {
			props: { ...base, onCancel, cancel: { available: true, loading: false } }
		});
		await user.click(getByRole('button', { name: /back to the app/iu }));
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('keeps the request in the way back to the sign-in page', () => {
		const { getByRole } = render(VerifyEmailCodeView, {
			props: { ...base, backHref: '/login?saml_request_id=r&saml_login_nonce=n' }
		});
		expect(getByRole('link', { name: /back to login/iu }).getAttribute('href')).toBe(
			'/login?saml_request_id=r&saml_login_nonce=n'
		);
	});

	it('is busy while going back (no second click)', async () => {
		const onCancel = vi.fn();
		const { getByRole } = render(VerifyEmailCodeView, {
			props: { ...base, onCancel, cancel: { available: true, loading: true } }
		});
		expect((getByRole('button', { name: /back to the app/iu }) as HTMLButtonElement).disabled).toBe(
			true
		);
	});
});
