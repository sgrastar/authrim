import { describe, expect, it } from 'vitest';
import { defaultLaunchTypeForApplication } from './launcher-editor';

describe('defaultLaunchTypeForApplication', () => {
	it('defaults SAML applications to SP-initiated launch', () => {
		expect(defaultLaunchTypeForApplication('saml_sp')).toBe('saml_sp_initiated');
	});

	it.each(['standalone', 'oidc_client'] as const)(
		'defaults %s applications to bookmarks',
		(applicationType) => {
			expect(defaultLaunchTypeForApplication(applicationType)).toBe('bookmark');
		}
	);
});
