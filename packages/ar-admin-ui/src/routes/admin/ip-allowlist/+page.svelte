<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminIpAllowlistAPI,
		type IpAllowlistEntry,
		validateIpRange
	} from '$lib/api/admin-ip-allowlist';
	import { Modal } from '$lib/components';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminToolbar
	} from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';

	let entries: IpAllowlistEntry[] = $state([]);
	let currentIp = $state('');
	let restrictionActive = $state(false);
	let loading = $state(true);
	let error = $state('');
	let includeDisabled = $state(false);

	// Create dialog state
	let showCreateDialog = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let newIpRange = $state('');
	let newDescription = $state('');

	// Edit dialog state
	let showEditDialog = $state(false);
	let editingEntry: IpAllowlistEntry | null = $state(null);
	let editIpRange = $state('');
	let editDescription = $state('');
	let saving = $state(false);

	// IP check dialog
	let showCheckDialog = $state(false);
	let checkIp = $state('');
	let checkResult: { allowed: boolean; restriction_active: boolean } | null = $state(null);
	let checking = $state(false);

	async function loadEntries() {
		loading = true;
		error = '';

		try {
			const response = await adminIpAllowlistAPI.list(includeDisabled);
			entries = response.items;
			currentIp = response.current_ip;
			restrictionActive = response.restriction_active;
		} catch (err) {
			console.error('Failed to load IP allowlist:', err);
			error = err instanceof Error ? err.message : $LL.admin_ip_allowlist_load_failed();
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadEntries();
	});

	function openCreateDialog() {
		newIpRange = '';
		newDescription = '';
		createError = '';
		showCreateDialog = true;
	}

	function closeCreateDialog() {
		showCreateDialog = false;
	}

	async function handleCreate() {
		const validation = validateIpRange(newIpRange);
		if (!validation.valid) {
			createError = formatValidationError(validation.error);
			return;
		}

		creating = true;
		createError = '';

		try {
			await adminIpAllowlistAPI.create({
				ip_range: newIpRange.trim(),
				description: newDescription.trim() || undefined
			});
			closeCreateDialog();
			loadEntries();
		} catch (err) {
			createError = err instanceof Error ? err.message : $LL.admin_ip_allowlist_create_failed();
		} finally {
			creating = false;
		}
	}

	function openEditDialog(entry: IpAllowlistEntry) {
		editingEntry = entry;
		editIpRange = entry.ip_range;
		editDescription = entry.description || '';
		showEditDialog = true;
	}

	function closeEditDialog() {
		showEditDialog = false;
		editingEntry = null;
	}

	async function handleSave() {
		if (!editingEntry) return;

		const validation = validateIpRange(editIpRange);
		if (!validation.valid) {
			alert(formatValidationError(validation.error));
			return;
		}

		saving = true;

		try {
			await adminIpAllowlistAPI.update(editingEntry.id, {
				ip_range: editIpRange.trim(),
				description: editDescription.trim() || undefined
			});
			closeEditDialog();
			loadEntries();
		} catch (err) {
			alert(err instanceof Error ? err.message : $LL.admin_ip_allowlist_update_failed());
		} finally {
			saving = false;
		}
	}

	async function handleDelete(entry: IpAllowlistEntry) {
		if (!confirm($LL.admin_ip_allowlist_delete_confirm({ ipRange: entry.ip_range }))) return;

		try {
			await adminIpAllowlistAPI.delete(entry.id);
			loadEntries();
		} catch (err) {
			alert(err instanceof Error ? err.message : $LL.admin_ip_allowlist_delete_failed());
		}
	}

	async function handleToggleEnabled(entry: IpAllowlistEntry) {
		try {
			if (entry.enabled) {
				await adminIpAllowlistAPI.disable(entry.id);
			} else {
				await adminIpAllowlistAPI.enable(entry.id);
			}
			loadEntries();
		} catch (err) {
			alert(err instanceof Error ? err.message : $LL.admin_ip_allowlist_toggle_failed());
		}
	}

	function openCheckDialog() {
		checkIp = '';
		checkResult = null;
		showCheckDialog = true;
	}

	function closeCheckDialog() {
		showCheckDialog = false;
	}

	async function handleCheckIp() {
		if (!checkIp.trim()) return;

		checking = true;
		try {
			checkResult = await adminIpAllowlistAPI.checkIp(checkIp.trim());
		} catch (err) {
			alert(err instanceof Error ? err.message : $LL.admin_ip_allowlist_check_failed());
		} finally {
			checking = false;
		}
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleString();
	}

	function formatValidationError(errorMessage?: string): string {
		switch (errorMessage) {
			case 'IPv6 CIDR prefix must be between 0 and 128':
				return $LL.admin_ip_allowlist_invalid_ipv6_cidr_prefix();
			case 'Invalid IPv6 address':
				return $LL.admin_ip_allowlist_invalid_ipv6();
			case 'IPv4 CIDR prefix must be between 0 and 32':
				return $LL.admin_ip_allowlist_invalid_ipv4_cidr_prefix();
			case 'Invalid IPv4 address':
				return $LL.admin_ip_allowlist_invalid_ipv4();
			default:
				return errorMessage || $LL.admin_ip_allowlist_invalid_ip_or_cidr();
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_ip_allowlist_head_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_ip_allowlist_title()}
		description={$LL.admin_ip_allowlist_description()}
	>
		{#snippet actions()}
			<button class="btn btn-secondary" onclick={openCheckDialog}>
				{$LL.admin_ip_allowlist_check_ip()}
			</button>
			<button class="btn btn-primary" onclick={openCreateDialog}>
				<i class="i-ph-plus"></i>
				{$LL.admin_ip_allowlist_add_ip()}
			</button>
		{/snippet}
	</AdminPageHeader>

	<!-- Status Banner -->
	<div class="status-banner {restrictionActive ? 'active' : 'inactive'}">
		<span
			class={restrictionActive
				? 'status-icon i-ph-shield-check'
				: 'status-icon i-ph-warning-circle'}
			aria-hidden="true"
		></span>
		<div class="status-text">
			{#if restrictionActive}
				<strong>{$LL.admin_ip_allowlist_restriction_active()}</strong>
				<span>{$LL.admin_ip_allowlist_restriction_active_description()}</span>
			{:else}
				<strong>{$LL.admin_ip_allowlist_no_restriction()}</strong>
				<span>{$LL.admin_ip_allowlist_no_restriction_description()}</span>
			{/if}
		</div>
		<div class="current-ip">
			{$LL.admin_ip_allowlist_your_ip()} <code>{currentIp}</code>
		</div>
	</div>

	<!-- Filters -->
	<AdminToolbar>
		<label class="checkbox-label">
			<input type="checkbox" bind:checked={includeDisabled} onchange={() => loadEntries()} />
			{$LL.admin_ip_allowlist_show_disabled_entries()}
		</label>
	</AdminToolbar>

	<!-- Content -->
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-spinner loading-spinner"></i>
			<p>{$LL.admin_ip_allowlist_loading()}</p>
		</div>
	{:else if error}
		<div class="error-state">
			<p class="error-text">{error}</p>
			<button class="btn btn-secondary" onclick={loadEntries}
				>{$LL.admin_ip_allowlist_retry()}</button
			>
		</div>
	{:else if entries.length === 0}
		<div class="empty-state">
			<p>{$LL.admin_ip_allowlist_empty()}</p>
			<p class="text-secondary">{$LL.admin_ip_allowlist_empty_description()}</p>
		</div>
	{:else}
		<AdminDataTable width="wide">
			<thead>
				<tr>
					<th>{$LL.admin_ip_allowlist_ip_range()}</th>
					<th>{$LL.admin_ip_allowlist_description_label()}</th>
					<th>{$LL.admin_ip_allowlist_version()}</th>
					<th>{$LL.admin_ip_allowlist_status()}</th>
					<th>{$LL.admin_ip_allowlist_created()}</th>
					<th>{$LL.admin_ip_allowlist_actions()}</th>
				</tr>
			</thead>
			<tbody>
				{#each entries as entry (entry.id)}
					<tr class:disabled={!entry.enabled}>
						<td>
							<code class="ip-code">{entry.ip_range}</code>
						</td>
						<td>{entry.description || '-'}</td>
						<td>IPv{entry.ip_version || '?'}</td>
						<td>
							{#if entry.enabled}
								<span class="badge badge-success">{$LL.admin_ip_allowlist_enabled()}</span>
							{:else}
								<span class="badge badge-neutral">{$LL.admin_ip_allowlist_disabled()}</span>
							{/if}
						</td>
						<td>{formatDate(entry.created_at)}</td>
						<td>
							<div class="action-buttons">
								<button class="btn btn-sm btn-secondary" onclick={() => handleToggleEnabled(entry)}>
									{entry.enabled
										? $LL.admin_ip_allowlist_disable()
										: $LL.admin_ip_allowlist_enable()}
								</button>
								<button class="btn btn-sm btn-secondary" onclick={() => openEditDialog(entry)}>
									{$LL.admin_ip_allowlist_edit()}
								</button>
								<button class="btn btn-sm btn-danger" onclick={() => handleDelete(entry)}>
									{$LL.admin_ip_allowlist_delete()}
								</button>
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</AdminDataTable>
	{/if}
</AdminPageShell>

<!-- Create Dialog -->
<Modal
	open={showCreateDialog}
	onClose={closeCreateDialog}
	title={$LL.admin_ip_allowlist_add_entry()}
	size="md"
>
	{#if createError}
		<div class="alert alert-danger">{createError}</div>
	{/if}
	<div class="admin-field modal-field">
		<label class="admin-field__label" for="ipRange">
			{$LL.admin_ip_allowlist_ip_range_required()}
		</label>
		<input
			type="text"
			id="ipRange"
			class="admin-input"
			bind:value={newIpRange}
			placeholder={$LL.admin_ip_allowlist_ip_range_placeholder()}
		/>
		<p class="field-hint">{$LL.admin_ip_allowlist_ip_range_help()}</p>
	</div>
	<div class="admin-field modal-field">
		<label class="admin-field__label" for="description">
			{$LL.admin_ip_allowlist_description_label()}
		</label>
		<input
			type="text"
			id="description"
			class="admin-input"
			bind:value={newDescription}
			placeholder={$LL.admin_ip_allowlist_description_placeholder()}
		/>
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeCreateDialog} disabled={creating}>
			{$LL.admin_ip_allowlist_cancel()}
		</button>
		<button class="btn btn-primary" onclick={handleCreate} disabled={creating}>
			{creating ? $LL.admin_ip_allowlist_adding() : $LL.admin_ip_allowlist_add()}
		</button>
	{/snippet}
</Modal>

<!-- Edit Dialog -->
<Modal
	open={showEditDialog && !!editingEntry}
	onClose={closeEditDialog}
	title={$LL.admin_ip_allowlist_edit_entry()}
	size="md"
>
	<div class="admin-field modal-field">
		<label class="admin-field__label" for="editIpRange">
			{$LL.admin_ip_allowlist_ip_range_label()}
		</label>
		<input type="text" id="editIpRange" class="admin-input" bind:value={editIpRange} />
	</div>
	<div class="admin-field modal-field">
		<label class="admin-field__label" for="editDescription">
			{$LL.admin_ip_allowlist_description_label()}
		</label>
		<input type="text" id="editDescription" class="admin-input" bind:value={editDescription} />
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeEditDialog} disabled={saving}>
			{$LL.admin_ip_allowlist_cancel()}
		</button>
		<button class="btn btn-primary" onclick={handleSave} disabled={saving}>
			{saving ? $LL.admin_ip_allowlist_saving() : $LL.admin_ip_allowlist_save()}
		</button>
	{/snippet}
</Modal>

<!-- Check IP Dialog -->
<Modal
	open={showCheckDialog}
	onClose={closeCheckDialog}
	title={$LL.admin_ip_allowlist_check_address()}
	size="md"
>
	<div class="admin-field modal-field">
		<label class="admin-field__label" for="checkIpInput">
			{$LL.admin_ip_allowlist_ip_address()}
		</label>
		<input
			type="text"
			id="checkIpInput"
			class="admin-input"
			bind:value={checkIp}
			placeholder={$LL.admin_ip_allowlist_check_placeholder()}
		/>
	</div>
	{#if checkResult !== null}
		<div class="check-result {checkResult.allowed ? 'allowed' : 'denied'}">
			{#if checkResult.restriction_active}
				{#if checkResult.allowed}
					<span class="result-icon">✓</span>
					<span>{$LL.admin_ip_allowlist_allowed_result()}</span>
				{:else}
					<span class="result-icon">✗</span>
					<span>{$LL.admin_ip_allowlist_denied_result()}</span>
				{/if}
			{:else}
				<span class="result-icon">○</span>
				<span>{$LL.admin_ip_allowlist_all_allowed_result()}</span>
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeCheckDialog}
			>{$LL.admin_ip_allowlist_close()}</button
		>
		<button class="btn btn-primary" onclick={handleCheckIp} disabled={checking || !checkIp.trim()}>
			{checking ? $LL.admin_ip_allowlist_checking() : $LL.admin_ip_allowlist_check()}
		</button>
	{/snippet}
</Modal>

<style>
	.status-banner {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 1rem 1.5rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		margin-bottom: 1.5rem;
		background: var(--color-surface);
		box-shadow: var(--card-shadow, var(--shadow-panel, none));
	}

	.status-banner.active {
		background: color-mix(in srgb, var(--color-success) 10%, var(--color-surface));
		border-color: color-mix(in srgb, var(--color-success) 36%, var(--color-border));
	}

	.status-banner.inactive {
		background: color-mix(in srgb, var(--color-warning) 10%, var(--color-surface));
		border-color: color-mix(in srgb, var(--color-warning) 36%, var(--color-border));
	}

	.status-icon {
		flex: none;
		width: 2rem;
		height: 2rem;
	}

	.status-banner.active .status-icon {
		color: var(--color-success);
	}

	.status-banner.inactive .status-icon {
		color: var(--color-warning);
	}

	.status-text {
		flex: 1;
	}

	.status-text strong {
		display: block;
		color: var(--color-text);
	}

	.status-text span {
		font-size: 0.875rem;
		color: var(--color-text-muted);
	}

	.current-ip {
		font-size: 0.875rem;
		color: var(--color-text);
	}

	.current-ip code {
		background: var(--color-surface-muted);
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius-control);
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
	}

	.checkbox-label {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		font-size: 0.875rem;
		color: var(--color-text);
	}

	tr.disabled {
		opacity: 0.6;
	}

	.ip-code {
		background: var(--color-surface-muted);
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius-control);
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		color: var(--color-text);
	}

	.action-buttons {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.error-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 48px 24px;
		text-align: center;
		color: var(--color-text-muted);
	}

	.error-text {
		color: var(--color-danger);
		margin-bottom: 1rem;
	}

	.text-secondary {
		color: var(--color-text-muted);
		font-size: 0.875rem;
	}

	.modal-field + .modal-field {
		margin-top: 1rem;
	}

	.alert-danger {
		border: 1px solid color-mix(in srgb, var(--color-danger) 32%, var(--color-border));
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
		color: var(--color-danger);
	}

	.check-result {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 1rem;
		border-radius: var(--radius-control);
		margin-top: 1rem;
	}

	.check-result.allowed {
		background: color-mix(in srgb, var(--color-success) 10%, transparent);
		color: var(--color-success);
	}

	.check-result.denied {
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
		color: var(--color-danger);
	}

	.result-icon {
		font-size: 1.25rem;
	}
</style>
