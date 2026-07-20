import { describe, expect, it } from 'vitest';
import type { ConsentGateDecisionInput } from '../../types/consent-gates';
import { CONSENT_GATE_REASON_CODES, evaluateConsentGate } from '../consent-gate-decision';

const acceptedRequiredItem = {
  id: 'tos-a',
  required: true,
  acceptanceStatus: 'accepted' as const,
  actionRequired: false,
};

const pendingRequiredItem = {
  ...acceptedRequiredItem,
  acceptanceStatus: 'pending' as const,
  actionRequired: true,
};

function decisionInput(
  overrides: Partial<ConsentGateDecisionInput> = {}
): ConsentGateDecisionInput {
  return {
    gateKind: 'legal_document',
    protocol: 'direct',
    policyResolved: true,
    policyRequired: true,
    items: [acceptedRequiredItem],
    ...overrides,
  };
}

describe('evaluateConsentGate', () => {
  it.each([
    ['direct', 'legal_document'],
    ['oidc', 'legal_document'],
    ['saml', 'legal_document'],
    ['oidc', 'oidc_authorization'],
    ['saml', 'saml_attribute_release'],
  ] as const)('evaluates the applicable %s %s gate', (protocol, gateKind) => {
    expect(evaluateConsentGate(decisionInput({ protocol, gateKind }))).toMatchObject({
      action: 'skip',
      reasonCodes: expect.arrayContaining([CONSENT_GATE_REASON_CODES.satisfied]),
    });
  });

  it.each([
    ['direct', 'oidc_authorization'],
    ['direct', 'saml_attribute_release'],
    ['oidc', 'saml_attribute_release'],
    ['saml', 'oidc_authorization'],
  ] as const)('skips the inapplicable %s %s gate', (protocol, gateKind) => {
    expect(evaluateConsentGate(decisionInput({ protocol, gateKind }))).toEqual({
      action: 'skip',
      gateKind,
      reasonCodes: [CONSENT_GATE_REASON_CODES.notApplicable],
      forceInteraction: false,
      pendingItemIds: [],
    });
  });

  it.each([
    ['an empty item identifier', { items: [{ ...pendingRequiredItem, id: '' }] }],
    ['duplicate item identifiers', { items: [pendingRequiredItem, pendingRequiredItem] }],
    [
      'an empty release set hash',
      {
        gateKind: 'oidc_authorization' as const,
        protocol: 'oidc' as const,
        release: { mode: 'once' as const, currentSetHash: '', existingState: null },
      },
    ],
  ])('denies invalid decision input with %s', (_name, overrides) => {
    expect(evaluateConsentGate(decisionInput(overrides))).toMatchObject({
      action: 'deny',
      reasonCodes: [CONSENT_GATE_REASON_CODES.invalidInput],
    });
  });

  it('challenges only for pending required Legal Consent items', () => {
    expect(
      evaluateConsentGate(
        decisionInput({
          items: [
            pendingRequiredItem,
            {
              id: 'optional-marketing',
              required: false,
              acceptanceStatus: 'pending',
              actionRequired: true,
            },
          ],
        })
      )
    ).toMatchObject({
      action: 'challenge',
      pendingItemIds: ['tos-a'],
      forceInteraction: false,
    });
  });

  it('skips Legal Consent when every required item is accepted', () => {
    expect(
      evaluateConsentGate(
        decisionInput({
          items: [
            acceptedRequiredItem,
            {
              id: 'optional-marketing',
              required: false,
              acceptanceStatus: 'pending',
              actionRequired: true,
            },
          ],
        })
      )
    ).toMatchObject({ action: 'skip' });
  });

  it('fails closed for a pending required release item even if actionRequired is false', () => {
    expect(
      evaluateConsentGate(
        decisionInput({
          gateKind: 'oidc_authorization',
          protocol: 'oidc',
          items: [{ ...pendingRequiredItem, actionRequired: false }],
        })
      )
    ).toMatchObject({ action: 'challenge', pendingItemIds: ['tos-a'] });
  });

  it.each([
    ['missing', { mode: 'once', existingState: null }, CONSENT_GATE_REASON_CODES.releaseMissing],
    [
      'revoked',
      { mode: 'once', existingState: 'revoked' },
      CONSENT_GATE_REASON_CODES.releaseMissing,
    ],
    ['denied', { mode: 'once', existingState: 'denied' }, CONSENT_GATE_REASON_CODES.releaseMissing],
    [
      'expired',
      { mode: 'once', existingState: 'expired' },
      CONSENT_GATE_REASON_CODES.releaseMissing,
    ],
    [
      'every time',
      { mode: 'every_time', existingState: 'granted' },
      CONSENT_GATE_REASON_CODES.releaseEveryTime,
    ],
    [
      'changed set',
      {
        mode: 'until_attributes_change',
        existingState: 'granted',
        existingSetHash: 'sha256:old',
      },
      CONSENT_GATE_REASON_CODES.releaseSetChanged,
    ],
  ] as const)('challenges for %s release consent', (_name, release, reasonCode) => {
    expect(
      evaluateConsentGate(
        decisionInput({
          gateKind: 'saml_attribute_release',
          protocol: 'saml',
          items: [],
          release: { ...release, currentSetHash: 'sha256:current' },
        })
      )
    ).toMatchObject({
      action: 'challenge',
      reasonCodes: expect.arrayContaining([reasonCode]),
    });
  });

  it.each(['once', 'until_attributes_change'] as const)(
    'skips a satisfied %s release consent',
    (mode) => {
      expect(
        evaluateConsentGate(
          decisionInput({
            gateKind: 'oidc_authorization',
            protocol: 'oidc',
            items: [],
            release: {
              mode,
              currentSetHash: 'sha256:current',
              existingState: 'granted',
              existingSetHash: 'sha256:current',
            },
          })
        )
      ).toMatchObject({
        action: 'skip',
        reasonCodes: expect.arrayContaining([CONSENT_GATE_REASON_CODES.releaseSatisfied]),
      });
    }
  );

  it('forces only the OIDC Authorization Gate for prompt=consent', () => {
    expect(
      evaluateConsentGate(
        decisionInput({
          gateKind: 'oidc_authorization',
          protocol: 'oidc',
          oidcPrompt: 'consent',
          items: [acceptedRequiredItem],
        })
      )
    ).toMatchObject({
      action: 'challenge',
      forceInteraction: true,
      reasonCodes: expect.arrayContaining([CONSENT_GATE_REASON_CODES.promptConsentForced]),
    });

    expect(
      evaluateConsentGate(
        decisionInput({ protocol: 'oidc', oidcPrompt: 'consent', items: [acceptedRequiredItem] })
      )
    ).toMatchObject({ action: 'skip', forceInteraction: false });
  });

  it('returns consent_required instead of a challenge when prompt=none forbids interaction', () => {
    expect(
      evaluateConsentGate(
        decisionInput({
          gateKind: 'oidc_authorization',
          protocol: 'oidc',
          oidcPrompt: 'none',
          items: [pendingRequiredItem],
        })
      )
    ).toMatchObject({
      action: 'protocol_error',
      protocolError: { error: 'consent_required' },
      reasonCodes: expect.arrayContaining([
        CONSENT_GATE_REASON_CODES.promptNoneInteractionForbidden,
      ]),
    });
  });

  it('returns consent_required for release-only interaction with prompt=none', () => {
    expect(
      evaluateConsentGate(
        decisionInput({
          gateKind: 'oidc_authorization',
          protocol: 'oidc',
          oidcPrompt: 'none',
          items: [],
          release: {
            mode: 'once',
            currentSetHash: 'sha256:current',
            existingState: null,
          },
        })
      )
    ).toMatchObject({
      action: 'protocol_error',
      pendingItemIds: [],
      reasonCodes: [
        CONSENT_GATE_REASON_CODES.releaseMissing,
        CONSENT_GATE_REASON_CODES.promptNoneInteractionForbidden,
      ],
      protocolError: { error: 'consent_required' },
    });
  });

  it('skips a pending optional release item that requires no action', () => {
    expect(
      evaluateConsentGate(
        decisionInput({
          gateKind: 'oidc_authorization',
          protocol: 'oidc',
          items: [
            {
              id: 'optional-profile',
              required: false,
              acceptanceStatus: 'pending',
              actionRequired: false,
            },
          ],
        })
      )
    ).toMatchObject({ action: 'skip', pendingItemIds: [] });
  });

  it('challenges for a pending optional release item when Policy requires a decision', () => {
    expect(
      evaluateConsentGate(
        decisionInput({
          gateKind: 'oidc_authorization',
          protocol: 'oidc',
          items: [
            {
              id: 'optional-profile',
              required: false,
              acceptanceStatus: 'pending',
              actionRequired: true,
            },
          ],
        })
      )
    ).toMatchObject({ action: 'challenge', pendingItemIds: ['optional-profile'] });
  });

  it.each(['none consent', 'login none', 'none none', 'unknown'])(
    'rejects invalid OIDC prompt value %s',
    (oidcPrompt) => {
      expect(
        evaluateConsentGate(
          decisionInput({ protocol: 'oidc', gateKind: 'oidc_authorization', oidcPrompt })
        )
      ).toMatchObject({
        action: 'protocol_error',
        protocolError: { error: 'invalid_request' },
        reasonCodes: [CONSENT_GATE_REASON_CODES.promptInvalid],
      });
    }
  );

  it('does not treat an omitted prompt as prompt=none', () => {
    expect(
      evaluateConsentGate(
        decisionInput({
          gateKind: 'oidc_authorization',
          protocol: 'oidc',
          items: [pendingRequiredItem],
        })
      )
    ).toMatchObject({ action: 'challenge' });
  });

  it.each(['', 'login', 'select_account'])('%s does not force OIDC consent', (oidcPrompt) => {
    expect(
      evaluateConsentGate(
        decisionInput({
          gateKind: 'oidc_authorization',
          protocol: 'oidc',
          oidcPrompt,
          items: [acceptedRequiredItem],
        })
      )
    ).toMatchObject({ action: 'skip', forceInteraction: false });
  });

  it('ignores OIDC prompt syntax outside an OIDC request', () => {
    expect(evaluateConsentGate(decisionInput({ oidcPrompt: 'unknown' }))).toMatchObject({
      action: 'skip',
    });
  });

  it('denies when a required Policy cannot be resolved', () => {
    expect(
      evaluateConsentGate(decisionInput({ policyResolved: false, policyRequired: true, items: [] }))
    ).toMatchObject({
      action: 'deny',
      reasonCodes: [CONSENT_GATE_REASON_CODES.requiredPolicyMissing],
    });
  });

  it('skips when an optional Policy cannot be resolved', () => {
    expect(
      evaluateConsentGate(
        decisionInput({ policyResolved: false, policyRequired: false, items: [] })
      )
    ).toMatchObject({
      action: 'skip',
      reasonCodes: [CONSENT_GATE_REASON_CODES.optionalPolicyMissing],
    });
  });

  it.each([
    [{ policyOutcome: 'deny' as const }, CONSENT_GATE_REASON_CODES.policyDenied],
    [{ releaseAvailable: false }, CONSENT_GATE_REASON_CODES.releaseUnavailable],
  ])('denies a Policy or release failure', (overrides, reasonCode) => {
    expect(evaluateConsentGate(decisionInput(overrides))).toMatchObject({
      action: 'deny',
      reasonCodes: [reasonCode],
    });
  });
});
