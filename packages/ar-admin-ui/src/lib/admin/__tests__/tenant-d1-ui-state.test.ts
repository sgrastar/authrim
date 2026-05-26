import { describe, expect, it } from 'vitest';
import { getTenantD1CreateUiState, getTenantProvisioningDraftUiState } from '../tenant-d1-ui-state';

describe('tenant D1 UI state', () => {
	it('describes the new tenant screen when preallocated slots are available', () => {
		const state = getTenantD1CreateUiState({
			enabled: true,
			capacity: 3,
			available_slots: 2
		});

		expect(state).toMatchObject({
			showPool: true,
			summary: 'Available 2 / 3',
			exhausted: false
		});
	});

	it('describes the slot exhausted state for tenant creation', () => {
		const state = getTenantD1CreateUiState({
			enabled: true,
			capacity: 3,
			available_slots: 0
		});

		expect(state).toMatchObject({
			showPool: true,
			summary: 'Available 0 / 3',
			exhausted: true,
			exhaustedTitle: 'No preallocated tenant D1 slots available',
			exhaustedMessage: 'Use the setup tool existing environment settings to add tenant D1 slots.'
		});
	});

	it('describes provisioning_failed retry and cleanup display state', () => {
		const state = getTenantProvisioningDraftUiState({
			id: 'draft-tenant',
			tenant_code: 'draft-tenant',
			name: 'Draft Tenant',
			description: null,
			lifecycle_state: 'suspended',
			is_default: false,
			created_at: 1,
			updated_at: 1,
			provisioning_status: 'provisioning_failed',
			provisioning_error: 'smoke test failed',
			provisioning_slot_id: 'tdb-slot-0002'
		});

		expect(state).toMatchObject({
			failed: true,
			title: 'Provisioning Failed',
			slot: 'tdb-slot-0002',
			error: 'smoke test failed',
			showActions: true
		});
		expect(state.description).toContain('Operational settings are unavailable');
	});
});
