<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import {
		adminDatabaseConnectionsAPI,
		type DatabaseConnection,
		type DatabaseConnectionProvider,
		type ResourceStatus
	} from '$lib/api/admin-database-connections';
	import { LL } from '$i18n/i18n-svelte';

	const connectionId = $derived($page.params.id ?? 'new');
	const isNew = $derived(connectionId === 'new');

	let connection = $state<DatabaseConnection | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let success = $state('');

	let name = $state('');
	let displayName = $state('');
	let description = $state('');
	let provider = $state<DatabaseConnectionProvider>('hyperdrive');
	let status = $state<ResourceStatus>('active');
	let configJson = $state('{}');
	let credentialJson = $state('');
	let elevationGrantId = $state('');

	let d1BindingRef = $state('');
	let hyperdriveBindingRef = $state('');
	let hyperdriveDialect = $state<'postgres' | 'mysql'>('postgres');
	let sqlConnectionString = $state('');
	let sqlSchema = $state('');
	let sqlPoolName = $state('');
	let customType = $state('');
	let customConfig = $state('');
	let customCredential = $state('');

	const readOnly = $derived(Boolean(connection?.read_only));

	onMount(async () => {
		if (isNew) {
			loading = false;
			return;
		}
		await load();
	});

	async function load() {
		loading = true;
		error = '';
		try {
			connection = await adminDatabaseConnectionsAPI.get(connectionId);
			name = connection.name;
			displayName = connection.display_name;
			description = connection.description ?? '';
			provider = connection.provider;
			status = connection.status;
			configJson = JSON.stringify(connection.config ?? {}, null, 2);
		} catch (err) {
			error =
				err instanceof Error ? err.message : $LL.admin_database_connections_detail_load_failed();
		} finally {
			loading = false;
		}
	}

	function parseJsonField(value: string): Record<string, unknown> {
		const trimmed = value.trim();
		if (!trimmed) return {};
		const parsed = JSON.parse(trimmed);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error($LL.admin_database_connections_json_object_error());
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
			throw new Error($LL.admin_database_connections_required({ label }));
		}
		return trimmed;
	}

	function buildCreateConfig(): Record<string, unknown> {
		if (provider === 'd1') {
			return {
				bindingRef: requiredString(
					d1BindingRef,
					$LL.admin_database_connections_d1_binding_ref_required()
				)
			};
		}
		if (provider === 'hyperdrive') {
			return {
				bindingRef: requiredString(
					hyperdriveBindingRef,
					$LL.admin_database_connections_hyperdrive_binding_ref_required()
				),
				dialect: hyperdriveDialect
			};
		}
		if (provider === 'postgres' || provider === 'mysql') {
			return {
				...(optionalString(sqlSchema) ? { schema: optionalString(sqlSchema) } : {}),
				...(optionalString(sqlPoolName) ? { poolName: optionalString(sqlPoolName) } : {})
			};
		}
		const parsedCustomConfig = parseJsonField(customConfig);
		return {
			type: requiredString(customType, $LL.admin_database_connections_custom_type_required()),
			...(Object.keys(parsedCustomConfig).length > 0 ? { config: parsedCustomConfig } : {})
		};
	}

	function buildCreateCredential(): Record<string, unknown> | undefined {
		if (provider === 'postgres' || provider === 'mysql') {
			const value = optionalString(sqlConnectionString);
			return value ? { connectionString: value } : undefined;
		}
		if (provider === 'custom') {
			const parsed = parseJsonField(customCredential);
			return Object.keys(parsed).length > 0 ? parsed : undefined;
		}
		return undefined;
	}

	async function save() {
		saving = true;
		error = '';
		success = '';
		try {
			if (isNew) {
				const created = await adminDatabaseConnectionsAPI.create({
					name: requiredString(name, $LL.admin_database_connections_name_required()),
					display_name: displayName.trim() || name.trim(),
					description: description.trim() || null,
					provider,
					config: buildCreateConfig(),
					credential: buildCreateCredential(),
					status
				});
				success = $LL.admin_database_connections_created();
				connection = created;
				name = created.name;
				displayName = created.display_name;
				description = created.description ?? '';
				provider = created.provider;
				status = created.status;
				configJson = JSON.stringify(created.config ?? {}, null, 2);
				await goto(`/admin/database-connections/${encodeURIComponent(created.id)}`, {
					replaceState: true
				});
				return;
			}
			if (!connection || readOnly) return;
			connection = await adminDatabaseConnectionsAPI.update(connection.id, {
				display_name: displayName.trim() || connection.name,
				description: description.trim() || null,
				config: parseJsonField(configJson),
				status
			});
			success = $LL.admin_database_connections_updated();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_database_connections_save_failed();
		} finally {
			saving = false;
		}
	}

	async function rotateCredential() {
		if (!connection || readOnly) return;
		saving = true;
		error = '';
		success = '';
		try {
			const credential = parseJsonField(credentialJson);
			connection = await adminDatabaseConnectionsAPI.updateCredential(
				connection.id,
				credential,
				elevationGrantId.trim() || undefined
			);
			credentialJson = '';
			elevationGrantId = '';
			success = $LL.admin_database_connections_credential_updated_success();
		} catch (err) {
			error =
				err instanceof Error
					? err.message
					: $LL.admin_database_connections_credential_update_failed();
		} finally {
			saving = false;
		}
	}

	async function testConnection() {
		if (!connection) return;
		saving = true;
		error = '';
		success = '';
		try {
			const result = await adminDatabaseConnectionsAPI.test(connection.id);
			success =
				result.message || $LL.admin_database_connections_test_status({ status: result.status });
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_database_connections_test_failed();
		} finally {
			saving = false;
		}
	}

	async function deleteConnection() {
		if (!connection || readOnly) return;
		if (!confirm($LL.admin_database_connections_delete_confirm({ name: connection.display_name })))
			return;
		saving = true;
		error = '';
		success = '';
		try {
			await adminDatabaseConnectionsAPI.delete(connection.id, elevationGrantId.trim() || undefined);
			await goto('/admin/database-connections');
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_database_connections_delete_failed();
		} finally {
			saving = false;
		}
	}

	function formatDate(timestamp: number | null): string {
		return timestamp ? new Date(timestamp).toLocaleString() : '-';
	}
