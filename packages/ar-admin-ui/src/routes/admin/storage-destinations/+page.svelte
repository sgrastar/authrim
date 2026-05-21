<script lang="ts">
	import { onMount } from 'svelte';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import {
		adminStorageDestinationsAPI,
		type ResourceScopeType,
		type StorageDestination,
		type StorageDestinationProvider
	} from '$lib/api/admin-storage-destinations';
	import {
		adminLoggingControlAPI,
		type AdminDestination,
		type AdminDestinationCredentialState,
		type AdminDestinationDiffPreview,
		type AdminDestinationScope
	} from '$lib/api/admin-logging-control';
	import DangerConfirmationModal from '$lib/components/admin/DangerConfirmationModal.svelte';

	type DangerConfirmationRequest = {
		title: string;
		resourceName: string;
		phrase: string;
		confirmLabel: string;
		resolve: (value: string | null) => void;
	};

	let scopeType = $state<ResourceScopeType>('platform');
	let controlPlaneScope = $state<AdminDestinationScope>('tenant');
	let items = $state<StorageDestination[]>([]);
	let controlPlaneItems = $state<AdminDestination[]>([]);
	let selected = $state<StorageDestination | null>(null);
	let selectedControlPlane = $state<AdminDestination | null>(null);
	let destinationDiffPreview = $state<AdminDestinationDiffPreview | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let healthActionId = $state<string | null>(null);
	let credentialActionId = $state<string | null>(null);
	let lifecycleActionId = $state<string | null>(null);
	let diffPreviewActionId = $state<string | null>(null);
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
	let dangerConfirmation = $state<DangerConfirmationRequest | null>(null);
	const isPlatformAdmin = $derived(Boolean(adminAuth.user?.isPlatformAdmin));
	const canManagePlatformStorage = $derived(isPlatformAdmin);
	const canManageControlPlaneDestination = $derived(isPlatformAdmin);
	const availableControlPlaneScopes = $derived<AdminDestinationScope[]>(
		isPlatformAdmin ? ['platform', 'tenant', 'shared'] : ['tenant', 'shared']
	);

	$effect(() => {
		if (!isPlatformAdmin && scopeType === 'platform') {
			scopeType = 'tenant';
		}
		if (!availableControlPlaneScopes.includes(controlPlaneScope)) {
			controlPlaneScope = availableControlPlaneScopes[0] ?? 'tenant';
		}
	});

	function requestDangerConfirmation(input: Omit<DangerConfirmationRequest, 'resolve'>) {
		return new Promise<string | null>((resolve) => {
			dangerConfirmation = { ...input, resolve };
		});
	}

	function cancelDangerConfirmation() {
		dangerConfirmation?.resolve(null);
		dangerConfirmation = null;
	}

	function confirmDangerConfirmation(value: string) {
		dangerConfirmation?.resolve(value);
		dangerConfirmation = null;
	}

	async function load() {
		loading = true;
		error = '';
		try {
			const storageScope = !isPlatformAdmin && scopeType === 'platform' ? 'tenant' : scopeType;
			const destinationScope = availableControlPlaneScopes.includes(controlPlaneScope)
				? controlPlaneScope
				: availableControlPlaneScopes[0];
			const [response, controlPlaneResponse] = await Promise.all([
				adminStorageDestinationsAPI.list(storageScope),
				adminLoggingControlAPI.listDestinations(destinationScope)
			]);
			items = response.items;
			controlPlaneItems = controlPlaneResponse.items;
			if (selected) {
				selected = items.find((item) => item.id === selected?.id) ?? null;
			}
			if (selectedControlPlane) {
				selectedControlPlane =
					controlPlaneItems.find((item) => item.id === selectedControlPlane?.id) ?? null;
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
				scope_type: 'platform',
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
		const confirmation = await requestDangerConfirmation({
			title: 'Delete Storage Destination',
			resourceName: selected.display_name,
			phrase: `DELETE STORAGE ${selected.name}`,
			confirmLabel: 'Delete'
		});
		if (!confirmation) return;
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

	async function runHealthCheck(destination: AdminDestination, checkType: 'quick' | 'deep') {
		if (healthActionId) return;
		healthActionId = destination.id;
		error = '';
		success = '';
		try {
			const response = await adminLoggingControlAPI.runDestinationHealthCheck(
				destination.id,
				checkType
			);
			controlPlaneItems = controlPlaneItems.map((item) =>
				item.id === destination.id
					? {
							...item,
							health_status: response.item.next_health_status,
							last_health_check_at: response.item.checked_at,
							updated_at: response.item.checked_at
						}
					: item
			);
			success = `Health check completed: ${response.item.next_health_status}`;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to run destination health check';
		} finally {
			healthActionId = null;
		}
	}

	async function loadControlPlaneDestinationDetail(destination: AdminDestination) {
		error = '';
		try {
			const response = await adminLoggingControlAPI.getDestination(destination.id);
			selectedControlPlane = response.item;
			destinationDiffPreview = null;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load destination detail';
		}
	}

	function patchControlPlaneLifecycleState(
		id: string,
		state: { lifecycle_status: string; version: number; updated_at: number }
	) {
		controlPlaneItems = controlPlaneItems.map((item) =>
			item.id === id
				? {
						...item,
						lifecycle_status: state.lifecycle_status as AdminDestination['lifecycle_status'],
						version: state.version,
						updated_at: state.updated_at
					}
				: item
		);
	}

	async function disableControlPlaneDestination(destination: AdminDestination) {
		if (lifecycleActionId) return;
		const expected = `FORCE DISABLE ${destination.name}`;
		const confirmation = await requestDangerConfirmation({
			title: 'Disable Logging Destination',
			resourceName: destination.display_name,
			phrase: expected,
			confirmLabel: 'Disable'
		});
		if (!confirmation) return;
		lifecycleActionId = destination.id;
		error = '';
		success = '';
		try {
			const response = await adminLoggingControlAPI.disableDestination(destination.id, confirmation);
			patchControlPlaneLifecycleState(destination.id, response.item);
			success = 'Destination disabled.';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to disable destination';
		} finally {
			lifecycleActionId = null;
		}
	}

	async function enableControlPlaneDestination(destination: AdminDestination) {
		if (lifecycleActionId) return;
		lifecycleActionId = destination.id;
		error = '';
		success = '';
		try {
			const response = await adminLoggingControlAPI.enableDestination(destination.id);
			patchControlPlaneLifecycleState(destination.id, response.item);
			success = 'Destination enabled.';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to enable destination';
		} finally {
			lifecycleActionId = null;
		}
	}

	function patchControlPlaneCredentialState(id: string, state: AdminDestinationCredentialState) {
		controlPlaneItems = controlPlaneItems.map((item) =>
			item.id === id
				? {
						...item,
						credential_ref: state.credential_ref ?? item.credential_ref,
						credential_version: state.credential_version ?? item.credential_version,
						next_credential_ref: state.next_credential_ref ?? null,
						next_credential_version: state.next_credential_version ?? null,
						previous_credential_ref: state.previous_credential_ref ?? null,
						previous_credential_retire_after: state.previous_credential_retire_after ?? null,
						rotation_status: state.rotation_status,
						version: state.version,
						updated_at: state.updated_at
					}
				: item
		);
	}

	async function prepareControlPlaneCredential(destination: AdminDestination) {
		if (credentialActionId) return;
		const secret = window.prompt(`Enter new credential secret for ${destination.name}`)?.trim();
		if (!secret) return;
		credentialActionId = destination.id;
		error = '';
		success = '';
		try {
			const response = await adminLoggingControlAPI.prepareDestinationCredential(destination.id, {
				secret_value: secret
			});
			patchControlPlaneCredentialState(destination.id, response.item);
			success = 'Credential rotation prepared.';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to prepare credential rotation';
		} finally {
			credentialActionId = null;
		}
	}

	async function markControlPlaneCredentialReady(destination: AdminDestination) {
		if (credentialActionId) return;
		credentialActionId = destination.id;
		error = '';
		success = '';
		try {
			const response = await adminLoggingControlAPI.markDestinationCredentialReady(destination.id);
			patchControlPlaneCredentialState(destination.id, response.item);
			success = 'Credential rotation marked ready.';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to mark credential ready';
		} finally {
			credentialActionId = null;
		}
	}

	async function activateControlPlaneCredential(destination: AdminDestination) {
		if (credentialActionId) return;
		const expected = `ACTIVATE CREDENTIAL ${destination.name}`;
		const confirmation = await requestDangerConfirmation({
			title: 'Activate Credential',
			resourceName: destination.display_name,
			phrase: expected,
			confirmLabel: 'Activate'
		});
		if (!confirmation) return;
		credentialActionId = destination.id;
		error = '';
		success = '';
		try {
			const response = await adminLoggingControlAPI.activateDestinationCredential(
				destination.id,
				confirmation
			);
			patchControlPlaneCredentialState(destination.id, response.item);
			success = 'Credential rotation activated.';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to activate credential rotation';
		} finally {
			credentialActionId = null;
		}
	}

	async function retirePreviousControlPlaneCredential(destination: AdminDestination) {
		if (credentialActionId) return;
		const needsConfirmation =
			destination.previous_credential_retire_after !== null &&
			destination.previous_credential_retire_after > Date.now();
		const expected = `RETIRE CREDENTIAL ${destination.name}`;
		const confirmation = needsConfirmation
			? await requestDangerConfirmation({
					title: 'Retire Previous Credential',
					resourceName: destination.display_name,
					phrase: expected,
					confirmLabel: 'Retire'
				})
			: undefined;
		if (needsConfirmation && !confirmation) return;
		credentialActionId = destination.id;
		error = '';
		success = '';
		try {
			const response = await adminLoggingControlAPI.retirePreviousDestinationCredential(
				destination.id,
				confirmation ?? undefined
			);
			patchControlPlaneCredentialState(destination.id, response.item);
			success = 'Previous credential retired.';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to retire previous credential';
		} finally {
			credentialActionId = null;
		}
	}

	function formatDate(timestamp: number | null): string {
		return timestamp ? new Date(timestamp).toLocaleString() : '-';
	}

	function parseJsonArrayText(value: string | null | undefined): string[] {
		if (!value) return [];
		try {
			const parsed = JSON.parse(value) as unknown;
			return Array.isArray(parsed)
				? parsed.filter((item): item is string => typeof item === 'string')
				: [];
		} catch {
			return [];
		}
	}

	function redactDisplayValue(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(redactDisplayValue);
		if (!value || typeof value !== 'object') return value;
		const redacted: Record<string, unknown> = {};
		for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
			if (/(secret|password|credential|token|api[_-]?key|private[_-]?key|authorization)/iu.test(key)) {
				redacted[key] = '[redacted]';
			} else {
				redacted[key] = redactDisplayValue(nestedValue);
			}
		}
		return redacted;
	}

	function jsonDisplayText(value: unknown): string {
		return JSON.stringify(redactDisplayValue(value), null, 2);
	}

	function providerConfigText(destination: AdminDestination): string {
		if (destination.provider_config && typeof destination.provider_config === 'object') {
			return jsonDisplayText(destination.provider_config);
		}
		try {
			return jsonDisplayText(JSON.parse(destination.provider_config ?? '{}'));
		} catch {
			return destination.provider_config || '{}';
		}
	}

	function listText(value: string | null | undefined): string {
		const items = parseJsonArrayText(value);
		return items.length > 0 ? items.join(', ') : 'All';
	}

	async function previewSelectedControlPlaneDiff() {
		if (!selectedControlPlane || diffPreviewActionId) return;
		diffPreviewActionId = selectedControlPlane.id;
		error = '';
		try {
			const response = await adminLoggingControlAPI.previewDestinationDiff(selectedControlPlane.id, {
				scope_type: selectedControlPlane.scope_type,
				scope_id: selectedControlPlane.scope_id,
				provider: selectedControlPlane.provider,
				name: selectedControlPlane.name,
				display_name: selectedControlPlane.display_name,
				description: selectedControlPlane.description,
				provider_config:
					typeof selectedControlPlane.provider_config === 'string'
						? JSON.parse(selectedControlPlane.provider_config || '{}')
						: selectedControlPlane.provider_config || {},
				allowed_tenant_ids: parseJsonArrayText(selectedControlPlane.allowed_tenant_ids),
				allowed_log_types: parseJsonArrayText(selectedControlPlane.allowed_log_types),
				allowed_planes: parseJsonArrayText(selectedControlPlane.allowed_planes),
				region: selectedControlPlane.region,
				critical_allowed: Boolean(selectedControlPlane.critical_allowed),
				default_fallback_eligible: Boolean(selectedControlPlane.default_fallback_eligible),
				retention_days: selectedControlPlane.retention_days,
				encryption_mode: selectedControlPlane.encryption_mode as 'platform_managed',
				capabilities:
					selectedControlPlane.capabilities
						?.filter((capability) => capability.enabled)
						.map((capability) => capability.capability) ?? [],
				expected_version: selectedControlPlane.version
			});
			destinationDiffPreview = response.item;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to preview destination diff';
		} finally {
			diffPreviewActionId = null;
		}
	}

	function closeControlPlaneDestinationDetail() {
		selectedControlPlane = null;
		destinationDiffPreview = null;
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
				{#if canManagePlatformStorage}
					<option value="platform">Platform</option>
				{/if}
			</select>
			<select bind:value={controlPlaneScope} onchange={load}>
				{#if isPlatformAdmin}
					<option value="platform">Platform Destinations</option>
				{/if}
				<option value="tenant">Tenant Destinations</option>
				<option value="shared">Shared Destinations</option>
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
					{#each items as item (item.id)}
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

		{#if canManagePlatformStorage}
			<section>
				<h2>Create Platform Destination</h2>
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
		{/if}
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
			<pre>{jsonDisplayText(selected.config)}</pre>
			{#if canManagePlatformStorage}
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
			{/if}
		</section>
	{/if}

	<section class="detail">
		<div class="section-header">
			<h2>Control Plane Destinations</h2>
			<span>{controlPlaneItems.length}</span>
		</div>
		{#if loading}
			<p class="muted">Loading...</p>
		{:else if controlPlaneItems.length === 0}
			<p class="muted">No control plane destinations.</p>
		{:else}
			<div class="control-table">
				<table>
					<thead>
						<tr>
							<th>Name</th>
							<th>Provider</th>
							<th>Runtime</th>
							<th>Lifecycle</th>
							<th>Health</th>
							<th>Credential</th>
							<th>Retention</th>
							<th>Last Check</th>
							<th>Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each controlPlaneItems as item (item.id)}
							<tr>
								<td>
									<strong>{item.display_name}</strong>
									<small>{item.name}</small>
								</td>
								<td>{item.provider}</td>
								<td>
									{item.runtime_status ?? 'unknown'}
									{#if item.runtime_unsupported_reason}
										<small>{item.runtime_unsupported_reason}</small>
									{/if}
								</td>
								<td>{item.lifecycle_status}</td>
								<td>{item.health_status}</td>
								<td>
									<strong>v{item.credential_version}</strong>
									<small>{item.rotation_status}</small>
								</td>
								<td>{item.retention_days ? `${item.retention_days} days` : 'Default'}</td>
								<td>{formatDate(item.last_health_check_at)}</td>
								<td>
									<div class="row-actions">
										<button
											class="btn btn-secondary"
											onclick={() => loadControlPlaneDestinationDetail(item)}
										>
											Details
										</button>
										<button
											class="btn btn-secondary"
											onclick={() => runHealthCheck(item, 'quick')}
											disabled={Boolean(healthActionId)}
										>
											Quick Check
										</button>
										<button
											class="btn btn-secondary"
											onclick={() => runHealthCheck(item, 'deep')}
											disabled={Boolean(healthActionId)}
										>
											Deep Check
										</button>
										{#if canManageControlPlaneDestination}
											{#if item.lifecycle_status === 'disabled'}
												<button
													class="btn btn-secondary"
													onclick={() => enableControlPlaneDestination(item)}
													disabled={Boolean(lifecycleActionId)}
												>
													Enable
												</button>
											{:else}
												<button
													class="btn btn-secondary"
													onclick={() => disableControlPlaneDestination(item)}
													disabled={Boolean(lifecycleActionId)}
												>
													Disable
												</button>
											{/if}
											<button
												class="btn btn-secondary"
												onclick={() => prepareControlPlaneCredential(item)}
												disabled={Boolean(credentialActionId)}
											>
												Prepare
											</button>
											<button
												class="btn btn-secondary"
												onclick={() => markControlPlaneCredentialReady(item)}
												disabled={Boolean(credentialActionId) || !item.next_credential_ref}
											>
												Ready
											</button>
											<button
												class="btn btn-secondary"
												onclick={() => activateControlPlaneCredential(item)}
												disabled={Boolean(credentialActionId) || !item.next_credential_ref}
											>
												Activate
											</button>
											<button
												class="btn btn-secondary"
												onclick={() => retirePreviousControlPlaneCredential(item)}
												disabled={Boolean(credentialActionId) || !item.previous_credential_ref}
											>
												Retire
											</button>
										{/if}
									</div>
								</td>
							</tr>
							<tr class="config-row">
								<td colspan="9"><pre>{providerConfigText(item)}</pre></td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	{#if selectedControlPlane}
		<aside class="detail-drawer" aria-label="Storage destination details">
			<div class="drawer-header">
				<div>
					<h2>{selectedControlPlane.display_name}</h2>
					<span>{selectedControlPlane.scope_type}:{selectedControlPlane.scope_id}</span>
				</div>
				<button
					class="btn btn-secondary"
					type="button"
					onclick={closeControlPlaneDestinationDetail}
				>
					Close
				</button>
			</div>
			<div class="drawer-actions">
				<button
					class="btn btn-secondary"
					type="button"
					onclick={previewSelectedControlPlaneDiff}
					disabled={diffPreviewActionId === selectedControlPlane.id}
				>
					{diffPreviewActionId === selectedControlPlane.id ? 'Previewing...' : 'Preview diff'}
				</button>
			</div>
			<div class="detail-grid">
				<div><span>Provider</span><strong>{selectedControlPlane.provider}</strong></div>
				<div>
					<span>Runtime</span><strong>{selectedControlPlane.runtime_status ?? 'unknown'}</strong>
				</div>
				<div><span>Lifecycle</span><strong>{selectedControlPlane.lifecycle_status}</strong></div>
				<div><span>Health</span><strong>{selectedControlPlane.health_status}</strong></div>
				<div>
					<span>Retention</span><strong
						>{selectedControlPlane.retention_days
							? `${selectedControlPlane.retention_days} days`
							: 'Platform default'}</strong
					>
				</div>
				<div><span>Region</span><strong>{selectedControlPlane.region ?? 'Any'}</strong></div>
				<div>
					<span>Critical</span><strong
						>{selectedControlPlane.critical_allowed ? 'Allowed' : 'Not allowed'}</strong
					>
				</div>
				<div>
					<span>Fallback</span><strong
						>{selectedControlPlane.default_fallback_eligible ? 'Eligible' : 'Not eligible'}</strong
					>
				</div>
				<div>
					<span>Encryption</span><strong>{selectedControlPlane.encryption_mode}</strong>
				</div>
				{#if selectedControlPlane.runtime_unsupported_reason}
					<div>
						<span>Runtime reason</span><strong>{selectedControlPlane.runtime_unsupported_reason}</strong>
					</div>
				{/if}
			</div>
			<div class="usage-grid">
				<div>
					<span>Allowed tenants</span>
					<strong>{listText(selectedControlPlane.allowed_tenant_ids)}</strong>
				</div>
				<div>
					<span>Allowed log types</span>
					<strong>{listText(selectedControlPlane.allowed_log_types)}</strong>
				</div>
				<div>
					<span>Allowed planes</span>
					<strong>{listText(selectedControlPlane.allowed_planes)}</strong>
				</div>
				<div>
					<span>Capabilities</span>
					<strong
						>{selectedControlPlane.capabilities
							?.filter((capability) => capability.enabled)
							.map((capability) => capability.capability)
							.join(', ') || 'None'}</strong
					>
				</div>
			</div>
			<pre>{providerConfigText(selectedControlPlane)}</pre>
			{#if destinationDiffPreview}
				<div class="usage-grid">
					<div>
						<span>Diff state</span>
						<strong>{destinationDiffPreview.dangerous_classification}</strong>
					</div>
					<div>
						<span>Changed fields</span>
						<strong>{destinationDiffPreview.diff.length}</strong>
					</div>
					<div>
						<span>Confirmation</span>
						<strong>{destinationDiffPreview.confirmation ?? '-'}</strong>
					</div>
				</div>
				<pre>{jsonDisplayText({
						diff: destinationDiffPreview.diff,
						affected_assignments: destinationDiffPreview.affected_assignments,
						dangerous_reasons: destinationDiffPreview.dangerous_reasons
					})}</pre>
			{/if}
		</aside>
	{/if}
</div>

<DangerConfirmationModal
	open={Boolean(dangerConfirmation)}
	title={dangerConfirmation?.title ?? ''}
	resourceName={dangerConfirmation?.resourceName ?? ''}
	phrase={dangerConfirmation?.phrase ?? ''}
	confirmLabel={dangerConfirmation?.confirmLabel ?? 'Confirm'}
	onConfirm={confirmDangerConfirmation}
	onCancel={cancelDangerConfirmation}
/>

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
	.detail-drawer {
		position: fixed;
		top: 0;
		right: 0;
		z-index: 30;
		width: min(560px, calc(100vw - 24px));
		height: 100vh;
		overflow: auto;
		background: #fff;
		border-left: 1px solid #d4d4d4;
		box-shadow: -12px 0 28px rgb(0 0 0 / 0.14);
		padding: 20px;
	}
	.drawer-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 16px;
	}
	.drawer-header h2 {
		margin: 0 0 4px;
	}
	.drawer-header span {
		color: #666;
		font-size: 0.9rem;
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
	.usage-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
		margin: 12px 0;
	}
	.detail-grid div,
	.usage-grid div {
		border: 1px solid #e5e5e5;
		border-radius: 6px;
		padding: 12px;
	}
	.detail-grid span,
	.usage-grid span {
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
	.control-table {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
	}
	th,
	td {
		border-bottom: 1px solid #e5e5e5;
		padding: 10px;
		text-align: left;
		vertical-align: top;
	}
	td strong,
	td small {
		display: block;
	}
	.config-row pre {
		margin: 0 0 12px;
		max-height: 180px;
	}
	.row-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
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
		.detail-grid,
		.usage-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
