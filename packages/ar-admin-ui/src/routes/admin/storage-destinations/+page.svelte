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
	let newR2BindingRef = $state('');
	let newR2Prefix = $state('');
	let newR2Region = $state('');
	let newR2StorageClass = $state('');
	let newAwsBucket = $state('');
	let newAwsRegion = $state('');
	let newAwsPrefix = $state('');
	let newAwsEndpoint = $state('');
	let newAwsForcePathStyle = $state(false);
	let newAwsAccessKeyId = $state('');
	let newAwsSecretAccessKey = $state('');
	let newAwsSessionToken = $state('');
	let newCustomType = $state('');
	let newCustomConfig = $state('');
	let newCustomCredential = $state('');

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

	function optionalString(value: string): string | undefined {
		const trimmed = value.trim();
		return trimmed ? trimmed : undefined;
	}

	function requiredString(value: string, label: string): string {
		const trimmed = value.trim();
		if (!trimmed) {
			throw new Error(`${label} is required.`);
		}
		return trimmed;
	}

	function buildCreateConfig(): Record<string, unknown> {
		if (newProvider === 'r2') {
			return {
				bindingRef: requiredString(newR2BindingRef, 'R2 binding reference'),
				...(optionalString(newR2Prefix) ? { prefix: optionalString(newR2Prefix) } : {}),
				...(optionalString(newR2Region) ? { region: optionalString(newR2Region) } : {}),
				...(optionalString(newR2StorageClass)
					? { storageClass: optionalString(newR2StorageClass) }
					: {})
			};
		}
		if (newProvider === 'aws_s3') {
			return {
				bucket: requiredString(newAwsBucket, 'S3 bucket'),
				region: requiredString(newAwsRegion, 'S3 region'),
				...(optionalString(newAwsPrefix) ? { prefix: optionalString(newAwsPrefix) } : {}),
				...(optionalString(newAwsEndpoint) ? { endpoint: optionalString(newAwsEndpoint) } : {}),
				...(newAwsForcePathStyle ? { forcePathStyle: true } : {})
			};
		}
		const customConfig = parseJsonField(newCustomConfig);
		return {
			type: requiredString(newCustomType, 'Custom destination type'),
			...(Object.keys(customConfig).length > 0 ? { config: customConfig } : {})
		};
	}

	function buildCreateCredential(): Record<string, unknown> | undefined {
		if (newProvider === 'aws_s3') {
			const credential = {
				...(optionalString(newAwsAccessKeyId)
					? { accessKeyId: optionalString(newAwsAccessKeyId) }
					: {}),
				...(optionalString(newAwsSecretAccessKey)
					? { secretAccessKey: optionalString(newAwsSecretAccessKey) }
					: {}),
				...(optionalString(newAwsSessionToken)
					? { sessionToken: optionalString(newAwsSessionToken) }
					: {})
			};
			return Object.keys(credential).length > 0 ? credential : undefined;
		}
		if (newProvider === 'custom') {
			const credential = parseJsonField(newCustomCredential);
			return Object.keys(credential).length > 0 ? credential : undefined;
		}
		return undefined;
	}

	function resetCreateForm() {
		newName = '';
		newDisplayName = '';
		newDescription = '';
		newR2BindingRef = '';
		newR2Prefix = '';
		newR2Region = '';
		newR2StorageClass = '';
		newAwsBucket = '';
		newAwsRegion = '';
		newAwsPrefix = '';
		newAwsEndpoint = '';
		newAwsForcePathStyle = false;
		newAwsAccessKeyId = '';
		newAwsSecretAccessKey = '';
		newAwsSessionToken = '';
		newCustomType = '';
		newCustomConfig = '';
		newCustomCredential = '';
	}

	async function createDestination() {
		saving = true;
		error = '';
		success = '';
		try {
			const config = buildCreateConfig();
			const credential = buildCreateCredential();
			await adminStorageDestinationsAPI.create({
				scope_type: 'platform',
				name: newName.trim(),
				display_name: newDisplayName.trim() || newName.trim(),
				description: newDescription.trim() || null,
				provider: newProvider,
				config,
				credential
			});
			resetCreateForm();
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
			const response = await adminLoggingControlAPI.disableDestination(
				destination.id,
				confirmation
			);
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
			if (
				/(secret|password|credential|token|api[_-]?key|private[_-]?key|authorization)/iu.test(key)
			) {
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
			const response = await adminLoggingControlAPI.previewDestinationDiff(
				selectedControlPlane.id,
				{
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
				}
			);
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

<div class="page-shell">
	<header class="page-header">
		<div class="page-title-group">
			<h1 class="page-title">Storage Destinations</h1>
			<p class="page-description">Manage approved R2, S3, and custom storage endpoints</p>
		</div>
		<div class="page-actions">
			<label class="scope-label">
				<span>Registry</span>
				<select bind:value={scopeType} onchange={load}>
					<option value="tenant">Tenant</option>
					{#if canManagePlatformStorage}
						<option value="platform">Platform</option>
					{/if}
				</select>
			</label>
			<label class="scope-label">
				<span>Control plane</span>
				<select bind:value={controlPlaneScope} onchange={load}>
					{#if isPlatformAdmin}
						<option value="platform">Platform</option>
					{/if}
					<option value="tenant">Tenant</option>
					<option value="shared">Shared</option>
				</select>
			</label>
			<button class="btn btn-secondary" onclick={load} disabled={loading}>Refresh</button>
		</div>
	</header>

	{#if error}<div class="alert alert-error">{error}</div>{/if}
	{#if success}<div class="alert alert-success">{success}</div>{/if}

	<div class="split-panel">
		<div class="panel">
			<div class="panel-header">
				<h2 class="panel-title">Destinations</h2>
				<span class="badge badge-neutral">{items.length}</span>
			</div>
			{#if loading}
				<p class="text-muted">Loading...</p>
			{:else if items.length === 0}
				<p class="text-muted">No storage destinations.</p>
			{:else}
				<div class="item-list">
					{#each items as item (item.id)}
						<button
							class="item-row"
							class:selected={selected?.id === item.id}
							onclick={() => (selected = item)}
						>
							<div class="item-name">
								<strong>{item.display_name}</strong>
								<small>{item.name}</small>
							</div>
							<span class="badge badge-neutral">{item.provider}</span>
							<span class="badge {item.status === 'active' ? 'badge-success' : 'badge-neutral'}"
								>{item.status}</span
							>
							<span class="text-muted text-sm"
								>{item.has_credential ? 'credential set' : 'no credential'}</span
							>
						</button>
					{/each}
				</div>
			{/if}
		</div>

		{#if canManagePlatformStorage}
			<div class="panel create-panel">
				<div class="panel-header">
					<div>
						<h2 class="panel-title">Create Platform Destination</h2>
						<p class="panel-description">
							Register a storage target that other logging and job features can select.
						</p>
					</div>
				</div>
				<div class="form-grid">
					<label class="form-label-group">
						<span>Name</span>
						<input bind:value={newName} />
						<small>Stable identifier used by API and audit records.</small>
					</label>
					<label class="form-label-group">
						<span>Display name</span>
						<input bind:value={newDisplayName} />
						<small>Human-readable name shown in Admin UI pickers.</small>
					</label>
					<label class="form-label-group">
						<span>Provider</span>
						<select bind:value={newProvider}>
							<option value="r2">R2</option>
							<option value="aws_s3">AWS S3</option>
							<option value="custom">Custom</option>
						</select>
					</label>
					<label class="form-label-group">
						<span>Description</span>
						<input bind:value={newDescription} />
						<small>Optional operational note for where this destination is used.</small>
					</label>

					<div class="form-section wide">
						<div>
							<h3 class="form-section-title">Provider settings</h3>
							<p class="form-section-description">
								These fields become the destination config stored by the API.
							</p>
						</div>
						{#if newProvider === 'r2'}
							<div class="form-grid nested">
								<label class="form-label-group">
									<span>R2 binding reference</span>
									<input bind:value={newR2BindingRef} />
									<small
										>Worker binding name, for example the R2 bucket binding configured by setup.</small
									>
								</label>
								<label class="form-label-group">
									<span>Object prefix</span>
									<input bind:value={newR2Prefix} />
									<small>Optional key prefix for logs or artifacts in the bucket.</small>
								</label>
								<label class="form-label-group">
									<span>Region</span>
									<input bind:value={newR2Region} />
									<small>Optional locality label for routing and operations.</small>
								</label>
								<label class="form-label-group">
									<span>Storage class</span>
									<input bind:value={newR2StorageClass} />
									<small>Optional storage class metadata if the provider uses one.</small>
								</label>
							</div>
						{:else if newProvider === 'aws_s3'}
							<div class="form-grid nested">
								<label class="form-label-group">
									<span>S3 bucket</span>
									<input bind:value={newAwsBucket} />
									<small>Bucket name used for archive objects and exported artifacts.</small>
								</label>
								<label class="form-label-group">
									<span>Region</span>
									<input bind:value={newAwsRegion} />
									<small>AWS region for the bucket.</small>
								</label>
								<label class="form-label-group">
									<span>Object prefix</span>
									<input bind:value={newAwsPrefix} />
									<small>Optional key prefix inside the bucket.</small>
								</label>
								<label class="form-label-group">
									<span>Endpoint URL</span>
									<input bind:value={newAwsEndpoint} />
									<small>Optional S3-compatible endpoint URL.</small>
								</label>
								<label class="checkbox-row wide">
									<input type="checkbox" bind:checked={newAwsForcePathStyle} />
									<span>Use path-style bucket addressing</span>
								</label>
							</div>
						{:else}
							<div class="form-grid nested">
								<label class="form-label-group">
									<span>Custom type</span>
									<input bind:value={newCustomType} />
									<small>Provider-specific destination type.</small>
								</label>
								<label class="form-label-group wide">
									<span>Advanced fields</span>
									<textarea rows="5" bind:value={newCustomConfig}></textarea>
									<small>Optional object for fields that do not have a dedicated control yet.</small
									>
								</label>
							</div>
						{/if}
					</div>

					{#if newProvider !== 'r2'}
						<div class="form-section wide">
							<div>
								<h3 class="form-section-title">Credentials</h3>
								<p class="form-section-description">
									Secrets are encrypted by the management API and are not stored in config.
								</p>
							</div>
							{#if newProvider === 'aws_s3'}
								<div class="form-grid nested">
									<label class="form-label-group">
										<span>Access key ID</span>
										<input bind:value={newAwsAccessKeyId} autocomplete="off" />
									</label>
									<label class="form-label-group">
										<span>Secret access key</span>
										<input
											type="password"
											bind:value={newAwsSecretAccessKey}
											autocomplete="new-password"
										/>
									</label>
									<label class="form-label-group wide">
										<span>Session token</span>
										<textarea rows="3" bind:value={newAwsSessionToken} autocomplete="off"
										></textarea>
										<small>Optional temporary credential token.</small>
									</label>
								</div>
							{:else}
								<label class="form-label-group">
									<span>Credential object</span>
									<textarea rows="5" bind:value={newCustomCredential} autocomplete="off"></textarea>
									<small>Optional encrypted credential object for custom providers.</small>
								</label>
							{/if}
						</div>
					{/if}
					<div class="form-actions">
						<button
							class="btn btn-primary"
							onclick={createDestination}
							disabled={saving || !newName}
						>
							Create Destination
						</button>
					</div>
				</div>
			</div>
		{/if}
	</div>

	{#if selected}
		<div class="panel">
			<div class="panel-header">
				<div>
					<h2 class="panel-title">{selected.display_name}</h2>
					<p class="text-muted text-sm">{selected.scope_type}:{selected.scope_id}</p>
				</div>
				{#if canManagePlatformStorage}
					<button class="btn btn-danger btn-sm" onclick={deleteSelected} disabled={saving}
						>Delete</button
					>
				{/if}
			</div>
			<div class="stat-grid">
				<div class="stat-card"><span>Provider</span><strong>{selected.provider}</strong></div>
				<div class="stat-card"><span>Status</span><strong>{selected.status}</strong></div>
				<div class="stat-card">
					<span>Credential</span><strong>{selected.has_credential ? 'Set' : 'Not set'}</strong>
				</div>
				<div class="stat-card">
					<span>Credential Updated</span><strong
						>{formatDate(selected.credential_updated_at)}</strong
					>
				</div>
			</div>
			<pre class="code-block">{jsonDisplayText(selected.config)}</pre>
			{#if canManagePlatformStorage}
				<div class="credential-section">
					<h3 class="subsection-title">Update Credential</h3>
					<div class="form-grid">
						<label class="form-label-group wide">
							<span>Elevation grant ID</span>
							<input bind:value={elevationGrantId} />
							<small>Required unless the caller already has wildcard credential access.</small>
						</label>
						<label class="form-label-group wide">
							<span>New credential object</span>
							<textarea rows="4" bind:value={credentialPayload}></textarea>
						</label>
					</div>
					<div class="form-actions">
						<button
							class="btn btn-secondary"
							onclick={rotateCredential}
							disabled={saving || !credentialPayload}
						>
							Update Credential
						</button>
					</div>
				</div>
			{/if}
		</div>
	{/if}

	<div class="panel">
		<div class="panel-header">
			<h2 class="panel-title">Control Plane Destinations</h2>
			<span class="badge badge-neutral">{controlPlaneItems.length}</span>
		</div>
		{#if loading}
			<p class="text-muted">Loading...</p>
		{:else if controlPlaneItems.length === 0}
			<p class="text-muted">No control plane destinations.</p>
		{:else}
			<div class="table-wrap">
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
									<div class="cell-name">{item.display_name}</div>
									<div class="cell-sub">{item.name}</div>
								</td>
								<td><span class="badge badge-neutral">{item.provider}</span></td>
								<td>
									<span
										class="badge {item.runtime_status === 'supported'
											? 'badge-success'
											: 'badge-neutral'}">{item.runtime_status ?? 'unknown'}</span
									>
									{#if item.runtime_unsupported_reason}
										<div class="cell-sub">{item.runtime_unsupported_reason}</div>
									{/if}
								</td>
								<td
									><span
										class="badge {item.lifecycle_status === 'active'
											? 'badge-success'
											: item.lifecycle_status === 'disabled'
												? 'badge-neutral'
												: 'badge-warning'}">{item.lifecycle_status}</span
									></td
								>
								<td
									><span
										class="badge {item.health_status === 'healthy'
											? 'badge-success'
											: item.health_status === 'unhealthy'
												? 'badge-error'
												: 'badge-neutral'}">{item.health_status}</span
									></td
								>
								<td>
									<div class="cell-name">v{item.credential_version}</div>
									<div class="cell-sub">{item.rotation_status}</div>
								</td>
								<td>{item.retention_days ? `${item.retention_days}d` : 'Default'}</td>
								<td class="text-sm">{formatDate(item.last_health_check_at)}</td>
								<td>
									<div class="row-actions">
										<button
											class="btn btn-secondary btn-sm"
											onclick={() => loadControlPlaneDestinationDetail(item)}>Details</button
										>
										<button
											class="btn btn-secondary btn-sm"
											onclick={() => runHealthCheck(item, 'quick')}
											disabled={Boolean(healthActionId)}>Quick</button
										>
										<button
											class="btn btn-secondary btn-sm"
											onclick={() => runHealthCheck(item, 'deep')}
											disabled={Boolean(healthActionId)}>Deep</button
										>
										{#if canManageControlPlaneDestination}
											{#if item.lifecycle_status === 'disabled'}
												<button
													class="btn btn-secondary btn-sm"
													onclick={() => enableControlPlaneDestination(item)}
													disabled={Boolean(lifecycleActionId)}>Enable</button
												>
											{:else}
												<button
													class="btn btn-secondary btn-sm"
													onclick={() => disableControlPlaneDestination(item)}
													disabled={Boolean(lifecycleActionId)}>Disable</button
												>
											{/if}
											<button
												class="btn btn-secondary btn-sm"
												onclick={() => prepareControlPlaneCredential(item)}
												disabled={Boolean(credentialActionId)}>Prepare</button
											>
											<button
												class="btn btn-secondary btn-sm"
												onclick={() => markControlPlaneCredentialReady(item)}
												disabled={Boolean(credentialActionId) || !item.next_credential_ref}
												>Ready</button
											>
											<button
												class="btn btn-secondary btn-sm"
												onclick={() => activateControlPlaneCredential(item)}
												disabled={Boolean(credentialActionId) || !item.next_credential_ref}
												>Activate</button
											>
											<button
												class="btn btn-secondary btn-sm"
												onclick={() => retirePreviousControlPlaneCredential(item)}
												disabled={Boolean(credentialActionId) || !item.previous_credential_ref}
												>Retire</button
											>
										{/if}
									</div>
									<details class="config-details">
										<summary>Config</summary>
										<pre class="code-block">{providerConfigText(item)}</pre>
									</details>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>

	{#if selectedControlPlane}
		<aside class="detail-drawer" aria-label="Storage destination details">
			<div class="drawer-header">
				<div>
					<h2 class="drawer-title">{selectedControlPlane.display_name}</h2>
					<p class="text-muted text-sm">
						{selectedControlPlane.scope_type}:{selectedControlPlane.scope_id}
					</p>
				</div>
				<button
					class="btn btn-secondary btn-sm"
					type="button"
					onclick={closeControlPlaneDestinationDetail}>Close</button
				>
			</div>
			<div class="drawer-actions">
				<button
					class="btn btn-secondary btn-sm"
					type="button"
					onclick={previewSelectedControlPlaneDiff}
					disabled={diffPreviewActionId === selectedControlPlane.id}
				>
					{diffPreviewActionId === selectedControlPlane.id ? 'Previewing...' : 'Preview diff'}
				</button>
			</div>
			<div class="stat-grid compact">
				<div class="stat-card">
					<span>Provider</span><strong>{selectedControlPlane.provider}</strong>
				</div>
				<div class="stat-card">
					<span>Runtime</span><strong>{selectedControlPlane.runtime_status ?? 'unknown'}</strong>
				</div>
				<div class="stat-card">
					<span>Lifecycle</span><strong>{selectedControlPlane.lifecycle_status}</strong>
				</div>
				<div class="stat-card">
					<span>Health</span><strong>{selectedControlPlane.health_status}</strong>
				</div>
				<div class="stat-card">
					<span>Retention</span><strong
						>{selectedControlPlane.retention_days
							? `${selectedControlPlane.retention_days}d`
							: 'Default'}</strong
					>
				</div>
				<div class="stat-card">
					<span>Region</span><strong>{selectedControlPlane.region ?? 'Any'}</strong>
				</div>
				<div class="stat-card">
					<span>Critical</span><strong
						>{selectedControlPlane.critical_allowed ? 'Allowed' : 'Not allowed'}</strong
					>
				</div>
				<div class="stat-card">
					<span>Fallback</span><strong
						>{selectedControlPlane.default_fallback_eligible ? 'Eligible' : 'Not eligible'}</strong
					>
				</div>
				<div class="stat-card">
					<span>Encryption</span><strong>{selectedControlPlane.encryption_mode}</strong>
				</div>
				{#if selectedControlPlane.runtime_unsupported_reason}
					<div class="stat-card wide">
						<span>Runtime reason</span><strong
							>{selectedControlPlane.runtime_unsupported_reason}</strong
						>
					</div>
				{/if}
			</div>
			<div class="usage-grid">
				<div class="stat-card">
					<span>Allowed tenants</span><strong
						>{listText(selectedControlPlane.allowed_tenant_ids)}</strong
					>
				</div>
				<div class="stat-card">
					<span>Allowed log types</span><strong
						>{listText(selectedControlPlane.allowed_log_types)}</strong
					>
				</div>
				<div class="stat-card">
					<span>Allowed planes</span><strong>{listText(selectedControlPlane.allowed_planes)}</strong
					>
				</div>
				<div class="stat-card">
					<span>Capabilities</span><strong
						>{selectedControlPlane.capabilities
							?.filter((c) => c.enabled)
							.map((c) => c.capability)
							.join(', ') || 'None'}</strong
					>
				</div>
			</div>
			<pre class="code-block">{providerConfigText(selectedControlPlane)}</pre>
			{#if destinationDiffPreview}
				<div class="usage-grid">
					<div class="stat-card">
						<span>Diff state</span><strong>{destinationDiffPreview.dangerous_classification}</strong
						>
					</div>
					<div class="stat-card">
						<span>Changed fields</span><strong>{destinationDiffPreview.diff.length}</strong>
					</div>
					<div class="stat-card">
						<span>Confirmation</span><strong>{destinationDiffPreview.confirmation ?? '-'}</strong>
					</div>
				</div>
				<pre class="code-block">{jsonDisplayText({
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
	.page-shell {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.page-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}

	.page-title {
		margin: 0 0 0.25rem;
		font-size: 1.5rem;
	}

	.page-description {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	.page-actions {
		display: flex;
		align-items: flex-end;
		gap: 0.75rem;
		flex-shrink: 0;
	}

	.scope-label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-secondary);
	}

	.scope-label select {
		min-height: 2rem;
	}

	.alert {
		padding: 0.75rem 1rem;
		border-radius: var(--radius-sm);
		font-size: 0.875rem;
	}

	.alert-error {
		background: rgba(239, 68, 68, 0.08);
		color: #991b1b;
		border: 1px solid rgba(239, 68, 68, 0.2);
	}

	.alert-success {
		background: rgba(16, 185, 129, 0.08);
		color: #065f46;
		border: 1px solid rgba(16, 185, 129, 0.2);
	}

	.split-panel {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(420px, 1fr);
		gap: 1.25rem;
		align-items: start;
	}

	.panel {
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--bg-card);
		padding: 1.5rem;
	}

	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.panel-title {
		margin: 0;
		font-size: 1.05rem;
		font-weight: 600;
	}

	.panel-description {
		margin: 0.25rem 0 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
		line-height: 1.45;
	}

	.item-list {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		overflow: hidden;
	}

	.item-row {
		display: grid;
		grid-template-columns: 1fr auto auto auto;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		border: none;
		border-bottom: 1px solid var(--border);
		background: var(--bg-card);
		text-align: left;
		cursor: pointer;
		transition: background var(--transition-fast);
	}

	.item-row:last-child {
		border-bottom: none;
	}

	.item-row:hover,
	.item-row.selected {
		background: var(--bg-subtle);
	}

	.item-name strong {
		display: block;
		font-weight: 600;
		color: var(--text-primary);
	}

	.item-name small {
		color: var(--text-secondary);
		font-size: 0.75rem;
	}

	.badge {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		border-radius: var(--radius-full);
		font-size: 0.75rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.badge-neutral {
		background: var(--bg-subtle);
		color: var(--text-secondary);
	}

	.badge-success {
		background: rgba(16, 185, 129, 0.1);
		color: #065f46;
	}

	.badge-error {
		background: rgba(239, 68, 68, 0.1);
		color: #991b1b;
	}

	.badge-warning {
		background: rgba(245, 158, 11, 0.12);
		color: #92400e;
	}

	.form-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
		align-items: start;
	}

	.form-grid.nested {
		margin-top: 1rem;
	}

	.form-label-group {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.form-label-group small {
		color: var(--text-secondary);
		font-size: 0.8125rem;
		font-weight: 400;
		line-height: 1.4;
	}

	.form-section {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-subtle);
		padding: 1rem;
	}

	.form-section-title {
		margin: 0;
		color: var(--text-primary);
		font-size: 0.9375rem;
		font-weight: 600;
	}

	.form-section-description {
		margin: 0.25rem 0 0;
		color: var(--text-secondary);
		font-size: 0.8125rem;
		line-height: 1.45;
	}

	.checkbox-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		color: var(--text-primary);
		font-size: 0.875rem;
		font-weight: 500;
	}

	.checkbox-row input {
		width: 1rem;
		height: 1rem;
		min-height: auto;
	}

	.wide {
		grid-column: 1 / -1;
	}

	.form-actions {
		grid-column: 1 / -1;
		display: flex;
		justify-content: flex-start;
	}

	input,
	select,
	textarea {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		padding: 0.625rem 0.75rem;
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
		font-size: 0.875rem;
		min-height: 2.625rem;
		width: 100%;
	}

	input:focus,
	select:focus,
	textarea:focus {
		outline: 2px solid color-mix(in srgb, var(--primary) 28%, transparent);
		outline-offset: 1px;
	}

	textarea,
	pre {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
	}

	textarea {
		line-height: 1.5;
		resize: vertical;
	}

	.code-block {
		padding: 0.75rem;
		background: var(--bg-subtle);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		overflow: auto;
		max-height: 220px;
		margin: 0.75rem 0 0;
	}

	.stat-grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0.75rem;
		margin-bottom: 0;
	}

	.stat-grid.compact {
		grid-template-columns: repeat(3, 1fr);
	}

	.stat-card {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.75rem;
	}

	.stat-card span {
		display: block;
		color: var(--text-secondary);
		font-size: 0.75rem;
		margin-bottom: 0.25rem;
	}

	.stat-card strong {
		font-weight: 600;
		font-size: 0.875rem;
	}

	.stat-card.wide {
		grid-column: 1 / -1;
	}

	.usage-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 0.75rem;
		margin: 0.75rem 0 0;
	}

	.credential-section {
		margin-top: 1.25rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--border);
	}

	.subsection-title {
		margin: 0 0 0.75rem;
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-secondary);
	}

	.table-wrap {
		overflow-x: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
	}

	th,
	td {
		padding: 0.75rem;
		border-bottom: 1px solid var(--border);
		text-align: left;
		vertical-align: top;
	}

	th {
		color: var(--text-secondary);
		font-size: 0.75rem;
		text-transform: uppercase;
		font-weight: 600;
		white-space: nowrap;
	}

	.cell-name {
		font-weight: 600;
		font-size: 0.875rem;
	}

	.cell-sub {
		color: var(--text-secondary);
		font-size: 0.75rem;
		margin-top: 2px;
	}

	.row-actions {
		display: flex;
		gap: 0.375rem;
		flex-wrap: wrap;
		margin-bottom: 0.5rem;
	}

	.config-details summary {
		cursor: pointer;
		font-size: 0.75rem;
		color: var(--text-secondary);
		margin-top: 0.5rem;
	}

	.config-details .code-block {
		margin-top: 0.5rem;
		max-height: 140px;
	}

	.text-muted {
		color: var(--text-secondary);
	}

	.text-sm {
		font-size: 0.8125rem;
	}

	.detail-drawer {
		position: fixed;
		top: 0;
		right: 0;
		z-index: 30;
		width: min(560px, calc(100vw - 24px));
		height: 100vh;
		overflow-y: auto;
		background: var(--bg-card);
		border-left: 1px solid var(--border);
		box-shadow: var(--shadow-lg);
		padding: 1.25rem;
	}

	.drawer-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.drawer-title {
		margin: 0 0 0.25rem;
		font-size: 1.125rem;
	}

	.drawer-actions {
		margin-bottom: 1rem;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.5rem 0.875rem;
		font: inherit;
		font-size: 0.875rem;
		cursor: pointer;
		transition: background var(--transition-fast);
		white-space: nowrap;
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-primary {
		background: var(--primary);
		color: #fff;
		border-color: var(--primary);
	}

	.btn-primary:hover:not(:disabled) {
		background: var(--primary-hover);
	}

	.btn-secondary {
		background: var(--bg-subtle);
		color: var(--text-primary);
	}

	.btn-secondary:hover:not(:disabled) {
		background: var(--border);
	}

	.btn-danger {
		background: rgba(239, 68, 68, 0.1);
		color: #991b1b;
		border-color: rgba(239, 68, 68, 0.3);
	}

	.btn-danger:hover:not(:disabled) {
		background: rgba(239, 68, 68, 0.18);
	}

	.btn-sm {
		padding: 0.3rem 0.625rem;
		font-size: 0.8125rem;
	}

	@media (max-width: 900px) {
		.split-panel,
		.stat-grid,
		.stat-grid.compact,
		.form-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
