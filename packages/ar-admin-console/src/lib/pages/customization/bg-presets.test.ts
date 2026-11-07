import { describe, expect, it } from 'vitest';
import { bgPresetGroups, type BgPreset } from './bg-presets';

const preset = (category: string, name: string): BgPreset => ({
	id: `${category}/${name}`,
	category,
	name,
	url: `/api/assets/presets/login-ui/backgrounds/${category}/${name}.webp`
});

describe('background preset groups', () => {
	it('offers the known categories first, in their order, then any other', () => {
		const groups = bgPresetGroups([
			preset('zebra', 'stripes'),
			preset('paper', 'indigo-washi'),
			preset('nature', 'hatenohama-day'),
			preset('art', 'canvas')
		]);
		expect(groups.map((g) => g.id)).toEqual(['nature', 'paper', 'art', 'zebra']);
	});

	it('chooses a preset by the path a theme stores', () => {
		const [group] = bgPresetGroups([preset('nature', 'hatenohama-day')]);
		expect(group.items[0].value).toBe(
			'/api/assets/presets/login-ui/backgrounds/nature/hatenohama-day.webp'
		);
	});

	it('names a preset without a message from its file name', () => {
		const [group] = bgPresetGroups([preset('art', 'oil-on-canvas')]);
		expect(group.label).toBe('Art');
		expect(group.items[0].label).toBe('Oil on canvas');
	});
});
