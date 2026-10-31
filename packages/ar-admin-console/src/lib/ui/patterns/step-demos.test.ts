import { describe, expect, it } from 'vitest';
import { TRANSFORMS } from './mapping-model';
import { DEMOS } from './step-demos';

describe('step demos', () => {
	it('show every step changing something', () => {
		for (const def of TRANSFORMS) {
			const demo = DEMOS[def.id];
			const changes = demo.chips.some(
				(chip) => chip.as || chip.parts.some((part) => part.as !== undefined)
			);
			expect(changes, def.id).toBe(true);
		}
	});

	it('turn characters over one by one where they change', () => {
		const turned = DEMOS.strip_accents.chips[0].parts.filter((part) => part.as === 'swap');
		expect(turned.map((part) => `${part.text}→${part.to}`)).toEqual(['é→e', 'ü→u']);
		const digits = DEMOS.ascii_digits.chips[0].parts.map((part) => part.to);
		expect(digits).toEqual(['4', '2', '0', '1']);
	});
});
