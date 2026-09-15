import { describe, expect, it } from 'vitest';
import { classifyPublicAssetKey } from '../public-asset-contract';

describe('direct public asset backup namespaces', () => {
  it.each(['logo', 'background', 'panel-background', 'favicon', 'thumbnail'])(
    'classifies %s as settings independently of historical artifact selection',
    (kind) => {
      expect(
        classifyPublicAssetKey(`public/tenant-a/login-ui/${kind}/image.png`, 'tenant-a')
      ).toEqual({
        kind: 'asset',
        category: 'settings',
        tenantId: 'tenant-a',
        filename: 'image.png',
      });
    }
  );

  it('keeps user avatars separate from settings', () => {
    expect(classifyPublicAssetKey('avatars/tenant-a/users/photo.webp', 'tenant-a')).toEqual({
      kind: 'asset',
      category: 'users',
      tenantId: 'tenant-a',
      filename: 'photo.webp',
    });
  });

  it.each(['public/tenant-b/login-ui/logo/image.png', 'avatars/tenant-b/users/image.png'])(
    'does not include another tenant asset: %s',
    (key) => {
      expect(classifyPublicAssetKey(key, 'tenant-a')).toEqual({ kind: 'foreign_tenant' });
    }
  );

  it.each([
    'public/tenant-a/login-ui/unknown/image.png',
    'public/tenant-a/login-ui/logo/../../other.png',
    'avatars/tenant-a/users/%2fother.png',
    'avatars/tenant-a/users/photo.svg',
    'public/tenant-a/login-ui/logo/nested/image.png',
    'https://example.com/public/tenant-a/login-ui/logo/image.png',
    'public/tenant-a/login-ui/logo/image.png?download=1',
  ])('reports unsupported keys instead of normalizing or fetching them: %s', (key) => {
    expect(classifyPublicAssetKey(key, 'tenant-a')).toEqual({ kind: 'unsupported' });
  });
});
