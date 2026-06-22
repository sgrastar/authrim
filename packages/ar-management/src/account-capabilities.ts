import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { requireAccountSession } from './account-page';

type AccountCapabilityStatus = 'available' | 'planned';

type AccountCapability = {
  id: string;
  status: AccountCapabilityStatus;
  requires_reauth: boolean;
  planned_phase?: string;
};

const CAPABILITIES: AccountCapability[] = [
  {
    id: 'profile.name',
    status: 'available',
    requires_reauth: false,
  },
  {
    id: 'sessions.manage',
    status: 'available',
    requires_reauth: false,
  },
  {
    id: 'passkeys.manage',
    status: 'available',
    requires_reauth: true,
  },
  {
    id: 'email.change',
    status: 'planned',
    requires_reauth: true,
    planned_phase: '4E-1',
  },
  {
    id: 'account.deletion',
    status: 'planned',
    requires_reauth: true,
    planned_phase: '4E-2',
  },
  {
    id: 'social_accounts.manage',
    status: 'planned',
    requires_reauth: true,
    planned_phase: '4E-3',
  },
  {
    id: 'rp_sessions.manage',
    status: 'planned',
    requires_reauth: false,
    planned_phase: '4E-4',
  },
  {
    id: 'theme.customize',
    status: 'planned',
    requires_reauth: false,
    planned_phase: '4E-5',
  },
];

const SECTIONS = [
  {
    id: 'profile',
    status: 'available',
    capabilities: ['profile.name'],
  },
  {
    id: 'security',
    status: 'available',
    capabilities: ['sessions.manage', 'passkeys.manage'],
  },
  {
    id: 'connections',
    status: 'planned',
    capabilities: ['social_accounts.manage'],
  },
  {
    id: 'danger',
    status: 'planned',
    capabilities: ['account.deletion'],
  },
] as const;

export async function getAccountCapabilitiesHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');

  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) {
    return accountSession;
  }

  return c.json({
    capabilities: CAPABILITIES,
    sections: SECTIONS,
    theme: {
      version: 1,
      scope: 'login-ui',
      source: 'default',
      account_page_overrides_supported: false,
      planned_tokens: ['logo', 'brand_name', 'colors', 'radius', 'font', 'page_overrides'],
    },
  });
}
