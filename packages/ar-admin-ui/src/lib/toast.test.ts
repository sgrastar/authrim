// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { toast, toastState } from './toast';

afterEach(() => toast.dismissAll());

describe('Admin toast utility', () => {
	it('publishes success and error messages with appropriate announcement priority', () => {
		toast.success('Settings saved.');
		toast.error(new Error('Settings could not be saved.'));

		const items = get(toastState);
		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({
			type: 'background',
			data: { tone: 'success', message: 'Settings saved.' }
		});
		expect(items[1]).toMatchObject({
			type: 'foreground',
			data: { tone: 'error', message: 'Settings could not be saved.' }
		});
	});

	it('deduplicates rapid identical messages', () => {
		toast.success('Published once.');
		toast.success('Published once.');

		expect(get(toastState)).toHaveLength(1);
	});

	it('caps the visible stack at four messages', () => {
		for (let index = 1; index <= 5; index += 1) {
			toast.info(`Message ${index}`);
		}

		expect(get(toastState).map((item) => item.data.message)).toEqual([
			'Message 2',
			'Message 3',
			'Message 4',
			'Message 5'
		]);
	});
});
