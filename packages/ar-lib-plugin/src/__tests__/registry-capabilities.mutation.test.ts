import { describe, expect, it, vi } from 'vitest';
import {
  CapabilityRegistry,
  globalRegistry,
  type AuthenticatorHandler,
  type IdPHandler,
} from '../core/registry';
import type { NotifierHandler, PluginCapability } from '../core/types';

const notifier = (send = vi.fn(async () => ({ success: true }))): NotifierHandler =>
  ({ send }) as unknown as NotifierHandler;
const idp = {} as IdPHandler;
const authenticator = {} as AuthenticatorHandler;
const cap = (value: string) => value as PluginCapability;

describe('CapabilityRegistry registration', () => {
  it('stores handlers per category and returns them', () => {
    const registry = new CapabilityRegistry();
    const mail = notifier();
    registry.registerNotifier('email', mail);
    registry.registerIdP('google', idp);
    registry.registerAuthenticator('totp', authenticator);
    expect(registry.getNotifier('email')).toBe(mail);
    expect(registry.getIdP('google')).toBe(idp);
    expect(registry.getAuthenticator('totp')).toBe(authenticator);
    expect(registry.getNotifier('sms')).toBeUndefined();
    expect(registry.getIdP('email')).toBeUndefined();
    expect(registry.getAuthenticator('email')).toBeUndefined();
  });

  it('refuses a second handler for the same key, naming the first owner when known', () => {
    const registry = new CapabilityRegistry();
    registry.registerNotifier('email', notifier(), 'plugin-a');
    expect(() => registry.registerNotifier('email', notifier(), 'plugin-b')).toThrow(
      "Notifier for channel 'email' already registered by plugin 'plugin-a'"
    );
    registry.registerIdP('google', idp, 'plugin-a');
    expect(() => registry.registerIdP('google', idp)).toThrow(
      "IdP 'google' already registered by plugin 'plugin-a'"
    );
    registry.registerAuthenticator('totp', authenticator);
    expect(() => registry.registerAuthenticator('totp', authenticator, 'plugin-b')).toThrow(
      /^Authenticator 'totp' already registered$/u
    );
  });

  it('keeps a failed registration from changing the owner', () => {
    const registry = new CapabilityRegistry();
    registry.registerNotifier('email', notifier(), 'plugin-a');
    expect(() => registry.registerNotifier('email', notifier(), 'plugin-b')).toThrow();
    expect(registry.getCapabilityOwner(cap('notifier.email'))).toBe('plugin-a');
  });

  it('allows the same key in different categories', () => {
    const registry = new CapabilityRegistry();
    registry.registerNotifier('x', notifier(), 'p1');
    registry.registerIdP('x', idp, 'p2');
    registry.registerAuthenticator('x', authenticator, 'p3');
    expect(registry.getCapabilityOwner(cap('notifier.x'))).toBe('p1');
    expect(registry.getCapabilityOwner(cap('idp.x'))).toBe('p2');
    expect(registry.getCapabilityOwner(cap('authenticator.x'))).toBe('p3');
  });

  it('has no owner for a handler registered without a plugin id', () => {
    const registry = new CapabilityRegistry();
    registry.registerNotifier('email', notifier());
    expect(registry.getCapabilityOwner(cap('notifier.email'))).toBeUndefined();
  });
});

describe('CapabilityRegistry notifications', () => {
  it('reports support from the handler, defaulting to everything', () => {
    const registry = new CapabilityRegistry();
    const supports = vi.fn((options: unknown) => (options as { rich?: boolean }).rich === true);
    registry.registerNotifier('limited', { ...notifier(), supports } as NotifierHandler);
    registry.registerNotifier('open', notifier());
    expect(registry.notifierSupports('limited', { rich: true } as never)).toBe(true);
    expect(registry.notifierSupports('limited', { rich: false } as never)).toBe(false);
    expect(registry.notifierSupports('open', {} as never)).toBe(true);
    expect(registry.notifierSupports('missing', {} as never)).toBe(false);
  });

  it('sends through the notifier of the channel', async () => {
    const registry = new CapabilityRegistry();
    const send = vi.fn(async () => ({ success: true, messageId: 'm1' }));
    registry.registerNotifier('email', notifier(send));
    const message = { channel: 'email', to: 'a@example.com', body: 'x' } as never;
    await expect(registry.sendNotification(message)).resolves.toEqual({
      success: true,
      messageId: 'm1',
    });
    expect(send).toHaveBeenCalledWith(message);
  });

  it('reports a channel without notifier', async () => {
    await expect(
      new CapabilityRegistry().sendNotification({ channel: 'sms', to: '1', body: 'x' } as never)
    ).resolves.toEqual({ success: false, error: "No notifier registered for channel 'sms'" });
  });

  it('turns a failing notifier into an error result', async () => {
    const registry = new CapabilityRegistry();
    registry.registerNotifier(
      'email',
      notifier(
        vi.fn(async () => {
          throw new Error('smtp down');
        })
      )
    );
    registry.registerNotifier(
      'sms',
      notifier(
        vi.fn(async () => {
          throw 'weird';
        })
      )
    );
    await expect(registry.sendNotification({ channel: 'email' } as never)).resolves.toEqual({
      success: false,
      error: 'smtp down',
    });
    await expect(registry.sendNotification({ channel: 'sms' } as never)).resolves.toEqual({
      success: false,
      error: 'Unknown error sending notification',
    });
  });
});

