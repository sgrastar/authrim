import { describe, expect, it } from 'vitest';
import { LogPager } from './log-pager.svelte';

describe('log cursor navigation', () => {
	it('retains previous cursors and resets them when the tenant or filters change', () => {
		const pager = new LogPager();
		pager.prepare('tenant-a/action-login');
		pager.info = { mode: 'cursor', limit: 20, has_more: true, next_cursor: 'cursor-a' };
		pager.next();
		expect(pager.cursor).toBe('cursor-a');
		expect(pager.hasPrevious).toBe(true);
		pager.prepare('tenant-a/action-login');
		expect(pager.cursor).toBe('cursor-a');
		pager.previous();
		expect(pager.cursor).toBeUndefined();
		pager.next();
		pager.prepare('tenant-b/action-login');
		expect(pager.cursor).toBeUndefined();
		expect(pager.info).toBeUndefined();
		expect(pager.hasPrevious).toBe(false);
		pager.info = { mode: 'cursor', limit: 20, has_more: true, next_cursor: 'cursor-b' };
		pager.next();
		pager.prepare('tenant-b/action-token');
		expect(pager.cursor).toBeUndefined();
	});
});
