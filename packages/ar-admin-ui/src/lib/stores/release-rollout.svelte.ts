import { adminControlPlaneAPI, type ReleaseRolloutStatus } from '$lib/api/admin-control-plane';

const IDLE: ReleaseRolloutStatus = {
	operationId: null,
	sourceVersion: null,
	targetVersion: null,
	phase: 'idle',
	completedTargets: 0,
	totalTargets: 0,
	adminMutationMode: 'available',
	lastErrorCode: null,
	updatedAt: null,
	blockedTargetCount: 0,
	blockedTargets: []
};

export function createReleaseRolloutStore(
	api: Pick<typeof adminControlPlaneAPI, 'getReleaseRolloutStatus'> = adminControlPlaneAPI
) {
	let status = $state<ReleaseRolloutStatus>({ ...IDLE });
	let loading = $state(false);
	let available = $state(true);
	let hasSnapshot = $state(false);

	async function refresh() {
		if (loading) return;
		loading = true;
		try {
			status = (await api.getReleaseRolloutStatus()).rollout;
			available = true;
			hasSnapshot = true;
		} catch {
			available = false;
		} finally {
			loading = false;
		}
	}

	return {
		get status() {
			return status;
		},
		get loading() {
			return loading;
		},
		get available() {
			return available;
		},
		get active() {
			return hasSnapshot && !['idle', 'completed'].includes(status.phase);
		},
		get readOnly() {
			return hasSnapshot && status.adminMutationMode === 'read_only';
		},
		get shouldPoll() {
			return !hasSnapshot || !available || !['idle', 'completed'].includes(status.phase);
		},
		refresh
	};
}

export const releaseRolloutStore = createReleaseRolloutStore();
