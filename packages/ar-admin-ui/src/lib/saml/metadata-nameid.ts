export const SAML_NAME_ID_EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
export const SAML_NAME_ID_PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';

export function selectMetadataNameIdFormat(options: {
	advertisedFormats: string[];
	profile: string;
	currentFormat?: string;
}): string {
	const profileDefault =
		options.profile === 'strict' || options.profile === 'academic_publisher'
			? SAML_NAME_ID_PERSISTENT
			: SAML_NAME_ID_EMAIL;
	const advertisedFormats = [...new Set(options.advertisedFormats.filter(Boolean))];

	if (advertisedFormats.length === 0) {
		return profileDefault;
	}
	if (advertisedFormats.includes(profileDefault)) {
		return profileDefault;
	}
	if (options.currentFormat && advertisedFormats.includes(options.currentFormat)) {
		return options.currentFormat;
	}
	return advertisedFormats[0];
}
