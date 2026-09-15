import {
	createTenantBundleKeyEnvelope,
	unlockTenantBundleKeyEnvelope
} from '@authrim/ar-lib-core/services/tenant-portability/bundle-key-envelope';
import type { TenantBackupKeyHandoffContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-key-handoff';
import { API_BASE_URL, adminFetch, buildAdminHeaders } from './admin-request';
import { hashTenantBackupFile } from './tenant-backup-sha256';

export interface TenantBackupSelection {
	settings: boolean;
	users: boolean;
	admin: boolean;
	artifacts: boolean;
	logs: {
		audit: boolean;
		other: boolean;
		sensitive: boolean;
		period: 7 | 30 | 90 | 'all';
	};
}

export interface TenantBackupOperationSummary {
	id: string;
	kind: 'export' | 'import';
	state:
		| 'queued'
		| 'running'
		| 'waiting'
		| 'ready'
		| 'completed'
		| 'failed'
		| 'cancelling'
		| 'cancelled';
	phase: string;
	revision: number;
	createdAt: number;
	updatedAt: number;
	lastErrorCode: string | null;
}

export interface TenantBackupOperation extends TenantBackupOperationSummary {
	selection: TenantBackupSelection;
	publication: { expiresAt: number; downloadAvailable: boolean } | null;
	adminMapping: {
		revision: number;
		state: 'open' | 'frozen';
		sourceCount: number;
		mappedCount: number;
		complete: boolean;
		digest: string | null;
	} | null;
	heldRecords: { datasetId: string; reason: string; count: number }[];
	preview: {
		planDigest: string;
		datasetCount: number;
		recordCount: number;
		datasets: { datasetId: string; recordCount: number }[];
		prerequisites: {
			id: string;
			kind: string;
			scope: 'tenant' | 'shared';
			resolution: 'included' | 'target_binding' | 'reconnect';
			status: 'resolved' | 'unresolved';
			required: boolean;
		}[];
		deliverySafety: Record<string, unknown>;
		blockers: { code: string; subjectId: string | null }[];
		canApprove: boolean;
	} | null;
}

export interface TenantBackupAdminMappingSource {
	sourceAdminId: string;
	targetAdminId: string | null;
	targetEmail: string | null;
	targetName: string | null;
}

export interface TenantBackupAdminMappingTarget {
	id: string;
	email: string;
	name: string | null;
}

export interface TenantBackupAdminMappings {
	status: NonNullable<TenantBackupOperation['adminMapping']>;
	sources: TenantBackupAdminMappingSource[];
	targets: TenantBackupAdminMappingTarget[];
}

interface CreatedOperation {
	id: string;
	kind: 'export' | 'import';
	state: string;
	phase: string;
	revision: number;
}

interface KeyChallenge {
	publicKey: JsonWebKey;
	context: TenantBackupKeyHandoffContext;
	submitExpiresAt: number;
}

interface UploadProgress {
	id: string;
	state: 'allocating' | 'uploading' | 'completing' | 'uploaded';
	sizeBytes: number;
	sha256: string;
	expiresAt: number;
}

interface TenantBackupWritableFile {
	write(chunk: Uint8Array): Promise<void>;
	close(): Promise<void>;
	abort(): Promise<void>;
}

interface TenantBackupSaveHandle {
	createWritable(): Promise<TenantBackupWritableFile>;
}

type TenantBackupSavePicker = (options: {
	suggestedName: string;
	types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<TenantBackupSaveHandle>;

function message(value: unknown, fallback: string): string {
	if (!value || typeof value !== 'object') return fallback;
	const body = value as Record<string, unknown>;
	for (const key of ['error_description', 'message', 'error']) {
		if (typeof body[key] === 'string' && body[key]) return body[key];
	}
	return fallback;
}

async function json<T>(
	path: string,
	options: RequestInit = {},
	fallback = 'Backup request failed'
) {
	const response = await adminFetch(`${API_BASE_URL}${path}`, {
		...options,
		includeJsonContentType: options.body !== undefined
	});
	if (!response.ok) throw new Error(message(await response.json().catch(() => null), fallback));
	return response.json() as Promise<T>;
}

function idempotencyKey(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function recipient(challenge: KeyChallenge) {
	if (challenge.submitExpiresAt <= Date.now()) throw new Error('Backup key challenge expired');
	const publicKey = await crypto.subtle.importKey(
		'jwk',
		challenge.publicKey,
		{ name: 'RSA-OAEP', hash: 'SHA-256' },
		false,
		['encrypt']
	);
	return { publicKey, context: challenge.context };
}

async function acceptKey(
	operationId: string,
	challenge: KeyChallenge,
	key: { envelope: Uint8Array; handoff?: Uint8Array }
) {
	if (!key.handoff) throw new Error('Backup key handoff was not created');
	await json(
		`/api/admin/tenant-backups/${encodeURIComponent(operationId)}/key-challenges/${encodeURIComponent(challenge.context.challengeId)}/accept`,
		{
			method: 'POST',
			body: JSON.stringify({ envelope: hex(key.envelope), handoff: hex(key.handoff) })
		}
	);
}

export function extractTenantBackupEnvelope(header: ArrayBuffer): Uint8Array {
	const bytes = new Uint8Array(header);
	if (
		bytes.length !== 137 ||
		new TextDecoder().decode(bytes.subarray(0, 8)) !== 'AUTHRIM1' ||
		new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8) !== 125 ||
		bytes[12] !== 1
	)
		throw new Error('Invalid Authrim tenant backup file');
	return bytes.slice(12, 105);
}

export async function saveTenantBackupResponse(
	response: Response,
	filename: string
): Promise<void> {
	const picker = (window as Window & { showSaveFilePicker?: TenantBackupSavePicker })
		.showSaveFilePicker;
	if (picker && response.body) {
		const handle = await picker({
			suggestedName: filename,
			types: [
				{
					description: 'Authrim tenant backup',
					accept: { 'application/octet-stream': ['.authrim'] }
				}
			]
		});
		const writable = await handle.createWritable();
		const reader = response.body.getReader();
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				await writable.write(chunk.value);
			}
			await writable.close();
		} catch (error) {
			await writable.abort().catch(() => undefined);
			throw error;
		} finally {
			reader.releaseLock();
		}
		return;
	}

	const blob = await response.blob();
	const url = URL.createObjectURL(blob);
	try {
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		link.click();
	} finally {
		URL.revokeObjectURL(url);
	}
}

export const adminTenantBackupsAPI = {
	list() {
		return json<{ operations: TenantBackupOperationSummary[] }>(
			'/api/admin/tenant-backups/operations'
		);
	},

	get(operationId: string) {
		return json<TenantBackupOperation>(
			`/api/admin/tenant-backups/${encodeURIComponent(operationId)}`
		);
	},

	async adminMappings(operationId: string): Promise<TenantBackupAdminMappings> {
		const sources = new Map<string, TenantBackupAdminMappingSource>();
		const targets = new Map<string, TenantBackupAdminMappingTarget>();
		let after = '';
		let targetAfter = '';
		let sourceDone = false;
		let targetDone = false;
		let status: TenantBackupAdminMappings['status'] | null = null;
		for (let page = 0; page < 100 && (!sourceDone || !targetDone); page += 1) {
			const query = new URLSearchParams();
			if (after) query.set('after', after);
			if (targetAfter) query.set('targetAfter', targetAfter);
			const response = await json<{
				status: TenantBackupAdminMappings['status'];
				sources: {
					entries: TenantBackupAdminMappingSource[];
					nextCursor: string;
					done: boolean;
				};
				targets: {
					entries: TenantBackupAdminMappingTarget[];
					nextCursor: string;
					done: boolean;
				};
			}>(`/api/admin/tenant-backups/${encodeURIComponent(operationId)}/admin-mappings?${query}`);
			status = response.status;
			for (const source of response.sources.entries) sources.set(source.sourceAdminId, source);
			for (const target of response.targets.entries) targets.set(target.id, target);
			if (!sourceDone) {
				sourceDone = response.sources.done;
				if (!sourceDone && response.sources.nextCursor === after)
					throw new Error('Admin mapping source pagination stalled');
				after = response.sources.nextCursor;
			}
			if (!targetDone) {
				targetDone = response.targets.done;
				if (!targetDone && response.targets.nextCursor === targetAfter)
					throw new Error('Admin mapping target pagination stalled');
				targetAfter = response.targets.nextCursor;
			}
		}
		if (!status || !sourceDone || !targetDone)
			throw new Error('Admin mappings exceed the supported page limit');
		return { status, sources: [...sources.values()], targets: [...targets.values()] };
	},

	mapAdmin(operationId: string, sourceAdminId: string, targetAdminId: string) {
		return json<{ status: NonNullable<TenantBackupOperation['adminMapping']> }>(
			`/api/admin/tenant-backups/${encodeURIComponent(operationId)}/admin-mappings`,
			{
				method: 'PUT',
				body: JSON.stringify({ sourceAdminId, targetAdminId })
			}
		);
	},

	async createExport(selection: TenantBackupSelection, passphrase: string) {
		const operation = await json<CreatedOperation>('/api/admin/tenant-backups/exports', {
			method: 'POST',
			body: JSON.stringify({ idempotencyKey: idempotencyKey('export'), selection })
		});
		const challenge = await json<KeyChallenge>(
			`/api/admin/tenant-backups/${encodeURIComponent(operation.id)}/key-challenges`,
			{ method: 'POST' }
		);
		const key = await createTenantBundleKeyEnvelope(passphrase, await recipient(challenge));
		await acceptKey(operation.id, challenge, key);
		return json<CreatedOperation>(
			`/api/admin/tenant-backups/${encodeURIComponent(operation.id)}/start`,
			{
				method: 'POST',
				body: JSON.stringify({
					revision: operation.revision,
					challengeId: challenge.context.challengeId
				})
			}
		);
	},

	async upload(file: File, onProgress?: (uploaded: number, total: number) => void) {
		if (file.size < 174) throw new Error('Invalid Authrim tenant backup file');
		const digest = hex(await hashTenantBackupFile(file));
		const allocated = await json<{
			id: string;
			partSize: number;
			partCount: number;
			expiresAt: number;
		}>('/api/admin/tenant-backups/uploads', {
			method: 'POST',
			body: JSON.stringify({
				idempotencyKey: idempotencyKey('upload'),
				sizeBytes: file.size,
				sha256: digest
			})
		});
		for (let index = 0; index < allocated.partCount; index += 1) {
			const start = index * allocated.partSize;
			const bytes = await file
				.slice(start, Math.min(file.size, start + allocated.partSize))
				.arrayBuffer();
			const response = await adminFetch(
				`${API_BASE_URL}/api/admin/tenant-backups/uploads/${encodeURIComponent(allocated.id)}/parts/${index + 1}`,
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/octet-stream' },
					body: bytes
				}
			);
			if (!response.ok)
				throw new Error(message(await response.json().catch(() => null), 'Backup upload failed'));
			onProgress?.(Math.min(file.size, start + bytes.byteLength), file.size);
		}
		await json(`/api/admin/tenant-backups/uploads/${encodeURIComponent(allocated.id)}/complete`, {
			method: 'POST'
		});
		return { id: allocated.id, sha256: digest };
	},

	async waitForUpload(uploadId: string, signal?: AbortSignal): Promise<UploadProgress> {
		for (let attempt = 0; attempt < 120; attempt += 1) {
			signal?.throwIfAborted();
			const upload = await json<UploadProgress>(
				`/api/admin/tenant-backups/uploads/${encodeURIComponent(uploadId)}`,
				{ signal }
			);
			if (upload.state === 'uploaded') return upload;
			await new Promise((resolve) => globalThis.setTimeout(resolve, 1000));
		}
		throw new Error('Backup upload verification timed out');
	},

	async createImport(
		file: File,
		uploadId: string,
		selection: TenantBackupSelection,
		passphrase: string
	) {
		const operation = await json<CreatedOperation>('/api/admin/tenant-backups/imports', {
			method: 'POST',
			body: JSON.stringify({
				idempotencyKey: idempotencyKey('import'),
				selection,
				uploadIds: [uploadId]
			})
		});
		const challenge = await json<KeyChallenge>(
			`/api/admin/tenant-backups/${encodeURIComponent(operation.id)}/key-challenges`,
			{ method: 'POST', body: JSON.stringify({ inputId: uploadId }) }
		);
		const envelope = extractTenantBackupEnvelope(await file.slice(0, 137).arrayBuffer());
		const key = await unlockTenantBundleKeyEnvelope(
			envelope,
			passphrase,
			await recipient(challenge)
		);
		await acceptKey(operation.id, challenge, key);
		return json<CreatedOperation>(
			`/api/admin/tenant-backups/${encodeURIComponent(operation.id)}/start`,
			{
				method: 'POST',
				body: JSON.stringify({
					revision: operation.revision,
					challenges: [{ inputId: uploadId, challengeId: challenge.context.challengeId }]
				})
			}
		);
	},

	approve(operation: TenantBackupOperation) {
		if (!operation.preview) throw new Error('Restore preview is unavailable');
		return json<CreatedOperation>(
			`/api/admin/tenant-backups/${encodeURIComponent(operation.id)}/approve`,
			{
				method: 'POST',
				body: JSON.stringify({
					revision: operation.revision,
					planDigest: operation.preview.planDigest,
					...(operation.selection.admin
						? { adminMappingRevision: operation.adminMapping?.revision }
						: {})
				})
			}
		);
	},

	cancel(operationId: string) {
		return json<{ id: string; state: string }>(
			`/api/admin/tenant-backups/${encodeURIComponent(operationId)}/cancel`,
			{ method: 'POST' }
		);
	},

	download(operationId: string, tenantId?: string) {
		return fetch(
			`${API_BASE_URL}/api/admin/tenant-backups/${encodeURIComponent(operationId)}/download`,
			{
				credentials: 'include',
				headers: buildAdminHeaders(undefined, { tenantId })
			}
		);
	}
};
