import { describe, expect, it, vi } from 'vitest';
import { AdminLoginTimeoutError, withAdminLoginTimeout } from './admin-login-timeout';

describe('withAdminLoginTimeout', () => {
	it('returns a completed operation and clears its deadline', async () => {
		vi.useFakeTimers();
		const onTimeout = vi.fn();

		await expect(withAdminLoginTimeout(Promise.resolve('ok'), 1000, onTimeout)).resolves.toBe('ok');
		await vi.advanceTimersByTimeAsync(1000);
		expect(onTimeout).not.toHaveBeenCalled();
		vi.useRealTimers();
	});

	it('rejects a stalled operation and invokes ceremony cancellation', async () => {
		vi.useFakeTimers();
		const onTimeout = vi.fn();
		const result = withAdminLoginTimeout(new Promise<never>(() => undefined), 1000, onTimeout);
		const rejection = expect(result).rejects.toBeInstanceOf(AdminLoginTimeoutError);

		await vi.advanceTimersByTimeAsync(1000);
		await rejection;
		expect(onTimeout).toHaveBeenCalledOnce();
		vi.useRealTimers();
	});

	it('rejects invalid timeout values before waiting', async () => {
		await expect(withAdminLoginTimeout(Promise.resolve('ok'), 0)).rejects.toThrow(
			'admin_login_timeout_invalid'
		);
	});
});
