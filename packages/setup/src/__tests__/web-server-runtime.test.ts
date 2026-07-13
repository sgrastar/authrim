import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const serveMock = vi.hoisted(() => vi.fn());
vi.mock('@hono/node-server', () => ({ serve: serveMock }));
vi.mock('node:net', () => ({
  createServer: () => {
    const listeners = new Map<string, () => void>();
    return {
      once: (event: string, listener: () => void) => {
        listeners.set(event, listener);
      },
      listen: () => listeners.get('listening')?.(),
      close: () => {},
    };
  },
}));

import { getSessionToken } from '../web/api.js';
import { startWebServer } from '../web/server.js';

describe('setup web server runtime boundaries', () => {
  beforeEach(() => {
    serveMock.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'on').mockImplementation((() => process) as typeof process.on);
  });

  afterEach(() => vi.restoreAllMocks());

  it('serves localized UI, health, translations, and safe font failures on loopback', async () => {
    await startWebServer({
      host: '127.0.0.1',
      port: 45_600,
      openBrowser: false,
      manageOnly: true,
      lang: 'ja',
    });
    expect(serveMock).toHaveBeenCalledOnce();
    const { fetch, port, hostname } = serveMock.mock.calls[0][0];
    expect({ port, hostname }).toEqual({ port: 45_600, hostname: '127.0.0.1' });

    expect((await fetch(new Request('http://localhost:45600/health'))).status).toBe(200);
    const root = await fetch(new Request('http://localhost:45600/?lang=ja'));
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('<!DOCTYPE html>');
    expect(
      (await fetch(new Request('http://localhost:45600/api/translations/not-a-locale'))).status
    ).toBe(400);
    const translations = await fetch(new Request('http://localhost:45600/api/translations/en'));
    expect(translations.status).toBe(200);
    await expect(translations.json()).resolves.toMatchObject({ locale: 'en' });
    expect(
      (await fetch(new Request('http://localhost:45600/assets/fonts/../secret.txt'))).status
    ).toBe(404);
    expect(
      (await fetch(new Request('http://localhost:45600/assets/fonts/missing.woff2'))).status
    ).toBe(404);
  });

  it('requires the capability token when bound for WSL/LAN access', async () => {
    await startWebServer({ host: '0.0.0.0', port: 45_610, openBrowser: false });
    const { fetch } = serveMock.mock.calls[0][0];

    const unauthorized = await fetch(new Request('http://localhost:45610/'));
    expect(unauthorized.status).toBe(401);
    const authorized = await fetch(
      new Request(`http://localhost:45610/?setup_token=${getSessionToken()}`, {
        headers: { 'Accept-Language': 'en-US,en;q=0.9' },
      })
    );
    expect(authorized.status).toBe(200);

    const allowedCors = await fetch(
      new Request('http://localhost:45610/api/state', {
        headers: { Origin: 'http://localhost:45610' },
      })
    );
    expect(allowedCors.headers.get('access-control-allow-origin')).toBe('http://localhost:45610');
    const deniedCors = await fetch(
      new Request('http://localhost:45610/api/state', {
        headers: { Origin: 'http://192.0.2.1:45610' },
      })
    );
    expect(deniedCors.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('uses default loopback and locale behavior when optional settings are omitted', async () => {
    await startWebServer({ port: 45_620, openBrowser: false });
    const { fetch, hostname } = serveMock.mock.calls[0][0];
    expect(hostname).toBe('localhost');

    const root = await fetch(
      new Request('http://localhost:45620/?lang=unsupported', {
        headers: { 'Accept-Language': 'ja-JP' },
      })
    );
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('<!DOCTYPE html>');
  });
});
