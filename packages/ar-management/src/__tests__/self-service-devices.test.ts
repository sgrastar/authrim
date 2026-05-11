import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const {
  mockRepo,
  mockInstallationRepo,
  mockClientRepository,
  mockIntrospectTokenFromContext,
  mockGetTenantIdFromContext,
  mockCreateAuthContextFromHono,
} = vi.hoisted(() => {
  const repo = {
    findByUserId: vi.fn(),
    findByInstallationId: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
    revoke: vi.fn(),
  };
  const installationRepo = {
    ensureForDeviceSecret: vi.fn(),
    findById: vi.fn(),
    findByUserId: vi.fn(),
    updateDisplayName: vi.fn(),
    revoke: vi.fn(),
  };
  const clientRepository = {
    findByClientId: vi.fn(),
  };

  return {
    mockRepo: repo,
    mockInstallationRepo: installationRepo,
    mockClientRepository: clientRepository,
    mockIntrospectTokenFromContext: vi.fn(),
    mockGetTenantIdFromContext: vi.fn().mockReturnValue('default'),
    mockCreateAuthContextFromHono: vi.fn().mockReturnValue({
      coreAdapter: {},
      repositories: {
        client: clientRepository,
      },
    }),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    DeviceSecretRepository: vi.fn(function DeviceSecretRepositoryMock() {
      return mockRepo;
    }),
    DeviceInstallationRepository: vi.fn(function DeviceInstallationRepositoryMock() {
      return mockInstallationRepo;
    }),
    introspectTokenFromContext: mockIntrospectTokenFromContext,
    getDeviceSecretInstallationId: (device: { id: string; installation_id?: string }) =>
      device.installation_id ?? device.id,
    getTenantIdFromContext: mockGetTenantIdFromContext,
    createAuthContextFromHono: mockCreateAuthContextFromHono,
  };
});

import {
  listMyDevicesHandler,
  updateMyDeviceHandler,
  deleteMyDeviceHandler,
} from '../self-service-devices';

type MockContextOptions = {
  query?: Record<string, string | undefined>;
  params?: Record<string, string>;
  body?: unknown;
  env?: Partial<Env>;
};

function createMockContext(options: MockContextOptions = {}) {
  const headers = new Headers();
  return {
    env: {
      KEY_MANAGER_SECRET: 'cursor-secret',
      ...options.env,
    } as Env,
    req: {
      method: 'GET',
      url: 'https://op.example.com/me/devices',
      raw: new Request('https://op.example.com/me/devices', {
        headers: { Authorization: 'Bearer access-token' },
      }),
      header: (name: string) => (name === 'Authorization' ? 'Bearer access-token' : undefined),
      query: (name: string) => options.query?.[name],
      param: (name: string) => options.params?.[name] ?? '',
      json: vi.fn().mockResolvedValue(options.body),
    },
    header: (name: string, value: string) => {
      headers.set(name, value);
    },
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    get: vi.fn().mockReturnValue(undefined),
  } as any;
}

const accessClaims = {
  sub: 'user-001',
  client_id: 'native-client-001',
  sid: 'sid-current',
  authrim_installation_id: 'inst-current',
};

const currentDevice = {
  id: 'ds-current',
  installation_id: 'inst-current',
  tenant_id: 'default',
  client_id: 'native-client-001',
  user_id: 'user-001',
  session_id: 'sid-current',
  secret_hash: 'hash-current',
  device_platform: 'ios',
  created_at: 1_777_000_000_000,
  updated_at: 1_777_000_000_000,
  expires_at: 1_779_000_000_000,
  last_used_at: 1_778_000_000_000,
  use_count: 2,
  is_active: 1,
};

const otherDevice = {
  id: 'ds-other',
  installation_id: 'inst-other',
  tenant_id: 'default',
  client_id: 'native-client-001',
  user_id: 'user-001',
  session_id: 'sid-other',
  secret_hash: 'hash-other',
  device_name: 'Work Mac',
  device_platform: 'macos',
  created_at: 1_776_000_000_000,
  updated_at: 1_776_000_000_000,
  expires_at: 1_779_000_000_000,
  last_used_at: 1_777_000_000_000,
  use_count: 1,
  is_active: 1,
};

const currentInstallation = {
  id: 'inst-current',
  tenant_id: 'default',
  user_id: 'user-001',
  client_id: 'native-client-001',
  trust_group_id: 'tg-wallet',
  session_id: 'sid-current',
  display_name: '',
  device_platform: 'ios',
  created_at: 1_777_000_000_000,
  updated_at: 1_777_000_000_000,
  last_seen_at: 1_778_000_000_000,
  is_active: 1,
};

