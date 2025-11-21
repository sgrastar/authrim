/**
 * Authrim OP-Async Worker
 * RFC 8628: OAuth 2.0 Device Authorization Grant
 *
 * Handles asynchronous authentication flows:
 * - Device Flow (RFC 8628)
 * - CIBA (Client Initiated Backchannel Authentication) - Future
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from '@authrim/shared';
import { deviceAuthorizationHandler } from './device-authorization';
import { deviceVerifyHandler } from './device-verify';
import { deviceVerifyApiHandler } from './device-verify-api';

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

export default app;
