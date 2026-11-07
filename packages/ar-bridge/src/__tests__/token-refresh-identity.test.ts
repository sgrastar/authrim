import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinkedIdentity } from '../types';

const { mockLogger, mockGetProvider, mockUpdateLinkedIdentity, mockDecryptTokens, refreshTokens } =
  vi.hoisted(() => ({
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockGetProvider: vi.fn(),
    mockUpdateLinkedIdentity: vi.fn(),
    mockDecryptTokens: vi.fn(),
    refreshTokens: vi.fn(),
  }));

vi.mock('@authrim/ar-lib-core', () => ({
  createLogger: () => ({ module: () => mockLogger }),
  ensureAdminDatabaseAdapter: vi.fn(),
  ensureDatabaseAdapter: vi.fn(),
  getDefaultTenantId: vi.fn(),
  listEnvironmentTenantDefaultStores: vi.fn(),
  storeImmediateChunkedSensitiveDetailJson: vi.fn(),
}));
vi.mock('../services/provider-store', () => ({ getProvider: mockGetProvider }));
vi.mock('../services/linked-identity-store', () => ({
  updateLinkedIdentity: mockUpdateLinkedIdentity,
  decryptLinkedIdentityTokens: mockDecryptTokens,
}));
vi.mock('../clients/oidc-client', () => ({
  OIDCRPClient: { fromProvider: () => ({ refreshTokens }) },
}));
vi.mock('../utils/crypto', () => ({
  decrypt: vi.fn(async () => 'client-secret'),
  getEncryptionKeyOrUndefined: vi.fn(),
}));

import { refreshIdentityToken } from '../services/token-refresh';

const identity = {
  id: 'link-a',
  tenantId: 'tenant-a',
  providerId: 'google',
  refreshTokenEncrypted: 'enc-refresh-read',
} as LinkedIdentity;

describe('refreshing one linked identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProvider.mockResolvedValue({ clientSecretEncrypted: 'enc-secret' });
    mockDecryptTokens.mockResolvedValue({ refreshToken: 'refresh-plain' });
    refreshTokens.mockResolvedValue({ access_token: 'new-access', expires_in: 3600 });
  });

  it('saves the new tokens only over the refresh token it read', async () => {
    mockUpdateLinkedIdentity.mockResolvedValue(true);

    await expect(refreshIdentityToken({} as never, identity, 'key', {} as never)).resolves.toBe(
      true
    );
    expect(mockUpdateLinkedIdentity).toHaveBeenCalledWith(
      {},
      'tenant-a',
      'link-a',
      expect.objectContaining({
        tokens: { access_token: 'new-access', expires_in: 3600 },
        expectedRefreshTokenEncrypted: 'enc-refresh-read',
      }),
      {}
    );
  });

  it('reports a refresh not saved when the tokens were erased while the provider answered', async () => {
    // A PII deletion erased the tokens while the provider was being asked: the save matches no row.
    let answer!: (tokens: unknown) => void;
    refreshTokens.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    mockUpdateLinkedIdentity.mockResolvedValue(false);

    const refreshed = refreshIdentityToken({} as never, identity, 'key', {} as never);
    await Promise.resolve();
    answer({ access_token: 'late-access', refresh_token: 'rotated', expires_in: 3600 });

    await expect(refreshed).resolves.toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Refreshed external IdP token not saved: the link changed meanwhile'
    );
    expect(mockLogger.info).not.toHaveBeenCalledWith('Successfully refreshed external IdP token');
  });
});
