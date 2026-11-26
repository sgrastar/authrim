import { describe, expect, it } from 'vitest';
import {
  EmailNotificationSchema,
  NOTIFIER_SECURITY_DEFAULTS,
  NotificationSchema,
  PushNotificationSchema,
  SMSNotificationSchema,
  renderTemplate,
} from '../builtin/notifier/types';

describe('notifier security defaults', () => {
  it('pins every limit', () => {
    expect(NOTIFIER_SECURITY_DEFAULTS).toEqual({
      DEFAULT_TIMEOUT_MS: 10000,
      MAX_TIMEOUT_MS: 30000,
      MAX_RECIPIENTS_PER_REQUEST: 50,
      MAX_BODY_SIZE: 1024 * 1024,
      MAX_SUBJECT_LENGTH: 998,
      ALLOW_LOCALHOST_IN_PRODUCTION: false,
      MAX_RETRIES: 3,
      RETRY_DELAY_BASE_MS: 1000,
    });
  });
});

describe('renderTemplate', () => {
  it('replaces every occurrence of a known variable', () => {
    expect(renderTemplate('{{a}} and {{a}}', { a: 'x' })).toBe('x and x');
  });

  it('renders primitives as text and objects as JSON', () => {
    expect(
      renderTemplate('{{s}}|{{n}}|{{z}}|{{b}}|{{f}}|{{o}}|{{l}}', {
        s: 'text',
        n: 42,
        z: 0,
        b: true,
        f: false,
        o: { k: 1 },
        l: [1, 2],
      })
    ).toBe('text|42|0|true|false|{"k":1}|[1,2]');
  });

  it('keeps the placeholder of a variable that is missing, undefined or null', () => {
    expect(renderTemplate('{{a}}{{b}}{{c}}', { b: undefined, c: null })).toBe('{{a}}{{b}}{{c}}');
  });

  it('only takes the variables of the object itself', () => {
    expect(renderTemplate('{{constructor}} {{toString}}', {})).toBe('{{constructor}} {{toString}}');
  });

  it('only matches word-character names without spaces', () => {
    expect(renderTemplate('{{ a }} {{a-b}} {{a b}} {{}} {a}', { a: 'x', 'a-b': 'y' })).toBe(
      '{{ a }} {{a-b}} {{a b}} {{}} {a}'
    );
    expect(renderTemplate('{{a_1}}', { a_1: 'ok' })).toBe('ok');
  });

  it('does not render a template without placeholders differently', () => {
    expect(renderTemplate('plain text', { a: 1 })).toBe('plain text');
    expect(renderTemplate('', { a: 1 })).toBe('');
  });
});

describe('notification schemas', () => {
  const email = { channel: 'email', to: 'a@example.com', subject: 'S', body: 'b' };

  it('requires an email address, a subject of 1-998 characters and a body', () => {
    expect(EmailNotificationSchema.safeParse(email).success).toBe(true);
    expect(EmailNotificationSchema.safeParse({ ...email, to: 'nope' }).success).toBe(false);
    expect(EmailNotificationSchema.safeParse({ ...email, subject: '' }).success).toBe(false);
    expect(EmailNotificationSchema.safeParse({ ...email, subject: 's'.repeat(998) }).success).toBe(
      true
    );
    expect(EmailNotificationSchema.safeParse({ ...email, subject: 's'.repeat(999) }).success).toBe(
      false
    );
    expect(EmailNotificationSchema.safeParse({ ...email, body: undefined }).success).toBe(false);
    expect(EmailNotificationSchema.safeParse({ ...email, cc: ['bad'] }).success).toBe(false);
    expect(EmailNotificationSchema.safeParse({ ...email, bcc: ['b@example.com'] }).success).toBe(
      true
    );
    expect(EmailNotificationSchema.safeParse({ ...email, replyTo: 'bad' }).success).toBe(false);
    expect(EmailNotificationSchema.safeParse({ ...email, from: 'bad' }).success).toBe(false);
  });

  it.each([
    ['+12', true],
    ['+819012345678', true],
    ['+123456789012345', true],
    ['+1234567890123456', false],
    ['+1', false],
    ['+0123456', false],
    ['819012345678', false],
    ['+81 90', false],
  ])('checks the E.164 number %s: %s', (to, valid) => {
    const result = SMSNotificationSchema.safeParse({ channel: 'sms', to, body: 'x' });
    expect(result.success).toBe(valid);
    if (!result.success && to.startsWith('+8')) {
      expect(result.error.issues[0]?.message).toBe('Phone number must be in E.164 format');
    }
  });

  it('limits an SMS body to 1-1600 characters', () => {
    const sms = { channel: 'sms', to: '+12' };
    expect(SMSNotificationSchema.safeParse({ ...sms, body: '' }).success).toBe(false);
    expect(SMSNotificationSchema.safeParse({ ...sms, body: 'x' }).success).toBe(true);
    expect(SMSNotificationSchema.safeParse({ ...sms, body: 'x'.repeat(1600) }).success).toBe(true);
    expect(SMSNotificationSchema.safeParse({ ...sms, body: 'x'.repeat(1601) }).success).toBe(false);
  });

  it('accepts a push notification with a non-negative integer badge', () => {
    const push = { channel: 'push', to: 'token', body: 'b' };
    expect(PushNotificationSchema.safeParse(push).success).toBe(true);
    expect(PushNotificationSchema.safeParse({ ...push, badge: 0 }).success).toBe(true);
    expect(PushNotificationSchema.safeParse({ ...push, badge: -1 }).success).toBe(false);
    expect(PushNotificationSchema.safeParse({ ...push, badge: 1.5 }).success).toBe(false);
    expect(PushNotificationSchema.safeParse({ ...push, data: { a: 1 }, sound: 's' }).success).toBe(
      true
    );
  });

  it('picks the schema by channel', () => {
    expect(NotificationSchema.safeParse(email).success).toBe(true);
    expect(NotificationSchema.safeParse({ channel: 'sms', to: '+12', body: 'x' }).success).toBe(
      true
    );
    expect(NotificationSchema.safeParse({ channel: 'push', to: 't', body: 'x' }).success).toBe(
      true
    );
    expect(NotificationSchema.safeParse({ channel: 'fax', to: 't', body: 'x' }).success).toBe(
      false
    );
    expect(NotificationSchema.safeParse({ ...email, channel: 'sms' }).success).toBe(false);
  });
});
