<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminDirectoryConnectorsAPI,
		type DirectoryConnector,
		type DirectoryConnectorHealthResponse,
		type DirectoryConnectorsResponse
	} from '$lib/api/admin-directory-connectors';
	import { ToggleSwitch } from '$lib/components';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { LL } from '$i18n/i18n-svelte';

	const CONNECTOR_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
	const SECRET_REF_PATTERN = /^env:(AUTHRIM_WORDWARDEN_|WORDWARDEN_)[A-Z0-9_]+$/;

	interface DirectoryConnectorDraft {
		id: string;
		transport: 'direct' | 'relay';
		endpoint_url: string;
		auth_mode: 'hmac';
		connector_id: string;
		key_id: string;
		secret_ref: string;
		request_ms: number;
		attributes_text: string;
	}

	interface HealthState {
		loading: boolean;
		result: DirectoryConnectorHealthResponse | null;
		error: string;
	}

	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let successMessage = $state('');
	let tenantId = $state('');
	let enabled = $state(false);
	let defaultConnectorId = $state('campus');
	let autoProvision = $state(false);
	let connectors = $state<DirectoryConnectorDraft[]>([]);
	let initialConfigJson = $state(
		JSON.stringify({
			enabled: false,
			default_connector_id: 'campus',
			auto_provision: false,
			connectors: []
		})
	);
	let healthChecks = $state<Record<number, HealthState>>({});

	const currentTenantId = $derived(settingsContext.tenantId);
	const canEdit = $derived(settingsContext.canEditAtCurrentScope());
	const hasChanges = $derived(JSON.stringify(buildConfig()) !== initialConfigJson);

	function defaultConnector(index: number): DirectoryConnectorDraft {
		return {
			id: index === 0 ? 'campus' : `campus-${index + 1}`,
			transport: 'relay',
			endpoint_url: 'https://wordwarden.example.com',
			auth_mode: 'hmac',
			connector_id: 'ww_tenant',
			key_id: 'kid-active',
			secret_ref: 'env:WORDWARDEN_SECRET',
			request_ms: 2500,
			attributes_text: 'mail, displayName, uid'
		};
	}

	function toDraft(connector: DirectoryConnector): DirectoryConnectorDraft {
		return {
			id: connector.id,
			transport: connector.transport || 'direct',
			endpoint_url: connector.endpoint_url,
			auth_mode: connector.auth_mode,
			connector_id: connector.connector_id,
			key_id: connector.key_id,
			secret_ref: connector.secret_ref,
			request_ms: connector.timeouts.request_ms,
			attributes_text: connector.attribute_names.join(', ')
		};
	}

	function normalizeAttributes(value: string): string[] {
		const seen = new Set<string>();
		const result: string[] = [];
		for (const item of value.split(',')) {
			const normalized = item.trim();
			if (!normalized || seen.has(normalized)) continue;
			seen.add(normalized);
			result.push(normalized);
		}
		return result;
	}

	function buildConnectors(drafts: DirectoryConnectorDraft[]): DirectoryConnector[] {
		return drafts.map((draft) => ({
			id: draft.id.trim(),
			transport: draft.transport,
			endpoint_url: draft.transport === 'direct' ? draft.endpoint_url.trim() : '',
			auth_mode: 'hmac',
			connector_id: draft.connector_id.trim(),
			key_id: draft.key_id.trim(),
			secret_ref: draft.secret_ref.trim(),
			timeouts: {
				request_ms: Number(draft.request_ms)
			},
			attribute_names: normalizeAttributes(draft.attributes_text)
		}));
	}

	function buildConfig(): Omit<DirectoryConnectorsResponse, 'tenantId'> {
		return {
			enabled,
			default_connector_id: defaultConnectorId.trim() || 'campus',
			auto_provision: autoProvision,
			connectors: buildConnectors(connectors)
		};
	}

	function isLocalhostHostname(hostname: string): boolean {
		return hostname === 'localhost';
	}

	function validateEndpointURL(value: string): boolean {
		try {
			const parsed = new URL(value);
			return (
				parsed.protocol === 'https:' ||
				(parsed.protocol === 'http:' && isLocalhostHostname(parsed.hostname))
			);
		} catch {
			return false;
		}
	}

	function validateConnectors(): string {
		const config = buildConfig();
		if (config.enabled && config.connectors.length === 0) {
			return $LL.admin_directory_authentication_validation_connector_required_when_enabled();
		}
		if (
			config.enabled &&
			!config.connectors.some((connector) => connector.id === config.default_connector_id)
		) {
			return $LL.admin_directory_authentication_validation_default_connector();
		}
		const ids = new Set<string>();
		for (const connector of config.connectors) {
			if (!connector.id) return $LL.admin_directory_authentication_validation_id_required();
			if (!CONNECTOR_ID_PATTERN.test(connector.id)) {
				return $LL.admin_directory_authentication_validation_id_format();
			}
			if (ids.has(connector.id)) return $LL.admin_directory_authentication_validation_id_unique();
			ids.add(connector.id);
			if (connector.transport === 'direct') {
				if (!connector.endpoint_url) {
					return $LL.admin_directory_authentication_validation_endpoint_required();
				}
				if (!validateEndpointURL(connector.endpoint_url)) {
					return $LL.admin_directory_authentication_validation_endpoint_https();
				}
			}
			if (!connector.connector_id) {
				return $LL.admin_directory_authentication_validation_connector_id_required();
			}
			if (!connector.key_id) return $LL.admin_directory_authentication_validation_key_id_required();
			if (!connector.secret_ref) {
				return $LL.admin_directory_authentication_validation_secret_required();
			}
			if (!SECRET_REF_PATTERN.test(connector.secret_ref)) {
				return $LL.admin_directory_authentication_validation_secret_format();
			}
			if (
				!Number.isInteger(connector.timeouts.request_ms) ||
				connector.timeouts.request_ms < 100 ||
				connector.timeouts.request_ms > 30000
			) {
				return $LL.admin_directory_authentication_validation_timeout();
			}
			if (connector.attribute_names.length > 32) {
				return $LL.admin_directory_authentication_validation_attributes();
			}
		}
		return '';
	}

	async function loadConnectors(selectedTenantId: string) {
		loading = true;
		error = '';
		successMessage = '';
		healthChecks = {};

		try {
			const response = await adminDirectoryConnectorsAPI.get(selectedTenantId);
			tenantId = response.tenantId;
			enabled = response.enabled;
			defaultConnectorId = response.default_connector_id || 'campus';
			autoProvision = response.auto_provision;
			connectors = response.connectors.map(toDraft);
			initialConfigJson = JSON.stringify({
				enabled: response.enabled,
				default_connector_id: response.default_connector_id || 'campus',
				auto_provision: response.auto_provision,
				connectors: response.connectors
			});
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_directory_authentication_load_failed();
		} finally {
			loading = false;
		}
	}

	async function saveConnectors() {
		if (!tenantId || !canEdit) return;
		const validationError = validateConnectors();
		if (validationError) {
			error = validationError;
			successMessage = '';
			return;
		}

		saving = true;
		error = '';
		successMessage = '';

		try {
			const payload = buildConfig();
			const response = await adminDirectoryConnectorsAPI.update(tenantId, payload);
			enabled = response.enabled;
			defaultConnectorId = response.default_connector_id || 'campus';
			autoProvision = response.auto_provision;
			connectors = response.connectors.map(toDraft);
			initialConfigJson = JSON.stringify({
				enabled: response.enabled,
				default_connector_id: response.default_connector_id || 'campus',
				auto_provision: response.auto_provision,
				connectors: response.connectors
			});
			successMessage = $LL.admin_directory_authentication_saved();
			healthChecks = {};
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_directory_authentication_save_failed();
		} finally {
			saving = false;
		}
	}

	function addConnector() {
		connectors = [...connectors, defaultConnector(connectors.length)];
	}

	function removeConnector(index: number) {
		connectors = connectors.filter((_, itemIndex) => itemIndex !== index);
		const nextHealthChecks: Record<number, HealthState> = {};
		connectors.forEach((_, itemIndex) => {
			nextHealthChecks[itemIndex] = healthChecks[itemIndex >= index ? itemIndex + 1 : itemIndex];
		});
		healthChecks = nextHealthChecks;
	}

	async function checkHealth(index: number) {
		const connector = connectors[index];
		if (!tenantId || !connector || hasChanges || !canEdit) return;

		healthChecks = {
			...healthChecks,
			[index]: { loading: true, result: null, error: '' }
		};

		try {
			const result = await adminDirectoryConnectorsAPI.checkHealth(tenantId, connector.id);
			healthChecks = {
				...healthChecks,
				[index]: { loading: false, result, error: '' }
			};
		} catch (err) {
			healthChecks = {
				...healthChecks,
				[index]: {
					loading: false,
					result: null,
					error:
						err instanceof Error ? err.message : $LL.admin_directory_authentication_health_failed()
				}
			};
		}
	}

	onMount(async () => {
		await settingsContext.initialize();
		const selectedTenantId = settingsContext.tenantId;
		if (!selectedTenantId) {
			loading = false;
			error = $LL.admin_directory_authentication_select_tenant();
			return;
		}
		await loadConnectors(selectedTenantId);
	});

	$effect(() => {
		if (!currentTenantId || loading || currentTenantId === tenantId) return;
		void loadConnectors(currentTenantId);
	});
