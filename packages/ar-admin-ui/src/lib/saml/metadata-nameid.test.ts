import { describe, expect, it } from 'vitest';
import {
	SAML_NAME_ID_EMAIL,
	SAML_NAME_ID_PERSISTENT,
	selectMetadataNameIdFormat
} from './metadata-nameid';

describe('selectMetadataNameIdFormat', () => {
	it('uses the only format advertised by metadata', () => {
		expect(
			selectMetadataNameIdFormat({
				advertisedFormats: [SAML_NAME_ID_PERSISTENT],
				profile: 'baseline',
				currentFormat: SAML_NAME_ID_EMAIL
			})
		).toBe(SAML_NAME_ID_PERSISTENT);
	});

	it('uses the profile preference when metadata advertises both formats', () => {
		expect(
			selectMetadataNameIdFormat({
				advertisedFormats: [SAML_NAME_ID_EMAIL, SAML_NAME_ID_PERSISTENT],
				profile: 'academic_publisher'
			})
		).toBe(SAML_NAME_ID_PERSISTENT);
	});

	it('falls back to the profile when metadata has no NameIDFormat declaration', () => {
		expect(
			selectMetadataNameIdFormat({
				advertisedFormats: [],
				profile: 'academic_publisher'
			})
		).toBe(SAML_NAME_ID_PERSISTENT);
		expect(selectMetadataNameIdFormat({ advertisedFormats: [], profile: 'baseline' })).toBe(
			SAML_NAME_ID_EMAIL
		);
	});
});
