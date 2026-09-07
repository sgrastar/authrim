<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminMachineAccessAPI,
		type AdminMachineCredential,
		type AdminMachineCredentialAlgorithm,
		type AdminMachinePrincipal,
		type AdminMachinePrincipalStatus,
		type AdminMachinePrincipalType,
		type AdminMachineTenantScope,
		type AdminMachineTenantScopeMode
	} from '$lib/api/admin-machine-access';
	import { AdminPageHeader, AdminPageShell } from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';

	const PRINCIPAL_TYPES: AdminMachinePrincipalType[] = [
		'setup_tool',
		'admin_ui_bff',
		'automation',
		'ci',
		'mcp_server',
		'ai_agent',
		'internal_service',
		'integration'
	];
	const ALGORITHMS: AdminMachineCredentialAlgorithm[] = ['ES256', 'PS256', 'RS256'];

	let principals: AdminMachinePrincipal[] = $state([]);
	let selectedPrincipal: AdminMachinePrincipal | null = $state(null);
	let selectedCredential: AdminMachineCredential | null = $state(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let notice = $state('');
	let statusFilter: '' | AdminMachinePrincipalStatus = $state('');

	let createClientId = $state('');
	let createDisplayName = $state('');
	let createDescription = $state('');
	let createPrincipalType: AdminMachinePrincipalType = $state('automation');
	let createTokenTtl = $state(600);
	let createPermissions = $state('admin:clients:read');
	let createTenantScopes = $state('none');

	let editDisplayName = $state('');
	let editDescription = $state('');
	let editTokenTtl = $state(600);
	let editPermissions = $state('');
	let editTenantScopes = $state('');

	let credentialKid = $state('');
	let credentialDisplayName = $state('');
	let credentialDescription = $state('');
	let credentialAlg: AdminMachineCredentialAlgorithm = $state('ES256');
	let credentialPublicJwk = $state(
		'{\n  "kty": "EC",\n  "crv": "P-256",\n  "x": "",\n  "y": ""\n}'
	);
	let credentialPermissions = $state('');
	let credentialTenantScopes = $state('');

	let rotateKid = $state('');
	let rotateDisplayName = $state('');
	let rotateAlg: AdminMachineCredentialAlgorithm = $state('ES256');
	let rotatePublicJwk = $state('{\n  "kty": "EC",\n  "crv": "P-256",\n  "x": "",\n  "y": ""\n}');
	let rotateOverlapSeconds = $state(86400);
	let emergencyReason = $state('');
	let disableReason = $state('');

	const activeCredentialCount = $derived(
		principals.reduce(
			(count, principal) =>
				count + principal.credentials.filter((credential) => credential.status === 'active').length,
			0
		)
	);

	function formatDate(value: number | null | undefined): string {
		if (!value) return '-';
		return new Date(value).toLocaleString();
	}

	function formatPrincipalType(value: AdminMachinePrincipalType): string {
		switch (value) {
			case 'setup_tool':
				return $LL.admin_machine_access_type_setup_tool();
			case 'admin_ui_bff':
				return $LL.admin_machine_access_type_admin_ui_bff();
			case 'automation':
				return $LL.admin_machine_access_type_automation();
			case 'ci':
				return $LL.admin_machine_access_type_ci();
			case 'mcp_server':
				return $LL.admin_machine_access_type_mcp_server();
			case 'ai_agent':
				return $LL.admin_machine_access_type_ai_agent();
			case 'internal_service':
				return $LL.admin_machine_access_type_internal_service();
			case 'integration':
				return $LL.admin_machine_access_type_integration();
		}
	}

	function formatPrincipalStatus(value: AdminMachinePrincipalStatus): string {
		switch (value) {
			case 'active':
				return $LL.admin_machine_access_status_active();
			case 'disabled':
				return $LL.admin_machine_access_status_disabled();
			case 'deleted':
				return $LL.admin_machine_access_status_deleted();
		}
	}

	function formatCredentialStatus(value: AdminMachineCredential['status']): string {
		switch (value) {
			case 'active':
				return $LL.admin_machine_access_status_active();
			case 'rotating':
				return $LL.admin_machine_access_status_rotating();
			case 'revoked':
				return $LL.admin_machine_access_status_revoked();
			case 'expired':
				return $LL.admin_machine_access_status_expired();
		}
	}

	function formatTenantScopes(scopes: AdminMachineTenantScope[]): string {
		if (!scopes.length) return 'none';
		return scopes
			.map((scope) => (scope.scopeMode === 'allow' ? `allow:${scope.tenantId}` : scope.scopeMode))
			.join('\n');
	}

	function parseLines(value: string): string[] {
		return value
			.split(/[\s,]+/)
			.map((entry) => entry.trim())
			.filter(Boolean);
	}

	function parseTenantScopes(
		value: string
	): Array<{ scope_mode: AdminMachineTenantScopeMode; tenant_id?: string | null }> {
		const entries = parseLines(value);
		if (entries.length === 0) {
			return [{ scope_mode: 'none' as const }];
		}
		return entries.map((entry) => {
			if (entry === 'none') {
				return { scope_mode: 'none' as const };
			}
			if (entry === 'all') {
				return { scope_mode: 'all' as const };
			}
			const tenantId = entry.startsWith('allow:') ? entry.slice('allow:'.length).trim() : entry;
			return { scope_mode: 'allow' as const, tenant_id: tenantId };
		});
	}

	function parsePublicJwk(value: string): unknown {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error($LL.admin_machine_access_public_jwk_object_error());
		}
		return parsed;
	}

	function selectPrincipal(principal: AdminMachinePrincipal) {
		selectedPrincipal = principal;
		selectedCredential = principal.credentials[0] || null;
		editDisplayName = principal.displayName;
		editDescription = principal.description || '';
		editTokenTtl = principal.tokenTtlSeconds;
		editPermissions = principal.permissions.join('\n');
		editTenantScopes = formatTenantScopes(principal.tenantScopes);
		credentialPermissions = principal.permissions.join('\n');
		credentialTenantScopes = formatTenantScopes(principal.tenantScopes);
		notice = '';
		error = '';
	}

	async function refreshSelected() {
		if (!selectedPrincipal) return;
		const refreshed = await adminMachineAccessAPI.get(selectedPrincipal.id);
		selectedPrincipal = refreshed;
		principals = principals.map((principal) =>
			principal.id === refreshed.id ? refreshed : principal
		);
		if (selectedCredential) {
			selectedCredential =
				refreshed.credentials.find((credential) => credential.id === selectedCredential?.id) ||
				refreshed.credentials[0] ||
				null;
		}
	}

	async function loadPrincipals() {
		loading = true;
		error = '';
		try {
			const response = await adminMachineAccessAPI.list({
				status: statusFilter || undefined,
				limit: 100
			});
			principals = response.items;
			if (selectedPrincipal) {
				const stillSelected = principals.find(
					(principal) => principal.id === selectedPrincipal?.id
				);
				if (stillSelected) {
					selectPrincipal(stillSelected);
				} else {
					selectedPrincipal = null;
					selectedCredential = null;
				}
			} else if (principals[0]) {
				selectPrincipal(principals[0]);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_machine_access_load_failed();
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void loadPrincipals();
	});

	async function createPrincipal() {
		saving = true;
		error = '';
		notice = '';
		try {
			const principal = await adminMachineAccessAPI.create({
				client_id: createClientId.trim(),
				display_name: createDisplayName.trim(),
				description: createDescription.trim() || undefined,
				principal_type: createPrincipalType,
				token_ttl_seconds: createTokenTtl,
				permissions: parseLines(createPermissions),
				tenant_scopes: parseTenantScopes(createTenantScopes)
			});
			createClientId = '';
			createDisplayName = '';
			createDescription = '';
			notice = $LL.admin_machine_access_created_notice();
			await loadPrincipals();
			const created = principals.find((entry) => entry.id === principal.id);
			if (created) selectPrincipal(created);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_machine_access_create_failed();
		} finally {
			saving = false;
		}
	}

	async function savePrincipal() {
		if (!selectedPrincipal) return;
		saving = true;
		error = '';
		notice = '';
		try {
			const principal = await adminMachineAccessAPI.update(selectedPrincipal.id, {
				display_name: editDisplayName.trim(),
				description: editDescription.trim() || null,
				token_ttl_seconds: editTokenTtl,
				permissions: parseLines(editPermissions),
				tenant_scopes: parseTenantScopes(editTenantScopes)
			});
			notice = $LL.admin_machine_access_updated_notice();
			selectPrincipal(principal);
			await loadPrincipals();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_machine_access_update_failed();
		} finally {
			saving = false;
		}
	}

	async function togglePrincipalStatus() {
		if (!selectedPrincipal) return;
		saving = true;
		error = '';
		notice = '';
		try {
			if (selectedPrincipal.status === 'active') {
				const principal = await adminMachineAccessAPI.disable(
					selectedPrincipal.id,
					disableReason.trim() || $LL.admin_machine_access_default_disable_reason()
				);
				notice = $LL.admin_machine_access_disabled_notice();
				selectPrincipal(principal);
			} else {
				const principal = await adminMachineAccessAPI.enable(selectedPrincipal.id);
				notice = $LL.admin_machine_access_enabled_notice();
				selectPrincipal(principal);
			}
			await loadPrincipals();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_machine_access_status_update_failed();
		} finally {
			saving = false;
		}
	}

	async function createCredential() {
		if (!selectedPrincipal) return;
		saving = true;
		error = '';
		notice = '';
		try {
			await adminMachineAccessAPI.createCredential(selectedPrincipal.id, {
				kid: credentialKid.trim(),
				display_name: credentialDisplayName.trim(),
				description: credentialDescription.trim() || undefined,
				alg: credentialAlg,
				public_jwk: parsePublicJwk(credentialPublicJwk),
				permissions: parseLines(credentialPermissions),
				tenant_scopes: parseTenantScopes(credentialTenantScopes)
			});
			credentialKid = '';
			credentialDisplayName = '';
			credentialDescription = '';
			notice = $LL.admin_machine_access_credential_created_notice();
			await refreshSelected();
		} catch (err) {
			error =
				err instanceof Error ? err.message : $LL.admin_machine_access_credential_create_failed();
		} finally {
			saving = false;
		}
	}

	async function rotateCredential() {
		if (!selectedPrincipal || !selectedCredential) return;
		saving = true;
		error = '';
		notice = '';
		try {
			await adminMachineAccessAPI.rotateCredential(selectedPrincipal.id, selectedCredential.id, {
				kid: rotateKid.trim(),
				display_name: rotateDisplayName.trim(),
				alg: rotateAlg,
				public_jwk: parsePublicJwk(rotatePublicJwk),
				overlap_seconds: rotateOverlapSeconds
			});
			rotateKid = '';
			rotateDisplayName = '';
			notice = $LL.admin_machine_access_credential_rotation_notice();
			await refreshSelected();
		} catch (err) {
			error =
				err instanceof Error ? err.message : $LL.admin_machine_access_credential_rotate_failed();
		} finally {
			saving = false;
		}
	}

	async function emergencyRevokeCredential() {
		if (!selectedPrincipal || !selectedCredential) return;
		saving = true;
		error = '';
		notice = '';
		try {
			await adminMachineAccessAPI.emergencyRevokeCredential(
				selectedPrincipal.id,
				selectedCredential.id,
				emergencyReason.trim() || $LL.admin_machine_access_default_revoke_reason()
			);
			emergencyReason = '';
			notice = $LL.admin_machine_access_credential_revoked_notice();
			await refreshSelected();
		} catch (err) {
			error =
				err instanceof Error ? err.message : $LL.admin_machine_access_credential_revoke_failed();
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_machine_access_head_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_machine_access_title()}
		description={$LL.admin_machine_access_description()}
	>
		{#snippet actions()}
			<select
				class="form-select action-select"
				bind:value={statusFilter}
				onchange={() => void loadPrincipals()}
			>
				<option value="">{$LL.admin_machine_access_all_statuses()}</option>
				<option value="active">{$LL.admin_machine_access_status_active()}</option>
				<option value="disabled">{$LL.admin_machine_access_status_disabled()}</option>
				<option value="deleted">{$LL.admin_machine_access_status_deleted()}</option>
			</select>
			<button class="btn btn-secondary" onclick={() => void loadPrincipals()} disabled={loading}>
				<i class="i-ph-arrow-clockwise"></i>
				{$LL.admin_machine_access_refresh()}
			</button>
		{/snippet}
	</AdminPageHeader>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}
	{#if notice}
		<div class="alert alert-success">{notice}</div>
	{/if}

	<div class="summary-grid">
		<div class="summary-tile">
			<span>{$LL.admin_machine_access_principals()}</span>
			<strong>{principals.length}</strong>
		</div>
		<div class="summary-tile">
			<span>{$LL.admin_machine_access_active_credentials()}</span>
			<strong>{activeCredentialCount}</strong>
		</div>
		<div class="summary-tile">
			<span>{$LL.admin_machine_access_selected()}</span>
			<strong>{selectedPrincipal?.clientId || '-'}</strong>
		</div>
	</div>

	<div class="machine-layout">
		<section class="panel">
			<div class="panel-header">
				<h2>{$LL.admin_machine_access_principals()}</h2>
				<span
					>{loading
						? $LL.admin_machine_access_loading()
						: $LL.admin_machine_access_shown_count({ count: principals.length })}</span
				>
			</div>
			<div class="principal-list">
				{#each principals as principal (principal.id)}
					<button
						class:selected={selectedPrincipal?.id === principal.id}
						class="principal-row"
						onclick={() => selectPrincipal(principal)}
					>
						<span>
							<strong>{principal.displayName}</strong>
							<small>{principal.clientId}</small>
						</span>
						<span class="row-meta">
							<em>{formatPrincipalType(principal.principalType)}</em>
							<b class={`status ${principal.status}`}>{formatPrincipalStatus(principal.status)}</b>
						</span>
					</button>
				{/each}
				{#if !loading && principals.length === 0}
					<p class="empty-state">{$LL.admin_machine_access_no_principals()}</p>
				{/if}
			</div>
		</section>

		<section class="panel">
			<div class="panel-header">
				<h2>{$LL.admin_machine_access_create_principal()}</h2>
			</div>
			<div class="form-grid">
				<label>
					{$LL.admin_machine_access_client_id()}
					<input class="form-input" bind:value={createClientId} placeholder="automation-admin" />
				</label>
				<label>
					{$LL.admin_machine_access_display_name()}
					<input class="form-input" bind:value={createDisplayName} placeholder="Automation Admin" />
				</label>
				<label>
					{$LL.admin_machine_access_type()}
					<select class="form-select" bind:value={createPrincipalType}>
						{#each PRINCIPAL_TYPES as type (type)}
							<option value={type}>{formatPrincipalType(type)}</option>
						{/each}
					</select>
				</label>
				<label>
					{$LL.admin_machine_access_token_ttl_seconds()}
					<input class="form-input" type="number" min="60" max="900" bind:value={createTokenTtl} />
				</label>
				<label class="wide">
					{$LL.admin_machine_access_description_label()}
					<input class="form-input" bind:value={createDescription} />
				</label>
				<label>
					{$LL.admin_machine_access_permissions()}
					<textarea class="form-textarea" bind:value={createPermissions}></textarea>
				</label>
				<label>
					{$LL.admin_machine_access_tenant_scopes()}
					<textarea class="form-textarea" bind:value={createTenantScopes}></textarea>
				</label>
			</div>
			<button class="btn btn-primary" onclick={() => void createPrincipal()} disabled={saving}>
				<i class="i-ph-plus"></i>
				{$LL.admin_machine_access_create_principal()}
			</button>
		</section>
	</div>

	{#if selectedPrincipal}
		<div class="detail-layout">
			<section class="panel">
				<div class="panel-header">
					<h2>{$LL.admin_machine_access_principal_grants()}</h2>
					<b class={`status ${selectedPrincipal.status}`}
						>{formatPrincipalStatus(selectedPrincipal.status)}</b
					>
				</div>
				<div class="form-grid">
					<label>
						{$LL.admin_machine_access_display_name()}
						<input class="form-input" bind:value={editDisplayName} />
					</label>
					<label>
						{$LL.admin_machine_access_token_ttl_seconds()}
						<input class="form-input" type="number" min="60" max="900" bind:value={editTokenTtl} />
					</label>
					<label class="wide">
						{$LL.admin_machine_access_description_label()}
						<input class="form-input" bind:value={editDescription} />
					</label>
					<label>
						{$LL.admin_machine_access_permissions()}
						<textarea class="form-textarea tall" bind:value={editPermissions}></textarea>
					</label>
					<label>
						{$LL.admin_machine_access_tenant_scopes()}
						<textarea class="form-textarea tall" bind:value={editTenantScopes}></textarea>
					</label>
				</div>
				<div class="button-row">
					<button class="btn btn-primary" onclick={() => void savePrincipal()} disabled={saving}>
						<i class="i-ph-floppy-disk"></i>
						{$LL.admin_machine_access_save_grants()}
					</button>
					<input
						class="form-input compact"
						bind:value={disableReason}
						placeholder={$LL.admin_machine_access_disable_reason()}
						disabled={selectedPrincipal.status !== 'active'}
					/>
					<button
						class="btn btn-warning"
						onclick={() => void togglePrincipalStatus()}
						disabled={saving}
					>
						{selectedPrincipal.status === 'active'
							? $LL.admin_machine_access_disable()
							: $LL.admin_machine_access_enable()}
					</button>
				</div>
			</section>

			<section class="panel">
				<div class="panel-header">
					<h2>{$LL.admin_machine_access_credentials()}</h2>
					<span
						>{$LL.admin_machine_access_total_count({
							count: selectedPrincipal.credentials.length
						})}</span
					>
				</div>
				<div class="credential-list">
					{#each selectedPrincipal.credentials as credential (credential.id)}
						<button
							class:selected={selectedCredential?.id === credential.id}
							class="credential-row"
							onclick={() => (selectedCredential = credential)}
						>
							<span>
								<strong>{credential.displayName}</strong>
								<small>{credential.kid}</small>
							</span>
							<span class="row-meta">
								<em>{credential.alg}</em>
								<b class={`status ${credential.status}`}
									>{formatCredentialStatus(credential.status)}</b
								>
							</span>
						</button>
					{/each}
				</div>
				{#if selectedCredential}
					<div class="credential-detail">
						<dl>
							<div>
								<dt>{$LL.admin_machine_access_id()}</dt>
								<dd>{selectedCredential.id}</dd>
							</div>
							<div>
								<dt>{$LL.admin_machine_access_last_used()}</dt>
								<dd>{formatDate(selectedCredential.lastUsedAt)}</dd>
							</div>
							<div>
								<dt>{$LL.admin_machine_access_last_ip()}</dt>
								<dd>{selectedCredential.lastUsedIp || '-'}</dd>
							</div>
							<div>
								<dt>{$LL.admin_machine_access_expires()}</dt>
								<dd>{formatDate(selectedCredential.expiresAt)}</dd>
							</div>
						</dl>
						<div class="button-row">
							<input
								class="form-input compact"
								bind:value={emergencyReason}
								placeholder={$LL.admin_machine_access_revoke_reason()}
							/>
							<button
								class="btn btn-danger"
								onclick={() => void emergencyRevokeCredential()}
								disabled={saving || selectedCredential.status === 'revoked'}
							>
								{$LL.admin_machine_access_emergency_revoke()}
							</button>
						</div>
					</div>
				{/if}
			</section>
		</div>

		<div class="detail-layout">
			<section class="panel">
				<div class="panel-header">
					<h2>{$LL.admin_machine_access_create_credential()}</h2>
				</div>
				<div class="form-grid">
					<label>
						{$LL.admin_machine_access_key_id()}
						<input class="form-input" bind:value={credentialKid} placeholder="automation-2026-05" />
					</label>
					<label>
						{$LL.admin_machine_access_display_name()}
						<input class="form-input" bind:value={credentialDisplayName} />
					</label>
					<label>
						{$LL.admin_machine_access_algorithm()}
						<select class="form-select" bind:value={credentialAlg}>
							{#each ALGORITHMS as alg (alg)}
								<option value={alg}>{alg}</option>
							{/each}
						</select>
					</label>
					<label class="wide">
						{$LL.admin_machine_access_description_label()}
						<input class="form-input" bind:value={credentialDescription} />
					</label>
					<label>
						{$LL.admin_machine_access_permissions()}
						<textarea class="form-textarea" bind:value={credentialPermissions}></textarea>
					</label>
					<label>
						{$LL.admin_machine_access_tenant_scopes()}
						<textarea class="form-textarea" bind:value={credentialTenantScopes}></textarea>
					</label>
					<label class="wide">
						{$LL.admin_machine_access_public_jwk()}
						<textarea class="form-textarea jwk" bind:value={credentialPublicJwk}></textarea>
					</label>
				</div>
				<button class="btn btn-primary" onclick={() => void createCredential()} disabled={saving}>
					<i class="i-ph-key"></i>
					{$LL.admin_machine_access_create_credential()}
				</button>
			</section>

			<section class="panel">
				<div class="panel-header">
					<h2>{$LL.admin_machine_access_rotate_selected_credential()}</h2>
					<span>{selectedCredential?.kid || $LL.admin_machine_access_no_credential_selected()}</span
					>
				</div>
				<div class="form-grid">
					<label>
						{$LL.admin_machine_access_new_key_id()}
						<input class="form-input" bind:value={rotateKid} />
					</label>
					<label>
						{$LL.admin_machine_access_display_name()}
						<input class="form-input" bind:value={rotateDisplayName} />
					</label>
					<label>
						{$LL.admin_machine_access_algorithm()}
						<select class="form-select" bind:value={rotateAlg}>
							{#each ALGORITHMS as alg (alg)}
								<option value={alg}>{alg}</option>
							{/each}
						</select>
					</label>
					<label>
						{$LL.admin_machine_access_overlap_seconds()}
						<input
							class="form-input"
							type="number"
							min="0"
							max="604800"
							bind:value={rotateOverlapSeconds}
						/>
					</label>
					<label class="wide">
						{$LL.admin_machine_access_public_jwk()}
						<textarea class="form-textarea jwk" bind:value={rotatePublicJwk}></textarea>
					</label>
				</div>
				<button
					class="btn btn-warning"
					onclick={() => void rotateCredential()}
					disabled={saving || !selectedCredential}
				>
					<i class="i-ph-arrows-clockwise"></i>
					{$LL.admin_machine_access_rotate_credential()}
				</button>
			</section>
		</div>
	{/if}
</AdminPageShell>

<style>
	.panel-header,
	.button-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.summary-grid,
	.machine-layout,
	.detail-layout {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1rem;
	}

	.machine-layout,
	.detail-layout {
		grid-template-columns: minmax(280px, 0.85fr) minmax(420px, 1.15fr);
		align-items: start;
	}

	.summary-tile,
	.panel {
		border: var(--settings-panel-border, 1px solid var(--color-border));
		border-radius: var(--settings-panel-radius, var(--radius-panel));
		background: var(--settings-panel-bg, var(--color-surface));
		box-shadow: var(--settings-panel-shadow, var(--card-shadow, none));
		min-width: 0;
	}

	.summary-tile {
		padding: var(--settings-panel-padding, 1rem);
	}

	.summary-tile span,
	.panel-header span,
	label,
	small,
	dt {
		color: var(--color-text-muted);
	}

	.summary-tile strong {
		display: block;
		margin-top: 0.25rem;
		font-size: 1.5rem;
	}

	.panel {
		padding: var(--settings-panel-padding, 1rem);
	}

	.panel-header {
		margin-bottom: 1rem;
	}

	.panel-header h2 {
		margin: 0;
		font-size: 1rem;
	}

	.principal-list,
	.credential-list {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.principal-row,
	.credential-row {
		display: flex;
		width: 100%;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		border: var(--settings-card-border, 1px solid var(--color-border));
		border-radius: var(--settings-card-radius, var(--radius-control));
		background: transparent;
		padding: 0.75rem;
		text-align: left;
		cursor: pointer;
		color: var(--color-text);
		transition:
			background var(--transition-fast),
			border-color var(--transition-fast);
	}

	.principal-row:hover,
	.credential-row:hover {
		background: var(--table-row-hover-bg, var(--color-surface-muted));
	}

	.principal-row.selected,
	.credential-row.selected {
		border-color: var(--color-accent);
		background: color-mix(in srgb, var(--color-accent) 9%, transparent);
	}

	.principal-row span,
	.credential-row span {
		display: flex;
		min-width: 0;
		flex-direction: column;
	}

	.principal-row strong,
	.credential-row strong,
	.principal-row small,
	.credential-row small {
		overflow-wrap: anywhere;
	}

	.row-meta {
		align-items: flex-end;
		flex-shrink: 0;
	}

	.status {
		border-radius: var(--radius-full);
		padding: 0.125rem 0.5rem;
		font-size: 0.75rem;
		text-transform: capitalize;
	}

	.status.active {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.status.disabled,
	.status.rotating {
		background: color-mix(in srgb, var(--color-warning) 16%, transparent);
		color: var(--color-warning);
	}

	.status.deleted,
	.status.revoked,
	.status.expired {
		background: color-mix(in srgb, var(--color-danger) 14%, transparent);
		color: var(--color-danger);
	}

	.form-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.875rem;
		margin-bottom: 1rem;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.875rem;
	}

	.wide {
		grid-column: 1 / -1;
	}

	.form-input,
	.form-select,
	.form-textarea {
		width: 100%;
		min-height: var(--control-height, 38px);
		border: 1px solid var(--control-border, var(--color-border));
		border-radius: var(--control-radius, var(--radius-control));
		background: var(--control-bg, var(--color-surface));
		padding: var(--control-padding, 0.55rem 0.65rem);
		color: var(--color-text);
		font: inherit;
	}

	.action-select {
		width: auto;
		min-width: 14rem;
	}

	.form-input:focus,
	.form-select:focus,
	.form-textarea:focus {
		outline: 2px solid color-mix(in srgb, var(--color-accent) 28%, transparent);
		outline-offset: 1px;
	}

	.form-textarea {
		min-height: 6.5rem;
		resize: vertical;
	}

	.form-textarea.tall,
	.form-textarea.jwk {
		min-height: 9rem;
		font-family: var(--font-mono);
		font-size: 0.8125rem;
	}

	.compact {
		max-width: 18rem;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		border: 1px solid var(--control-border, transparent);
		border-radius: var(--control-radius, var(--radius-control));
		padding: var(--button-padding, 0.55rem 0.8rem);
		font-weight: 600;
		cursor: pointer;
		transition:
			background var(--transition-fast),
			border-color var(--transition-fast),
			color var(--transition-fast);
	}

	.btn:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	.btn-primary {
		border-color: var(--color-accent);
		background: var(--color-accent);
		color: var(--color-accent-contrast);
	}

	.btn-secondary {
		border-color: var(--color-border);
		background: var(--color-surface-muted);
		color: var(--color-text);
	}

	.btn-warning {
		border-color: color-mix(in srgb, var(--color-warning) 40%, var(--color-border));
		background: color-mix(in srgb, var(--color-warning) 16%, var(--color-surface));
		color: var(--color-warning);
	}

	.btn-danger {
		border-color: color-mix(in srgb, var(--color-danger) 40%, var(--color-border));
		background: color-mix(in srgb, var(--color-danger) 14%, var(--color-surface));
		color: var(--color-danger);
	}

	.alert {
		border-radius: var(--radius-control);
		padding: 0.75rem 1rem;
	}

	.alert-error {
		border: 1px solid color-mix(in srgb, var(--color-danger) 32%, var(--color-border));
		background: color-mix(in srgb, var(--color-danger) 10%, var(--color-surface));
		color: var(--color-danger);
	}

	.alert-success {
		border: 1px solid color-mix(in srgb, var(--color-success) 32%, var(--color-border));
		background: color-mix(in srgb, var(--color-success) 10%, var(--color-surface));
		color: var(--color-success);
	}

	.credential-detail {
		margin-top: 1rem;
		border-top: var(--settings-row-border-bottom, 1px solid var(--color-border));
		padding-top: 1rem;
	}

	dl {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.75rem;
		margin: 0 0 1rem;
	}

	dt,
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}

	.empty-state {
		margin: 0;
		color: var(--color-text-muted);
	}

	@media (max-width: 960px) {
		.summary-grid,
		.machine-layout,
		.detail-layout,
		.form-grid,
		dl {
			grid-template-columns: 1fr;
		}

		.panel-header,
		.button-row {
			align-items: stretch;
			flex-direction: column;
		}

		.compact {
			max-width: none;
		}
	}
</style>
