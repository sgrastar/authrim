import type { PluginHookExecutionInvocation, PluginRunnerEnv } from './types';
import { EmailNotificationSchema, type EmailNotification } from '@authrim/ar-lib-plugin/builtin';
import {
  StaticInProcessPluginRegistry,
  type InProcessPluginHookHandler,
  type InProcessPluginRegistry,
} from './backend-router';

const RESEND_PLUGIN_ID = 'notifier-resend';
const CLOUDFLARE_PLUGIN_ID = 'notifier-cloudflare';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function delivery(input: PluginHookExecutionInvocation): EmailNotification {
  if (
    input.capability !== 'notifier.send' ||
    !('delivery' in input.payload) ||
    input.payload.delivery.channel !== 'email'
  ) {
    throw new Error('plugin_in_process_message_rejected');
  }
  const parsed = EmailNotificationSchema.safeParse(input.payload.delivery);
  if (!parsed.success || containsControlCharacter(parsed.data.subject)) {
    throw new Error('plugin_in_process_message_rejected');
  }
  return parsed.data;
}

function sender(env: PluginRunnerEnv, from: string | undefined): string {
  const value = from?.trim() || env.EMAIL_FROM?.trim();
  if (!value || !EmailNotificationSchema.shape.from.safeParse(value).success) {
    throw new Error(
      from ? 'plugin_in_process_message_rejected' : 'plugin_in_process_provider_rejected'
    );
  }
  const name = env.EMAIL_FROM_NAME?.trim();
  if (!name || from) return value;
  if (
    name.length > 128 ||
    containsControlCharacter(name) ||
    name.includes('<') ||
    name.includes('>')
  ) {
    throw new Error('plugin_in_process_provider_rejected');
  }
  return `"${name.replace(/(["\\])/gu, '\\$1')}" <${value}>`;
}

function resendHandler(env: PluginRunnerEnv): InProcessPluginHookHandler {
  return async (invocation, access) => {
    const payload = delivery(invocation);
    const response = await access.fetchExternal(
      new Request(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': invocation.idempotencyKey,
        },
        body: JSON.stringify({
          from: sender(env, payload.from),
          to: [payload.to],
          subject: payload.subject ?? '',
          html: payload.body,
          ...(payload.replyTo ? { reply_to: payload.replyTo } : {}),
          ...(payload.cc ? { cc: payload.cc } : {}),
          ...(payload.bcc ? { bcc: payload.bcc } : {}),
        }),
        signal: access.signal,
      })
    );
    await response.body?.cancel();
    if (response.status >= 200 && response.status < 300) return;
    if (response.status === 429 || response.status >= 500) {
      throw new Error('plugin_in_process_transient_failure');
    }
    if ([401, 403, 404].includes(response.status)) {
      throw new Error('plugin_in_process_provider_rejected');
    }
    throw new Error('plugin_in_process_message_rejected');
  };
}

function cloudflareHandler(env: PluginRunnerEnv): InProcessPluginHookHandler {
  return async (invocation) => {
    const payload = delivery(invocation);
    if (!env.EMAIL) throw new Error('plugin_in_process_provider_rejected');
    await env.EMAIL.send({
      to: payload.to,
      from: sender(env, payload.from),
      subject: payload.subject ?? '',
      html: payload.body,
      ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
      ...(payload.cc ? { cc: payload.cc } : {}),
      ...(payload.bcc ? { bcc: payload.bcc } : {}),
    });
  };
}

export function createBuiltinNotifierRegistry(env: PluginRunnerEnv): InProcessPluginRegistry {
  return new StaticInProcessPluginRegistry(
    new Map([
      [`${RESEND_PLUGIN_ID}:notifier.send`, resendHandler(env)],
      [`${CLOUDFLARE_PLUGIN_ID}:notifier.send`, cloudflareHandler(env)],
    ])
  );
}
