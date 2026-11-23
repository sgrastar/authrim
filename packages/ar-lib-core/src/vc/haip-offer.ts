/**
 * Issuer-initiated Credential Offer for HAIP wallets (OpenID4VCI 1.0 section 4.1, HAIP 1.0
 * section 4): the authorization code grant at the Authrim OP, by value, invoked through the
 * `haip-vci://` scheme. The offer carries nothing secret and is not stored: the wallet starts a
 * normal authorization (PAR, DPoP, wallet attestation) and the issuer decides at that point.
 */

export const HAIP_VCI_SCHEME = 'haip-vci://';

export interface HaipCredentialOffer {
  credential_issuer: string;
  credential_configuration_ids: string[];
  grants: { authorization_code: { authorization_server: string } };
}

export function buildHaipCredentialOffer(input: {
  /** https origin of the tenant: the Credential Issuer and the OP's issuer. */
  credentialIssuer: string;
  credentialConfigurationId: string;
}): { offer: HaipCredentialOffer; uri: string } {
  const url = new URL(input.credentialIssuer);
  if (url.protocol !== 'https:' || url.origin !== input.credentialIssuer) {
    throw new Error('haip_offer_issuer_invalid');
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(input.credentialConfigurationId)) {
    throw new Error('haip_offer_configuration_invalid');
  }
  const offer: HaipCredentialOffer = {
    credential_issuer: input.credentialIssuer,
    credential_configuration_ids: [input.credentialConfigurationId],
    grants: { authorization_code: { authorization_server: input.credentialIssuer } },
  };
  return {
    offer,
    uri: `${HAIP_VCI_SCHEME}?credential_offer=${encodeURIComponent(JSON.stringify(offer))}`,
  };
}
