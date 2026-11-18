import { describe, expect, it } from 'vitest';
import { MAX_CUSTOM_BLOCKS, readCustomBlock, safeCustomBlocks } from './custom-blocks';

describe('custom blocks', () => {
	it('keeps well-formed text and html blocks, trimmed', () => {
		expect(
			readCustomBlock({ position: 'below-form', type: 'text', content: ' Campus only ' })
		).toEqual({ position: 'below-form', type: 'text', content: 'Campus only' });
		expect(
			readCustomBlock({
				position: 'above-header',
				type: 'html',
				content: 'See <a href="https://x.test">help</a>'
			})
		).toMatchObject({ type: 'html' });
	});

	it('leaves out blocks with an unknown position or type, or no content', () => {
		expect(readCustomBlock({ position: 'sidebar', type: 'text', content: 'x' })).toBeNull();
		expect(readCustomBlock({ position: 'below-form', type: 'script', content: 'x' })).toBeNull();
		expect(readCustomBlock({ position: 'below-form', type: 'text', content: '  ' })).toBeNull();
		expect(readCustomBlock('text')).toBeNull();
		expect(readCustomBlock(null)).toBeNull();
	});

	it('shows an image only from a safe address, with its description', () => {
		expect(
			readCustomBlock({
				position: 'above-form',
				type: 'image',
				content: 'https://cdn.test/a.png',
				alt: ' Map '
			})
		).toEqual({
			position: 'above-form',
			type: 'image',
			content: 'https://cdn.test/a.png',
			alt: 'Map'
		});
		expect(
			readCustomBlock({ position: 'above-form', type: 'image', content: 'javascript:alert(1)' })
		).toBeNull();
		expect(
			readCustomBlock({
				position: 'above-form',
				type: 'image',
				content: 'data:image/svg+xml;base64,PHN2Zz4='
			})
		).toBeNull();
	});

	it('shows a link only to an http(s) address', () => {
		expect(
			readCustomBlock({
				position: 'below-footer',
				type: 'link',
				content: 'Help desk',
				url: 'https://help.test/'
			})
		).toEqual({
			position: 'below-footer',
			type: 'link',
			content: 'Help desk',
			url: 'https://help.test/'
		});
		expect(
			readCustomBlock({
				position: 'below-footer',
				type: 'link',
				content: 'Help',
				url: 'javascript:1'
			})
		).toBeNull();
		expect(readCustomBlock({ position: 'below-footer', type: 'link', content: 'Help' })).toBeNull();
	});

	it('takes an array only, drops the ill-formed entries and caps the count', () => {
		expect(safeCustomBlocks('[]')).toEqual([]);
		expect(safeCustomBlocks({ position: 'below-form', type: 'text', content: 'x' })).toEqual([]);
		const many = Array.from({ length: MAX_CUSTOM_BLOCKS + 3 }, (_, i) => ({
			position: 'below-form',
			type: 'text',
			content: `Block ${i}`
		}));
		expect(safeCustomBlocks([{ position: 'nowhere' }, ...many])).toHaveLength(MAX_CUSTOM_BLOCKS);
	});
});
