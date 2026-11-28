/**
 * The "Create key" form of the Check API keys (Settings → Authorization): what is typed, what is
 * wrong with it, the request it makes, and what to tell the admin when the API refuses it.
 */
import { ApiError } from '#lib/api/api-error.js';
import type { CheckApiKeyInput } from '#lib/api/check-api-keys.js';
import { inputTimeToMs } from '#lib/pages/team/team-model.js';
import type { TimeZoneMode } from '#lib/ui/time/format-time.js';
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';
import { authzRefusal } from './authz-errors';

/** The operations a key can be limited to (the three the API takes). */
export const KEY_OPERATIONS = ['check', 'batch', 'subscribe'] as const;
export type KeyOperation = (typeof KEY_OPERATIONS)[number];

export interface KeyForm {
	name: string;
	client_id: string;
	operations: KeyOperation[];
}

export const EMPTY_KEY_FORM: KeyForm = { name: '', client_id: '', operations: ['check'] };

export type KeyProblems = Partial<Record<'name' | 'client_id' | 'operations', MessageKey>>;

export function keyProblems(form: KeyForm): KeyProblems {
	const problems: KeyProblems = {};
	if (!form.name.trim()) problems.name = 'az.keys.new.nameRequired';
	if (!form.client_id.trim()) problems.client_id = 'az.keys.new.clientRequired';
	if (form.operations.length === 0) problems.operations = 'az.keys.new.operationsRequired';
	return problems;
}

/** The request for the form, with its end (milliseconds, none when null). */
export function keyInputOf(form: KeyForm, expiresAt: number | null): CheckApiKeyInput {
	return {
		name: form.name.trim(),
		client_id: form.client_id.trim(),
		// In the order the form offers them, whatever order they were ticked in.
		allowed_operations: KEY_OPERATIONS.filter((operation) => form.operations.includes(operation)),
		expires_at: expiresAt
	};
}

/**
 * A key's end as typed (a `datetime-local` value in `zone`): the time in milliseconds, or what is
 * wrong with it. Empty is no end. `incomplete` is the field's own report of a part left out.
 */
export function readKeyEnd(
	text: string,
	incomplete: boolean,
	zone: TimeZoneMode,
	now = Date.now()
): { ms?: number; problem?: 'az.keys.new.endsInvalid' | 'az.keys.new.endsPast' } {
	if (incomplete) return { problem: 'az.keys.new.endsInvalid' };
	if (!text) return {};
	const ms = inputTimeToMs(text, zone);
	if (ms === undefined) return { problem: 'az.keys.new.endsInvalid' };
	if (ms <= now) return { problem: 'az.keys.new.endsPast' };
	return { ms };
}

/** Tick or untick an operation. */
export function toggleOperation(
	operations: readonly KeyOperation[],
	operation: KeyOperation,
	on: boolean
): KeyOperation[] {
	const rest = operations.filter((item) => item !== operation);
	return on ? [...rest, operation] : rest;
}

/** The platform has turned machine credentials off (403 `capability_disabled`). */
export function isCapabilityRefusal(error: unknown): boolean {
	return error instanceof ApiError && error.capabilityDisabled;
}

/** What to tell the admin when making a key is refused: the sentence, then the API's words. */
export function keyRefusalText(error: unknown, translate: (key: MessageKey) => string): string {
	if (isCapabilityRefusal(error)) return translate('az.keys.new.capabilityOff');
	const refusal = authzRefusal(error);
	return refusal.detail ? `${translate(refusal.key)} (${refusal.detail})` : translate(refusal.key);
}
