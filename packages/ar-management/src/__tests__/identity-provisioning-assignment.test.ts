import { describe, expect, it } from 'vitest';
import {
  decideLifecycleSignalRevocation,
  evaluateProvisioningAssignmentRule,
  LIFECYCLE_SIGNAL_REASON_CODES,
  PROVISIONING_ASSIGNMENT_REASON_CODES,
} from '../identity-provisioning-assignment';

describe('evaluateProvisioningAssignmentRule', () => {
  it('matches import, JIT, and registration assignment context without exposing raw values', () => {
    expect(
      evaluateProvisioningAssignmentRule(
        {
          id: 'rule-1',
          targetType: 'group',
          targetId: 'group-1',
          condition: {
            eventTypes: ['import', 'jit', 'registration'],
            sourceTypes: ['scim'],
            domain: 'Example.EDU',
            claims: {
              affiliation: 'faculty',
            },
          },
        },
        {
          eventType: 'jit',
          sourceType: 'scim',
          domain: 'example.edu',
          claims: {
            affiliation: 'faculty',
            email: 'person@example.edu',
          },
        }
      )
    ).toEqual({
      matched: true,
      ruleId: 'rule-1',
      targetType: 'group',
      targetId: 'group-1',
      reasonCodes: [PROVISIONING_ASSIGNMENT_REASON_CODES.matched],
    });
  });

  it('returns mismatch reasons when conditional assignment does not match', () => {
    expect(
      evaluateProvisioningAssignmentRule(
        {
          id: 'rule-1',
          targetType: 'entitlement',
          targetId: 'entitlement-1',
          condition: {
            eventTypes: ['registration'],
            sourceTypes: ['csv'],
            domains: ['example.edu'],
          },
        },
        {
          eventType: 'jit',
          sourceType: 'saml',
          domain: 'other.example',
        }
      ).reasonCodes
    ).toEqual([
      PROVISIONING_ASSIGNMENT_REASON_CODES.eventTypeMismatch,
      PROVISIONING_ASSIGNMENT_REASON_CODES.sourceTypeMismatch,
      PROVISIONING_ASSIGNMENT_REASON_CODES.domainMismatch,
    ]);
  });
});

describe('decideLifecycleSignalRevocation', () => {
  it('turns SCIM active:false into an account suspension decision', () => {
    expect(
      decideLifecycleSignalRevocation({
        signalType: 'scim_active_false',
        targetType: 'account',
        targetId: 'account-1',
      })
    ).toEqual({
      decision: 'suspend_account',
      reasonCodes: [LIFECYCLE_SIGNAL_REASON_CODES.scimActiveFalse],
    });
  });

  it('does not silently revoke protected manual assignment', () => {
    expect(
      decideLifecycleSignalRevocation({
        signalType: 'scim_group_removed',
        targetType: 'group_membership',
        targetId: 'membership-1',
        now: 1000,
        ownership: {
          assignmentType: 'group_membership',
          assignmentId: 'membership-1',
          ownershipPolicy: 'manual',
          revokePolicy: 'auto',
          protectedUntil: 2000,
        },
      })
    ).toEqual({
      decision: 'review',
      reasonCodes: [
        LIFECYCLE_SIGNAL_REASON_CODES.scimGroupRemoved,
        LIFECYCLE_SIGNAL_REASON_CODES.protectedAssignment,
      ],
    });
  });

  it('allows source-owned automated revocation for CSV diff and claim disappearance signals', () => {
    for (const signalType of ['csv_diff_removed', 'claim_disappeared'] as const) {
      expect(
        decideLifecycleSignalRevocation({
          signalType,
          targetType: 'entitlement',
          targetId: 'entitlement-1',
          ownership: {
            assignmentType: 'entitlement',
            assignmentId: 'entitlement-1',
            ownershipPolicy: 'source_owned',
            revokePolicy: 'auto',
          },
        })
      ).toMatchObject({
        decision: 'revoke',
        reasonCodes: expect.arrayContaining([LIFECYCLE_SIGNAL_REASON_CODES.sourceOwnedAuto]),
      });
    }
  });
});
