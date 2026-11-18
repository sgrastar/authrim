import type { SamlProviderKind } from '../saml-providers';

/** Public synthetic metadata shared by stories and the loopback dev mock. Never fetches URLs. */
export const metadataCertificate =
	'-----BEGIN CERTIFICATE-----\nVEVTVA==\n-----END CERTIFICATE-----';
export const metadataXml = (kind: SamlProviderKind) =>
	`<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="urn:synthetic:${kind}"><md:${kind === 'saml_sp' ? 'SP' : 'IDP'}SSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>VEVTVA==</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:${kind === 'saml_sp' ? 'AssertionConsumerService' : 'SingleSignOnService'} Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://synthetic.example.test/${kind === 'saml_sp' ? 'acs' : 'sso'}" index="0" /></md:${kind === 'saml_sp' ? 'SP' : 'IDP'}SSODescriptor></md:EntityDescriptor>`;

export function previewMetadataFixture(body: Record<string, unknown>): Response {
	const fail = (code: string) =>
		Response.json({ error: 'invalid_request', error_description: code }, { status: 400 });
	const url = typeof body.metadataUrl === 'string' ? body.metadataUrl : '';
	if (url && (!url.startsWith('https://') || url.includes('fetch-failed')))
		return fail('metadata_fetch_failed');
	let source = typeof body.metadataXml === 'string' ? body.metadataXml : '';
	if (!source && url) source = metadataXml(url.endsWith('/idp.xml') ? 'saml_idp' : 'saml_sp');
	if (new TextEncoder().encode(source).length > 1024 * 1024) return fail('metadata_invalid_xml');
	// Only these synthetic fixture documents are supported by the dev mock.
	const entities = [metadataXml('saml_sp'), metadataXml('saml_idp')].flatMap((xml) =>
		source.includes(xml) ? [xml] : []
	);
	if (source.includes('EntitiesDescriptor')) {
		if (entities.length !== 1 || (source.match(/<md:EntityDescriptor\s/g) ?? []).length !== 1)
			return fail('metadata_aggregate_requires_federation');
		source = entities[0];
	}
	if (source !== metadataXml('saml_sp') && source !== metadataXml('saml_idp'))
		return fail('metadata_invalid_xml');
	const kind = source.includes('IDPSSODescriptor') ? 'saml_idp' : 'saml_sp';
	return Response.json({
		kind: 'single',
		providerType: kind,
		config: {
			entityId: `urn:synthetic:${kind}`,
			...(kind === 'saml_sp'
				? { acsUrl: 'https://synthetic.example.test/acs' }
				: { ssoUrl: 'https://synthetic.example.test/sso' }),
			certificate: metadataCertificate,
			certificates: [metadataCertificate],
			metadataXml: source,
			...(url ? { metadataUrl: url } : {})
		}
	});
}