</script>

<svelte:head>
	<title>
		{isNew
			? $LL.admin_database_connections_detail_page_title_create()
			: $LL.admin_database_connections_detail_page_title()}
	</title>
</svelte:head>

<div class="page-shell">
	<header class="page-header">
		<div class="page-title-group">
			<button class="link-button" onclick={() => goto('/admin/database-connections')}
				><i class="i-ph-arrow-left"></i>{$LL.admin_database_connections_back_connections()}</button
			>
			<h1 class="page-title">
				{isNew
					? $LL.admin_database_connections_create_title()
					: connection?.display_name || $LL.admin_database_connections_detail_title()}
			</h1>
			<p class="page-description">
				{isNew
					? $LL.admin_database_connections_create_description()
					: $LL.admin_database_connections_detail_description()}
			</p>
		</div>
		<div class="page-actions">
			{#if !isNew && connection}
				<button class="btn btn-secondary" onclick={testConnection} disabled={saving}
					>{$LL.admin_database_connections_test_connection()}</button
				>
			{/if}
			{#if !readOnly}
				<button class="btn btn-primary" onclick={save} disabled={saving || !name}>
					{isNew
						? $LL.admin_database_connections_create_connection()
						: $LL.admin_database_connections_save_changes()}
				</button>
			{/if}
		</div>
	</header>

	{#if error}<div class="alert alert-error">{error}</div>{/if}
	{#if success}<div class="alert alert-success">{success}</div>{/if}

	{#if loading}
		<div class="panel"><p class="text-muted">{$LL.admin_database_connections_loading()}</p></div>
	{:else if !isNew && !connection}
		<div class="panel"><p class="text-muted">{$LL.admin_database_connections_not_found()}</p></div>
	{:else}
		<div class="panel">
			<div class="panel-header">
				<h2 class="panel-title">{$LL.admin_database_connections_connection()}</h2>
				<div class="header-actions">
					{#if readOnly}<span class="badge badge-muted"
							>{$LL.admin_database_connections_setup_managed()}</span
						>{/if}
					{#if connection}
						<span class="badge {connection.status === 'active' ? 'badge-success' : 'badge-neutral'}"
							>{connection.status}</span
						>
					{/if}
				</div>
			</div>

			<div class="form-grid">
				<label class="form-label-group">
					<span>{$LL.admin_database_connections_name()}</span>
					<input bind:value={name} disabled={!isNew} />
					<small>{$LL.admin_database_connections_name_help()}</small>
				</label>
				<label class="form-label-group">
					<span>{$LL.admin_database_connections_display_name()}</span>
					<input bind:value={displayName} disabled={readOnly} />
				</label>
				<label class="form-label-group">
					<span>{$LL.admin_database_connections_provider()}</span>
					<select bind:value={provider} disabled={!isNew}>
						<option value="d1">D1</option>
						<option value="hyperdrive">Hyperdrive</option>
						<option value="postgres">PostgreSQL</option>
						<option value="mysql">MySQL</option>
						<option value="custom">{$LL.admin_database_connections_custom_type()}</option>
					</select>
				</label>
				<label class="form-label-group">
					<span>{$LL.admin_database_connections_status()}</span>
					<select bind:value={status} disabled={readOnly}>
						<option value="active">{$LL.admin_database_connections_active()}</option>
						<option value="disabled">{$LL.admin_database_connections_disabled()}</option>
					</select>
				</label>
				<label class="form-label-group wide">
					<span>{$LL.admin_database_connections_description_label()}</span>
					<input bind:value={description} disabled={readOnly} />
				</label>

				{#if isNew}
					<div class="form-section wide">
						<h3 class="form-section-title">{$LL.admin_database_connections_provider_settings()}</h3>
						<p class="form-section-description">
							{$LL.admin_database_connections_provider_settings_help()}
						</p>
						{#if provider === 'd1'}
							<label class="form-label-group nested-single">
								<span>{$LL.admin_database_connections_d1_binding_ref()}</span>
								<input bind:value={d1BindingRef} />
							</label>
						{:else if provider === 'hyperdrive'}
							<div class="form-grid nested">
								<label class="form-label-group">
									<span>{$LL.admin_database_connections_hyperdrive_binding_ref()}</span>
									<input bind:value={hyperdriveBindingRef} />
								</label>
								<label class="form-label-group">
									<span>{$LL.admin_database_connections_sql_dialect()}</span>
									<select bind:value={hyperdriveDialect}>
										<option value="postgres">PostgreSQL</option>
										<option value="mysql">MySQL</option>
									</select>
								</label>
							</div>
						{:else if provider === 'postgres' || provider === 'mysql'}
							<div class="form-grid nested">
								<label class="form-label-group">
									<span>{$LL.admin_database_connections_schema()}</span>
									<input bind:value={sqlSchema} />
								</label>
								<label class="form-label-group">
									<span>{$LL.admin_database_connections_pool_name()}</span>
									<input bind:value={sqlPoolName} />
								</label>
							</div>
						{:else}
							<div class="form-grid nested">
								<label class="form-label-group">
									<span>{$LL.admin_database_connections_custom_type()}</span>
									<input bind:value={customType} />
								</label>
								<label class="form-label-group wide">
									<span>{$LL.admin_database_connections_advanced_fields()}</span>
									<textarea rows="5" bind:value={customConfig}></textarea>
								</label>
							</div>
						{/if}
					</div>

					{#if provider === 'postgres' || provider === 'mysql' || provider === 'custom'}
						<div class="form-section wide">
							<h3 class="form-section-title">{$LL.admin_database_connections_credentials()}</h3>
							{#if provider === 'postgres' || provider === 'mysql'}
								<label class="form-label-group nested-single">
									<span>{$LL.admin_database_connections_connection_string()}</span>
									<textarea rows="3" bind:value={sqlConnectionString} autocomplete="off"></textarea>
								</label>
							{:else}
								<label class="form-label-group nested-single">
									<span>{$LL.admin_database_connections_credential_object()}</span>
									<textarea rows="5" bind:value={customCredential} autocomplete="off"></textarea>
								</label>
							{/if}
						</div>
					{/if}
				{:else}
					<label class="form-label-group wide">
						<span>{$LL.admin_database_connections_config()}</span>
						<textarea rows="8" bind:value={configJson} disabled={readOnly}></textarea>
					</label>
				{/if}
			</div>
		</div>

		{#if connection}
			<div class="panel">
				<div class="panel-header">
					<h2 class="panel-title">{$LL.admin_database_connections_metadata()}</h2>
					{#if !readOnly}
						<button class="btn btn-danger btn-sm" onclick={deleteConnection} disabled={saving}
							>{$LL.admin_database_connections_delete()}</button
						>
					{/if}
				</div>
				<div class="stat-grid">
					<div class="stat-card">
						<span>{$LL.admin_database_connections_provider()}</span><strong
							>{connection.provider}</strong
						>
					</div>
					<div class="stat-card">
						<span>{$LL.admin_database_connections_credential()}</span><strong
							>{connection.has_credential
								? $LL.admin_database_connections_set()
								: $LL.admin_database_connections_not_set()}</strong
						>
					</div>
					<div class="stat-card">
						<span>{$LL.admin_database_connections_credential_updated()}</span><strong
							>{formatDate(connection.credential_updated_at)}</strong
						>
					</div>
					<div class="stat-card">
						<span>{$LL.admin_database_connections_updated_by()}</span><strong
							>{connection.updated_by || '-'}</strong
						>
					</div>
				</div>
			</div>
		{/if}

		{#if connection && !readOnly}
			<div class="panel">
				<div class="panel-header">
					<h2 class="panel-title">{$LL.admin_database_connections_update_credential()}</h2>
				</div>
				<div class="form-grid">
					<label class="form-label-group wide">
						<span>{$LL.admin_database_connections_elevation_grant_id()}</span>
						<input bind:value={elevationGrantId} />
					</label>
					<label class="form-label-group wide">
						<span>{$LL.admin_database_connections_new_credential_object()}</span>
						<textarea rows="4" bind:value={credentialJson}></textarea>
					</label>
				</div>
				<div class="form-actions">
					<button
						class="btn btn-secondary"
						onclick={rotateCredential}
						disabled={saving || !credentialJson}
					>
						{$LL.admin_database_connections_update_credential_button()}
					</button>
				</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	.page-shell {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.page-header,
	.page-actions,
	.panel-header,
	.header-actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.page-header,
	.panel-header {
		justify-content: space-between;
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

	.link-button {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		margin: 0 0 0.35rem;
		padding: 0;
		border: none;
		background: transparent;
		color: var(--primary);
		cursor: pointer;
		font: inherit;
		font-size: 0.875rem;
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

	.panel {
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--bg-card);
		padding: 1.5rem;
	}

	.panel-title {
		margin: 0;
		font-size: 1.05rem;
		font-weight: 600;
	}

	.form-grid,
	.stat-grid {
		display: grid;
		gap: 1rem;
	}

	.form-grid {
		grid-template-columns: 1fr 1fr;
		align-items: start;
	}

	.form-grid.nested {
		margin-top: 1rem;
	}

	.stat-grid {
		grid-template-columns: repeat(4, 1fr);
	}

	.form-label-group {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.form-label-group small,
	.form-section-description,
	.text-muted {
		color: var(--text-secondary);
	}

	.form-label-group small,
	.form-section-description {
		font-size: 0.8125rem;
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
		font-size: 0.9375rem;
		font-weight: 600;
	}

	.form-section-description {
		margin: 0.25rem 0 0;
	}

	.nested-single {
		margin-top: 1rem;
	}

	.wide {
		grid-column: 1 / -1;
	}

	.form-actions {
		display: flex;
		justify-content: flex-start;
		margin-top: 1rem;
	}

	input,
	select,
	textarea {
		min-height: 2.625rem;
		width: 100%;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		padding: 0.625rem 0.75rem;
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
		font-size: 0.875rem;
	}

	input:disabled,
	select:disabled,
	textarea:disabled {
		opacity: 0.72;
	}

	textarea {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		line-height: 1.5;
		resize: vertical;
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

	.badge-neutral,
	.badge-muted {
		background: var(--bg-subtle);
		color: var(--text-secondary);
	}

	.badge-success {
		background: rgba(16, 185, 129, 0.1);
		color: #065f46;
	}

	.stat-card {
		padding: 0.875rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-subtle);
	}

	.stat-card span {
		display: block;
		margin-bottom: 0.35rem;
		color: var(--text-secondary);
		font-size: 0.75rem;
	}

	.stat-card strong {
		color: var(--text-primary);
		font-size: 0.875rem;
	}

	@media (max-width: 900px) {
		.page-header {
			align-items: flex-start;
			flex-direction: column;
		}

		.form-grid,
		.stat-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
