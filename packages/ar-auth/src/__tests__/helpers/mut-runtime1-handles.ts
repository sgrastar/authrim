/** The start of a Flow whose method selector step is read for its output handles (mut-runtime1-auth-*). */
import { expect, vi } from 'vitest';
import type { FlowRuntimeContract } from '@authrim/ar-lib-core';
import { loginRuntimeInteractionStartHandler } from '../../login-runtime-flow';
import {
  assignmentRow,
  contractStep,
  createContext,
  loginRuntime,
  mocks,
  readJson,
  versionRow,
} from './mut-runtime1-harness';

export const registrationRuntime: FlowRuntimeContract = {
  flow_kind: 'registration',
  ui: {
    steps: [
      {
        id: 'auth:step',
        source_node_id: 'auth',
        component: 'registration_method_selector',
        render: true,
      },
      { id: 'complete:step', source_node_id: 'complete', component: 'completion', render: true },
    ],
  },
};

export function settingsOf(methods: Record<string, unknown>) {
  return {
    get: vi.fn(async (key: string) =>
      key === 'settings:tenant:tenant_test:authentication-methods' ? JSON.stringify(methods) : null
    ),
  };
}

export interface HandlesInput {
  methods?: Record<string, unknown>;
  runtime?: FlowRuntimeContract;
  editor?: Record<string, unknown> | null;
  externalIdp?: { fetch: ReturnType<typeof vi.fn> };
  headers?: Record<string, string>;
  url?: string;
}

export async function handlesOf(input: HandlesInput = {}): Promise<unknown> {
  const runtime = input.runtime ?? loginRuntime;
  mocks.coreAdapter.queryOne
    .mockResolvedValueOnce(assignmentRow({ flow_kind: runtime.flow_kind }))
    .mockResolvedValueOnce(versionRow(runtime, input.editor ?? null));
  const response = await loginRuntimeInteractionStartHandler(
    createContext({
      body: { flow_kind: runtime.flow_kind },
      env: {
        ...(input.methods ? { SETTINGS: settingsOf(input.methods) } : {}),
        ...(input.externalIdp ? { EXTERNAL_IDP: input.externalIdp } : {}),
      },
      headers: input.headers,
      url: input.url,
    })
  );
  const data = await readJson(response);
  expect(response.status).toBe(200);
  const step = contractStep(data, 'auth:step');
  const handles = (step?.config as Record<string, unknown>).output_handles;
  expect((step?.content as Record<string, unknown>).authentication_profile).toEqual({
    id: 'default',
    output_handles: handles,
  });
  return handles;
}

export function providersIdp(providers: unknown, init: ResponseInit = { status: 200 }) {
  return {
    fetch: vi.fn(
      async (_url: string, _init: { headers: Record<string, string> }) =>
        new Response(JSON.stringify({ providers }), init)
    ),
  };
}

export const none = {
  'authentication-methods.email_otp.enabled': false,
  'authentication-methods.passkey.enabled': false,
};
