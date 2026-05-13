<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminStorageDestinationsAPI,
		type ResourceScopeType,
		type StorageDestination,
		type StorageDestinationProvider
	} from '$lib/api/admin-storage-destinations';

	let scopeType = $state<ResourceScopeType>('tenant');
	let items = $state<StorageDestination[]>([]);
	let selected = $state<StorageDestination | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let success = $state('');

	let newName = $state('');
	let newDisplayName = $state('');
	let newDescription = $state('');
	let newProvider = $state<StorageDestinationProvider>('r2');
	let newConfig = $state('{\n  "bindingRef": "DIAGNOSTIC_LOGS"\n}');
	let newCredential = $state('');

	let credentialPayload = $state('');
	let elevationGrantId = $state('');

	async function load() {
		loading = true;
		error = '';
		try {
			const response = await adminStorageDestinationsAPI.list(scopeType);
			items = response.items;
			if (selected) {
				selected = items.find((item) => item.id === selected?.id) ?? null;
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load storage destinations';
			items = [];
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function parseJsonField(value: string): Record<string, unknown> {
		const trimmed = value.trim();
		if (!trimmed) return {};
		const parsed = JSON.parse(trimmed);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('JSON must be an object');
		}
		return parsed as Record<string, unknown>;
	}

	async function createDestination() {
		saving = true;
		error = '';
		success = '';
		try {
			const config = parseJsonField(newConfig);
			const credential = newCredential.trim() ? parseJsonField(newCredential) : undefined;
			await adminStorageDestinationsAPI.create({
				scope_type: scopeType,
				name: newName.trim(),
				display_name: newDisplayName.trim() || newName.trim(),
				description: newDescription.trim() || null,
				provider: newProvider,
				config,
				credential
			});
			newName = '';
			newDisplayName = '';
			newDescription = '';
			newCredential = '';
			success = 'Storage destination created.';
			await load();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create storage destination';
		} finally {
			saving = false;
		}
	}

	async function rotateCredential() {
		if (!selected) return;
		saving = true;
		error = '';
		success = '';
		try {
			const credential = parseJsonField(credentialPayload);
			selected = await adminStorageDestinationsAPI.updateCredential(
				selected.id,
				credential,
				elevationGrantId.trim() || undefined
			);
			credentialPayload = '';
			elevationGrantId = '';
			success = 'Storage credential updated.';
			await load();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to update storage credential';
		} finally {
			saving = false;
		}
	}

	async function deleteSelected() {
		if (!selected) return;
		if (!confirm(`Delete storage destination "${selected.display_name}"?`)) return;
		saving = true;
		error = '';
		success = '';
		try {
			await adminStorageDestinationsAPI.delete(selected.id, elevationGrantId.trim() || undefined);
			selected = null;
			elevationGrantId = '';
			success = 'Storage destination deleted.';
			await load();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to delete storage destination';
		} finally {
			saving = false;
		}
	}

	function formatDate(timestamp: number | null): string {
		return timestamp ? new Date(timestamp).toLocaleString() : '-';
	}
</script>

<svelte:head>
	<title>Storage Destinations - Authrim</title>
</svelte:head>

<div class="admin-page">
	<div class="page-header">
		<div>
			<h1 class="page-title">Storage Destinations</h1>
			<p class="page-description">Manage approved R2, S3, SFTP, and custom storage endpoints</p>
		</div>
		<div class="page-actions">
			<select bind:value={scopeType} onchange={load}>
				<option value="tenant">Tenant</option>
				<option value="platform">Platform</option>
			</select>
			<button class="btn btn-secondary" onclick={load} disabled={loading}>Refresh</button>
		</div>
	</div>

	{#if error}<div class="alert error">{error}</div>{/if}
	{#if success}<div class="alert success">{success}</div>{/if}

	<div class="resource-grid">
		<section>
			<div class="section-header">
				<h2>Destinations</h2>
				<span>{items.length}</span>
			</div>
			{#if loading}
				<p class="muted">Loading...</p>
			{:else if items.length === 0}
				<p class="muted">No storage destinations.</p>
			{:else}
				<div class="table">
					{#each items as item}
						<button
							class:selected={selected?.id === item.id}
							class="row"
							onclick={() => (selected = item)}
						>
							<span>
								<strong>{item.display_name}</strong>
								<small>{item.name}</small>
							</span>
							<span>{item.provider}</span>
							<span>{item.status}</span>
							<span>{item.has_credential ? 'credential set' : 'no credential'}</span>
						</button>
					{/each}
				</div>
			{/if}
		</section>

		<section>
			<h2>Create</h2>
			<div class="form-grid">
				<label>
					Name
					<input bind:value={newName} placeholder="tenant-logs" />
				</label>
				<label>
					Display name
					<input bind:value={newDisplayName} placeholder="Tenant Logs" />
				</label>
				<label>
					Provider
					<select bind:value={newProvider}>
						<option value="r2">R2</option>
						<option value="aws_s3">AWS S3</option>
						<option value="sftp">SFTP</option>
						<option value="custom">Custom</option>
					</select>
				</label>
				<label>
					Description
					<input bind:value={newDescription} />
				</label>
				<label class="wide">
					Config JSON
					<textarea rows="7" bind:value={newConfig}></textarea>
				</label>
				<label class="wide">
					Credential JSON
					<textarea rows="5" bind:value={newCredential} placeholder="JSON credential object"
					></textarea>
				</label>
				<button class="btn btn-primary" onclick={createDestination} disabled={saving || !newName}>
					Create Destination
				</button>
			</div>
		</section>
	</div>

	{#if selected}
		<section class="detail">
			<div class="section-header">
				<h2>{selected.display_name}</h2>
				<span>{selected.scope_type}:{selected.scope_id}</span>
			</div>
			<div class="detail-grid">
				<div><span>Provider</span><strong>{selected.provider}</strong></div>
				<div><span>Status</span><strong>{selected.status}</strong></div>
				<div>
					<span>Credential</span><strong>{selected.has_credential ? 'Set' : 'Not set'}</strong>
				</div>
				<div>
					<span>Credential Updated</span><strong
						>{formatDate(selected.credential_updated_at)}</strong
					>
				</div>
			</div>
			<pre>{JSON.stringify(selected.config, null, 2)}</pre>
			<div class="credential-panel">
				<label>
					Elevation grant ID
					<input
						bind:value={elevationGrantId}
						placeholder="Required unless caller has wildcard access"
					/>
				</label>
				<label>
					New credential JSON
					<textarea rows="4" bind:value={credentialPayload} placeholder="JSON credential object"
					></textarea>
				</label>
				<div class="actions">
					<button
						class="btn btn-secondary"
						onclick={rotateCredential}
						disabled={saving || !credentialPayload}
					>
						Update Credential
					</button>
					<button class="btn btn-danger" onclick={deleteSelected} disabled={saving}>Delete</button>
				</div>
			</div>
		</section>
	{/if}
</div>

<style>
	.admin-page {
		padding: 24px;
	}
	.page-header,
	.section-header,
	.page-actions,
	.actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.page-title {
		margin: 0 0 6px;
	}
	.page-description,
	.muted,
	small {
		color: #666;
	}
	.alert {
		margin: 16px 0;
		padding: 12px;
		border-radius: 6px;
	}
	.error {
		background: #fee2e2;
		color: #991b1b;
	}
	.success {
		background: #dcfce7;
		color: #166534;
	}
	.resource-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(360px, 0.7fr);
		gap: 20px;
	}
	section {
		margin-top: 20px;
	}
	.table {
		border: 1px solid #ddd;
		border-radius: 6px;
		overflow: hidden;
	}
	.row {
		width: 100%;
		display: grid;
		grid-template-columns: 1.4fr 0.7fr 0.6fr 0.8fr;
		gap: 12px;
		padding: 12px;
		border: 0;
		border-bottom: 1px solid #eee;
		background: #fff;
		text-align: left;
	}
	.row.selected,
	.row:hover {
		background: #f7f7f7;
	}
	.form-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}
	label {
		display: grid;
		gap: 6px;
		font-size: 0.9rem;
	}
	.wide {
		grid-column: 1 / -1;
	}
	input,
	select,
	textarea {
		border: 1px solid #d4d4d4;
		border-radius: 6px;
		padding: 8px;
		font: inherit;
	}
	textarea,
	pre {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	pre {
		padding: 12px;
		background: #f7f7f7;
		border-radius: 6px;
		overflow: auto;
	}
	.detail-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 12px;
	}
	.detail-grid div {
		border: 1px solid #e5e5e5;
		border-radius: 6px;
		padding: 12px;
	}
	.detail-grid span {
		display: block;
		color: #666;
		font-size: 0.8rem;
		margin-bottom: 6px;
	}
	.credential-panel {
		display: grid;
		gap: 12px;
		max-width: 720px;
	}
	.btn {
		border: 0;
		border-radius: 6px;
		padding: 9px 14px;
		cursor: pointer;
	}
	.btn-primary {
		background: #111;
		color: #fff;
	}
	.btn-secondary {
		background: #eee;
	}
	.btn-danger {
		background: #b91c1c;
		color: #fff;
	}
	@media (max-width: 900px) {
		.resource-grid,
		.detail-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
