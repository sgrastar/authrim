<script lang="ts">
	import { onMount } from 'svelte';
	import { adminAdminPoliciesAPI } from '$lib/api/admin-admin-policies';
	import type {
		AdminPolicy,
		AdminPolicyCreateInput,
		AdminPolicyUpdateInput,
		PolicySimulationInput,
		PolicySimulationResult
	} from '$lib/api/admin-admin-policies';
	import {
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AdminToolbar
	} from '$lib/components/admin';
	import { Modal } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';

	let policies: AdminPolicy[] = [];
	let loading = true;
	let error = '';
	let searchQuery = '';
	let filterActive: 'all' | 'active' | 'inactive' = 'all';

	let showCreateDialog = false;
	let createForm: AdminPolicyCreateInput = {
		name: '',
		display_name: '',
		description: '',
		effect: 'allow',
		priority: 0,
		resource_pattern: '',
		actions: ['*'],
		conditions: { condition_type: 'all' }
	};
	let createLoading = false;
	let createError = '';

	let showEditDialog = false;
	let editingPolicy: AdminPolicy | null = null;
	let editForm: AdminPolicyUpdateInput = {};
	let editLoading = false;
	let editError = '';

	let showDeleteDialog = false;
	let deletingPolicy: AdminPolicy | null = null;
	let deleteLoading = false;
	let deleteError = '';

	let showSimulationDialog = false;
	let simulationForm: PolicySimulationInput = {
		resource: '',
		action: '',
		admin_user_context: {
			roles: [],
			attributes: {},
			relationships: []
		}
	};
	let simulationResult: PolicySimulationResult | null = null;
	let simulationLoading = false;
	let simulationError = '';

	async function loadPolicies() {
		loading = true;
		error = '';
		try {
			const response = await adminAdminPoliciesAPI.listPolicies({
				active_only: filterActive === 'active'
			});
			policies = response.items;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_admin_policies_load_failed();
		} finally {
			loading = false;
		}
	}

	function openCreateDialog() {
		createForm = {
			name: '',
			display_name: '',
			description: '',
			effect: 'allow',
			priority: 0,
			resource_pattern: '',
			actions: ['*'],
			conditions: { condition_type: 'all' }
		};
		createError = '';
		showCreateDialog = true;
	}

	async function handleCreate() {
		createLoading = true;
		createError = '';
		try {
			await adminAdminPoliciesAPI.createPolicy(createForm);
			showCreateDialog = false;
			await loadPolicies();
		} catch (err) {
			createError = err instanceof Error ? err.message : $LL.admin_admin_policies_create_failed();
		} finally {
			createLoading = false;
		}
	}

	function openEditDialog(policy: AdminPolicy) {
		editingPolicy = policy;
		editForm = {
			display_name: policy.display_name || '',
			description: policy.description || '',
			effect: policy.effect,
			priority: policy.priority,
			resource_pattern: policy.resource_pattern,
			actions: policy.actions,
			conditions: policy.conditions
		};
		editError = '';
		showEditDialog = true;
	}

	async function handleEdit() {
		if (!editingPolicy) return;

		editLoading = true;
		editError = '';
		try {
			await adminAdminPoliciesAPI.updatePolicy(editingPolicy.id, editForm);
			showEditDialog = false;
			await loadPolicies();
		} catch (err) {
			editError = err instanceof Error ? err.message : $LL.admin_admin_policies_update_failed();
		} finally {
			editLoading = false;
		}
	}

	async function toggleActive(policy: AdminPolicy) {
		try {
			if (policy.is_active) {
				await adminAdminPoliciesAPI.deactivatePolicy(policy.id);
			} else {
				await adminAdminPoliciesAPI.activatePolicy(policy.id);
			}
			await loadPolicies();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_admin_policies_toggle_failed();
		}
	}

	function openDeleteDialog(policy: AdminPolicy) {
		deletingPolicy = policy;
		deleteError = '';
		showDeleteDialog = true;
	}

	async function handleDelete() {
		if (!deletingPolicy) return;

		deleteLoading = true;
		deleteError = '';
		try {
			await adminAdminPoliciesAPI.deletePolicy(deletingPolicy.id);
			showDeleteDialog = false;
			await loadPolicies();
		} catch (err) {
			deleteError = err instanceof Error ? err.message : $LL.admin_admin_policies_delete_failed();
		} finally {
			deleteLoading = false;
		}
	}

	async function setActiveFilter(nextFilter: typeof filterActive) {
		if (filterActive === nextFilter) return;
		filterActive = nextFilter;
		await loadPolicies();
	}

	function openSimulationDialog() {
		simulationForm = {
			resource: 'admin:admin_users:read',
			action: 'read',
			admin_user_context: {
				roles: ['admin'],
				attributes: {},
				relationships: []
			}
		};
		simulationResult = null;
		simulationError = '';
		showSimulationDialog = true;
	}

	async function handleSimulation() {
		simulationLoading = true;
		simulationError = '';
		try {
			simulationResult = await adminAdminPoliciesAPI.simulatePolicy(simulationForm);
		} catch (err) {
			simulationError =
				err instanceof Error ? err.message : $LL.admin_admin_policies_simulation_failed();
		} finally {
			simulationLoading = false;
		}
	}

	onMount(() => {
		loadPolicies();
	});

	$: filteredPolicies = policies.filter((policy) => {
		const query = searchQuery.toLowerCase();
		const matchesSearch =
			!query ||
			policy.name.toLowerCase().includes(query) ||
			policy.display_name?.toLowerCase().includes(query) ||
			policy.resource_pattern.toLowerCase().includes(query);

		const matchesFilter =
			filterActive === 'all' ||
			(filterActive === 'active' && policy.is_active) ||
			(filterActive === 'inactive' && !policy.is_active);

		return matchesSearch && matchesFilter;
	});

	function formatEffect(effect: AdminPolicy['effect']) {
		return effect === 'allow' ? $LL.admin_admin_policies_allow() : $LL.admin_admin_policies_deny();
	}

	function formatDecision(decision: PolicySimulationResult['decision']) {
		if (decision === 'allow') return $LL.admin_admin_policies_allow();
		if (decision === 'deny') return $LL.admin_admin_policies_deny();
		return $LL.admin_admin_policies_no_match();
	}
