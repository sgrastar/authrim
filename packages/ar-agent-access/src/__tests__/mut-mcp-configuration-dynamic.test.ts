import { describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '../core';
import type { AgentConfigurationResourceSubject } from '../platform/ports';
import {
  ADMIN_CONFIGURATION_PROMPTS,
  ADMIN_CONFIGURATION_RESOURCE_TEMPLATES,
  createAdminConfigurationResourceTemplates,
} from '../protocol/mcp/admin-configuration-context';
import { makeContext } from './helpers/mut-mcp-harness';

const context = makeContext({ actor: { sub: 'client:abc', clientId: 'abc' } });
const subject: AgentConfigurationResourceSubject = {
  tenantId: 'tenant-1',
  grantId: 'grant-1',
  grantGeneration: 4,
  consentVersion: 3,
  actorSub: 'client:abc',
  clientId: 'abc',
};

function templates(values: { summary?: JsonObject | null; plan?: JsonObject | null } = {}) {
  const readTenantSummary = vi.fn(async () =>
    values.summary === undefined ? { ok: 'summary' } : values.summary
  );
  const readPlan = vi.fn(async () => (values.plan === undefined ? { ok: 'plan' } : values.plan));
  const list = createAdminConfigurationResourceTemplates({ readTenantSummary, readPlan });
  return { list, summary: list[2], plan: list[3], readTenantSummary, readPlan };
}

describe('dynamic configuration resource templates', () => {
  it('appends tenant summary and plan templates after the static templates', () => {
    const { list } = templates();
    expect(Object.isFrozen(list)).toBe(true);
    expect(list.slice(0, 2)).toEqual([...ADMIN_CONFIGURATION_RESOURCE_TEMPLATES]);
    expect(
      list
        .slice(2)
        .map(({ uriTemplate, name, title, description, mimeType, authorizationTool }) => ({
          uriTemplate,
          name,
          title,
          description,
          mimeType,
          auth: authorizationTool.id,
        }))
    ).toEqual([
      {
        uriTemplate: 'authrim://tenants/{tenant_id}/configuration-summary/v1',
        name: 'authrim_tenant_configuration_summary_v1',
        title: 'Authrim tenant configuration summary',
        description: 'Read an authorized tenant configuration summary without credential values.',
        mimeType: 'application/json',
        auth: 'admin.read.configuration.capabilities',
      },
      {
        uriTemplate: 'authrim://plans/{plan_id}/v1',
        name: 'authrim_configuration_plan_v1',
        title: 'Authrim configuration Plan',
        description: 'Read one immutable Plan owned by the current Grant and actor context.',
        mimeType: 'application/json',
        auth: 'admin.read.configuration.capabilities',
      },
    ]);
  });

  it('targets the tenant named in the URI so authorization can refuse other tenants', () => {
    const { summary } = templates();
    expect(summary.match(context, 'authrim://tenants/tenant-2/configuration-summary/v1')).toEqual({
      tenantId: 'tenant-2',
      domain: 'configuration',
      quantity: 1,
    });
  });

  it.each([
    'xauthrim://tenants/t/configuration-summary/v1',
    'authrim://tenants/t/configuration-summary/v1/extra',
    'authrim://tenants/t/x/configuration-summary/v1',
    'authrim://tenants//configuration-summary/v1',
  ])('rejects malformed tenant summary URI %s', async (uri) => {
    const { summary, readTenantSummary } = templates();
    expect(summary.match(context, uri)).toBeNull();
    await expect(summary.read(context, uri)).rejects.toThrow(`Unknown MCP resource: ${uri}`);
    expect(readTenantSummary).not.toHaveBeenCalled();
  });

  it('reads the summary for the URI tenant with the caller subject', async () => {
    const { summary, readTenantSummary } = templates();
    const uri = 'authrim://tenants/tenant-2/configuration-summary/v1';
    expect(await summary.read(context, uri)).toEqual({
      uri,
      mimeType: 'application/json',
      text: '{"ok":"summary"}',
    });
    expect(readTenantSummary).toHaveBeenCalledWith({ ...subject, tenantId: 'tenant-2' });
  });

  it('treats a missing summary as access denied', async () => {
    const { summary } = templates({ summary: null });
    await expect(
      summary.read(context, 'authrim://tenants/tenant-1/configuration-summary/v1')
    ).rejects.toThrow(new TypeError('MCP resource access denied'));
  });

  it('binds plan reads to the grant tenant and the current subject', async () => {
    const { plan, readPlan } = templates();
    expect(plan.match(context, 'authrim://plans/plan-1/v1')).toEqual({
      tenantId: 'tenant-1',
      domain: 'configuration',
      resourceId: 'plan-1',
      quantity: 1,
    });
    expect(await plan.read(context, 'authrim://plans/plan-1/v1')).toEqual({
      uri: 'authrim://plans/plan-1/v1',
      mimeType: 'application/json',
      text: '{"ok":"plan"}',
    });
    expect(readPlan).toHaveBeenCalledWith(subject, 'plan-1');
  });

  it.each(['xauthrim://plans/p/v1', 'authrim://plans/p/v1x', 'authrim://plans/a/b/v1'])(
    'rejects malformed plan URI %s',
    async (uri) => {
      const { plan, readPlan } = templates();
      expect(plan.match(context, uri)).toBeNull();
      await expect(plan.read(context, uri)).rejects.toThrow(`Unknown MCP resource: ${uri}`);
      expect(readPlan).not.toHaveBeenCalled();
    }
  );

  it('treats a plan owned by someone else as access denied', async () => {
    const { plan } = templates({ plan: null });
    await expect(plan.read(context, 'authrim://plans/plan-9/v1')).rejects.toThrow(
      new TypeError('MCP resource access denied')
    );
  });
});

describe('configuration guidance prompts', () => {
  it('publishes four goal-driven prompts behind the capability tool', () => {
    expect(
      ADMIN_CONFIGURATION_PROMPTS.map((prompt) => ({
        name: prompt.name,
        title: prompt.title,
        description: prompt.description,
        arguments: prompt.arguments,
        auth: prompt.authorizationTool.id,
      }))
    ).toEqual(
      [
        [
          'diagnose_auth_configuration_v1',
          'Diagnose Authrim configuration',
          'Collect evidence and propose a version-bound remediation Plan.',
        ],
        [
          'design_oidc_integration_v1',
          'Design OIDC integration',
          'Design an OIDC/OAuth integration using supported Authrim contracts.',
        ],
        [
          'design_saml_integration_v1',
          'Design SAML integration',
          'Design a SAML federation integration without requiring SP-side Agent changes.',
        ],
        [
          'review_auth_config_plan_v1',
          'Review authentication configuration Plan',
          'Review Plan diff, preconditions, risk, and rollback evidence before apply.',
        ],
      ].map(([name, title, description]) => ({
        name,
        title,
        description,
        arguments: [
          { name: 'goal', description: 'Desired authentication outcome', required: true },
        ],
        auth: 'admin.read.configuration.capabilities',
      }))
    );
  });

  it.each([
    [
      0,
      'Diagnose the current Authrim configuration and explain evidence before proposing changes.',
    ],
    [1, 'Design an OIDC/OAuth integration and produce a validated configuration Plan.'],
    [2, 'Design a SAML federation integration and identify any human-owned trust inputs.'],
    [
      3,
      'Review the immutable Plan, its diff, scope, risk classification, and verification checks.',
    ],
  ])('renders prompt %i with the goal and the no-secrets guard', async (index, text) => {
    const prompt = ADMIN_CONFIGURATION_PROMPTS[index];
    const result = await prompt.get(context, { goal: 'SSO for app' });
    expect(result).toEqual({
      description: prompt.description,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `${text}\nGoal: SSO for app\nUse read and validation tools first. Do not request or emit raw secrets. Treat this prompt only as guidance; authorization is enforced by the server.`,
          },
        },
      ],
    });
  });

  it('renders an empty goal when none is supplied', async () => {
    const result = await ADMIN_CONFIGURATION_PROMPTS[0].get(context, {});
    expect(result.messages[0]?.content.text).toContain('\nGoal: \nUse read');
  });
});
