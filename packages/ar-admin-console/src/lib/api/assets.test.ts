import { describe, expect, it } from 'vitest';
import { resolveApiAssetUrl } from './assets';

describe('resolveApiAssetUrl', () => {
	const path = '/api/assets/default/login-ui/background/12bd.png';

	it('reads a stored asset path from the API origin', () => {
		expect(resolveApiAssetUrl(path, 'https://api.example.com')).toBe(
			`https://api.example.com${path}`
		);
		expect(resolveApiAssetUrl(path, 'https://api.example.com/')).toBe(
			`https://api.example.com${path}`
		);
	});

	it('keeps the path when the console reaches the API on its own origin', () => {
		expect(resolveApiAssetUrl(path, '')).toBe(path);
	});

	it('leaves other URLs as they are', () => {
		for (const url of [
			'https://cdn.example.com/logo.png',
			'data:image/png;base64,AA==',
			'/logo.png'
		]) {
			expect(resolveApiAssetUrl(url, 'https://api.example.com')).toBe(url);
		}
	});
});
