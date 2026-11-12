import { StepUpCancelledError, stepUpRequired } from '#lib/api/admin-step-up.js';
import {
	LegalHoldError,
	LifecycleConflictError,
	SUSPEND_MAX_HOURS,
	type AdminUser,
	type AdminUserProfileChange,
	type UserLifecycleState
} from '#lib/api/admin-users.js';
import { ApiError } from '#lib/api/api-error.js';
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';
import { inputTimeToMs } from '#lib/pages/team/team-model.js';
import type { TimeZoneMode } from '#lib/ui/time/format-time.js';

/** The state changes an admin can ask for, each with its own dialog. */
export type LifecycleKind = 'suspend' | 'lock' | 'activate';

/** What names a user in a sentence or to a screen reader: the name, else the address, else the id. */
export function userLabel(user: Pick<AdminUser, 'id' | 'name' | 'email'>): string {
	return user.name ?? user.email ?? user.id;
}

export const STATUS_LABEL: Record<UserLifecycleState, MessageKey> = {
	active: 'usr.status.active',
	suspended: 'usr.status.suspended',
	locked: 'usr.status.locked',
	deprovisioned: 'usr.status.deprovisioned'
};

/** Only a count may be red (Design rules › Badges): a stop is a warning, a retired account neutral. */
export const STATUS_TONE: Record<UserLifecycleState, 'success' | 'warning' | 'neutral'> = {
	active: 'success',
	suspended: 'warning',
	locked: 'warning',
	deprovisioned: 'neutral'
};

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

/** What is wrong with the address before it is sent; null when it can be. */
export function emailProblem(email: string): MessageKey | null {
	const value = email.trim();
	if (!value) return 'usr.new.emailRequired';
	return EMAIL_SHAPE.test(value) ? null : 'usr.new.emailInvalid';
}

/** Why adding a user was refused: the message, and whether it belongs to the email field. */
export function createErrorOf(error: unknown): { key: MessageKey; field: 'email' | null } {
	if (error instanceof ApiError) {
		if (error.status === 409) return { key: 'usr.new.emailTaken', field: 'email' };
		if (error.status === 400) {
			if (Array.isArray(error.body.missing_required_fields)) {
				return { key: 'usr.new.fieldsRequired', field: null };
			}
			if (/email/i.test(error.message)) {
				return {
					key: /required/i.test(error.message) ? 'usr.new.emailRequired' : 'usr.new.emailInvalid',
					field: 'email'
				};
			}
		}
		if (error.status === 403) return { key: 'usr.new.forbidden', field: null };
		if (error.status === 503) return { key: 'usr.new.unavailable', field: null };
	}
	return { key: 'usr.new.error', field: null };
}

/** Why a state change or a deletion was refused, in words for the admin. */
export function actionErrorKey(error: unknown): MessageKey {
	if (error instanceof LifecycleConflictError) return 'usr.error.conflict';
	if (error instanceof LegalHoldError) return 'usr.error.legalHold';
	if (error instanceof ApiError) {
		if (error.status === 403) return 'usr.error.forbidden';
		if (error.status === 404) return 'usr.error.notFound';
	}
	return 'usr.error.generic';
}

/** Why signing the user out everywhere did not happen. */
export function signOutErrorKey(error: unknown): MessageKey {
	if (error instanceof StepUpCancelledError) return 'usr.d.signOut.cancelled';
	if (stepUpRequired(error)) return 'usr.d.signOut.stepUp';
	if (error instanceof ApiError && error.status === 403) return 'usr.error.forbidden';
	return 'usr.d.signOut.error';
}

/** The profile fields the page edits, in the order the form shows them. */
export const PROFILE_FIELDS = [
	'name',
	'given_name',
	'family_name',
	'preferred_username',
	'phone_number'
] as const satisfies readonly (keyof AdminUserProfileChange & keyof AdminUser)[];

export type ProfileForm = Record<(typeof PROFILE_FIELDS)[number], string>;

export function profileFormOf(user: AdminUser): ProfileForm {
	return {
		name: user.name ?? '',
		given_name: user.given_name ?? '',
		family_name: user.family_name ?? '',
		preferred_username: user.preferred_username ?? '',
		phone_number: user.phone_number ?? ''
	};
}

/** Only what differs from the saved profile; an emptied field is sent as `''` to clear it. */
export function profileChange(user: AdminUser, form: ProfileForm): AdminUserProfileChange {
	const saved = profileFormOf(user);
	const change: AdminUserProfileChange = {};
	for (const field of PROFILE_FIELDS) {
		const value = form[field].trim();
		if (value !== saved[field]) change[field] = value;
	}
	// The API keeps `phone_number_verified` when it is left out, so a new number would count as
	// verified. A changed (or cleared) number starts unverified.
	if (change.phone_number !== undefined) change.phone_number_verified = false;
	return change;
}

const PHONE_SHAPE = /^\+?(?=.*\d)[0-9 ()-]{3,25}$/;

/** What is wrong with a phone number before it is sent; null when it can be (or is empty). */
export function phoneProblem(phone: string): MessageKey | null {
	const value = phone.trim();
	return value === '' || PHONE_SHAPE.test(value) ? null : 'usr.d.edit.phoneInvalid';
}

/** The reasons of a state change as select options, labelled in the console's words. */
export function reasonOptions(
	codes: readonly string[],
	translate: (key: MessageKey) => string
): Array<{ value: string; label: string }> {
	return codes.map((code) => ({
		value: code,
		label: translate(`usr.reason.${code}` as MessageKey)
	}));
}

/** A whole number of hours the API accepts, or the message that says it is not. */
export function suspendHours(value: number | null): { hours?: number; problem?: MessageKey } {
	if (value === null) return {};
	return Number.isInteger(value) && value >= 1 && value <= SUSPEND_MAX_HOURS
		? { hours: value }
		: { problem: 'usr.suspend.hoursInvalid' };
}

/** When a lock ends, as typed in the admin's time zone: the time, or what is wrong with it. */
export function lockEnd(
	text: string,
	incomplete: boolean,
	zone: TimeZoneMode,
	now = Date.now()
): { ms?: number; problem?: MessageKey } {
	if (incomplete) return { problem: 'usr.lock.untilInvalid' };
	if (!text) return {};
	const ms = inputTimeToMs(text, zone);
	if (ms === undefined) return { problem: 'usr.lock.untilInvalid' };
	return ms <= now ? { problem: 'usr.lock.untilPast' } : { ms };
}

const BROWSERS: Array<[RegExp, string]> = [
	[/Edg\//, 'Edge'],
	[/OPR\//, 'Opera'],
	[/Firefox\//, 'Firefox'],
	[/Chrome\//, 'Chrome'],
	[/Safari\//, 'Safari']
];
const SYSTEMS: Array<[RegExp, string]> = [
	[/iPhone|iPad/, 'iOS'],
	[/Android/, 'Android'],
	[/Mac OS X/, 'macOS'],
	[/Windows/, 'Windows'],
	[/Linux/, 'Linux']
];
const RAW_LIMIT = 60;

/** A user agent as a short device text ("Safari · macOS"); the start of the raw text if unknown. */
export function deviceText(userAgent: string | null): string | null {
	if (!userAgent) return null;
	const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
	const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
	if (browser || system) return [browser, system].filter(Boolean).join(' · ');
	return userAgent.length > RAW_LIMIT ? `${userAgent.slice(0, RAW_LIMIT)}…` : userAgent;
}
