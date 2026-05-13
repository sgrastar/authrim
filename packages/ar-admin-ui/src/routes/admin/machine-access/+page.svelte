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
	let credentialPublicJwk = $state('{\n  "kty": "EC",\n  "crv": "P-256",\n  "x": "",\n  "y": ""\n}');
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

	function formatPrincipalType(value: string): string {
		return value.replaceAll('_', ' ');
	}

	function formatTenantScopes(scopes: AdminMachineTenantScope[]): string {
		if (!scopes.length) return 'none';
		return scopes
			.map((scope) => (scope.scopeMode === 'allow' ? `allow:${scope.tenantId}` : scope.scopeMode))
			.join('\n');
	}

	function parseLines(value: string): string[] {
		return value
			.split(/\r?\n|,/)
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
			throw new Error('Public JWK must be a JSON object');
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
		principals = principals.map((principal) => (principal.id === refreshed.id ? refreshed : principal));
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
				const stillSelected = principals.find((principal) => principal.id === selectedPrincipal?.id);
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
			error = err instanceof Error ? err.message : 'Failed to load machine access principals';
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
			notice = 'Machine principal created';
			await loadPrincipals();
			const created = principals.find((entry) => entry.id === principal.id);
			if (created) selectPrincipal(created);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create machine principal';
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
			notice = 'Machine principal updated';
			selectPrincipal(principal);
			await loadPrincipals();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to update machine principal';
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
					disableReason.trim() || 'disabled from Admin UI'
				);
				notice = 'Machine principal disabled';
				selectPrincipal(principal);
			} else {
				const principal = await adminMachineAccessAPI.enable(selectedPrincipal.id);
				notice = 'Machine principal enabled';
				selectPrincipal(principal);
			}
			await loadPrincipals();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to update principal status';
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
			notice = 'Machine credential created';
			await refreshSelected();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create machine credential';
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
			notice = 'Machine credential rotation started';
			await refreshSelected();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to rotate machine credential';
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
				emergencyReason.trim() || 'emergency revoke from Admin UI'
			);
			emergencyReason = '';
			notice = 'Machine credential revoked';
			await refreshSelected();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to revoke machine credential';
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head>
	<title>Admin Machine Access - Authrim</title>
</svelte:head>

