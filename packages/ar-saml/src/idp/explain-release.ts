export { loadSAMLNameIdProfile } from './nameid-profile';
import type { SAMLFixtureExplanation, SAMLFixtureExplanationRequest } from '../release-explain';
import {
  DestinationProfileReleaseValidationError,
  ensureAdminDatabaseAdapter,
  loadDestinationProfileConsentDescriptor,
  RELEASE_APPROVE_ALL,
  RELEASE_APPROVE_REQUIRED,
  withStandardUserAttributeNames,
  type Env,
  type NameIDFormat,
  type SAMLSPConfig,
} from '@authrim/ar-lib-core';
import { getSPConfig, validateSAMLSPMappingConfig } from '../admin/providers';
import { getSAMLLocalEntityIds } from '../common/entity-id';
import {
  computeSAMLAttributeRelease,
  samlReleaseItems,
  samlApprovalNeedsIdentifiers,
  applySAMLReleaseApproval,
  resolveSAMLMappedNameID,
} from './release-items';
import { MissingRequiredSAMLAttributeError, SAMLIdentityMappingRuntimeError } from './attributes';
import { resolveSAMLRuntimeIdentityMapping } from './runtime-identity-mapping';
import { resolveEffectiveSAMLNameIDFormat, resolveSAMLNameIDValue } from './subject';
import { NAMEID_FORMATS } from '../common/constants';

function failure(error: unknown) {
  if (error instanceof MissingRequiredSAMLAttributeError) {
    return {
      code: 'required_field_missing',
      fields: error.missingAttributes.map((item) => item.name),
    };
  }
  if (error instanceof DestinationProfileReleaseValidationError) {
    return { code: error.code, fields: error.field ? [error.field] : [] };
  }
  if (error instanceof SAMLIdentityMappingRuntimeError) {
    return { code: 'mapping_failed', reasons: error.reasons.map((reason) => reason.code) };
  }
  return { code: 'release_failed' };
}

type NameIdResult = {
  format: NameIDFormat;
  status: 'released' | 'deferred' | 'suppressed' | 'failed';
  value?: string;
  reasons?: string[];
};

function answer(
  body: Record<string, unknown>,
  status: SAMLFixtureExplanation['status'] = 200
): SAMLFixtureExplanation {
  return { body, status };
}

/** A typed package boundary: management need not load the SAML compiler's internal types. */
export async function validateSAMLSPReleaseBinding(
  env: Env,
  tenantId: string,
  config: SAMLSPConfig
): Promise<{ field: string } | null> {
  return validateSAMLSPMappingConfig(env, tenantId, config);
}

