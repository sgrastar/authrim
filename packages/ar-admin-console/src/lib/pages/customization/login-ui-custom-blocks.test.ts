import { describe, expect, it } from 'vitest';
import { BLOCKS_MAX, blockProblem, parseBlocks, serializeBlocks } from './login-ui-custom-blocks';

describe('the Login UI page’s custom blocks', () => {
	it('reads the saved JSON, keeping blocks with a known place and kind, up to the limit', () => {
		expect(parseBlocks('')).toEqual([]);
		expect(parseBlocks('not json')).toEqual([]);
		expect(parseBlocks('{"position":"below-form"}')).toEqual([]);
		const many = JSON.stringify(
			Array.from({ length: BLOCKS_MAX + 2 }, (_, i) => ({
				position: 'below-form',
				type: 'text',
				content: `b${i}`
			}))
		);
		expect(parseBlocks(many)).toHaveLength(BLOCKS_MAX);
		expect(
			parseBlocks(
				'[{"position":"sidebar","type":"text","content":"x"},{"position":"above-form","type":"link","content":"Help","url":"https://h.test/","extra":1}]'
			)
		).toEqual([{ position: 'above-form', type: 'link', content: 'Help', url: 'https://h.test/' }]);
	});

	it('writes only the fields a kind uses, trimmed; nothing for no blocks', () => {
		expect(serializeBlocks([])).toBe('');
		expect(
			JSON.parse(
				serializeBlocks([
					{ position: 'below-form', type: 'text', content: ' Hello ', url: 'x', alt: 'y' },
					{ position: 'above-form', type: 'image', content: 'https://i.test/a.png', alt: ' Map ' },
					{ position: 'below-footer', type: 'link', content: 'Help', url: ' https://h.test/ ' }
				])
			)
		).toEqual([
			{ position: 'below-form', type: 'text', content: 'Hello' },
			{ position: 'above-form', type: 'image', content: 'https://i.test/a.png', alt: 'Map' },
			{ position: 'below-footer', type: 'link', content: 'Help', url: 'https://h.test/' }
		]);
	});

	it('names what the screens would refuse', () => {
		expect(blockProblem({ position: 'below-form', type: 'text', content: '  ' })).toBe('content');
		expect(blockProblem({ position: 'below-form', type: 'text', content: 'x'.repeat(2001) })).toBe(
			'contentLong'
		);
		expect(blockProblem({ position: 'below-form', type: 'html', content: 'ok' })).toBeNull();
		expect(
			blockProblem({ position: 'above-form', type: 'image', content: 'http://i.test/a.png' })
		).toBe('content');
		expect(
			blockProblem({
				position: 'above-form',
				type: 'image',
				content: 'data:image/svg+xml;base64,x'
			})
		).toBe('content');
		expect(
			blockProblem({ position: 'above-form', type: 'image', content: 'https://i.test/a.png' })
		).toBeNull();
		// A path on the screens' own origin (an uploaded asset) is shown by the screens too.
		expect(
			blockProblem({
				position: 'above-form',
				type: 'image',
				content: '/api/assets/t/login-ui/a.png'
			})
		).toBeNull();
		expect(
			blockProblem({ position: 'above-form', type: 'image', content: '//cdn.test/a.png' })
		).toBe('content');
		expect(blockProblem({ position: 'below-footer', type: 'link', content: 'Help' })).toBe('url');
		expect(
			blockProblem({ position: 'below-footer', type: 'link', content: 'Help', url: 'javascript:1' })
		).toBe('url');
		expect(
			blockProblem({
				position: 'below-footer',
				type: 'link',
				content: 'Help',
				url: 'http://h.test'
			})
		).toBeNull();
	});
});
