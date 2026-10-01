import { describe, expect, it } from 'vitest';
import { leaveDecision } from './leave-guard';

const at = (path: string) => ({ url: new URL(path, 'https://admin.example.com') });

describe('leaveDecision', () => {
	it('lets the admin go when nothing is unsaved', () => {
		expect(
			leaveDecision({ willUnload: false, from: at('/admin/a'), to: at('/admin/b') }, false)
		).toBe('allow');
	});

	it('asks in the console for a move inside the console', () => {
		expect(
			leaveDecision({ willUnload: false, from: at('/admin/a'), to: at('/admin/b') }, true)
		).toBe('ask');
	});

	it('leaves closing, reloading or leaving the site to the browser dialog', () => {
		expect(leaveDecision({ willUnload: true, from: at('/admin/a'), to: null }, true)).toBe(
			'native'
		);
	});

	it('does not ask for a jump within the same page', () => {
		expect(
			leaveDecision({ willUnload: false, from: at('/admin/a'), to: at('/admin/a#keys') }, true)
		).toBe('allow');
	});

	it('asks when only the query changes (another view of the page)', () => {
		expect(
			leaveDecision({ willUnload: false, from: at('/admin/a'), to: at('/admin/a?tab=keys') }, true)
		).toBe('ask');
	});
});
