import { withSAMLAssuranceAttributes } from './identity-assurance';
import { loadSAMLInstitutionRelease, withSAMLInstitutionAttributes } from './institution-release';
import type { SAMLAttributeSubject } from './attributes';

/** The same trusted subject enrichment for attribute release and consent-approved NameID copies. */
export async function prepareSAMLReleaseSubject(
  subject: SAMLAttributeSubject,
  input: Parameters<typeof withSAMLAssuranceAttributes>[1]
) {
  const assured = await withSAMLAssuranceAttributes(subject, input);
  const institution = await loadSAMLInstitutionRelease(input.env, input.tenantId, input.onError);
  return { subject: withSAMLInstitutionAttributes(assured, institution), institution };
}