describe('CapabilityRegistry queries', () => {
  function populated() {
    const registry = new CapabilityRegistry();
    registry.registerNotifier('email', notifier(), 'p1');
    registry.registerNotifier('sms', notifier(), 'p1');
    registry.registerIdP('google', idp, 'p2');
    registry.registerAuthenticator('totp', authenticator, 'p1');
    return registry;
  }

  it('lists capabilities by category in registration order', () => {
    const registry = populated();
    expect(registry.listCapabilities()).toEqual([
      'notifier.email',
      'notifier.sms',
      'idp.google',
      'authenticator.totp',
    ]);
    expect(registry.getCapabilitiesByCategory('notifier')).toEqual(['email', 'sms']);
    expect(registry.getCapabilitiesByCategory('idp')).toEqual(['google']);
    expect(registry.getCapabilitiesByCategory('authenticator')).toEqual(['totp']);
    expect(registry.getCapabilitiesByCategory('other' as never)).toEqual([]);
  });

  it('answers whether a capability is registered', () => {
    const registry = populated();
    expect(registry.hasCapability(cap('notifier.email'))).toBe(true);
    expect(registry.hasCapability(cap('idp.google'))).toBe(true);
    expect(registry.hasCapability(cap('authenticator.totp'))).toBe(true);
    expect(registry.hasCapability(cap('notifier.google'))).toBe(false);
    expect(registry.hasCapability(cap('idp.email'))).toBe(false);
    expect(registry.hasCapability(cap('authenticator.email'))).toBe(false);
    expect(registry.hasCapability(cap('other.email'))).toBe(false);
  });
});

describe('CapabilityRegistry removal', () => {
  it('removes every handler of one plugin and no others', () => {
    const registry = new CapabilityRegistry();
    registry.registerNotifier('email', notifier(), 'p1');
    registry.registerIdP('google', idp, 'p1');
    registry.registerAuthenticator('totp', authenticator, 'p1');
    registry.registerNotifier('sms', notifier(), 'p2');
    registry.registerNotifier('push', notifier());
    registry.unregisterPlugin('p1');
    expect(registry.listCapabilities()).toEqual(['notifier.sms', 'notifier.push']);
    expect(registry.getCapabilityOwner(cap('notifier.email'))).toBeUndefined();
    expect(registry.getCapabilityOwner(cap('notifier.sms'))).toBe('p2');
    // The freed keys can be registered again.
    expect(() => registry.registerIdP('google', idp, 'p3')).not.toThrow();
  });

  it('does nothing for a plugin that registered nothing', () => {
    const registry = new CapabilityRegistry();
    registry.registerNotifier('email', notifier(), 'p1');
    registry.unregisterPlugin('nobody');
    expect(registry.listCapabilities()).toEqual(['notifier.email']);
  });

  it('clears everything, including owners', () => {
    const registry = new CapabilityRegistry();
    registry.registerNotifier('email', notifier(), 'p1');
    registry.registerIdP('google', idp, 'p1');
    registry.registerAuthenticator('totp', authenticator, 'p1');
    registry.clear();
    expect(registry.listCapabilities()).toEqual([]);
    expect(registry.getCapabilityOwner(cap('notifier.email'))).toBeUndefined();
    expect(() => registry.registerNotifier('email', notifier(), 'p2')).not.toThrow();
  });

  it('offers a shared registry instance', () => {
    expect(globalRegistry).toBeInstanceOf(CapabilityRegistry);
  });
});
