import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_VISIBLE_TOASTS, toast } from './toast.svelte';

describe('toast', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		toast.dismissAll();
		toast.resume();
		vi.useRealTimers();
	});

	it('closes after the tone duration', () => {
		toast.success('Saved');
		expect(toast.items).toHaveLength(1);
		vi.advanceTimersByTime(5000);
		expect(toast.items).toHaveLength(0);
	});

	it('suppresses the same message within the dedupe window', () => {
		expect(toast.error('Failed')).not.toBeNull();
		expect(toast.error('Failed')).toBeNull();
		vi.advanceTimersByTime(1300);
		expect(toast.error('Failed')).not.toBeNull();
	});

	it('keeps at most four on screen, dropping the oldest', () => {
		for (let i = 0; i < 6; i++) toast.info(`Message ${i}`);
		expect(toast.items).toHaveLength(MAX_VISIBLE_TOASTS);
		expect(toast.items[0].message).toBe('Message 2');
	});

	it('pauses every countdown while hovered and resumes with the time left', () => {
		toast.warning('Check');
		vi.advanceTimersByTime(3000);
		toast.pause();
		vi.advanceTimersByTime(60_000);
		expect(toast.items).toHaveLength(1);
		toast.resume();
		vi.advanceTimersByTime(3999);
		expect(toast.items).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(toast.items).toHaveLength(0);
	});

	it('ignores empty messages and unwraps errors', () => {
		expect(toast.info('   ')).toBeNull();
		toast.error(new Error('Boom'));
		expect(toast.items[0].message).toBe('Boom');
	});
});
