import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	KeyringPresentationFlow,
	MAX_POLL_FAILURES,
	POLL_INTERVAL_MS,
	VERIFICATION_GRACE_MS,
	type PresentationProgress
} from './presentation-flow.svelte';

const T0 = 1_800_000_000_000;
let clock = T0;

function flowWith(progress: (id: string) => Promise<PresentationProgress>, onverified = vi.fn()) {
	const start = vi.fn(async () => ({
		requestId: 'req-1',
		qr: 'openid4vp://?client_id=x&request_uri=y',
		matchCode: '42',
		expiresAt: T0 + 300_000
	}));
	const flow = new KeyringPresentationFlow({ start, progress, onverified, now: () => clock });
	return { flow, start, onverified };
}

/** Move the clock and the timers together, a second at a time (as the countdown sees them). */
async function advance(ms: number) {
	let left = ms;
	do {
		const step = Math.min(1_000, left);
		clock += step;
		await vi.advanceTimersByTimeAsync(step);
		left -= step;
	} while (left > 0);
}

beforeEach(() => {
	vi.useFakeTimers();
	clock = T0;
});
afterEach(() => vi.useRealTimers());

describe('KeyringPresentationFlow', () => {
	it('shows the QR code and the number, then reports the verified presentation once', async () => {
		const progress = vi
			.fn<(id: string) => Promise<PresentationProgress>>()
			.mockResolvedValueOnce({ status: 'pending' })
			.mockResolvedValueOnce({ status: 'processing' })
			.mockResolvedValue({ status: 'verified' });
		const { flow, onverified } = flowWith(progress);

		await flow.start();
		expect(flow.phase).toBe('waiting');
		expect(flow.qr).toContain('openid4vp://');
		expect(flow.matchCode).toBe('42');

		await advance(POLL_INTERVAL_MS);
		expect(flow.checking).toBe(false);
		await advance(POLL_INTERVAL_MS);
		expect(flow.checking).toBe(true);
		await advance(POLL_INTERVAL_MS);
		expect(flow.phase).toBe('verified');
		// The values are dropped as soon as they are no longer needed.
		expect(flow.qr).toBe('');
		expect(flow.matchCode).toBe('');
		expect(onverified).toHaveBeenCalledTimes(1);
		expect(progress).toHaveBeenCalledWith('req-1');

		await advance(POLL_INTERVAL_MS * 3);
		expect(progress).toHaveBeenCalledTimes(3);
	});

	it('ends with the server reason when the presentation failed', async () => {
		const { flow } = flowWith(async () => ({ status: 'failed', error: 'match_code_mismatch' }));
		await flow.start();
		await advance(POLL_INTERVAL_MS);
		expect(flow.phase).toBe('ended');
		expect(flow.endReason).toBe('failed');
		expect(flow.failure).toBe('match_code_mismatch');
		expect(flow.matchCode).toBe('');
	});

	it('treats a result consumed elsewhere as no result here', async () => {
		const { flow, onverified } = flowWith(async () => ({ status: 'consumed' }));
		await flow.start();
		await advance(POLL_INTERVAL_MS);
		expect(flow.phase).toBe('ended');
		expect(onverified).not.toHaveBeenCalled();
	});

	it('expires at the deadline, but follows an answer still being checked for a while', async () => {
		const pending = flowWith(async () => ({ status: 'pending' }));
		await pending.flow.start();
		await advance(300_000 + POLL_INTERVAL_MS + 1_000);
		expect(pending.flow.phase).toBe('ended');
		expect(pending.flow.endReason).toBe('expired');

		clock = T0;
		const checking = flowWith(async () => ({ status: 'processing' }));
		await checking.flow.start();
		await advance(300_000 + 10_000);
		expect(checking.flow.phase).toBe('waiting');
		await advance(VERIFICATION_GRACE_MS);
		expect(checking.flow.phase).toBe('ended');
		expect(checking.flow.endReason).toBe('expired');
	});

	it('gives up after repeated failed status checks', async () => {
		const { flow } = flowWith(async () => {
			throw new Error('offline');
		});
		await flow.start();
		for (let i = 0; i < MAX_POLL_FAILURES; i++) await advance(POLL_INTERVAL_MS);
		expect(flow.phase).toBe('ended');
		expect(flow.endReason).toBe('failed');
	});

	it('does not poll while the page is hidden', async () => {
		const progress = vi.fn(async (): Promise<PresentationProgress> => ({ status: 'pending' }));
		const { flow } = flowWith(progress);
		await flow.start();
		flow.setVisible(false);
		await advance(POLL_INTERVAL_MS * 5);
		expect(progress).not.toHaveBeenCalled();
		flow.setVisible(true);
		await advance(0);
		expect(progress).toHaveBeenCalledTimes(1);
	});

	it('reports a refused start and can start over', async () => {
		const flow = new KeyringPresentationFlow({
			start: vi
				.fn()
				.mockRejectedValueOnce(new Error('refused'))
				.mockResolvedValueOnce({
					requestId: 'req-2',
					qr: 'openid4vp://?a',
					matchCode: '07',
					expiresAt: T0 + 300_000
				}),
			progress: async () => ({ status: 'pending' }),
			now: () => clock
		});
		await flow.start();
		expect(flow.phase).toBe('error');
		await flow.start();
		expect(flow.phase).toBe('waiting');
		expect(flow.matchCode).toBe('07');
	});

	it('stops everything when destroyed', async () => {
		const progress = vi.fn(async (): Promise<PresentationProgress> => ({ status: 'pending' }));
		const { flow } = flowWith(progress);
		await flow.start();
		flow.destroy();
		await advance(POLL_INTERVAL_MS * 3);
		expect(progress).not.toHaveBeenCalled();
		expect(flow.phase).toBe('idle');
		expect(flow.matchCode).toBe('');
	});
});
