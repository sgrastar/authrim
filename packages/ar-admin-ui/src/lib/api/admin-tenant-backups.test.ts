// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from 'vitest';
import { File as NodeFile } from 'node:buffer';
import {
	adminTenantBackupsAPI,
	extractTenantBackupEnvelope,
	inspectTenantBackupSource,
	saveTenantBackupResponse,
	type TenantBackupOperation
} from './admin-tenant-backups';
import { createTenantBundleKeyEnvelope } from '@authrim/ar-lib-core/services/tenant-portability/bundle-key-envelope';
import { encryptTenantBundleStream } from '@authrim/ar-lib-core/services/tenant-portability/bundle-cipher';
import { encodeTenantBackupContainerV2 } from '@authrim/ar-lib-core/services/tenant-portability/backup-container-v2';

beforeEach(() => {
	vi.restoreAllMocks();
	Reflect.deleteProperty(window, 'showSaveFilePicker');
	sessionStorage.clear();
	sessionStorage.setItem('settings_tenant_id', 'tenant-a');
});

it('streams downloads to a browser file handle without buffering the full artifact', async () => {
	const writes: number[][] = [];
	const writable = {
		write: vi.fn(async (chunk: Uint8Array) => {
			writes.push(Array.from(chunk));
		}),
		close: vi.fn(async () => undefined),
		abort: vi.fn(async () => undefined)
	};
	const picker = vi.fn(async () => ({ createWritable: async () => writable }));
	Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: picker });
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2]));
				controller.enqueue(new Uint8Array([3]));
				controller.close();
			}
		})
	);
	const blob = vi.spyOn(response, 'blob');

	await saveTenantBackupResponse(response, 'tenant.authrim');

	expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'tenant.authrim' }));
	expect(writes).toEqual([[1, 2], [3]]);
	expect(writable.close).toHaveBeenCalledOnce();
	expect(writable.abort).not.toHaveBeenCalled();
	expect(blob).not.toHaveBeenCalled();
});

it('extracts only the portable key envelope from an authenticated artifact header', () => {
	const header = new Uint8Array(137);
	header.set(new TextEncoder().encode('AUTHRIM1'));
	new DataView(header.buffer).setUint32(8, 125);
	header[12] = 1;
	for (let index = 13; index < 105; index += 1) header[index] = index;

	expect(extractTenantBackupEnvelope(header.buffer)).toEqual(header.slice(12, 105));
	header[0] = 0;
	expect(() => extractTenantBackupEnvelope(header.buffer)).toThrow(
		'Invalid Authrim tenant backup file'
	);
});

it('reads a cross-environment source identity from the locally decrypted manifest', async () => {
	const passphrase = 'correct horse battery staple';
	const session = await createTenantBundleKeyEnvelope(passphrase);
	const source = {
		tenantId: 'tenant-a',
		issuer: 'https://source.example',
		productVersion: '0.4.2'
	};
	const manifest = new TextEncoder().encode(JSON.stringify({ source }));
	const first = new Uint8Array(manifest.length + 1);
	first[0] = 1;
	first.set(manifest, 1);
	async function* plaintext() {
		yield first;
	}
	const frames: Uint8Array[] = [];
	for await (const frame of encryptTenantBundleStream(plaintext(), session)) frames.push(frame);
	const file = new NodeFile(
		frames.map((frame) => frame.slice()),
		'tenant.authrim'
	) as unknown as File;

	await expect(inspectTenantBackupSource(file, passphrase)).resolves.toEqual(source);
});

it('reads source identity and envelope from an authenticated v2 container', async () => {
	const passphrase = 'correct horse battery staple';
	const session = await createTenantBundleKeyEnvelope(passphrase);
	const source = {
		tenantId: 'tenant-a',
		issuer: 'https://source.example',
		productVersion: '0.4.2'
	};
	const container = await encodeTenantBackupContainerV2({
		manifest: {
			formatVersion: 1,
			bundleId: Array.from(session.envelope.slice(1, 17), (byte) =>
				byte.toString(16).padStart(2, '0')
			).join(''),
			source,
			snapshotId: 'snapshot-a',
			boundaryUnixMs: 1,
			inventoryDigestSha256: 'ab'.repeat(32),
			selection: {
				settings: true,
				users: false,
				admin: false,
				artifacts: false,
				logs: { audit: false, other: false, sensitive: false, period: 'all' }
			},
			datasets: []
		},
		datasets: (async function* () {})(),
		session
	});
	const file = new NodeFile(
		container.parts.map((part) => part.slice()),
		'tenant.authrim'
	) as unknown as File;

	expect(extractTenantBackupEnvelope(await file.slice(0, 137).arrayBuffer())).toEqual(
		session.envelope
	);
	await expect(inspectTenantBackupSource(file, passphrase)).resolves.toEqual(source);
});

it('lists public progress and submits the exact preview revision and digest for approval', async () => {
	const operation = {
		id: 'operation-a',
		kind: 'import',
		state: 'waiting',
		phase: 'await_restore_approval',
		revision: 9,
		createdAt: 1,
		updatedAt: 2,
		lastErrorCode: null,
		selection: {
			settings: true,
			users: false,
			admin: false,
			artifacts: false,
			logs: { audit: false, other: false, sensitive: false, period: 'all' }
		},
		publication: null,
		adminMapping: null,
		heldRecords: [],
		progress: null,
		preview: {
			planDigest: 'ab'.repeat(32),
			datasetCount: 2,
			recordCount: 3,
			datasets: [],
			prerequisites: [],
			deliverySafety: {},
			blockers: [],
			canApprove: true
		}
	} satisfies TenantBackupOperation;
	const fetchMock = vi
		.fn()
		.mockResolvedValueOnce(
			new Response(JSON.stringify({ operations: [operation] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		)
		.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					id: operation.id,
					kind: operation.kind,
					state: 'queued',
					phase: operation.phase,
					revision: 10
				}),
				{ status: 202, headers: { 'Content-Type': 'application/json' } }
			)
		);
	vi.stubGlobal('fetch', fetchMock);

	await expect(adminTenantBackupsAPI.list()).resolves.toEqual({ operations: [operation] });
	await adminTenantBackupsAPI.approve(operation);
	const [url, request] = fetchMock.mock.calls[1] as [string, RequestInit];
	expect(url).toContain('/api/admin/tenant-backups/operation-a/approve');
	expect(JSON.parse(String(request.body))).toEqual({
		revision: 9,
		planDigest: 'ab'.repeat(32)
	});
	expect(new Headers(request.headers).get('X-Tenant-Id')).toBe('tenant-a');
});

it('refuses approval when no current preview is available', () => {
	const operation = { id: 'operation-a', preview: null } as TenantBackupOperation;
	expect(() => adminTenantBackupsAPI.approve(operation)).toThrow('Restore preview is unavailable');
});
