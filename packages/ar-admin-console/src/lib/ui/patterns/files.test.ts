import { describe, expect, it } from 'vitest';
import { describeAccept, matchesAccept, partitionFiles } from './files';

const file = (name: string, type: string, size = 10) => ({ name, type, size });

describe('matchesAccept', () => {
	it('accepts everything without a filter', () => {
		expect(matchesAccept(file('a.bin', ''), undefined)).toBe(true);
	});

	it('matches extensions, exact MIME types and wildcards', () => {
		expect(matchesAccept(file('Metadata.XML', 'text/xml'), '.xml')).toBe(true);
		expect(matchesAccept(file('a.json', 'application/json'), 'application/json')).toBe(true);
		expect(matchesAccept(file('logo.png', 'image/png'), 'image/*')).toBe(true);
		expect(matchesAccept(file('logo.svg', 'image/svg+xml'), '.png, .jpg')).toBe(false);
	});
});

describe('partitionFiles', () => {
	it('rejects wrong types before checking size', () => {
		const result = partitionFiles(
			[
				file('ok.png', 'image/png', 5),
				file('big.png', 'image/png', 50),
				file('x.pdf', 'application/pdf', 1)
			],
			{ accept: 'image/*', maxBytes: 10 }
		);
		expect(result.accepted.map((f) => f.name)).toEqual(['ok.png']);
		expect(result.rejected).toEqual([
			{ name: 'big.png', reason: 'size' },
			{ name: 'x.pdf', reason: 'type' }
		]);
	});
});

describe('describeAccept', () => {
	it('turns the accept list into short labels', () => {
		expect(describeAccept('.json, image/*, application/xml')).toBe('JSON, IMAGE, XML');
		expect(describeAccept('image/png,image/svg+xml')).toBe('PNG, SVG');
	});
});
