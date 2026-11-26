import { describe, expect, it, vi } from 'vitest';
import { deliverHttpSinkBatch } from '@authrim/ar-lib-logging/delivery';
import { isInternalUrl } from '../url-security';

/**
 * The HTTP sink (ar-lib-logging) keeps its own IPv4 block table because ar-lib-logging cannot
 * import ar-lib-core (core depends on logging). This test pins the two tables to each other so
 * they cannot drift again (the sink used to block 192.0.0.0/16, 198.51.0.0/16 and 203.0.0.0/16).
 */
async function sinkBlocks(address: string): Promise<boolean> {
  const fetcher = vi.fn(async () => new Response('', { status: 200 }));
  try {
    await deliverHttpSinkBatch({
      endpointUrl: `https://${address}/logs`,
      body: '{}',
      fetcher,
    });
  } catch (error) {
    expect((error as Error).message).toBe('http_sink_url_private_network_blocked');
    // A blocked address must never reach the fetcher.
    expect(fetcher).toHaveBeenCalledTimes(0);
    return true;
  }
  // An allowed address must actually be delivered exactly once (a silent no-op must not pass).
  expect(fetcher).toHaveBeenCalledTimes(1);
  return false;
}

const BOUNDARY_ADDRESSES = [
  '0.0.0.0',
  '0.255.255.255',
  '1.0.0.0',
  '9.255.255.255',
  '10.0.0.0',
  '10.255.255.255',
  '11.0.0.0',
  '100.63.255.255',
  '100.64.0.0',
  '100.127.255.255',
  '100.128.0.0',
  '126.255.255.255',
  '127.0.0.1',
  '128.0.0.0',
  '168.63.129.15',
  '168.63.129.16',
  '168.63.129.17',
  '169.253.255.255',
  '169.254.0.0',
  '169.254.255.255',
  '169.255.0.0',
  '172.15.255.255',
  '172.16.0.0',
  '172.31.255.255',
  '172.32.0.0',
  '192.0.0.1',
  '192.0.1.255',
  '192.0.2.0',
  '192.0.2.255',
  '192.0.3.0',
  '192.0.255.255',
  '192.167.255.255',
  '192.168.0.0',
  '192.168.255.255',
  '192.169.0.0',
  '198.17.255.255',
  '198.18.0.0',
  '198.19.255.255',
  '198.20.0.0',
  '198.51.0.0',
  '198.51.99.255',
  '198.51.100.0',
  '198.51.100.255',
  '198.51.101.0',
  '198.51.255.255',
  '203.0.0.0',
  '203.0.112.255',
  '203.0.113.0',
  '203.0.113.255',
  '203.0.114.0',
  '203.0.255.255',
  '223.255.255.255',
  '224.0.0.0',
  '255.255.255.255',
];

describe('HTTP sink and url-security IPv4 block ranges agree', () => {
  it.each(BOUNDARY_ADDRESSES)('%s is blocked identically', async (address) => {
    expect(await sinkBlocks(address)).toBe(isInternalUrl(`https://${address}/logs`));
  });

  it('blocks only the documentation /24s in both implementations', async () => {
    for (const address of ['192.0.2.0', '192.0.2.255', '198.51.100.0', '203.0.113.255']) {
      expect(isInternalUrl(`https://${address}/`)).toBe(true);
      expect(await sinkBlocks(address)).toBe(true);
    }
    for (const address of ['192.0.1.255', '192.0.3.0', '198.51.99.255', '203.0.114.0']) {
      expect(isInternalUrl(`https://${address}/`)).toBe(false);
      expect(await sinkBlocks(address)).toBe(false);
    }
  });
});
