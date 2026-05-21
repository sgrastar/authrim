/**
 * human-basic Login Flow - built-in definition
 *
 * Works without Admin UIbuilt-in flow.
 * Start → Identifier → AuthMethod → Complete minimal structure.
 *
 * @see /private/docs/track-c-flow-engine-design.md
 */

import type { GraphDefinition } from '../types';

// =============================================================================
// human-basic Login Flow
// =============================================================================

/**
 * human-basic Login Flow
 *
 * Basic login flow (Passkey / Email Code)
 * Works in headless operation without Admin UI.
 */
export const HUMAN_BASIC_LOGIN_FLOW: GraphDefinition = {
  id: 'human-basic-login',
  flowVersion: '1.0.0',
  name: 'Human Basic Login',
  description: '基本的なログインフロー（Passkey / Email Code）',
  profileId: 'human-basic',

  nodes: [
    // Start Node
    {
      id: 'start',
      type: 'start',
      position: { x: 250, y: 50 },
      data: {
        label: 'Start',
        intent: 'identify_user',
        capabilities: [],
        config: {},
      },
    },

    // Identifier Node (Emailinput)
    {
      id: 'identifier',
      type: 'identifier',
      position: { x: 250, y: 150 },
      data: {
        label: 'Enter Email',
        intent: 'identify_user',
        capabilities: [
          {
            type: 'collect_identifier',
            idSuffix: 'email',
            required: true,
            hintsTemplate: {
              inputType: 'email',
              label: 'Email address',
              autoComplete: 'email',
              autoFocus: true,
            },
            validationRules: [
              { type: 'required', message: 'Email is required' },
              { type: 'email', message: 'Please enter a valid email' },
            ],
          },
        ],
        config: {},
      },
    },

    // Auth Method Node (authentication method selection)
    {
      id: 'auth_method',
      type: 'auth_method',
      position: { x: 250, y: 250 },
      data: {
        label: 'Authenticate',
        intent: 'authenticate_user',
        capabilities: [
          // Passkey authentication (prefer)
          {
            type: 'verify_possession',
            idSuffix: 'passkey',
            required: false,
            hintsTemplate: {
              webauthn: {
                mode: 'authenticate',
                discoverable: true,
                userVerification: 'preferred',
              },
            },
          },
          // Email Code authentication (fallback)
          {
            type: 'collect_secret',
            idSuffix: 'email_code',
            required: false,
            hintsTemplate: {
              inputType: 'otp',
              maxLength: 6,
              label: 'Verification code',
              helpText: 'Enter the 6-digit code sent to your email',
            },
          },
        ],
        config: {
          preferredMethod: 'passkey',
          fallbackMethod: 'email_code',
        },
      },
    },

    // Complete Node (flow completion)
    {
      id: 'complete',
      type: 'end',
      position: { x: 250, y: 350 },
      data: {
        label: 'Complete',
        intent: 'complete_flow',
        capabilities: [
          {
            type: 'redirect',
            idSuffix: 'callback',
            required: true,
          },
        ],
        config: {},
      },
    },

    // Error Node (error handling)
    {
      id: 'error',
      type: 'error',
      position: { x: 450, y: 250 },
      data: {
        label: 'Error',
        intent: 'handle_error',
        capabilities: [
          {
            type: 'display_info',
            idSuffix: 'error',
            required: true,
            hintsTemplate: {
              variant: 'error',
            },
          },
        ],
        config: {
          allowRetry: true,
        },
      },
    },
  ],

  edges: [
    // Start → Identifier
    {
      id: 'e_start_identifier',
      source: 'start',
      target: 'identifier',
      type: 'success',
    },

    // Identifier → AuthMethod (on success)
    {
      id: 'e_identifier_auth',
      source: 'identifier',
      target: 'auth_method',
      type: 'success',
    },

    // Identifier → Error (on error)
    {
      id: 'e_identifier_error',
      source: 'identifier',
      target: 'error',
      type: 'error',
    },

    // AuthMethod → Complete (on success)
    {
      id: 'e_auth_complete',
      source: 'auth_method',
      target: 'complete',
      type: 'success',
    },

    // AuthMethod → Error (on error)
    {
      id: 'e_auth_error',
      source: 'auth_method',
      target: 'error',
      type: 'error',
    },

    // Error → Identifier (retry)
    {
      id: 'e_error_retry',
      source: 'error',
      target: 'identifier',
      type: 'conditional',
      data: {
        label: 'Retry',
        condition: {
          type: 'custom',
          expression: 'allowRetry === true',
        },
      },
    },
  ],

  metadata: {
    createdAt: '2026-01-16T00:00:00Z',
    updatedAt: '2026-01-16T00:00:00Z',
    createdBy: 'system',
  },
};

// =============================================================================
// Builtin Flow Registry
// =============================================================================

/**
 * Map of built-in flows
 * Usable without Admin UI
 */
export const BUILTIN_FLOWS: Record<string, GraphDefinition> = {
  'human-basic-login': HUMAN_BASIC_LOGIN_FLOW,
};

/**
 * Get a built-in flow
 */
export function getBuiltinFlow(flowId: string): GraphDefinition | undefined {
  return BUILTIN_FLOWS[flowId];
}

/**
 * Get all built-in flow IDs
 */
export function getBuiltinFlowIds(): string[] {
  return Object.keys(BUILTIN_FLOWS);
}

// =============================================================================
// Export
// =============================================================================

export default HUMAN_BASIC_LOGIN_FLOW;
