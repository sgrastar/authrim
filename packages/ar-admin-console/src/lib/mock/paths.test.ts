import { describe, expect, it } from 'vitest';
import { consoleToMockHref, mockToConsolePath, withPersona } from './paths';

describe('mock paths', () => {
	it('maps a mock URL to the console path it stands for', () => {
		expect(mockToConsolePath('/mock')).toBe('/admin');
		expect(mockToConsolePath('/mock/')).toBe('/admin');
		expect(mockToConsolePath('/mock/users/all')).toBe('/admin/users/all');
		expect(mockToConsolePath('/mock/platform')).toBe('/admin/platform');
		expect(mockToConsolePath('/mock/platform/tenants/list')).toBe('/admin/platform/tenants/list');
	});

	it('sends anything outside the mock to the overview', () => {
		expect(mockToConsolePath('/')).toBe('/admin');
		expect(mockToConsolePath('/mockery/x')).toBe('/admin');
	});

	it('moves the links the shell builds into the mock', () => {
		expect(consoleToMockHref('/admin')).toBe('/mock');
		expect(consoleToMockHref('/admin/users/all')).toBe('/mock/users/all');
		expect(consoleToMockHref('/admin/platform')).toBe('/mock/platform');
		expect(consoleToMockHref('/admin/integrations/notifications?id=n3')).toBe(
			'/mock/integrations/notifications?id=n3'
		);
		expect(consoleToMockHref('/admin#top')).toBe('/mock#top');
	});

	it('leaves every other link alone', () => {
		expect(consoleToMockHref('/administrator')).toBeNull();
		expect(consoleToMockHref('/mock/users/all')).toBeNull();
		expect(consoleToMockHref('https://example.com/admin')).toBeNull();
		expect(consoleToMockHref('')).toBeNull();
	});

	it('keeps the persona on the way through the mock', () => {
		expect(consoleToMockHref('/admin/users/all', 'viewer')).toBe('/mock/users/all?persona=viewer');
		expect(consoleToMockHref('/admin/x?id=1#top', 'support')).toBe(
			'/mock/x?id=1&persona=support#top'
		);
		expect(consoleToMockHref('/admin/users/all', 'platform')).toBe('/mock/users/all');
		expect(withPersona('/mock/platform', 'tenant')).toBe('/mock/platform?persona=tenant');
		expect(withPersona('/mock?persona=viewer', 'tenant')).toBe('/mock?persona=viewer');
		expect(withPersona('/mock', undefined)).toBe('/mock');
	});
});
