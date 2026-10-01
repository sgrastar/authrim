/**
 * An in-memory Settings API for Storybook, tests and the dev mock. It follows the real one
 * (ar-lib-core `SettingsManager`, ar-management `routes/settings-v2`):
 * - a value comes from this scope's store, else the scopes it inherits from (a client's
 *   tenant, then the platform, where the category allows them), else the deployment's
 *   environment, else the built-in default; `sources` says which, and `inherited` gives what
 *   applies when this scope sets nothing;
 * - a change must carry the current `version`, or it fails with ConflictError;
 * - values are checked against the setting's type, range and choices; refused keys come back
 *   in `rejected`, and a change where nothing applies fails with RejectedError;
 * - what the admin may do follows `settingsLevel` (403 as the API answers it).
 * Options make the states a page must handle easy to show: slow, failing, someone else saving.
 */
import {
	ALL_CATEGORY_META,
	settingsParentScopes
} from '@authrim/ar-lib-core/types/settings/catalog';
import type {
	InheritedSettingSource,
	SettingMeta,
	SettingScope
} from '@authrim/ar-lib-core/utils/settings-manager';
import { settingsLevel, type AdminAccess } from '$lib/access/access';
import { ApiError, ConflictError, RejectedError } from '../api-error';
import {
	targetKey,
	type CategoryName,
	type SettingsClient,
	type SettingsGetResult,
	type SettingsPatchResult,
	type SettingsTarget,
	type SettingSource
} from '../settings';

export interface FakeSettingsOptions {
	/** Values set at a scope, by target key (`tenant:acme`, `platform`) then setting key. */
	stored?: Record<string, Record<string, unknown>>;
	/** The deployment's environment, by setting key (applies at every scope). */
	env?: Record<string, unknown>;
	/** Who is asking; defaults to someone who may edit everything. */
	access?: () => AdminAccess;
	/** Milliseconds each call takes. */
	latency?: number;
	/** Reading fails: `error` (500) or never answers (`hang`, to show loading). */
	failGet?: 'error' | 'hang';
	/** Just before the next change, someone else saves these values (a conflict). */
	othersSaveFirst?: Record<string, unknown>;
	/** Settings the scope above has fixed: read as usual, refused when changed. */
	locked?: readonly string[];
}

const EVERYONE: AdminAccess = { platform: true, roles: ['super_admin'], permissions: ['*'] };

function settingsOf(category: CategoryName): Record<string, SettingMeta> {
	return ALL_CATEGORY_META[category].settings as Record<string, SettingMeta>;
}

