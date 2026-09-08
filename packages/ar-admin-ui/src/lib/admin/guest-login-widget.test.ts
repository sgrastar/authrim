import { describe, expect, it } from 'vitest';
import { createGuestLoginWidget } from './screen-default-drafts';
describe('guest widget creation', () => {
	it('creates an actionable guest block rather than an identity input', () => {
		expect(createGuestLoginWidget('guest-1', 10, (_ja, en) => en)).toEqual({
			field: 'auth.guest',
			label: 'Continue as a guest',
			required: false,
			block_type: 'guest_login_widget',
			block_id: 'guest-1',
			order: 10
		});
	});
	it('preserves configured labels and localization on edit', () => {
		expect(createGuestLoginWidget('guest-1', 10, (ja) => ja, { label: 'Try now' }).label).toBe(
			'Try now'
		);
	});
});
