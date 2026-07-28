// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { installPageResumeHandler } from './page-resume';

describe('installPageResumeHandler', () => {
	it('runs once after a hidden page becomes visible again', async () => {
		let visibilityState: DocumentVisibilityState = 'visible';
		vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState);
		const callback = vi.fn();
		const cleanup = installPageResumeHandler(callback);

		visibilityState = 'hidden';
		document.dispatchEvent(new Event('visibilitychange'));
		visibilityState = 'visible';
		document.dispatchEvent(new Event('visibilitychange'));
		await Promise.resolve();

		expect(callback).toHaveBeenCalledTimes(1);
		cleanup();
		vi.restoreAllMocks();
	});

	it('runs when Safari restores a page from the back-forward cache', async () => {
		const callback = vi.fn();
		const cleanup = installPageResumeHandler(callback);
		const event = new Event('pageshow') as PageTransitionEvent;
		Object.defineProperty(event, 'persisted', { value: true });

		window.dispatchEvent(event);
		await Promise.resolve();

		expect(callback).toHaveBeenCalledTimes(1);
		cleanup();
	});
});