/** Why a value cannot be saved, in the API's words; null when it can. */
export function refusal(meta: SettingMeta, value: unknown): string | null {
	switch (meta.type) {
		case 'number':
		case 'duration': {
			if (typeof value !== 'number' || !Number.isFinite(value)) return 'Value must be a number';
			if (meta.integer && !Number.isInteger(value)) return 'Value must be a whole number';
			if (meta.min !== undefined && value < meta.min) return `Value must be >= ${meta.min}`;
			if (meta.max !== undefined && value > meta.max) return `Value must be <= ${meta.max}`;
			return null;
		}
		case 'boolean':
			return typeof value === 'boolean' ? null : 'Value must be true or false';
		case 'enum':
			return typeof value === 'string' && meta.enum?.includes(value)
				? null
				: `Value must be one of: ${(meta.enum ?? []).join(', ')}`;
		case 'string':
			return typeof value === 'string' ? null : 'Value must be text';
		default:
			return null;
	}
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createFakeSettings(options: FakeSettingsOptions = {}): SettingsClient {
	const stores = new Map<string, Record<string, unknown>>(
		Object.entries(options.stored ?? {}).map(([key, values]) => [key, { ...values }])
	);
	const versions = new Map<string, number>();
	const env = options.env ?? {};
	const access = options.access ?? (() => EVERYONE);
	let othersPending = options.othersSaveFirst;

	const storeKey = (target: SettingsTarget, category: CategoryName) =>
		`${targetKey(target)}/${category}`;

	function storeOf(target: SettingsTarget): Record<string, unknown> {
		const key = targetKey(target);
		if (!stores.has(key)) stores.set(key, {});
		return stores.get(key)!;
	}

	function version(target: SettingsTarget, category: CategoryName): string {
		return `v${versions.get(storeKey(target, category)) ?? 1}`;
	}

	function bump(target: SettingsTarget, category: CategoryName): void {
		const key = storeKey(target, category);
		versions.set(key, (versions.get(key) ?? 1) + 1);
	}

	function scopeOf(target: SettingsTarget): SettingScope {
		return target.level === 'platform'
			? { type: 'platform' }
			: target.level === 'tenant'
				? { type: 'tenant', id: target.tenantId }
				: { type: 'client', id: target.clientId, tenantId: target.tenantId };
	}

	function targetOf(scope: SettingScope): SettingsTarget {
		return scope.type === 'platform'
			? { level: 'platform' }
			: { level: 'tenant', tenantId: scope.id };
	}

	function check(target: SettingsTarget, category: CategoryName, need: 'view' | 'edit'): void {
		const level = settingsLevel(access(), category, target.level);
		if (level === 'none' || (need === 'edit' && level !== 'edit')) {
			throw new ApiError(403, 'forbidden', 'Insufficient permissions');
		}
	}

	async function pause(): Promise<void> {
		if (options.latency) await wait(options.latency);
	}

	return {
		async get(target, category) {
			await pause();
			if (options.failGet === 'hang') await new Promise(() => {});
			if (options.failGet === 'error') {
				throw new ApiError(500, 'server_error', 'The settings could not be read');
			}
			check(target, category, 'view');
			const stored = storeOf(target);
			const scope = scopeOf(target);
			const parents = settingsParentScopes(category, scope).map((parent) => ({
				source: parent.type as InheritedSettingSource,
				stored: storeOf(targetOf(parent))
			}));
			const values: Record<string, unknown> = {};
			const sources: Record<string, SettingSource> = {};
			const inherited: SettingsGetResult['inherited'] = { values: {}, sources: {} };
			for (const [key, meta] of Object.entries(settingsOf(category))) {
				const parent = parents.find((p) => key in p.stored);
				const [value, source]: [unknown, InheritedSettingSource] = parent
					? [parent.stored[key], parent.source]
					: key in env
						? [env[key], 'env']
						: [meta.default, 'default'];
				inherited.values[key] = value;
				inherited.sources[key] = source;
				values[key] = key in stored ? stored[key] : value;
				sources[key] = key in stored ? 'kv' : source;
			}
			const result: SettingsGetResult = {
				category,
				scope,
				version: version(target, category),
				values,
				sources,
				inherited
			};
			const locked = (options.locked ?? []).filter((key) => key in values);
			if (locked.length > 0) result.locked = locked;
			return result;
		},

		async patch(target, category, request) {
			await pause();
			check(target, category, 'edit');
			const stored = storeOf(target);
			if (othersPending) {
				Object.assign(stored, othersPending);
				othersPending = undefined;
				bump(target, category);
			}
			const current = version(target, category);
			if (request.ifMatch !== current) {
				throw new ConflictError('Settings were changed by someone else', {
					currentVersion: current
				});
			}
			const metas = settingsOf(category);
			const result: SettingsPatchResult = {
				version: current,
				applied: [],
				cleared: [],
				disabled: [],
				rejected: {}
			};
			const isLocked = (key: string) => options.locked?.includes(key) === true;
			for (const [key, value] of Object.entries(request.set ?? {})) {
				const meta = metas[key];
				const reason = !meta
					? 'Unknown setting'
					: isLocked(key)
						? 'Fixed by the scope above'
						: refusal(meta, value);
				if (reason) {
					result.rejected[key] = reason;
					continue;
				}
				stored[key] = value;
				result.applied.push(key);
			}
			for (const key of request.clear ?? []) {
				if (!metas[key] || isLocked(key)) {
					result.rejected[key] = metas[key] ? 'Fixed by the scope above' : 'Unknown setting';
					continue;
				}
				delete stored[key];
				result.cleared.push(key);
			}
			const applied = result.applied.length + result.cleared.length > 0;
			if (!applied && Object.keys(result.rejected).length > 0) {
				throw new RejectedError('All changes were rejected', { ...result });
			}
			if (applied) bump(target, category);
			result.version = version(target, category);
			return result;
		}
	};
}
