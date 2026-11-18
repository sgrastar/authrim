import { beforeEach, describe, expect, it, vi } from 'vitest';

const { safeFetchJson } = vi.hoisted(() => ({ safeFetchJson: vi.fn() }));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  safeFetchJson,
}));

import { validatePairwiseClientMetadata } from '../pairwise-client-validation';

const SECTOR = 'https://sector.example/uris.json';

describe('validatePairwiseClientMetadata', () => {
  beforeEach(() => safeFetchJson.mockReset());

  it('accepts a public client and a pairwise client on one host (the port is not a host)', async () => {
    expect(
      await validatePairwiseClientMetadata({ redirectUris: ['https://a.example/cb'] })
    ).toBeNull();
    expect(
      await validatePairwiseClientMetadata({
        subjectType: 'pairwise',
        redirectUris: ['https://a.example/cb', 'https://a.example:8443/cb'],
      })
    ).toBeNull();
  });

  it('refuses a pairwise client on several hosts without a sector_identifier_uri', async () => {
    expect(
      await validatePairwiseClientMetadata({
        subjectType: 'pairwise',
        redirectUris: ['https://a.example/cb', 'https://b.example/cb'],
      })
    ).toMatchObject({ error: 'invalid_client_metadata' });
  });

  it('refuses a pairwise client with no redirect URI and no sector_identifier_uri, or an unusable sector URI', async () => {
    expect(
      await validatePairwiseClientMetadata({ subjectType: 'pairwise', redirectUris: [] })
    ).toMatchObject({ error: 'invalid_client_metadata' });
    expect(
      await validatePairwiseClientMetadata({
        subjectType: 'pairwise',
        redirectUris: ['https://a.example/cb'],
        sectorIdentifierUri: 'not a url',
      })
    ).toMatchObject({ error: 'invalid_client_metadata' });
    // A public client needs no sector.
    expect(await validatePairwiseClientMetadata({ redirectUris: [] })).toBeNull();
  });

  it('accepts empty redirects for a pairwise client with an explicit sector', async () => {
    safeFetchJson.mockResolvedValue([]);
    expect(
      await validatePairwiseClientMetadata({
        subjectType: 'pairwise',
        redirectUris: [],
        sectorIdentifierUri: SECTOR,
      })
    ).toBeNull();
    expect(safeFetchJson).toHaveBeenCalledOnce();
  });

  it('accepts a sector_identifier_uri that lists every redirect URI', async () => {
    safeFetchJson.mockResolvedValue(['https://a.example/cb', 'https://b.example/cb']);
    expect(
      await validatePairwiseClientMetadata({
        subjectType: 'pairwise',
        redirectUris: ['https://a.example/cb', 'https://b.example/cb'],
        sectorIdentifierUri: SECTOR,
      })
    ).toBeNull();
  });

  it('refuses a sector_identifier_uri that does not list a redirect URI, is not an array, or is not HTTPS', async () => {
    safeFetchJson.mockResolvedValue(['https://a.example/cb']);
    const base = {
      subjectType: 'pairwise',
      redirectUris: ['https://a.example/cb', 'https://b.example/cb'],
    };
    expect(
      await validatePairwiseClientMetadata({ ...base, sectorIdentifierUri: SECTOR })
    ).toMatchObject({ error: 'invalid_client_metadata' });
    safeFetchJson.mockResolvedValue({ not: 'an array' });
    expect(
      await validatePairwiseClientMetadata({ ...base, sectorIdentifierUri: SECTOR })
    ).toMatchObject({ error: 'invalid_client_metadata' });
    expect(
      await validatePairwiseClientMetadata({
        ...base,
        sectorIdentifierUri: 'http://sector.example/uris.json',
      })
    ).toMatchObject({ error: 'invalid_client_metadata' });
  });

  it('does not fetch when told the sector URI and the redirect URIs did not change', async () => {
    expect(
      await validatePairwiseClientMetadata({
        subjectType: 'pairwise',
        redirectUris: ['https://a.example/cb'],
        sectorIdentifierUri: SECTOR,
        checkSectorContent: false,
      })
    ).toBeNull();
    expect(safeFetchJson).not.toHaveBeenCalled();
  });
});