</script>

<svelte:head>
	<title>{$LL.admin_admin_policies_head_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_admin_policies_title()}
		description={$LL.admin_admin_policies_description()}
	>
		{#snippet actions()}
			<button class="btn btn-secondary" onclick={openSimulationDialog}>
				<span class="i-ph-flask"></span>
				{$LL.admin_admin_policies_simulate()}
			</button>
			<button class="btn btn-primary" onclick={openCreateDialog}>
				<span class="i-ph-plus"></span>
				{$LL.admin_admin_policies_create_policy()}
			</button>
		{/snippet}
	</AdminPageHeader>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	<AdminToolbar>
		<div class="admin-field admin-field--search">
			<label class="admin-field__label" for="admin-policy-search">
				{$LL.admin_admin_policies_search_placeholder()}
			</label>
			<div class="search-box">
				<span class="i-ph-magnifying-glass"></span>
				<input
					id="admin-policy-search"
					class="admin-input search-input"
					type="text"
					bind:value={searchQuery}
					placeholder={$LL.admin_admin_policies_search_placeholder()}
				/>
			</div>
		</div>
		<div class="filter-segment" aria-label={$LL.admin_admin_policies_breadcrumb()}>
			<button
				class:filter-segment__button--active={filterActive === 'all'}
				class="filter-segment__button"
				onclick={() => setActiveFilter('all')}
			>
				{$LL.admin_admin_policies_all()}
			</button>
			<button
				class:filter-segment__button--active={filterActive === 'active'}
				class="filter-segment__button"
				onclick={() => setActiveFilter('active')}
			>
				{$LL.admin_admin_policies_active()}
			</button>
			<button
				class:filter-segment__button--active={filterActive === 'inactive'}
				class="filter-segment__button"
				onclick={() => setActiveFilter('inactive')}
			>
				{$LL.admin_admin_policies_inactive()}
			</button>
		</div>
	</AdminToolbar>

	{#if loading}
		<AdminSection>
			<div class="loading-state">{$LL.admin_admin_policies_loading()}</div>
		</AdminSection>
	{:else if filteredPolicies.length === 0}
		<AdminSection>
			<div class="empty-state">
				<span class="i-ph-shield-check empty-state__icon"></span>
				<h2>{$LL.admin_admin_policies_no_policies_found()}</h2>
				<p>
					{searchQuery || filterActive !== 'all'
						? $LL.admin_admin_policies_try_adjusting_filters()
						: $LL.admin_admin_policies_empty_create()}
				</p>
				{#if !searchQuery && filterActive === 'all'}
					<button class="btn btn-primary" onclick={openCreateDialog}>
						{$LL.admin_admin_policies_create_policy()}
					</button>
				{/if}
			</div>
		</AdminSection>
	{:else}
		<AdminSection>
			<div class="policy-list">
				{#each filteredPolicies as policy (policy.id)}
					<article class="policy-card">
						<div class="policy-card__main">
							<div class="policy-card__heading">
								<h2>{policy.name}</h2>
								{#if policy.is_system}
									<span class="mini-badge">{$LL.admin_admin_policies_system()}</span>
								{/if}
								<span class:effect-badge--deny={policy.effect === 'deny'} class="effect-badge">
									{formatEffect(policy.effect)}
								</span>
								<span class:status-badge--inactive={!policy.is_active} class="status-badge">
									{policy.is_active
										? $LL.admin_admin_policies_active()
										: $LL.admin_admin_policies_inactive()}
								</span>
							</div>
							{#if policy.display_name}
								<p class="policy-card__name">{policy.display_name}</p>
							{/if}
							{#if policy.description}
								<p class="policy-card__description">{policy.description}</p>
							{/if}
							<div class="policy-card__meta">
								<div>
									<span>{$LL.admin_admin_policies_resource_label()}</span>
									<code>{policy.resource_pattern}</code>
								</div>
								<div>
									<span>{$LL.admin_admin_policies_actions_label()}</span>
									<code>{policy.actions.join(', ')}</code>
								</div>
								<div>
									<span>{$LL.admin_admin_policies_priority_label()}</span>
									<strong>{policy.priority}</strong>
								</div>
							</div>
						</div>
						<div class="policy-card__actions">
							{#if !policy.is_system}
								<button
									class="icon-action"
									onclick={() => toggleActive(policy)}
									title={policy.is_active
										? $LL.admin_admin_policies_deactivate()
										: $LL.admin_admin_policies_activate()}
									aria-label={policy.is_active
										? $LL.admin_admin_policies_deactivate()
										: $LL.admin_admin_policies_activate()}
								>
									<span class={policy.is_active ? 'i-ph-toggle-right' : 'i-ph-toggle-left'}></span>
								</button>
								<button
									class="icon-action"
									onclick={() => openEditDialog(policy)}
									title={$LL.admin_admin_policies_edit()}
									aria-label={$LL.admin_admin_policies_edit()}
								>
									<span class="i-ph-pencil"></span>
								</button>
								<button
									class="icon-action icon-action--danger"
									onclick={() => openDeleteDialog(policy)}
									title={$LL.admin_admin_policies_delete()}
									aria-label={$LL.admin_admin_policies_delete()}
								>
									<span class="i-ph-trash"></span>
								</button>
							{:else}
								<span class="system-note">{$LL.admin_admin_policies_system_protected()}</span>
							{/if}
						</div>
					</article>
				{/each}
			</div>
		</AdminSection>
	{/if}
</AdminPageShell>

<Modal
	open={showCreateDialog}
	onClose={() => (showCreateDialog = false)}
	title={$LL.admin_admin_policies_create_title()}
	size="lg"
>
	{#if createError}
		<div class="alert alert-error">{createError}</div>
	{/if}
	<form
		class="modal-form"
		onsubmit={(event) => {
			event.preventDefault();
			handleCreate();
		}}
	>
		<label class="form-field" for="policy-name">
			<span>{$LL.admin_admin_policies_name_required()} <b>*</b></span>
			<input
				id="policy-name"
				class="form-control form-control--mono"
				bind:value={createForm.name}
				required
			/>
		</label>
		<label class="form-field" for="policy-resource-pattern">
			<span>{$LL.admin_admin_policies_resource_pattern_required()} <b>*</b></span>
			<input
				id="policy-resource-pattern"
				class="form-control form-control--mono"
				bind:value={createForm.resource_pattern}
				placeholder={$LL.admin_admin_policies_resource_pattern_placeholder()}
				required
			/>
		</label>
		<label class="form-field" for="policy-effect">
			<span>{$LL.admin_admin_policies_effect()}</span>
			<select id="policy-effect" class="form-control" bind:value={createForm.effect}>
				<option value="allow">{$LL.admin_admin_policies_effect_allow()}</option>
				<option value="deny">{$LL.admin_admin_policies_effect_deny()}</option>
			</select>
		</label>
	</form>

	{#snippet footer()}
		<button
			class="btn btn-secondary"
			onclick={() => (showCreateDialog = false)}
			disabled={createLoading}
		>
			{$LL.admin_admin_policies_cancel()}
		</button>
		<button
			class="btn btn-primary"
			onclick={handleCreate}
			disabled={createLoading || !createForm.name || !createForm.resource_pattern}
		>
			{createLoading ? $LL.admin_admin_policies_creating() : $LL.admin_admin_policies_create()}
		</button>
	{/snippet}
</Modal>

<Modal
	open={showEditDialog && !!editingPolicy}
	onClose={() => (showEditDialog = false)}
	title={$LL.admin_admin_policies_edit()}
	size="lg"
>
	{#if editError}
		<div class="alert alert-error">{editError}</div>
	{/if}
	{#if editingPolicy}
		<div class="modal-form">
			<div class="form-field">
				<span>{$LL.admin_admin_policies_name_required()}</span>
				<div class="readonly-value">{editingPolicy.name}</div>
			</div>
			<label class="form-field" for="edit-policy-resource-pattern">
				<span>{$LL.admin_admin_policies_resource_pattern_required()} <b>*</b></span>
				<input
					id="edit-policy-resource-pattern"
					class="form-control form-control--mono"
					bind:value={editForm.resource_pattern}
					placeholder={$LL.admin_admin_policies_resource_pattern_placeholder()}
				/>
			</label>
			<label class="form-field" for="edit-policy-effect">
				<span>{$LL.admin_admin_policies_effect()}</span>
				<select id="edit-policy-effect" class="form-control" bind:value={editForm.effect}>
					<option value="allow">{$LL.admin_admin_policies_effect_allow()}</option>
					<option value="deny">{$LL.admin_admin_policies_effect_deny()}</option>
				</select>
			</label>
		</div>
	{/if}

	{#snippet footer()}
		<button
			class="btn btn-secondary"
			onclick={() => (showEditDialog = false)}
			disabled={editLoading}
		>
			{$LL.admin_admin_policies_cancel()}
		</button>
		<button
			class="btn btn-primary"
			onclick={handleEdit}
			disabled={editLoading || !editForm.resource_pattern}
		>
			{editLoading ? $LL.admin_admin_policies_running() : $LL.admin_admin_policies_edit()}
		</button>
	{/snippet}
</Modal>

<Modal
	open={showDeleteDialog && !!deletingPolicy}
	onClose={() => (showDeleteDialog = false)}
	title={$LL.admin_admin_policies_delete()}
	size="md"
>
	{#if deleteError}
		<div class="alert alert-error">{deleteError}</div>
	{/if}
	{#if deletingPolicy}
		<p class="confirm-copy">{deletingPolicy.name}</p>
	{/if}

	{#snippet footer()}
		<button
			class="btn btn-secondary"
			onclick={() => (showDeleteDialog = false)}
			disabled={deleteLoading}
		>
			{$LL.admin_admin_policies_cancel()}
		</button>
		<button class="btn btn-danger" onclick={handleDelete} disabled={deleteLoading}>
			{deleteLoading ? $LL.admin_admin_policies_running() : $LL.admin_admin_policies_delete()}
		</button>
	{/snippet}
</Modal>

<Modal
	open={showSimulationDialog}
	onClose={() => (showSimulationDialog = false)}
	title={$LL.admin_admin_policies_simulation_title()}
	size="lg"
>
	<p class="modal-copy">{$LL.admin_admin_policies_simulation_description()}</p>
	{#if simulationError}
		<div class="alert alert-error">{simulationError}</div>
	{/if}
	<div class="modal-form">
		<label class="form-field" for="simulation-resource">
			<span>{$LL.admin_admin_policies_resource_label()}</span>
			<input
				id="simulation-resource"
				class="form-control form-control--mono"
				type="text"
				bind:value={simulationForm.resource}
				placeholder={$LL.admin_admin_policies_resource_placeholder()}
			/>
		</label>
		<label class="form-field" for="simulation-action">
			<span>{$LL.admin_admin_policies_actions_label()}</span>
			<input
				id="simulation-action"
				class="form-control"
				type="text"
				bind:value={simulationForm.action}
				placeholder={$LL.admin_admin_policies_action_placeholder()}
			/>
		</label>
	</div>

	{#if simulationResult}
		<div class="simulation-result">
			<div class="simulation-result__decision">
				<span>{$LL.admin_admin_policies_decision_label()}</span>
				<span
					class:effect-badge--deny={simulationResult.decision === 'deny'}
					class:effect-badge--neutral={simulationResult.decision === 'no_match'}
					class="effect-badge"
				>
					{formatDecision(simulationResult.decision)}
				</span>
			</div>
			<p>
				{$LL.admin_admin_policies_evaluated_count({
					count: simulationResult.total_policies_evaluated
				})}
			</p>
		</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showSimulationDialog = false)}>
			{$LL.admin_admin_policies_cancel()}
		</button>
		<button class="btn btn-primary" onclick={handleSimulation} disabled={simulationLoading}>
			{simulationLoading
				? $LL.admin_admin_policies_running()
				: $LL.admin_admin_policies_run_simulation()}
		</button>
	{/snippet}
</Modal>

<style>
	.search-box {
		position: relative;
	}

	.search-box :global(.i-ph-magnifying-glass) {
		position: absolute;
		left: 0.75rem;
		top: 50%;
		width: 18px;
		height: 18px;
		color: var(--color-text-subtle);
		transform: translateY(-50%);
	}

	.search-input {
		padding-left: 2.5rem;
	}

	.filter-segment {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface-muted);
	}

	.filter-segment__button {
		min-height: 32px;
		padding: 0 12px;
		border: 0;
		border-radius: calc(var(--radius-control) - 2px);
		background: transparent;
		color: var(--color-text-muted);
		font: inherit;
		cursor: pointer;
	}

	.filter-segment__button--active {
		background: var(--color-accent);
		color: var(--color-accent-contrast);
	}

	.alert {
		padding: 12px 14px;
		border-radius: var(--radius-control);
		margin-bottom: 1rem;
	}

	.alert-error {
		background: color-mix(in srgb, var(--color-danger) 10%, var(--color-surface));
		border: 1px solid color-mix(in srgb, var(--color-danger) 28%, transparent);
		color: var(--color-danger);
	}

	.loading-state,
	.empty-state {
		display: grid;
		place-items: center;
		gap: 12px;
		min-height: 220px;
		padding: 36px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
		color: var(--color-text-muted);
		text-align: center;
	}

	.empty-state h2,
	.empty-state p {
		margin: 0;
	}

	.empty-state h2 {
		color: var(--color-text);
		font-size: 1.1rem;
	}

	.empty-state__icon {
		color: var(--color-text-subtle);
		font-size: 3rem;
	}

	.policy-list {
		display: grid;
		gap: 14px;
	}

	.policy-card {
		display: flex;
		justify-content: space-between;
		gap: 18px;
		padding: 20px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
		box-shadow: var(--card-shadow, var(--shadow-sm));
		transition:
			border-color var(--transition-fast),
			box-shadow var(--transition-fast);
	}

	.policy-card:hover {
		border-color: var(--color-accent);
		box-shadow: var(--shadow-md);
	}

	.policy-card__main {
		min-width: 0;
	}

	.policy-card__heading {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-bottom: 8px;
	}

	.policy-card__heading h2 {
		margin: 0;
		color: var(--color-text);
		font-family: var(--font-mono);
		font-size: 1rem;
	}

	.policy-card__name {
		margin: 0 0 5px;
		color: var(--color-text);
	}

	.policy-card__description {
		margin: 0 0 12px;
		color: var(--color-text-muted);
		font-size: 0.88rem;
		line-height: 1.65;
	}

	.policy-card__meta {
		display: grid;
		gap: 6px;
		color: var(--color-text-subtle);
		font-size: 0.8rem;
	}

	.policy-card__meta div {
		display: flex;
		align-items: baseline;
		gap: 8px;
		flex-wrap: wrap;
	}

	.policy-card__meta code,
	.policy-card__meta strong {
		color: var(--color-text);
		font-family: var(--font-mono);
		font-size: 0.84rem;
		font-weight: 500;
	}

	.policy-card__actions {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		flex: 0 0 auto;
	}

	.icon-action {
		display: grid;
		width: 34px;
		height: 34px;
		place-items: center;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface);
		color: var(--color-text-muted);
		cursor: pointer;
	}

	.icon-action:hover {
		border-color: var(--color-accent);
		color: var(--color-text);
	}

	.icon-action--danger:hover {
		border-color: var(--color-danger);
		color: var(--color-danger);
	}

	.mini-badge,
	.effect-badge,
	.status-badge {
		display: inline-flex;
		align-items: center;
		padding: 3px 8px;
		border-radius: var(--radius-control);
		font-size: 0.72rem;
		font-weight: 700;
	}

	.mini-badge {
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
	}

	.effect-badge {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.effect-badge--deny {
		background: color-mix(in srgb, var(--color-danger) 10%, var(--color-surface));
		color: var(--color-danger);
	}

	.effect-badge--neutral,
	.status-badge--inactive {
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
	}

	.status-badge {
		background: var(--color-accent-muted);
		color: var(--color-accent);
	}

	.system-note {
		color: var(--color-text-subtle);
		font-size: 0.76rem;
		font-style: italic;
	}

	.modal-copy,
	.confirm-copy {
		margin: 0 0 14px;
		color: var(--color-text-muted);
		line-height: 1.7;
	}

	.modal-form {
		display: grid;
		gap: 16px;
	}

	.form-field {
		display: grid;
		gap: 6px;
		color: var(--color-text);
		font-size: 0.88rem;
	}

	.form-field b {
		color: var(--color-danger);
	}

	.form-control,
	.readonly-value {
		width: 100%;
		padding: 9px 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
	}

	.form-control--mono,
	.readonly-value {
		font-family: var(--font-mono);
		font-size: 0.86rem;
	}

	.readonly-value {
		background: var(--color-surface-muted);
	}

	.form-control:focus {
		outline: none;
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.simulation-result {
		margin-top: 18px;
		padding: 16px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface-muted);
	}

	.simulation-result__decision {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 8px;
		color: var(--color-text);
		font-weight: 700;
	}

	.simulation-result p {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.86rem;
	}

	@media (max-width: 720px) {
		.policy-card {
			align-items: flex-start;
			flex-direction: column;
		}

		.filter-segment {
			width: 100%;
		}

		.filter-segment__button {
			flex: 1 1 0;
		}
	}
</style>
