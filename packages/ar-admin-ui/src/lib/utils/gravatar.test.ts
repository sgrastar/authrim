import { describe, expect, it } from 'vitest';
import { getAvatarUrl, getGravatarUrl, getInitials } from './gravatar';

describe('avatar utilities', () => {
	it('does not generate third-party Gravatar URLs from admin email addresses', () => {
		expect(getGravatarUrl('admin@example.com')).toBe('');
		expect(getAvatarUrl('admin@example.com')).toBe('');
	});

	it('uses explicit picture URLs without deriving an email hash', () => {
		expect(getAvatarUrl('admin@example.com', 'https://assets.example.com/avatar.png')).toBe(
			'https://assets.example.com/avatar.png'
		);
	});

	it('uses local initials as the fallback display value', () => {
		expect(getInitials('admin@example.com', 'Admin User')).toBe('AU');
		expect(getInitials('admin@example.com')).toBe('AD');
	});
});
