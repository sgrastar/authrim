import type {
  ConsentGateDecisionInput,
  ConsentGateDecisionItem,
  ConsentGateDecisionResult,
  ConsentGateProtocol,
} from '../types/consent-gates';

const OIDC_PROMPT_VALUES = new Set(['none', 'login', 'consent', 'select_account']);

export const CONSENT_GATE_REASON_CODES = {
  notApplicable: 'consent.gate.not_applicable',
  optionalPolicyMissing: 'consent.gate.policy_optional_missing',
  requiredPolicyMissing: 'consent.gate.policy_required_missing',
  policyDenied: 'consent.gate.policy_denied',
  releaseUnavailable: 'consent.gate.release_unavailable',
  invalidInput: 'consent.gate.invalid_input',
  satisfied: 'consent.gate.satisfied',
  interactionRequired: 'consent.gate.interaction_required',
  promptConsentForced: 'consent.gate.prompt_consent_forced',
  promptInvalid: 'consent.gate.prompt_invalid',
  promptNoneInteractionForbidden: 'consent.gate.prompt_none_interaction_forbidden',
  releaseMissing: 'consent.gate.release_missing',
  releaseEveryTime: 'consent.gate.release_every_time',
  releaseSetChanged: 'consent.gate.release_set_changed',
  releaseSatisfied: 'consent.gate.release_satisfied',
} as const;

interface ParsedOidcPrompt {
  values: Set<string>;
  invalid: boolean;
}

export function evaluateConsentGate(input: ConsentGateDecisionInput): ConsentGateDecisionResult {
  const base = {
    gateKind: input.gateKind,
    forceInteraction: false,
    pendingItemIds: [] as string[],
  };

  if (hasInvalidDecisionInput(input)) {
    return {
      ...base,
      action: 'deny',
      reasonCodes: [CONSENT_GATE_REASON_CODES.invalidInput],
    };
  }

  if (!isGateApplicable(input.gateKind, input.protocol)) {
    return {
      ...base,
      action: 'skip',
      reasonCodes: [CONSENT_GATE_REASON_CODES.notApplicable],
    };
  }

  const prompt = parseOidcPrompt(input.protocol, input.oidcPrompt);
  if (prompt.invalid) {
    return {
      ...base,
      action: 'protocol_error',
      reasonCodes: [CONSENT_GATE_REASON_CODES.promptInvalid],
      protocolError: {
        error: 'invalid_request',
        description: 'The OIDC prompt parameter is invalid',
      },
    };
  }

  if (!input.policyResolved) {
    if (input.policyRequired) {
      return {
        ...base,
        action: 'deny',
        reasonCodes: [CONSENT_GATE_REASON_CODES.requiredPolicyMissing],
      };
    }
    return {
      ...base,
      action: 'skip',
      reasonCodes: [CONSENT_GATE_REASON_CODES.optionalPolicyMissing],
    };
  }

  if (input.policyOutcome === 'deny') {
    return {
      ...base,
      action: 'deny',
      reasonCodes: [CONSENT_GATE_REASON_CODES.policyDenied],
    };
  }

  if (input.releaseAvailable === false) {
    return {
      ...base,
      action: 'deny',
      reasonCodes: [CONSENT_GATE_REASON_CODES.releaseUnavailable],
    };
  }

  const forceInteraction =
    input.protocol === 'oidc' &&
    input.gateKind === 'oidc_authorization' &&
    prompt.values.has('consent');
  const pendingItems = itemsRequiringInteraction(input.gateKind, input.items);
  const releaseReasons = evaluateReleaseState(input);
  const interactionRequired =
    forceInteraction || pendingItems.length > 0 || releaseReasons.interactionRequired;

  if (interactionRequired && prompt.values.has('none')) {
    return {
      ...base,
      action: 'protocol_error',
      forceInteraction,
      pendingItemIds: pendingItems.map((item) => item.id),
      reasonCodes: [
        ...releaseReasons.reasonCodes,
        ...(pendingItems.length > 0 ? [CONSENT_GATE_REASON_CODES.interactionRequired] : []),
        CONSENT_GATE_REASON_CODES.promptNoneInteractionForbidden,
      ],
      protocolError: {
        error: 'consent_required',
        description: 'Consent is required but prompt=none forbids user interaction',
      },
    };
  }

  if (interactionRequired) {
    return {
      ...base,
      action: 'challenge',
      forceInteraction,
      pendingItemIds: pendingItems.map((item) => item.id),
      reasonCodes: [
        ...(forceInteraction ? [CONSENT_GATE_REASON_CODES.promptConsentForced] : []),
        ...releaseReasons.reasonCodes,
        ...(pendingItems.length > 0 ? [CONSENT_GATE_REASON_CODES.interactionRequired] : []),
      ],
    };
  }

  return {
    ...base,
    action: 'skip',
    reasonCodes: [CONSENT_GATE_REASON_CODES.satisfied, ...releaseReasons.reasonCodes],
  };
}

function hasInvalidDecisionInput(input: ConsentGateDecisionInput): boolean {
  const itemIds = input.items.map((item) => item.id);
  if (itemIds.some((id) => id.trim() === '') || new Set(itemIds).size !== itemIds.length) {
    return true;
  }
  return input.release !== null && input.release !== undefined
    ? input.release.currentSetHash.trim() === ''
    : false;
}

function isGateApplicable(
  gateKind: ConsentGateDecisionInput['gateKind'],
  protocol: ConsentGateProtocol
): boolean {
  if (gateKind === 'legal_document') return true;
  if (gateKind === 'oidc_authorization') return protocol === 'oidc';
  return protocol === 'saml';
}

function parseOidcPrompt(protocol: ConsentGateProtocol, value: string | null | undefined) {
  if (protocol !== 'oidc' || value === null || value === undefined || value.trim() === '') {
    return { values: new Set<string>(), invalid: false } satisfies ParsedOidcPrompt;
  }

  const values = value.trim().split(/\s+/u);
  const uniqueValues = new Set(values);
  return {
    values: uniqueValues,
    invalid:
      values.some((promptValue) => !OIDC_PROMPT_VALUES.has(promptValue)) ||
      (uniqueValues.has('none') && values.length > 1),
  } satisfies ParsedOidcPrompt;
}

function itemsRequiringInteraction(
  gateKind: ConsentGateDecisionInput['gateKind'],
  items: ConsentGateDecisionItem[]
): ConsentGateDecisionItem[] {
  return items.filter((item) => {
    if (item.acceptanceStatus === 'accepted') return false;
    if (gateKind === 'legal_document') return item.required;
    return item.required || item.actionRequired;
  });
}

function evaluateReleaseState(input: ConsentGateDecisionInput): {
  interactionRequired: boolean;
  reasonCodes: string[];
} {
  const release = input.release;
  if (!release) return { interactionRequired: false, reasonCodes: [] };

  if (release.mode === 'every_time') {
    return {
      interactionRequired: true,
      reasonCodes: [CONSENT_GATE_REASON_CODES.releaseEveryTime],
    };
  }

  if (release.existingState !== 'granted') {
    return {
      interactionRequired: true,
      reasonCodes: [CONSENT_GATE_REASON_CODES.releaseMissing],
    };
  }

  if (
    release.mode === 'until_attributes_change' &&
    release.existingSetHash !== release.currentSetHash
  ) {
    return {
      interactionRequired: true,
      reasonCodes: [CONSENT_GATE_REASON_CODES.releaseSetChanged],
    };
  }

  return {
    interactionRequired: false,
    reasonCodes: [CONSENT_GATE_REASON_CODES.releaseSatisfied],
  };
}
