/**
 * What to tell the admin when a change to groups, roles or dynamic rules is refused.
 *
 * The groups and roles APIs answer a conflict with a code of its own (`group_has_children`,
 * `role_in_use`…), told apart here; the wording of `error_description` is only the fallback for an
 * older API (and for the few refusals that still share the generic `conflict` / `invalid_request`
 * code). A refusal that matches nothing known keeps the API's own words, after a short sentence in
 * the admin's language.
 */
import { ApiError } from '#lib/api/api-error.js';
import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';

/** The API's code: the `error` of the body (a 409 is read as `conflict` otherwise). */
export function apiCode(error: unknown): string {
	if (!(error instanceof ApiError)) return '';
	return typeof error.body.error === 'string' ? error.body.error : error.code;
}

const BY_CODE: Readonly<Record<string, MessageKey>> = {
	group_managed_by_service_group: 'grp.error.managed',
	group_self_writable_attribute: 'grp.error.selfWritable',
	group_version_conflict: 'grp.error.catalogChanged',
	group_has_children: 'grp.error.hasChildren',
	group_referenced_as_scope: 'grp.error.scopedGrant',
	membership_other_source: 'grp.error.otherSource',
	role_in_use: 'eur.error.inUse',
	role_version_conflict: 'eur.error.changed',
	group_delete_conflict: 'grp.error.hasDependents',
	group_scim_reference_invalid: 'grp.error.scimReference',
	group_not_found: 'az.error.notFound',
	role_delegation_denied: 'az.error.beyondCeiling',
	capability_disabled: 'az.error.capability',
	dynamic_group_negative_condition: 'pol.error.dynamicNegative'
};

/** Wording of the API's descriptions, for the refusals without a code of their own. */
const BY_TEXT: readonly [RegExp, MessageKey][] = [
	[/child groups/i, 'grp.error.hasChildren'],
	[/has this group as its scope/i, 'grp.error.scopedGrant'],
	[/group_key already exists/i, 'grp.error.keyTaken'],
	[/changed meanwhile/i, 'grp.error.changed'],
	[/another source/i, 'grp.error.otherSource'],
	[/account is not active/i, 'grp.error.accountInactive'],
	[/does not form a loop/i, 'grp.error.parentLoop'],
	[/still assigned to this role/i, 'eur.error.inUse'],
	[/assigned to a group/i, 'eur.error.inUseGroup'],
	[/role name already exists|already exists/i, 'eur.error.exists'],
	[/cannot be modified|cannot be deleted/i, 'eur.error.system']
];

export interface AuthzRefusal {
	key: MessageKey;
	/** The API's own words, for a refusal not known here (shown after the sentence). */
	detail?: string;
}

export function authzRefusal(error: unknown): AuthzRefusal {
	if (error instanceof StepUpCancelledError) return { key: 'az.error.cancelled' };
	if (!(error instanceof ApiError)) return { key: 'az.error.generic' };
	const code = apiCode(error);
	const known = BY_CODE[code];
	if (known) return { key: known };
	const description =
		(typeof error.body.error_description === 'string' && error.body.error_description) ||
		error.message;
	for (const [pattern, key] of BY_TEXT) if (pattern.test(description)) return { key };
	if (error.status === 403) return { key: 'az.error.beyondCeiling' };
	if (error.status === 404) return { key: 'az.error.notFound' };
	if (error.status === 409) return { key: 'az.error.conflict', detail: description };
	if (error.status === 400) return { key: 'az.error.invalid', detail: description };
	return { key: 'az.error.generic' };
}

/** The refusal as one line: the sentence, then the API's words when it kept them. */
export function refusalText(error: unknown, translate: (key: MessageKey) => string): string {
	const refusal = authzRefusal(error);
	return refusal.detail ? `${translate(refusal.key)} (${refusal.detail})` : translate(refusal.key);
}
