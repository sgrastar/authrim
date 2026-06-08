import { reason } from '../core/reason-registry';
import type { ReasonCode } from '../core/types';

export type StaticFixtureKind =
  | 'csv-user'
  | 'scim-user'
  | 'saml-attributes'
  | 'oidc-claims-request'
  | 'malformed-user'
  | 'regulated-user'
  | 'conflict-field-mapping-set';

export interface StaticFixtureValidationResult {
  valid: boolean;
  reasons: ReasonCode[];
}

export function validateStaticFixture(
  kind: StaticFixtureKind,
  fixture: unknown
): StaticFixtureValidationResult {
  const valid = isStaticFixtureShapeValid(kind, fixture);
  return {
    valid,
    reasons: valid ? [] : [reason('fixture.invalid_static_fixture')],
  };
}

function isStaticFixtureShapeValid(kind: StaticFixtureKind, fixture: unknown): boolean {
  switch (kind) {
    case 'csv-user':
    case 'malformed-user':
    case 'regulated-user':
      return isRecord(fixture) && 'email' in fixture;
    case 'scim-user':
      return isRecord(fixture) && 'userName' in fixture;
    case 'saml-attributes':
      return (
        Array.isArray(fixture) &&
        fixture.every((item) => isRecord(item) && typeof item.name === 'string')
      );
    case 'oidc-claims-request':
      return isRecord(fixture) && 'email' in fixture;
    case 'conflict-field-mapping-set':
      return isRecord(fixture) && Array.isArray(fixture.sets);
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