/** Runs the SSO release with fixture guards; no account evidence, identifiers or secrets. */
export async function explainSAMLReleaseFixture(
  request: SAMLFixtureExplanationRequest
): Promise<SAMLFixtureExplanation> {
  const { env, tenantId, spEntityId, user, consent } = request;
  const admin = ensureAdminDatabaseAdapter(env, 'saml-release-explain');
  if (!admin) return answer({ error: 'temporarily_unavailable' }, 503);
  try {
    const [spConfig, { idpEntityId }] = await Promise.all([
      getSPConfig(env, tenantId, spEntityId),
      getSAMLLocalEntityIds(env, tenantId),
    ]);
    if (!spConfig)
      return answer({ error: 'not_found', error_description: 'SAML SP not found' }, 404);
    const attributes = withStandardUserAttributeNames(user.attributes);
    const userInfo = {
      ...attributes,
      id: user.userId,
      attributes,
      customClaims: attributes,
      customFields: attributes,
      ...(typeof attributes.email === 'string' ? { email: attributes.email } : {}),
    };
    const base = {
      protocol: 'saml',
      tenantId,
      sp_entity_id: spConfig.entityId,
      subject: { kind: 'test_user', user_id: user.userId },
      consent,
    };
    const input = { env: env, tenantId, idpEntityId, spConfig, userInfo, fixture: true };
    let fields: Array<{ field: string; policy: string }> = [];
    let nameIdFormat = spConfig.nameIdFormat ?? NAMEID_FORMATS.EMAIL;
    try {
      const mapping = await resolveSAMLRuntimeIdentityMapping(env, tenantId, idpEntityId, spConfig);
      const profile = mapping?.destinationProfileId
        ? await loadDestinationProfileConsentDescriptor(
            admin,
            tenantId,
            mapping.destinationProfileId
          )
        : null;
      fields = (profile?.fields ?? []).map((field) => ({
        field: field.key,
        policy: spConfig.identityMapping?.destinationFieldPolicies?.[field.key] ?? 'optional',
      }));
      const mappedNameID = await resolveSAMLMappedNameID(input);
      nameIdFormat = resolveEffectiveSAMLNameIDFormat({
        spConfig,
        mappedNameID: Boolean(mappedNameID),
      });
      const releaseInput = {
        ...input,
        userId: user.userId,
        requestScope: {},
        onError: () => undefined,
      };
      const before = await computeSAMLAttributeRelease({
        ...releaseInput,
        identifiers: 'deferred',
      });
      const items = samlReleaseItems(before, { nameIdFormat, userInfo, showValues: true });
      const beforeNameId: NameIdResult = {
        format: nameIdFormat,
        status: 'deferred',
        reasons: ['consent_pending'],
        ...(items[0]?.values?.[0] ? { value: items[0].values[0] } : {}),
      };
      const beforeConsent = {
        items,
        // Placeholders are deliberately kept out of the response, as on the consent screen.
        attributes: before.attributes.filter((attribute) => !before.deferred.has(attribute.name)),
        deferred_attributes: [...before.deferred],
        nameid: beforeNameId,
        optional_missing_attributes: before.optionalMissingAttributes,
        withheld_scoped_values: before.withheldScopedValues,
      };
      if (consent === 'none') {
        const nameid: NameIdResult = {
          format: nameIdFormat,
          status: 'suppressed',
          reasons: ['consent_missing'],
        };
        return answer({
          ...base,
          fields,
          before_consent: beforeConsent,
          after_consent: { status: 'awaiting_consent', attributes: [], nameid },
        });
      }
      const approved = [consent === 'required' ? RELEASE_APPROVE_REQUIRED : RELEASE_APPROVE_ALL];
      let nameid: NameIdResult;
      try {
        if (mappedNameID) {
          nameid = {
            format: nameIdFormat,
            status: 'released',
            value: (await mappedNameID()).value,
          };
        } else if (
          nameIdFormat === NAMEID_FORMATS.PERSISTENT ||
          nameIdFormat === NAMEID_FORMATS.TRANSIENT
        ) {
          nameid = {
            format: nameIdFormat,
            status: 'suppressed',
            reasons: ['test_user_identifier_not_evaluated'],
          };
        } else {
          nameid = {
            format: nameIdFormat,
            status: 'released',
            value: await resolveSAMLNameIDValue(userInfo, nameIdFormat),
          };
        }
      } catch (error) {
        const reasons =
          error instanceof SAMLIdentityMappingRuntimeError
            ? error.reasons.map((reason) => reason.code)
            : ['nameid_unavailable'];
        nameid = {
          format: nameIdFormat,
          status: reasons.some(
            (reason) => reason.includes('suppressed') || reason.includes('not_evaluated')
          )
            ? 'suppressed'
            : 'failed',
          reasons,
        };
      }
      try {
        const after = samlApprovalNeedsIdentifiers(before, approved)
          ? await computeSAMLAttributeRelease({ ...releaseInput, identifiers: 'made' })
          : before;
        const released = applySAMLReleaseApproval(after, approved, nameIdFormat);
        return answer({
          ...base,
          fields,
          before_consent: beforeConsent,
          after_consent: {
            status: released.ok && nameid.status === 'released' ? 'released' : 'failed',
            attributes: released.ok && nameid.status === 'released' ? released.attributes : [],
            nameid,
            ...(!released.ok
              ? { error: { code: 'required_field_missing', fields: released.missing } }
              : {}),
            optional_missing_attributes: after.optionalMissingAttributes,
            identifier_evaluation: 'suppressed_for_test_user',
          },
        });
      } catch (error) {
        return answer({
          ...base,
          fields,
          before_consent: beforeConsent,
          after_consent: { status: 'failed', attributes: [], nameid, error: failure(error) },
        });
      }
    } catch (error) {
      const nameid: NameIdResult = {
        format: nameIdFormat,
        status: 'failed',
        reasons: ['release_stopped'],
      };
      return answer({
        ...base,
        fields,
        before_consent: { status: 'failed', items: [], error: failure(error) },
        after_consent: { status: 'failed', attributes: [], nameid, error: failure(error) },
      });
    }
  } catch {
    return answer(
      { error: 'internal_error', error_description: 'The SAML release could not be explained' },
      500
    );
  }
}
