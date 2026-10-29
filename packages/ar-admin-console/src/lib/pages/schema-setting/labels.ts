import type { MessageKey } from '$lib/i18n/i18n.svelte';
import type {
	FieldType,
	OperationStatus,
	Schema,
	SchemaFailureKind,
	UsageProtection
} from '$lib/api/schema-setting';
import type { KeyProblem, RulesProblem } from './schema-validation';

export const TYPE_KEY: Record<FieldType, MessageKey> = {
	string: 'ss.type.string',
	number: 'ss.type.number',
	boolean: 'ss.type.boolean',
	date: 'ss.type.date',
	enum: 'ss.type.enum'
};

export const KEY_PROBLEM_KEY: Record<KeyProblem, MessageKey> = {
	empty: 'ss.key.empty',
	pattern: 'ss.key.pattern',
	reserved: 'ss.key.reserved',
	taken: 'ss.key.taken',
	same: 'ss.key.same'
};

export const RULES_PROBLEM_KEY: Record<RulesProblem, MessageKey> = {
	min_length_invalid: 'ss.rules.min_length_invalid',
	max_length_invalid: 'ss.rules.max_length_invalid',
	length_order: 'ss.rules.length_order',
	pattern_unsafe: 'ss.rules.pattern_unsafe',
	min_invalid: 'ss.rules.min_invalid',
	max_invalid: 'ss.rules.max_invalid',
	range_order: 'ss.rules.range_order',
	enum_empty: 'ss.rules.enum_empty',
	enum_too_many: 'ss.rules.enum_too_many',
	enum_duplicate: 'ss.rules.enum_duplicate',
	date_order: 'ss.rules.date_order',
	too_large: 'ss.rules.too_large'
};

/** What a failed call is called to the person. */
export const FAILURE_KEY: Record<SchemaFailureKind, MessageKey> = {
	invalid: 'ss.error.invalid',
	conflict: 'ss.error.conflict',
	in_use: 'ss.delete.inUse',
	forbidden: 'ss.error.forbidden',
	not_found: 'ss.error.notFound',
	partial: 'ss.error.partial',
	failed: 'ss.error.failed'
};

export const PROTECTION_KEY: Record<UsageProtection, MessageKey> = {
	delete_blocked: 'ss.usage.protection.delete_blocked',
	warn: 'ss.usage.protection.warn',
	none: 'ss.usage.protection.none'
};

const STATUS_KEY: Record<OperationStatus, MessageKey> = {
	active: 'ss.status.active',
	deleting: 'ss.status.deleting',
	renaming: 'ss.status.renaming',
	reconfiguring: 'ss.status.reconfiguring',
	error: 'ss.status.error'
};

export type StatusTone = 'success' | 'neutral' | 'warning' | 'danger';

/** The state of an attribute as a badge: failed and in-flight come before active or inactive. */
export function statusBadge(schema: Pick<Schema, 'status' | 'isActive'>): {
	key: MessageKey;
	tone: StatusTone;
} {
	if (schema.status === 'error') return { key: STATUS_KEY.error, tone: 'danger' };
	if (schema.status !== 'active') return { key: STATUS_KEY[schema.status], tone: 'warning' };
	return schema.isActive
		? { key: 'ss.status.active', tone: 'success' }
		: { key: 'ss.status.inactive', tone: 'neutral' };
}

/** An attribute is being worked on or has failed: nothing about it can be changed until resolved. */
export function isSettled(schema: Pick<Schema, 'status'>): boolean {
	return schema.status === 'active';
}

/** Running, with no way to recover from here (everything but failed, which has Retry). */
export function isStuck(schema: Pick<Schema, 'status'>): boolean {
	return (
		schema.status === 'deleting' ||
		schema.status === 'renaming' ||
		schema.status === 'reconfiguring'
	);
}

export function statusText(status: OperationStatus): MessageKey {
	return STATUS_KEY[status];
}
