/** Code samples for stories (fictional values). */
export const CODE_SAMPLES = {
	json: `{
  "client_id": "acme-portal",
  "redirect_uris": ["https://portal.acme.test/callback"],
  "token_endpoint_auth_method": "private_key_jwt",
  "require_pkce": true,
  "access_token_ttl": 3600,
  "post_logout_redirect_uri": null
}`,
	javascript: `// Map incoming SAML attributes to Authrim claims
export default function transform(input, context) {
  const groups = input.attributes['memberOf'] ?? [];
  return {
    email: input.nameId.toLowerCase(),
    admin: groups.includes('cn=admins'),
    tenant: context.tenantId,
    loginCount: Number(input.count) + 1
  };
}`,
	css: `/* Sign-in page branding */
@media (min-width: 640px) {
  .login-card:hover > .logo {
    color: #2c2724;
    --brand-radius: 12px;
    margin: 0 auto !important;
    background: var(--brand-bg, url("bg.webp"));
  }
}`,
	xml: `<?xml version="1.0" encoding="UTF-8"?>
<!-- Service provider metadata -->
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://sp.example.ac.jp/shibboleth">
  <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:AssertionConsumerService index="1" Location="https://sp.example.ac.jp/Shibboleth.sso/SAML2/POST" />
  </md:SPSSODescriptor>
</md:EntityDescriptor>`,
	shell: `# Create the environment and deploy everything
export AUTHRIM_ENV=prod
npx @authrim/setup init --env "$AUTHRIM_ENV" --lang ja
if [ -f .authrim/$AUTHRIM_ENV/config.json ]; then
  npx @authrim/setup deploy --env \${AUTHRIM_ENV} --yes | tee deploy.log
fi`
} as const;

/** Long single-line XML (real metadata often arrives like this) to show wrapping. */
export const LONG_XML = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.ac.jp/idp/shibboleth"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.ac.jp/idp/profile/SAML2/Redirect/SSO"/></md:IDPSSODescriptor></md:EntityDescriptor>
<!-- second line -->`;
