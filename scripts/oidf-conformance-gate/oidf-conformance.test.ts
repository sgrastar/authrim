import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertPassingEvidence,
  collectProfileEvidence,
  isCertificationAcceptableEvidence,
  profilesForArgument,
} from './oidf-conformance';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubEvidenceEnvironment(profile: 'BASIC' | 'CONFIG' | 'DYNAMIC', planId: string): void {
  vi.stubEnv(`OIDF_CONFORMANCE_${profile}_PLAN_ID`, planId);
  vi.stubEnv(
    'OIDF_CONFORMANCE_EXPECTED_DISCOVERY_URL',
    'https://conformance.authrim.example/.well-known/openid-configuration'
  );
  vi.stubEnv('OIDF_CONFORMANCE_MIN_STARTED_AT', '2026-07-17T00:00:00.000Z');
}

function planResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planName: 'oidcc-basic-certification-test-plan',
    started: '2026-07-17T00:01:00.000Z',
    config: {
      server: {
        discoveryUrl: 'https://conformance.authrim.example/.well-known/openid-configuration',
      },
    },
    modules: [{ testModule: 'oidcc-server', instances: ['module-1'] }],
    ...overrides,
  };
}

describe('OIDF conformance evidence gate', () => {
  it('treats all as the three required Phase 2 profiles', () => {
    expect(profilesForArgument('all')).toEqual(['basic-op', 'config-op', 'dynamic-op']);
    expect(profilesForArgument('fapi-2')).toEqual(['fapi-2']);
    expect(() => profilesForArgument('unknown')).toThrow('Unknown conformance profile');
  });

  it('rejects a plan with any unexecuted module', async () => {
    stubEvidenceEnvironment('BASIC', 'plan-basic');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify(
            planResponse({
              modules: [
                { testModule: 'executed', instances: ['module-1'] },
                { testModule: 'missing', instances: [] },
              ],
            })
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );

    await expect(collectProfileEvidence('basic-op')).rejects.toThrow(
      'contains unexecuted modules: missing'
    );
  });

  it('rejects a plan ID from a different certification profile', async () => {
    stubEvidenceEnvironment('CONFIG', 'plan-basic-in-config-slot');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(planResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    await expect(collectProfileEvidence('config-op')).rejects.toThrow(
      'config-op requires oidcc-config-certification-test-plan'
    );
  });

  it('collects every module result using the configured bearer token', async () => {
    stubEvidenceEnvironment('BASIC', 'plan-basic');
    vi.stubEnv('OIDF_CONFORMANCE_API_TOKEN', 'test-token');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(planResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            planId: 'plan-basic',
            started: '2026-07-17T00:02:00.000Z',
            status: 'FINISHED',
            result: 'PASSED',
            testName: 'oidcc-server',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const evidence = await collectProfileEvidence('basic-op');

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      planId: 'plan-basic',
      moduleId: 'module-1',
      started: '2026-07-17T00:02:00.000Z',
      status: 'FINISHED',
      result: 'PASSED',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.certification.openid.net/api/plan/plan-basic',
      expect.objectContaining({
        headers: { Authorization: 'Bearer test-token' },
        redirect: 'error',
      })
    );
    expect(() => assertPassingEvidence(evidence)).not.toThrow();
  });

  it('rejects evidence created before the tested deployment', async () => {
    stubEvidenceEnvironment('BASIC', 'plan-basic');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(planResponse({ started: '2026-07-16T23:59:59.000Z' })), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    await expect(collectProfileEvidence('basic-op')).rejects.toThrow(
      'started before OIDF_CONFORMANCE_MIN_STARTED_AT'
    );
  });

  it('does not send the suite token to a non-origin or non-HTTPS base URL', async () => {
    stubEvidenceEnvironment('BASIC', 'plan-basic');
    vi.stubEnv('OIDF_CONFORMANCE_API_TOKEN', 'test-token');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    for (const value of [
      'http://www.certification.openid.net',
      'https://www.certification.openid.net/api',
      'https://user@example.test',
    ]) {
      vi.stubEnv('OIDF_CONFORMANCE_BASE_URL', value);
      await expect(collectProfileEvidence('basic-op')).rejects.toThrow(
        'must be an absolute HTTPS origin'
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects evidence for another issuer or an older deployment', async () => {
    stubEvidenceEnvironment('BASIC', 'plan-basic');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify(
            planResponse({
              started: '2026-07-16T23:59:59.000Z',
              config: {
                server: {
                  discoveryUrl: 'https://other.example/.well-known/openid-configuration',
                },
              },
            })
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );

    await expect(collectProfileEvidence('basic-op')).rejects.toThrow(
      'targets https://other.example/.well-known/openid-configuration'
    );
  });

  it('rejects a module that is not bound to the selected plan', async () => {
    stubEvidenceEnvironment('BASIC', 'plan-basic');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(planResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              planId: 'plan-other',
              started: '2026-07-17T00:02:00.000Z',
              status: 'FINISHED',
              result: 'PASSED',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
    );

    await expect(collectProfileEvidence('basic-op')).rejects.toThrow(
      'belongs to plan-other; expected plan plan-basic'
    );
  });

  it('rejects a module timestamp that predates its plan', async () => {
    stubEvidenceEnvironment('BASIC', 'plan-basic');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(planResponse()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              planId: 'plan-basic',
              started: '2026-07-17T00:00:30.000Z',
              status: 'FINISHED',
              result: 'PASSED',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
    );

    await expect(collectProfileEvidence('basic-op')).rejects.toThrow(
      'started before its plan plan-basic'
    );
  });

  it.each(['PASSED', 'WARNING', 'SKIPPED'])(
    'accepts a finished %s result allowed by the certification suite',
    (result) => {
      const entry = {
        profile: 'dynamic-op' as const,
        planId: 'plan-dynamic',
        planName: 'oidcc-dynamic-certification-test-plan',
        moduleName: 'dynamic-client-registration',
        moduleId: 'module-dynamic',
        started: '2026-07-17T00:02:00.000Z',
        status: 'FINISHED',
        result,
      };

      expect(isCertificationAcceptableEvidence(entry)).toBe(true);
      expect(() => assertPassingEvidence([entry])).not.toThrow();
    }
  );

  it('accepts a finished REVIEW result with an uploaded image', () => {
    const entry = {
      profile: 'basic-op' as const,
      planId: 'plan-basic',
      planName: 'oidcc-basic-certification-test-plan',
      moduleName: 'oidcc-prompt-login',
      moduleId: 'module-review',
      started: '2026-07-17T00:02:00.000Z',
      status: 'FINISHED',
      result: 'REVIEW',
      reviewEvidenceUploaded: true,
    };

    expect(isCertificationAcceptableEvidence(entry)).toBe(true);
    expect(() => assertPassingEvidence([entry])).not.toThrow();
  });

  it.each([
    ['WAITING', 'PASSED'],
    ['FINISHED', 'FAILED'],
    ['FINISHED', 'REVIEW'],
    ['FINISHED', null],
  ])('rejects status=%s result=%s evidence', (status, result) => {
    const entry = {
      profile: 'dynamic-op' as const,
      planId: 'plan-dynamic',
      planName: 'oidcc-dynamic-certification-test-plan',
      moduleName: 'dynamic-client-registration',
      moduleId: 'module-dynamic',
      started: '2026-07-17T00:02:00.000Z',
      status: status as string,
      result: result as string | null,
    };

    expect(isCertificationAcceptableEvidence(entry)).toBe(false);
    expect(() => assertPassingEvidence([entry])).toThrow(
      'OIDF conformance evidence is not passing'
    );
  });
});
