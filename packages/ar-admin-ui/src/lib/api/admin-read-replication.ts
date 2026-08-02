import { adminFetch, API_BASE_URL } from './admin-request';

export type ReadReplicationAggregateStatus = 'off' | 'on' | 'updating' | 'attention_required';

export interface ReadReplicationStatus {
	environmentId: string;
	desiredMode: 'disabled' | 'enabled';
	aggregateStatus: ReadReplicationAggregateStatus;
	operationId: string | null;
	operationStatus:
		| 'queued'
		| 'applying'
		| 'verifying'
		| 'attention_required'
		| 'succeeded'
		| 'blocked'
		| null;
	eligiblePolicyCount: number;
	convergedPolicyCount: number;
	failedPolicyCount: number;
	targetCount: number;
	convergedTargetCount: number;
	pendingTargetCount: number;
	failedTargetCount: number;
	updatedAt: number;
}

interface ReadReplicationResponse {
	readReplication: ReadReplicationStatus;
	auditId?: string;
}

export class ReadReplicationApiError extends Error {
	constructor(
		public readonly status: number,
		message: string
	) {
		super(message);
		this.name = 'ReadReplicationApiError';
	}
}

async function responseJson(response: Response): Promise<ReadReplicationResponse> {
	const body = (await response.json().catch(() => null)) as
		| (Partial<ReadReplicationResponse> & { error?: string; error_description?: string })
		| null;
	if (!response.ok || !body?.readReplication) {
		throw new ReadReplicationApiError(
			response.status,
			body?.error_description ?? body?.error ?? 'READ_REPLICATION_REQUEST_FAILED'
		);
	}
	return body as ReadReplicationResponse;
}

export const adminReadReplicationAPI = {
	async get(): Promise<ReadReplicationStatus> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/platform/read-replication`, {
			skipTenantHeader: true
		});
		return (await responseJson(response)).readReplication;
	},

	async setEnabled(enabled: boolean): Promise<ReadReplicationStatus> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/platform/read-replication`, {
			method: 'PUT',
			includeJsonContentType: true,
			skipTenantHeader: true,
			body: JSON.stringify({ enabled })
		});
		return (await responseJson(response)).readReplication;
	}
};
