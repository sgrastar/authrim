import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { t } from '#lib/i18n/i18n.svelte.js';
const redeem = vi.hoisted(() => vi.fn());
vi.mock('#lib/api/admin-invitation-enrollment.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/api/admin-invitation-enrollment.js')>();
	return {
		...actual,
		adminInvitationEnrollmentAPI: { ...actual.adminInvitationEnrollmentAPI, redeem }
	};
});

import JoinPage from './+page.svelte';

beforeEach(() => {
	redeem.mockReset();
	vi.stubGlobal(
		'matchMedia',
		vi.fn((media: string) => ({
			matches: false,
			media,
			onchange: null,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(() => true)
		}))
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	window.history.replaceState(null, '', '/admin/join');
});

function open(hash: string) {
	window.history.replaceState(null, '', `/admin/join${hash}`);
	return render(JoinPage);
}

const emailField = (view: ReturnType<typeof open>) =>
	view.getByLabelText(new RegExp(t('join.email'))) as HTMLInputElement;
const codeField = (view: ReturnType<typeof open>) =>
	view.getByLabelText(new RegExp(t('join.code'))) as HTMLInputElement;

describe('the join page', () => {
	it('fills both fields from the link and makes them read-only', async () => {
		const view = open('#code=ABCD-EFGH-JKLM-NPQR&email=new%40example.com');

		await waitFor(() => expect(emailField(view).value).toBe('new@example.com'));
		expect(codeField(view).value).toBe('ABCD-EFGH-JKLM-NPQR');
		expect(emailField(view).readOnly).toBe(true);
		expect(codeField(view).readOnly).toBe(true);
		expect(view.getByText(t('join.fromLink'))).toBeTruthy();
	});

	it('still sends the values the link filled in', async () => {
		redeem.mockResolvedValue({
			enrollment_token: 'token',
			invitation: {
				email: 'new@example.com',
				name: null,
				role: 'Admin',
				ip_restriction_enabled: false
			}
		});
		const view = open('#code=ABCD-EFGH-JKLM-NPQR&email=new%40example.com');
		await waitFor(() => expect(emailField(view).value).toBe('new@example.com'));

		await fireEvent.click(view.getByRole('button', { name: t('join.check') }));

		await waitFor(() =>
			expect(redeem).toHaveBeenCalledWith('new@example.com', 'ABCD-EFGH-JKLM-NPQR')
		);
		expect(redeem).toHaveBeenCalledTimes(1);
		await waitFor(() =>
			expect(view.getByRole('button', { name: t('join.createPasskey') })).toBeTruthy()
		);
	});

	it('keeps the fields locked, and the invitation retryable, when it is refused', async () => {
		const { AdminInvitationEnrollmentError } =
			await import('#lib/api/admin-invitation-enrollment.js');
		redeem.mockRejectedValue(
			new AdminInvitationEnrollmentError('invalid_invitation', 'Invitation not found')
		);
		const view = open('#code=WRONG-WRONG-WRONG-WRNG&email=new%40example.com');
		await waitFor(() => expect(emailField(view).readOnly).toBe(true));

		await fireEvent.click(view.getByRole('button', { name: t('join.check') }));

		await waitFor(() => expect(view.getByText(t('join.error.invalid'))).toBeTruthy());
		// No way to edit here: a wrong link is replaced by asking for a new invitation.
		expect(emailField(view).readOnly).toBe(true);
		expect(codeField(view).readOnly).toBe(true);
		expect(view.getByRole('button', { name: t('join.check') })).toBeTruthy();
	});

	it('takes the fragment out of the address bar', async () => {
		const view = open('#code=ABCD-EFGH-JKLM-NPQR&email=new%40example.com');
		await waitFor(() => expect(emailField(view).value).toBe('new@example.com'));
		expect(window.location.hash).toBe('');
	});

	it.each([
		['only the e-mail address', '#email=new%40example.com'],
		['only the code', '#code=ABCD-EFGH-JKLM-NPQR']
	])('leaves the form open when the link carries %s', async (_name, hash) => {
		const view = open(hash);

		await waitFor(() => expect(window.location.hash).toBe(''));
		expect(emailField(view).readOnly).toBe(false);
		expect(codeField(view).readOnly).toBe(false);
		expect(view.queryByText(t('join.fromLink'))).toBeNull();
	});

	it('leaves the form open when opened without a link', () => {
		const view = open('');

		expect(emailField(view).value).toBe('');
		expect(emailField(view).readOnly).toBe(false);
		expect(codeField(view).readOnly).toBe(false);
		expect(view.queryByText(t('join.fromLink'))).toBeNull();
	});
});