</script>

<svelte:head>
	<title>{$LL.admin_directory_authentication_page_title()}</title>
</svelte:head>

{#snippet headerActions()}
	<button
		class="btn btn-secondary"
		disabled={!hasChanges || saving || loading}
		onclick={() => loadConnectors(tenantId)}
	>
		{$LL.admin_directory_authentication_discard()}
	</button>
	<button
		class="btn btn-primary"
		disabled={!hasChanges || saving || loading || !canEdit}
		onclick={saveConnectors}
	>
		{saving
			? $LL.admin_directory_authentication_saving()
			: $LL.admin_directory_authentication_save()}
	</button>
{/snippet}

{#snippet connectorActions()}
	<button class="btn btn-secondary" disabled={!canEdit || loading} onclick={addConnector}>
		<span class="i-ph-plus" aria-hidden="true"></span>
		{$LL.admin_directory_authentication_add_connector()}
	</button>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_directory_authentication_title()}
		description={$LL.admin_directory_authentication_description()}
		actions={headerActions}
	/>

	{#if loading}
		<AdminSection>
			<p class="state-text">{$LL.admin_directory_authentication_loading()}</p>
		</AdminSection>
	{:else}
		{#if error}
			<div class="alert alert-error">{error}</div>
		{/if}

		{#if successMessage}
			<div class="alert alert-success">{successMessage}</div>
		{/if}

		<AdminSection>
			<div class="settings-summary">
				<div>
					<h2>{$LL.admin_directory_authentication_tenant()}</h2>
					<p>{tenantId || $LL.admin_directory_authentication_not_selected()}</p>
				</div>
				<div>
					<h2>{$LL.admin_directory_authentication_connectors_title()}</h2>
					<p>{$LL.admin_directory_authentication_count({ count: connectors.length })}</p>
				</div>
				<div>
					<h2>{$LL.admin_directory_authentication_status()}</h2>
					<p>
						{enabled
							? $LL.admin_directory_authentication_status_enabled()
							: $LL.admin_directory_authentication_status_disabled()}
					</p>
				</div>
			</div>
		</AdminSection>

		<AdminSection
			title={$LL.admin_directory_authentication_runtime_title()}
			description={$LL.admin_directory_authentication_runtime_description()}
		>
			<div class="runtime-settings">
				<div class="runtime-row">
					<div>
						<h3>{$LL.admin_directory_authentication_enable_login()}</h3>
						<p>{$LL.admin_directory_authentication_enable_login_description()}</p>
					</div>
					<ToggleSwitch bind:checked={enabled} disabled={!canEdit} size="sm" />
				</div>

				<div class="form-grid">
					<div class="admin-field">
						<label class="admin-field__label" for="default-connector-id">
							{$LL.admin_directory_authentication_default_connector()}
						</label>
						<select
							id="default-connector-id"
							class="admin-input"
							bind:value={defaultConnectorId}
							disabled={!canEdit || connectors.length === 0}
						>
							{#if connectors.length === 0}
								<option value="campus">campus</option>
							{:else}
								{#each connectors as connector}
									<option value={connector.id}>{connector.id}</option>
								{/each}
							{/if}
						</select>
					</div>

					<div class="runtime-row runtime-row--inline">
						<div>
							<h3>{$LL.admin_directory_authentication_auto_provision()}</h3>
							<p>{$LL.admin_directory_authentication_auto_provision_description()}</p>
						</div>
						<ToggleSwitch bind:checked={autoProvision} disabled={!canEdit} size="sm" />
					</div>
				</div>
			</div>
		</AdminSection>

		<AdminSection
			title={$LL.admin_directory_authentication_connectors_title()}
			description={$LL.admin_directory_authentication_connectors_description()}
			actions={connectorActions}
		>
			{#if connectors.length === 0}
				<div class="empty-state">
					<p>{$LL.admin_directory_authentication_empty()}</p>
				</div>
			{:else}
				<div class="connector-list">
					{#each connectors as connector, index (index)}
						<section class="connector-panel">
							<header class="connector-header">
								<div>
									<h3>{connector.id || $LL.admin_directory_authentication_id()}</h3>
									<p>
										{connector.transport === 'relay'
											? $LL.admin_directory_authentication_transport_relay()
											: connector.endpoint_url}
									</p>
								</div>
								<div class="connector-actions">
									<button
										class="btn btn-secondary"
										disabled={!canEdit || hasChanges || healthChecks[index]?.loading}
										onclick={() => checkHealth(index)}
									>
										{healthChecks[index]?.loading
											? $LL.admin_directory_authentication_checking_health()
											: $LL.admin_directory_authentication_check_health()}
									</button>
									<button
										class="btn btn-danger"
										disabled={!canEdit}
										onclick={() => removeConnector(index)}
									>
										{$LL.admin_directory_authentication_remove()}
									</button>
								</div>
							</header>

							{#if healthChecks[index]?.result}
								<div
									class:health-status={true}
									class:health-status--ok={healthChecks[index].result?.ok}
									class:health-status--error={!healthChecks[index].result?.ok}
								>
									<span>
										{healthChecks[index].result?.ok
											? $LL.admin_directory_authentication_health_ok()
											: $LL.admin_directory_authentication_health_failed()}
									</span>
									{#if healthChecks[index].result?.status}
										<span>
											{$LL.admin_directory_authentication_health_status({
												status: healthChecks[index].result?.status ?? 0
											})}
										</span>
									{/if}
								</div>
							{:else if healthChecks[index]?.error}
								<div class="health-status health-status--error">{healthChecks[index].error}</div>
							{/if}

							<div class="form-grid">
								<div class="admin-field">
									<label class="admin-field__label" for={`connector-id-${index}`}>
										{$LL.admin_directory_authentication_id()}
									</label>
									<input
										id={`connector-id-${index}`}
										class="admin-input"
										bind:value={connector.id}
										disabled={!canEdit}
									/>
								</div>

								<div class="admin-field admin-field--full">
									<label class="admin-field__label" for={`transport-${index}`}>
										{$LL.admin_directory_authentication_transport()}
									</label>
									<select
										id={`transport-${index}`}
										class="admin-input"
										bind:value={connector.transport}
										disabled={!canEdit}
									>
										<option value="relay">
											{$LL.admin_directory_authentication_transport_relay()}
										</option>
										<option value="direct">
											{$LL.admin_directory_authentication_transport_direct()}
										</option>
									</select>
								</div>

								{#if connector.transport === 'direct'}
									<div class="admin-field admin-field--full">
									<label class="admin-field__label" for={`endpoint-url-${index}`}>
										{$LL.admin_directory_authentication_endpoint_url()}
									</label>
									<input
										id={`endpoint-url-${index}`}
										class="admin-input"
										bind:value={connector.endpoint_url}
										disabled={!canEdit}
									/>
								</div>
								{/if}

								<div class="admin-field">
									<label class="admin-field__label" for={`auth-mode-${index}`}>
										{$LL.admin_directory_authentication_auth_mode()}
									</label>
									<input
										id={`auth-mode-${index}`}
										class="admin-input"
										value={$LL.admin_directory_authentication_hmac()}
										disabled
									/>
								</div>

								<div class="admin-field">
									<label class="admin-field__label" for={`wordwarden-tenant-${index}`}>
										{$LL.admin_directory_authentication_connector_id()}
									</label>
									<input
										id={`wordwarden-tenant-${index}`}
										class="admin-input"
										bind:value={connector.connector_id}
										disabled={!canEdit}
									/>
								</div>

								<div class="admin-field">
									<label class="admin-field__label" for={`key-id-${index}`}>
										{$LL.admin_directory_authentication_key_id()}
									</label>
									<input
										id={`key-id-${index}`}
										class="admin-input"
										bind:value={connector.key_id}
										disabled={!canEdit}
									/>
								</div>

								<div class="admin-field">
									<label class="admin-field__label" for={`secret-ref-${index}`}>
										{$LL.admin_directory_authentication_secret_ref()}
									</label>
									<input
										id={`secret-ref-${index}`}
										class="admin-input"
										bind:value={connector.secret_ref}
										disabled={!canEdit}
									/>
									<p class="field-hint">{$LL.admin_directory_authentication_secret_hint()}</p>
								</div>

								<div class="admin-field">
									<label class="admin-field__label" for={`timeout-ms-${index}`}>
										{$LL.admin_directory_authentication_timeout_ms()}
									</label>
									<input
										id={`timeout-ms-${index}`}
										type="number"
										min="100"
										max="30000"
										class="admin-input"
										bind:value={connector.request_ms}
										disabled={!canEdit}
									/>
								</div>

								<div class="admin-field admin-field--full">
									<label class="admin-field__label" for={`attributes-${index}`}>
										{$LL.admin_directory_authentication_attributes()}
									</label>
									<input
										id={`attributes-${index}`}
										class="admin-input"
										bind:value={connector.attributes_text}
										disabled={!canEdit}
									/>
									<p class="field-hint">{$LL.admin_directory_authentication_attributes_hint()}</p>
								</div>
							</div>
						</section>
					{/each}
				</div>
			{/if}
		</AdminSection>
	{/if}
</AdminPageShell>

<style>
	h2,
	h3,
	p {
		margin: 0;
	}

	.settings-summary {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 16px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 16px;
		background: var(--color-surface);
	}

	.settings-summary h2 {
		margin-bottom: 4px;
		font-size: 0.78rem;
		font-weight: 700;
		color: var(--color-text-muted);
	}

	.settings-summary p {
		font-size: 0.95rem;
		font-weight: 650;
		color: var(--color-text);
	}

	.empty-state,
	.connector-panel {
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
	}

	.empty-state {
		padding: 18px;
		color: var(--color-text-muted);
	}

	.runtime-settings {
		display: grid;
		gap: 16px;
	}

	.runtime-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
		padding: 16px;
	}

	.runtime-row--inline {
		min-height: 76px;
	}

	.runtime-row h3 {
		font-size: 0.95rem;
		font-weight: 700;
		color: var(--color-text);
	}

	.runtime-row p {
		margin-top: 4px;
		color: var(--color-text-muted);
		font-size: 0.82rem;
		line-height: 1.5;
	}

	.connector-list {
		display: grid;
		gap: 16px;
	}

	.connector-panel {
		padding: 18px;
	}

	.connector-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 16px;
	}

	.connector-header h3 {
		font-size: 1rem;
		font-weight: 700;
		color: var(--color-text);
	}

	.connector-header p {
		margin-top: 4px;
		max-width: 620px;
		overflow-wrap: anywhere;
		color: var(--color-text-muted);
		font-size: 0.82rem;
	}

	.connector-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.form-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 14px;
	}

	.admin-field {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.admin-field--full {
		grid-column: 1 / -1;
	}

	.admin-field__label {
		font-size: 0.78rem;
		font-weight: 700;
		color: var(--color-text-muted);
	}

	.admin-input {
		width: 100%;
		min-height: 38px;
		border: 1px solid var(--color-border);
		border-radius: 6px;
		background: var(--color-surface-elevated, var(--color-surface));
		color: var(--color-text);
		padding: 8px 10px;
		font: inherit;
	}

	.admin-input:focus {
		outline: none;
		border-color: var(--color-primary);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 18%, transparent);
	}

	.field-hint {
		color: var(--color-text-muted);
		font-size: 0.78rem;
		line-height: 1.5;
	}

	.health-status {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 14px;
		border-radius: 6px;
		padding: 7px 10px;
		font-size: 0.82rem;
		font-weight: 650;
	}

	.health-status--ok {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.health-status--error {
		background: color-mix(in srgb, var(--color-danger) 12%, transparent);
		color: var(--color-danger);
	}

	.btn[disabled] {
		opacity: 0.55;
		cursor: not-allowed;
	}

	@media (max-width: 760px) {
		.connector-header {
			flex-direction: column;
		}

		.runtime-row {
			align-items: flex-start;
		}

		.connector-actions,
		.form-grid {
			width: 100%;
		}

		.form-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