const targetInstallation = {
  id: 'inst-target',
  tenant_id: 'default',
  user_id: 'user-001',
  client_id: 'other-native-client',
  trust_group_id: 'tg-wallet',
  source_installation_id: 'inst-current',
  source_client_id: 'native-client-001',
  session_id: 'sid-current',
  display_name: 'Companion App',
  device_platform: 'ios',
  created_at: 1_777_500_000_000,
  updated_at: 1_777_500_000_000,
  last_seen_at: 1_777_500_000_000,
  is_active: 1,
};

describe('/me/devices handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIntrospectTokenFromContext.mockResolvedValue({
      valid: true,
      claims: accessClaims,
    });
    mockRepo.findByUserId.mockResolvedValue([otherDevice, currentDevice]);
    mockRepo.findByInstallationId.mockResolvedValue(currentDevice);
    mockRepo.findById.mockResolvedValue(currentDevice);
    mockRepo.update.mockResolvedValue({
      ...currentDevice,
      device_name: 'My iPhone',
    });
    mockRepo.revoke.mockResolvedValue(true);
    mockClientRepository.findByClientId.mockImplementation(
      async (clientId: string) =>
        ({
          'native-client-001': { client_id: 'native-client-001', client_name: 'Authrim Wallet' },
          'other-native-client': {
            client_id: 'other-native-client',
            client_name: 'Companion Native',
          },
        })[clientId] ?? null
    );
    mockInstallationRepo.ensureForDeviceSecret.mockResolvedValue(null);
    mockInstallationRepo.findById.mockResolvedValue(null);
    mockInstallationRepo.findByUserId.mockResolvedValue([]);
    mockInstallationRepo.updateDisplayName.mockResolvedValue(null);
    mockInstallationRepo.revoke.mockResolvedValue(false);
  });

  it('lists devices with current-first cursor pagination and canonical shape', async () => {
    const firstResponse = await listMyDevicesHandler(createMockContext({ query: { limit: '1' } }));
    const firstBody = (await firstResponse.json()) as {
      devices: Array<Record<string, unknown>>;
      next_cursor?: string;
    };

    expect(firstResponse.status).toBe(200);
    expect(firstBody.devices).toHaveLength(1);
    expect(firstBody.devices[0]).toMatchObject({
      id: 'inst-current',
      display_name: '',
      fallback_display_name: 'ios device',
      platform: 'ios',
      current: true,
      client_id: 'native-client-001',
      app_display_name: 'Authrim Wallet',
      last_seen_at: '2026-05-05T16:53:20Z',
      last_seen_at_unix: 1778000000,
    });
    expect(firstBody.next_cursor).toMatch(/^cur_/);

    const secondResponse = await listMyDevicesHandler(
      createMockContext({ query: { cursor: firstBody.next_cursor } })
    );
    const secondBody = (await secondResponse.json()) as {
      devices: Array<Record<string, unknown>>;
      next_cursor?: string;
    };

    expect(secondResponse.status).toBe(200);
    expect(secondBody.devices[0]).toMatchObject({
      id: 'inst-other',
      display_name: 'Work Mac',
      platform: 'macos',
      current: false,
      client_id: 'native-client-001',
      app_display_name: 'Authrim Wallet',
      last_seen_at: '2026-04-24T03:06:40Z',
      last_seen_at_unix: 1777000000,
    });
    expect(secondBody.devices[0].fallback_display_name).toBeUndefined();
    expect(secondBody.next_cursor).toBeUndefined();
  });

  it('lists canonical installations from the current trust_group', async () => {
    mockRepo.findByUserId.mockResolvedValue([]);
    mockInstallationRepo.findById.mockResolvedValue(currentInstallation);
    mockInstallationRepo.findByUserId.mockResolvedValue([targetInstallation, currentInstallation]);

    const response = await listMyDevicesHandler(createMockContext());
    const body = (await response.json()) as {
      devices: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(mockInstallationRepo.findByUserId).toHaveBeenCalledWith('user-001', 'default', {
      validOnly: true,
      trustGroupId: 'tg-wallet',
      clientId: undefined,
    });
    expect(body.devices.map((device) => device.id)).toEqual(['inst-current', 'inst-target']);
    expect(body.devices[1]).toMatchObject({
      id: 'inst-target',
      display_name: 'Companion App',
      platform: 'ios',
      current: false,
      client_id: 'other-native-client',
      app_display_name: 'Companion Native',
    });
  });

  it('omits unresolved app display names', async () => {
    mockRepo.findByUserId.mockResolvedValue([]);
    mockInstallationRepo.findById.mockResolvedValue(currentInstallation);
    mockInstallationRepo.findByUserId.mockResolvedValue([currentInstallation]);
    mockClientRepository.findByClientId.mockResolvedValue(null);

    const response = await listMyDevicesHandler(createMockContext());
    const body = (await response.json()) as {
      devices: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(body.devices[0]).toMatchObject({
      id: 'inst-current',
      client_id: 'native-client-001',
    });
    expect(body.devices[0].app_display_name).toBeUndefined();
  });

  it('rejects tampered cursors with invalid_cursor details', async () => {
    const response = await listMyDevicesHandler(
      createMockContext({ query: { cursor: 'cur_tampered.signature' } })
    );
    const body = (await response.json()) as {
      error: string;
      error_details?: { code?: string };
    };

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(body.error_details?.code).toBe('invalid_cursor');
  });

  it('caps list limit at 100', async () => {
    const manyDevices = Array.from({ length: 101 }, (_, index) => ({
      ...otherDevice,
      id: `ds-${index}`,
      installation_id: `inst-${index}`,
      session_id: `sid-${index}`,
      last_used_at: 1_777_000_000_000 + index,
    }));
    mockRepo.findByUserId.mockResolvedValue(manyDevices);

    const response = await listMyDevicesHandler(createMockContext({ query: { limit: '101' } }));
    const body = (await response.json()) as {
      devices: Array<Record<string, unknown>>;
      next_cursor?: string;
    };

    expect(response.status).toBe(200);
    expect(body.devices).toHaveLength(100);
    expect(body.next_cursor).toMatch(/^cur_/);
  });

  it('renames an owned device and returns canonical device shape', async () => {
    const response = await updateMyDeviceHandler(
      createMockContext({
        params: { id: 'inst-current' },
        body: { display_name: '  My   iPhone  ' },
      })
    );
    const body = (await response.json()) as { device: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(mockRepo.findByInstallationId).toHaveBeenCalledWith('inst-current');
    expect(mockRepo.update).toHaveBeenCalledWith(
      'ds-current',
      { device_name: 'My iPhone' },
      'default'
    );
    expect(body.device).toMatchObject({
      id: 'inst-current',
      display_name: 'My iPhone',
      platform: 'ios',
      current: true,
      client_id: 'native-client-001',
      app_display_name: 'Authrim Wallet',
    });
    expect(body.device.fallback_display_name).toBeUndefined();
  });

  it('rejects empty display names', async () => {
    const response = await updateMyDeviceHandler(
      createMockContext({
        params: { id: 'inst-current' },
        body: { display_name: '     ' },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: 'invalid_request',
      error_description: 'display_name must not be empty',
    });
  });

  it('rejects display names longer than 64 characters', async () => {
    const response = await updateMyDeviceHandler(
      createMockContext({
        params: { id: 'inst-current' },
        body: { display_name: 'a'.repeat(65) },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: 'invalid_request',
      error_description: 'display_name must not exceed 64 characters',
    });
  });

  it('unlinks an owned current device using the canonical response envelope', async () => {
    const response = await deleteMyDeviceHandler(
      createMockContext({ params: { id: 'inst-current' } })
    );
    const body = (await response.json()) as {
      ok: boolean;
      device_unlink_result: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(mockRepo.findByInstallationId).toHaveBeenCalledWith('inst-current');
    expect(mockRepo.revoke).toHaveBeenCalledWith('ds-current', 'device_unlink', 'default');
    expect(body).toEqual({
      ok: true,
      device_unlink_result: {
        action: 'device_unlinked',
        target_id: 'inst-current',
        signed_out_required: true,
        status: 'completed',
      },
    });
  });

  it('unlinks an owned non-current device without requiring sign-out', async () => {
    mockRepo.findByInstallationId.mockImplementation(async (installationId: string) =>
      installationId === 'inst-other' ? otherDevice : null
    );

    const response = await deleteMyDeviceHandler(
      createMockContext({ params: { id: 'inst-other' } })
    );
    const body = (await response.json()) as {
      ok: boolean;
      device_unlink_result: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(mockRepo.revoke).toHaveBeenCalledWith('ds-other', 'device_unlink', 'default');
    expect(body.device_unlink_result).toEqual({
      action: 'device_unlinked',
      target_id: 'inst-other',
      signed_out_required: false,
      status: 'completed',
    });
  });

  it('unlinks a canonical target-side installation without revoking the source device_secret', async () => {
    mockInstallationRepo.findById.mockResolvedValue(targetInstallation);
    mockInstallationRepo.revoke.mockResolvedValue(true);

    const response = await deleteMyDeviceHandler(
      createMockContext({ params: { id: 'inst-target' } })
    );
    const body = (await response.json()) as {
      ok: boolean;
      device_unlink_result: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(mockInstallationRepo.revoke).toHaveBeenCalledWith(
      'inst-target',
      'default',
      'device_unlink'
    );
    expect(mockRepo.revoke).not.toHaveBeenCalled();
    expect(body.device_unlink_result).toEqual({
      action: 'device_unlinked',
      target_id: 'inst-target',
      signed_out_required: false,
      status: 'completed',
    });
  });
});
