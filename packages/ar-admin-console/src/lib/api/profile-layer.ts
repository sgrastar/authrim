/**
 * What the platform layer says about a profile in a tenant's list (method and session profiles
 * alike): whether it is the platform's, whether the tenant keeps a copy of it and whether that copy
 * applies, and whether the tenant may change it now. Default carries the same fields for the
 * platform's Default under the tenant's settings.
 */
export type ProfileSetAsideReason = 'locked' | 'changes_not_allowed';

export interface ProfileLayer {
	/** `platform`: one of the platform's profiles (its id starts pmp_ / psp_). */
	scope: 'tenant' | 'platform';
	/** The platform's own values (what holds without the tenant's copy). */
	platformValues: Record<string, unknown>;
	/** The tenant's copy applies. */
	overridden: boolean;
	/** The tenant keeps a copy, set aside now. */
	overrideInactive: boolean;
	overrideInactiveReason: ProfileSetAsideReason | null;
	locked: boolean;
	/** The tenant may change it now. */
	editable: boolean;
	/** The platform changed it since the tenant's copy was made. */
	platformUpdated: boolean;
	/** A platform profile: the version of the tenant's copy, or null while there is none. */
	copyVersion: number | null;
}

const object = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

/** The layer of a row, or null for a profile of the tenant's own (nothing above it). */
export function profileLayerFromRow(row: Record<string, unknown>): ProfileLayer | null {
	const scope = row.scope === 'platform' ? 'platform' : 'tenant';
	if (scope === 'tenant' && typeof row.editable !== 'boolean') return null;
	const reason = row.override_inactive_reason;
	return {
		scope,
		platformValues: object(row.platform_values),
		overridden: row.overridden === true,
		overrideInactive: row.override_inactive === true,
		overrideInactiveReason: reason === 'locked' || reason === 'changes_not_allowed' ? reason : null,
		locked: row.locked === true,
		editable: row.editable !== false,
		platformUpdated: row.platform_updated === true,
		copyVersion: scope === 'platform' && typeof row.version === 'number' ? row.version : null
	};
}

/** Whether the tenant keeps values of its own over the platform's (applying or set aside). */
export const keepsCopy = (layer: ProfileLayer | null): boolean =>
	layer !== null && (layer.overridden || layer.overrideInactive);