<div class="admin-page">
	<div class="page-header">
		<div>
			<h1 class="page-title">Admin Machine Access</h1>
			<p class="page-description">Manage scoped machine principals, credentials, and tenant grants.</p>
		</div>
		<div class="page-actions">
			<select class="form-select" bind:value={statusFilter} onchange={() => void loadPrincipals()}>
				<option value="">All statuses</option>
				<option value="active">Active</option>
				<option value="disabled">Disabled</option>
				<option value="deleted">Deleted</option>
			</select>
			<button class="btn btn-secondary" onclick={() => void loadPrincipals()} disabled={loading}>
				<i class="i-ph-arrow-clockwise"></i>
				Refresh
			</button>
		</div>
	</div>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}
	{#if notice}
		<div class="alert alert-success">{notice}</div>
	{/if}

	<div class="summary-grid">
		<div class="summary-tile">
			<span>Principals</span>
			<strong>{principals.length}</strong>
		</div>
		<div class="summary-tile">
			<span>Active credentials</span>
			<strong>{activeCredentialCount}</strong>
		</div>
		<div class="summary-tile">
			<span>Selected</span>
			<strong>{selectedPrincipal?.clientId || '-'}</strong>
		</div>
	</div>

	<div class="machine-layout">
		<section class="panel">
			<div class="panel-header">
				<h2>Principals</h2>
				<span>{loading ? 'Loading' : `${principals.length} shown`}</span>
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
							<b class={`status ${principal.status}`}>{principal.status}</b>
						</span>
					</button>
				{/each}
				{#if !loading && principals.length === 0}
					<p class="empty-state">No machine principals found.</p>
				{/if}
			</div>
		</section>

		<section class="panel">
			<div class="panel-header">
				<h2>Create principal</h2>
			</div>
			<div class="form-grid">
				<label>
					Client ID
					<input class="form-input" bind:value={createClientId} placeholder="automation-admin" />
				</label>
				<label>
					Display name
					<input class="form-input" bind:value={createDisplayName} placeholder="Automation Admin" />
				</label>
				<label>
					Type
					<select class="form-select" bind:value={createPrincipalType}>
						{#each PRINCIPAL_TYPES as type}
							<option value={type}>{formatPrincipalType(type)}</option>
						{/each}
					</select>
				</label>
				<label>
					Token TTL seconds
					<input class="form-input" type="number" min="60" max="900" bind:value={createTokenTtl} />
				</label>
				<label class="wide">
					Description
					<input class="form-input" bind:value={createDescription} />
				</label>
				<label>
					Permissions
					<textarea class="form-textarea" bind:value={createPermissions}></textarea>
				</label>
				<label>
					Tenant scopes
					<textarea class="form-textarea" bind:value={createTenantScopes}></textarea>
				</label>
			</div>
			<button class="btn btn-primary" onclick={() => void createPrincipal()} disabled={saving}>
				<i class="i-ph-plus"></i>
				Create principal
			</button>
		</section>
	</div>

	{#if selectedPrincipal}
		<div class="detail-layout">
			<section class="panel">
				<div class="panel-header">
					<h2>Principal grants</h2>
					<b class={`status ${selectedPrincipal.status}`}>{selectedPrincipal.status}</b>
				</div>
				<div class="form-grid">
					<label>
						Display name
						<input class="form-input" bind:value={editDisplayName} />
					</label>
					<label>
						Token TTL seconds
						<input class="form-input" type="number" min="60" max="900" bind:value={editTokenTtl} />
					</label>
					<label class="wide">
						Description
						<input class="form-input" bind:value={editDescription} />
					</label>
					<label>
						Permissions
						<textarea class="form-textarea tall" bind:value={editPermissions}></textarea>
					</label>
					<label>
						Tenant scopes
						<textarea class="form-textarea tall" bind:value={editTenantScopes}></textarea>
					</label>
				</div>
				<div class="button-row">
					<button class="btn btn-primary" onclick={() => void savePrincipal()} disabled={saving}>
						<i class="i-ph-floppy-disk"></i>
						Save grants
					</button>
					<input
						class="form-input compact"
						bind:value={disableReason}
						placeholder="Disable reason"
						disabled={selectedPrincipal.status !== 'active'}
					/>
					<button class="btn btn-warning" onclick={() => void togglePrincipalStatus()} disabled={saving}>
						{selectedPrincipal.status === 'active' ? 'Disable' : 'Enable'}
					</button>
				</div>
			</section>

			<section class="panel">
				<div class="panel-header">
					<h2>Credentials</h2>
					<span>{selectedPrincipal.credentials.length} total</span>
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
								<b class={`status ${credential.status}`}>{credential.status}</b>
							</span>
						</button>
					{/each}
				</div>
				{#if selectedCredential}
					<div class="credential-detail">
						<dl>
							<div><dt>ID</dt><dd>{selectedCredential.id}</dd></div>
							<div><dt>Last used</dt><dd>{formatDate(selectedCredential.lastUsedAt)}</dd></div>
							<div><dt>Last IP</dt><dd>{selectedCredential.lastUsedIp || '-'}</dd></div>
							<div><dt>Expires</dt><dd>{formatDate(selectedCredential.expiresAt)}</dd></div>
						</dl>
						<div class="button-row">
							<input class="form-input compact" bind:value={emergencyReason} placeholder="Revoke reason" />
							<button
								class="btn btn-danger"
								onclick={() => void emergencyRevokeCredential()}
								disabled={saving || selectedCredential.status === 'revoked'}
							>
								Emergency revoke
							</button>
						</div>
					</div>
				{/if}
			</section>
		</div>

		<div class="detail-layout">
			<section class="panel">
				<div class="panel-header">
					<h2>Create credential</h2>
				</div>
				<div class="form-grid">
					<label>
						Key ID
						<input class="form-input" bind:value={credentialKid} placeholder="automation-2026-05" />
					</label>
					<label>
						Display name
						<input class="form-input" bind:value={credentialDisplayName} />
					</label>
					<label>
						Algorithm
						<select class="form-select" bind:value={credentialAlg}>
							{#each ALGORITHMS as alg}
								<option value={alg}>{alg}</option>
							{/each}
						</select>
					</label>
					<label class="wide">
						Description
						<input class="form-input" bind:value={credentialDescription} />
					</label>
					<label>
						Permissions
						<textarea class="form-textarea" bind:value={credentialPermissions}></textarea>
					</label>
					<label>
						Tenant scopes
						<textarea class="form-textarea" bind:value={credentialTenantScopes}></textarea>
					</label>
					<label class="wide">
						Public JWK
						<textarea class="form-textarea jwk" bind:value={credentialPublicJwk}></textarea>
					</label>
				</div>
				<button class="btn btn-primary" onclick={() => void createCredential()} disabled={saving}>
					<i class="i-ph-key"></i>
					Create credential
				</button>
			</section>

			<section class="panel">
				<div class="panel-header">
					<h2>Rotate selected credential</h2>
					<span>{selectedCredential?.kid || 'No credential selected'}</span>
				</div>
				<div class="form-grid">
					<label>
						New key ID
						<input class="form-input" bind:value={rotateKid} />
					</label>
					<label>
						Display name
						<input class="form-input" bind:value={rotateDisplayName} />
					</label>
					<label>
						Algorithm
						<select class="form-select" bind:value={rotateAlg}>
							{#each ALGORITHMS as alg}
								<option value={alg}>{alg}</option>
							{/each}
						</select>
					</label>
					<label>
						Overlap seconds
						<input class="form-input" type="number" min="0" max="604800" bind:value={rotateOverlapSeconds} />
					</label>
					<label class="wide">
						Public JWK
						<textarea class="form-textarea jwk" bind:value={rotatePublicJwk}></textarea>
					</label>
				</div>
				<button
					class="btn btn-warning"
					onclick={() => void rotateCredential()}
					disabled={saving || !selectedCredential}
				>
					<i class="i-ph-arrows-clockwise"></i>
					Rotate credential
				</button>
			</section>
		</div>
	{/if}
</div>

<style>
	.admin-page {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		padding: 1.5rem;
	}

	.page-header,
	.panel-header,
	.button-row,
	.page-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.page-title {
		margin: 0;
		font-size: 1.875rem;
		font-weight: 700;
	}

	.page-description {
		margin: 0.25rem 0 0;
		color: var(--color-text-secondary, #64748b);
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
		border: 1px solid var(--color-border, #e2e8f0);
		border-radius: 8px;
		background: var(--color-surface, #fff);
	}

	.summary-tile {
		padding: 1rem;
	}

	.summary-tile span,
	.panel-header span,
	label,
	small,
	dt {
		color: var(--color-text-secondary, #64748b);
	}

	.summary-tile strong {
		display: block;
		margin-top: 0.25rem;
		font-size: 1.5rem;
	}

	.panel {
		padding: 1rem;
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
		border: 1px solid var(--color-border, #e2e8f0);
		border-radius: 6px;
		background: transparent;
		padding: 0.75rem;
		text-align: left;
		cursor: pointer;
	}

	.principal-row.selected,
	.credential-row.selected {
		border-color: var(--color-primary, #2563eb);
		background: color-mix(in srgb, var(--color-primary, #2563eb) 8%, transparent);
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
		border-radius: 999px;
		padding: 0.125rem 0.5rem;
		font-size: 0.75rem;
		text-transform: capitalize;
	}

	.status.active {
		background: #dcfce7;
		color: #166534;
	}

	.status.disabled,
	.status.rotating {
		background: #fef3c7;
		color: #92400e;
	}

	.status.deleted,
	.status.revoked,
	.status.expired {
		background: #fee2e2;
		color: #991b1b;
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
		border: 1px solid var(--color-border, #cbd5e1);
		border-radius: 6px;
		background: var(--color-surface, #fff);
		padding: 0.55rem 0.65rem;
		color: inherit;
		font: inherit;
	}

	.form-textarea {
		min-height: 6.5rem;
		resize: vertical;
	}

	.form-textarea.tall,
	.form-textarea.jwk {
		min-height: 9rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
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
		border: 1px solid transparent;
		border-radius: 6px;
		padding: 0.55rem 0.8rem;
		font-weight: 600;
		cursor: pointer;
	}

	.btn:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	.btn-primary {
		background: var(--color-primary, #2563eb);
		color: #fff;
	}

	.btn-secondary {
		border-color: var(--color-border, #cbd5e1);
		background: transparent;
	}

	.btn-warning {
		background: #f59e0b;
		color: #111827;
	}

	.btn-danger {
		background: #dc2626;
		color: #fff;
	}

	.alert {
		border-radius: 8px;
		padding: 0.75rem 1rem;
	}

	.alert-error {
		background: #fee2e2;
		color: #991b1b;
	}

	.alert-success {
		background: #dcfce7;
		color: #166534;
	}

	.credential-detail {
		margin-top: 1rem;
		border-top: 1px solid var(--color-border, #e2e8f0);
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
		color: var(--color-text-secondary, #64748b);
	}

	@media (max-width: 960px) {
		.summary-grid,
		.machine-layout,
		.detail-layout,
		.form-grid,
		dl {
			grid-template-columns: 1fr;
		}

		.page-header,
		.panel-header,
		.button-row,
		.page-actions {
			align-items: stretch;
			flex-direction: column;
		}

		.compact {
			max-width: none;
		}
	}
</style>
