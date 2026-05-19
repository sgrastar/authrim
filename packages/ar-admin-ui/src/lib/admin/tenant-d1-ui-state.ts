import type { Tenant, TenantListResponse } from '$lib/api/admin-tenants';

type TenantD1Pool = TenantListResponse['tenant_d1_pool'];

export interface TenantD1CreateUiState {
	showPool: boolean;
	summary: string;
	exhausted: boolean;
	exhaustedTitle: string;
	exhaustedMessage: string;
}

export function getTenantD1CreateUiState(pool: TenantD1Pool): TenantD1CreateUiState {
	const showPool = pool?.enabled === true;
	const available = pool?.available_slots ?? 0;
	const capacity = pool?.capacity ?? 0;
	const exhausted = showPool && available <= 0;

	return {
		showPool,
		summary: `Available ${available} / ${capacity}`,
		exhausted,
		exhaustedTitle: 'No preallocated tenant D1 slots available',
		exhaustedMessage: 'Use the setup tool existing environment settings to add tenant D1 slots.'
	};
}

export interface TenantProvisioningDraftUiState {
	failed: boolean;
	title: string;
	description: string;
	slot: string;
	error: string;
	showActions: boolean;
}

export function getTenantProvisioningDraftUiState(
	tenant: Tenant | null
): TenantProvisioningDraftUiState {
	const failed = tenant?.provisioning_status === 'provisioning_failed';

	return {
		failed,
		title: failed ? 'Provisioning Failed' : 'Tenant Inactive',
		description: failed
			? 'This tenant did not complete setup. Operational settings are unavailable until the failed draft is cleaned up and the slot is reset from the setup tool.'
			: 'This tenant is inactive. Operational settings are hidden until it is reactivated.',
		slot: tenant?.provisioning_slot_id ?? '—',
		error: tenant?.provisioning_error ?? 'No error detail was recorded.',
		showActions: failed
	};
}
