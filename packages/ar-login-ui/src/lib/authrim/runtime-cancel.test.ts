// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ cancel: vi.fn(), consume: vi.fn() }));

vi.mock('#lib/api/flow-runtime.js', () => ({ flowRuntimeAPI: { cancel: mocks.cancel } }));
vi.mock('./flow-runtime-state.js', () => ({ consumeFlowRuntimeState: mocks.consume }));

import { cancelRuntimeInteraction } from './runtime-cancel';

const input = { interactionId: 'i-1', contractHash: 'hash', signature: 'sig' };

describe('Back to the app', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		Object.defineProperty(window, 'location', {
			value: { href: 'https://tenant.example/verify-email-code', origin: 'https://tenant.example' },
			writable: true,
			configurable: true
		});
	});

	it('cancels with the kept hash and signature, then follows the redirect', async () => {
		mocks.cancel.mockResolvedValue({ data: { redirect_url: 'https://app.example/cb?error=x' } });
		expect(await cancelRuntimeInteraction(input)).toBe('left');
		expect(mocks.cancel).toHaveBeenCalledWith('i-1', { contract_hash: 'hash', signature: 'sig' });
		expect(window.location.href).toBe('https://app.example/cb?error=x');
		expect(mocks.consume).toHaveBeenCalledWith('i-1');
	});

	it('sends the step when one is known', async () => {
		mocks.cancel.mockResolvedValue({ data: { redirect_url: 'https://app.example/cb' } });
		await cancelRuntimeInteraction({ ...input, stepId: 's', nodeId: 'n' });
		expect(mocks.cancel).toHaveBeenCalledWith('i-1', {
			contract_hash: 'hash',
			signature: 'sig',
			step_id: 's',
			node_id: 'n'
		});
	});

	it('posts a real form when the application uses form_post', async () => {
		const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
		mocks.cancel.mockResolvedValue({
			data: {
				form_post: { action: 'https://app.example/cb', fields: [['error', 'access_denied']] }
			}
		});
		expect(await cancelRuntimeInteraction(input)).toBe('left');
		const form = document.querySelector('form') as HTMLFormElement;
		expect(form.action).toBe('https://app.example/cb');
		expect(form.querySelector('input[name="error"]')).toHaveProperty('value', 'access_denied');
		expect(submit).toHaveBeenCalledOnce();
		expect(window.location.href).toBe('https://tenant.example/verify-email-code');
	});

	it('stays, keeping the state, on a refusal (409), a retryable one (503) or no destination', async () => {
		mocks.cancel.mockResolvedValueOnce({ error: { error: 'cancel_not_available' } });
		expect(await cancelRuntimeInteraction(input)).toBe('failed');
		mocks.cancel.mockResolvedValueOnce({ error: { error: 'temporarily_unavailable' } });
		expect(await cancelRuntimeInteraction(input)).toBe('failed');
		mocks.cancel.mockResolvedValueOnce({ data: {} });
		expect(await cancelRuntimeInteraction(input)).toBe('failed');
		mocks.cancel.mockRejectedValueOnce(new Error('offline'));
		expect(await cancelRuntimeInteraction(input)).toBe('failed');
		expect(mocks.consume).not.toHaveBeenCalled();
	});

	it('refuses a destination the redirect rule refuses', async () => {
		mocks.cancel.mockResolvedValue({ data: { redirect_url: 'http://evil.example/cb' } });
		expect(await cancelRuntimeInteraction(input)).toBe('invalid_redirect');
		expect(window.location.href).toBe('https://tenant.example/verify-email-code');
	});
});
