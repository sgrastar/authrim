/**
 * Authrim OP-Async Worker
 * RFC 8628: OAuth 2.0 Device Authorization Grant
 * OpenID Connect CIBA Flow Core 1.0
 *
 * Handles asynchronous authentication flows:
 * - Device Flow (RFC 8628)
 * - CIBA (Client Initiated Backchannel Authentication)
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from '@authrim/shared';
import { deviceAuthorizationHandler } from './device-authorization';
import { deviceVerifyHandler } from './device-verify';
import { deviceVerifyApiHandler } from './device-verify-api';
import { cibaAuthorizationHandler } from './ciba-authorization';

const app = new Hono<{ Bindings: Env }>();

// CORS middleware
app.use('/*', cors({
  origin: (origin) => origin, // Allow all origins for discovery
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

/**
 * POST /device_authorization
 * RFC 8628: Device Authorization Endpoint
 *
 * Request:
 *   POST /device_authorization
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   client_id=...&scope=...
 *
 * Response:
 *   {
 *     "device_code": "GmRhmhcxhwAzkoEqiMEg_DnyEysNkuNhszIySk9eS",
 *     "user_code": "WDJB-MJHT",
 *     "verification_uri": "https://auth.example.com/device",
 *     "verification_uri_complete": "https://auth.example.com/device?user_code=WDJB-MJHT",
 *     "expires_in": 600,
 *     "interval": 5
 *   }
 */
app.post('/device_authorization', deviceAuthorizationHandler);

/**
 * GET /device
 * Device verification UI (user-facing)
 *
 * Shows form for user to enter user_code
 */
app.get('/device', deviceVerifyHandler);

/**
 * POST /device
 * Device verification submission (user approves/denies)
 */
app.post('/device', deviceVerifyHandler);

/**
 * POST /api/device/verify
 * Headless JSON API for device verification
 *
 * Used by SvelteKit UI and custom WebSDK implementations
 */
app.post('/api/device/verify', deviceVerifyApiHandler);

/**
 * POST /bc-authorize
 * OpenID Connect CIBA: Backchannel Authentication Endpoint
 *
 * Request:
 *   POST /bc-authorize
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   scope=openid&client_id=...&login_hint=user@example.com&binding_message=...
 *
 * Response:
 *   {
 *     "auth_req_id": "1c266114-a1be-4252-8ad1-04986c5b9ac1",
 *     "expires_in": 300,
 *     "interval": 5
 *   }
 */
app.post('/bc-authorize', cibaAuthorizationHandler);

export default app;
