/** Worker entry. Authrim-operated and tenant-independent: no binding to any tenant resource. */

import { createWalletProviderApp } from '../service/app';
import { buildConfig } from './config';
import { createD1DeviceRegistry } from './d1-device-registry';
import { createD1RateLimiter, purgeRateLimits } from './d1-rate-limiter';
import type { WalletProviderEnv } from './env';
import { consoleLogger } from './log-sink';
import { createSecretSigner } from './secret-signer';

const now = (): number => Math.floor(Date.now() / 1000);

export default {
  /** Scheduled cleanup of expired rate-limit counters. */
  async scheduled(_event: unknown, env: WalletProviderEnv): Promise<void> {
    await purgeRateLimits(env.DB, now());
  },

  async fetch(request: Request, env: WalletProviderEnv): Promise<Response> {
    const config = await buildConfig(env);
    if (!config) {
      return Response.json({ error: 'provider_unavailable' }, { status: 503 });
    }
    const app = createWalletProviderApp({
      config,
      now,
      sourceOf: (req) => req.headers.get('cf-connecting-ip') ?? 'unknown',
      logger: consoleLogger,
      ports: {
        registry: createD1DeviceRegistry(env.DB),
        signer: createSecretSigner({
          walletSecret: env.WALLET_ATTESTATION_SIGNER,
          keySecret: env.KEY_ATTESTATION_SIGNER,
          walletIntermediateSha256: env.WALLET_INTERMEDIATE_SHA256,
          keyIntermediateSha256: env.KEY_INTERMEDIATE_SHA256,
          now,
        }),
        rateLimiter: createD1RateLimiter(env.DB, now),
      },
    });
    return app.fetch(request);
  },
};
