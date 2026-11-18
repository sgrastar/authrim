import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminFetch } from './admin-request';
import { RELEASE_PAUSE_HOLD_MS, releasePause } from './release-pause.svelte';

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	releasePause.clear();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('releasePause', () => {
	it('is on after a refused change and goes away by itself', () => {
		expect(releasePause.active).toBe(false);
		releasePause.report();
		expect(releasePause.active).toBe(true);
		vi.advanceTimersByTime(RELEASE_PAUSE_HOLD_MS - 1);
		expect(releasePause.active).toBe(true);
		vi.advanceTimersByTime(1);
		expect(releasePause.active).toBe(false);
	});

	it('counts the hold time from the last refusal', () => {
		releasePause.report();
		vi.advanceTimersByTime(RELEASE_PAUSE_HOLD_MS - 1);
		releasePause.report();
		vi.advanceTimersByTime(RELEASE_PAUSE_HOLD_MS - 1);
		expect(releasePause.active).toBe(true);
	});
});

describe('adminFetch and the release pause', () => {
	const answerWith = (...responses: Response[]) => {
		const fetchMock = vi.fn();
		for (const response of responses) fetchMock.mockResolvedValueOnce(response);
		vi.stubGlobal('fetch', fetchMock);
	};

	it('turns the notice on for a change refused while a release is verified', async () => {
		answerWith(json(409, { error: 'ADMIN_MUTATION_PAUSED_FOR_RELEASE', phase: 'verifying' }));
		const response = await adminFetch('/api/admin/login-ui-themes/t1', { method: 'PUT' });
		expect(releasePause.active).toBe(true);
		// The caller still reads the answer itself.
		expect(await response.json()).toMatchObject({ error: 'ADMIN_MUTATION_PAUSED_FOR_RELEASE' });
	});

	it('turns the notice on when the release state cannot be read', async () => {
		answerWith(json(503, { error: 'CONTROL_PLANE_RELEASE_ROLLOUT_UNAVAILABLE' }));
		await adminFetch('/api/admin/me/onboarding/theme', { method: 'PUT' });
		expect(releasePause.active).toBe(true);
	});

	it('leaves the notice off for an edit conflict and for an answer that is not JSON', async () => {
		answerWith(json(409, { error: 'ADMIN_CONFLICT' }), new Response('busy', { status: 503 }));
		await adminFetch('/api/admin/x', { method: 'PUT' });
		await adminFetch('/api/admin/x', { method: 'PUT' });
		expect(releasePause.active).toBe(false);
	});

	it('turns the notice off when a change is taken, not when something is read', async () => {
		answerWith(
			json(409, { error: 'ADMIN_MUTATION_PAUSED_FOR_RELEASE' }),
			json(200, {}),
			json(200, {})
		);
		await adminFetch('/api/admin/x', { method: 'PUT' });
		await adminFetch('/api/admin/x');
		expect(releasePause.active).toBe(true);
		await adminFetch('/api/admin/x', { method: 'PUT' });
		expect(releasePause.active).toBe(false);
	});
});
