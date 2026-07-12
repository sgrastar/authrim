import { describe, expect, it } from 'vitest';
import { isValidImageUrl } from './url-validation';

describe('isValidImageUrl during SSR', () => {
	it('accepts HTTPS and same-origin relative image URLs without window', () => {
		expect(isValidImageUrl('https://cdn.example.com/theme/background.webp')).toBe(true);
		expect(isValidImageUrl('/api/assets/tenant/login-ui/background/image.webp')).toBe(true);
	});

	it('rejects insecure and executable image URLs without window', () => {
		expect(isValidImageUrl('http://cdn.example.com/theme/background.webp')).toBe(false);
		expect(isValidImageUrl('javascript:alert(1)')).toBe(false);
	});
});
