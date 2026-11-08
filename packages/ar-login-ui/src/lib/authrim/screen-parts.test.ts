import { describe, expect, it } from 'vitest';
import { screenHasPart } from './screen-parts';

describe('screenHasPart', () => {
	it('finds a part by its kind, hidden or not', () => {
		const screen = {
			fields: [
				{ field: 'heading.login', block_type: 'heading' },
				{
					field: 'auth.switch_link',
					block_type: 'auth_switch_link',
					display_condition: { mode: 'hidden' }
				}
			]
		};
		expect(screenHasPart(screen, 'auth_switch_link')).toBe(true);
		expect(screenHasPart(screen, 'guest_login_widget')).toBe(false);
	});

	it('is false for a screen with no parts, or no screen', () => {
		expect(screenHasPart({ fields: [] }, 'auth_switch_link')).toBe(false);
		expect(screenHasPart({}, 'auth_switch_link')).toBe(false);
		expect(screenHasPart({ fields: [null, 'x', 3] }, 'auth_switch_link')).toBe(false);
		expect(screenHasPart(null, 'auth_switch_link')).toBe(false);
		expect(screenHasPart(undefined, 'auth_switch_link')).toBe(false);
	});
});
