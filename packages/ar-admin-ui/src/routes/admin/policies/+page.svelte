<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminPoliciesAPI,
		type PolicyRule,
		type PolicyCondition,
		type ConditionTypeMetadata,
		type ConditionCategory,
		type PolicyContext,
		type SimulationResult,
		getEffectLabel,
		formatCondition,
		getCategoryIcon,
		createEmptyContext
	} from '$lib/api/admin-policies';
	import { adminSettingsAPI } from '$lib/api/admin-settings';
	import { ToggleSwitch } from '$lib/components';

	// State
	let rules: PolicyRule[] = $state([]);
	let loading = $state(true);
	let error = $state('');

	// Custom Rules Feature Flag state
	let customRulesEnabled = $state(false);
	let customRulesLoading = $state(true);
	let customRulesError = $state('');
	let customRulesSaving = $state(false);
	let featureFlagsVersion = $state('');
	let pagination = $state({
		page: 1,
		limit: 20,
		total: 0,
		total_pages: 0
	});

	// Filters
	let filterEnabled = $state<boolean | undefined>(undefined);
	let filterSearch = $state('');

	// Condition types metadata
	let conditionTypes: ConditionTypeMetadata[] = $state([]);
	let categories: ConditionCategory[] = $state([]);

	// Create/Edit dialog state
	let showRuleDialog = $state(false);
	let editingRule: PolicyRule | null = $state(null);
	let ruleForm = $state({
		name: '',
		description: '',
		priority: 100,
		effect: 'allow' as 'allow' | 'deny',
		resource_types: [] as string[],
		actions: [] as string[],
		conditions: [] as PolicyCondition[],
		enabled: true
	});
	let saving = $state(false);
	let saveError = $state('');

	// Delete dialog state
	let showDeleteDialog = $state(false);
	let ruleToDelete: PolicyRule | null = $state(null);
	let deleting = $state(false);
	let deleteError = $state('');

	// Simulation dialog state
	let showSimulateDialog = $state(false);
	let simulationContext: PolicyContext = $state(createEmptyContext());
	let simulationResult: SimulationResult | null = $state(null);
	let simulating = $state(false);
	let simulationError = $state('');

	// Condition builder state
	let showConditionDialog = $state(false);
	let selectedCategory = $state('');
	let selectedConditionType = $state('');
	let conditionParams: Record<string, unknown> = $state({});

	// Resource/Action inputs
	let resourceTypeInput = $state('');
	let actionInput = $state('');

	async function loadRules() {
		loading = true;
		error = '';

		try {
			const response = await adminPoliciesAPI.listPolicies({
				page: pagination.page,
				limit: pagination.limit,
				enabled: filterEnabled,
				search: filterSearch || undefined
			});

			rules = response.rules;
			pagination = response.pagination;
		} catch (err) {
			console.error('Failed to load policies:', err);
			error = err instanceof Error ? err.message : 'Failed to load policies';
		} finally {
			loading = false;
		}
	}

	async function loadConditionTypes() {
		try {
			const response = await adminPoliciesAPI.getConditionTypes();
			conditionTypes = response.condition_types;
			categories = response.categories;
		} catch (err) {
			console.error('Failed to load condition types:', err);
		}
	}

	function applyFilters() {
		pagination.page = 1;
		loadRules();
	}

	function clearFilters() {
		filterEnabled = undefined;
		filterSearch = '';
		pagination.page = 1;
		loadRules();
	}

	function goToPage(newPage: number) {
		if (newPage < 1 || newPage > pagination.total_pages) return;
		pagination.page = newPage;
		loadRules();
	}

	function openCreateDialog() {
		editingRule = null;
		ruleForm = {
			name: '',
			description: '',
			priority: 100,
			effect: 'allow',
			resource_types: [],
			actions: [],
			conditions: [],
			enabled: true
		};
		resourceTypeInput = '';
		actionInput = '';
		saveError = '';
		showRuleDialog = true;
	}

	function openEditDialog(rule: PolicyRule) {
		editingRule = rule;
		ruleForm = {
			name: rule.name,
			description: rule.description || '',
			priority: rule.priority,
			effect: rule.effect,
			resource_types: [...rule.resource_types],
			actions: [...rule.actions],
			conditions: [...rule.conditions],
			enabled: rule.enabled
		};
		resourceTypeInput = '';
		actionInput = '';
		saveError = '';
		showRuleDialog = true;
	}

	async function saveRule() {
		if (!ruleForm.name) {
			saveError = 'Name is required';
			return;
		}

		saving = true;
		saveError = '';

		try {
			if (editingRule) {
				await adminPoliciesAPI.updatePolicy(editingRule.id, ruleForm);
			} else {
				await adminPoliciesAPI.createPolicy(ruleForm);
			}

			showRuleDialog = false;
			loadRules();
		} catch (err) {
			console.error('Failed to save policy:', err);
			saveError = err instanceof Error ? err.message : 'Failed to save policy';
		} finally {
			saving = false;
		}
	}

	function openDeleteDialog(rule: PolicyRule, event: Event) {
		event.stopPropagation();
		ruleToDelete = rule;
		deleteError = '';
		showDeleteDialog = true;
	}

	async function confirmDelete() {
		if (!ruleToDelete) return;

		deleting = true;
		deleteError = '';

		try {
			await adminPoliciesAPI.deletePolicy(ruleToDelete.id);
			showDeleteDialog = false;
			ruleToDelete = null;
			loadRules();
		} catch (err) {
			console.error('Failed to delete policy:', err);
			deleteError = err instanceof Error ? err.message : 'Failed to delete policy';
		} finally {
			deleting = false;
		}
	}

	async function toggleEnabled(rule: PolicyRule, event: Event) {
		event.stopPropagation();
		try {
			await adminPoliciesAPI.updatePolicy(rule.id, { enabled: !rule.enabled });
			loadRules();
		} catch (err) {
			console.error('Failed to toggle policy:', err);
		}
	}

	function openSimulateDialog() {
		simulationContext = createEmptyContext();
		simulationResult = null;
		simulationError = '';
		showSimulateDialog = true;
	}

	async function runSimulation() {
		simulating = true;
		simulationError = '';
		simulationResult = null;

		try {
			simulationResult = await adminPoliciesAPI.simulate(simulationContext, true);
		} catch (err) {
			console.error('Simulation failed:', err);
			simulationError = err instanceof Error ? err.message : 'Simulation failed';
		} finally {
			simulating = false;
		}
	}

	// Condition builder helpers
	function openConditionBuilder() {
		selectedCategory = '';
		selectedConditionType = '';
		conditionParams = {};
		showConditionDialog = true;
	}

	function selectCategory(categoryId: string) {
		selectedCategory = categoryId;
		selectedConditionType = '';
		conditionParams = {};
	}

	function selectConditionType(type: string) {
		selectedConditionType = type;
		conditionParams = {};
	}

	function addCondition() {
		if (!selectedConditionType) return;

		const condition: PolicyCondition = {
			type: selectedConditionType as PolicyCondition['type'],
			params: { ...conditionParams }
		};

		ruleForm.conditions = [...ruleForm.conditions, condition];
		showConditionDialog = false;
	}

	function removeCondition(index: number) {
		ruleForm.conditions = ruleForm.conditions.filter((_, i) => i !== index);
	}

	// Resource types and actions helpers
	function addResourceType() {
		if (!resourceTypeInput.trim()) return;
		if (!ruleForm.resource_types.includes(resourceTypeInput.trim())) {
			ruleForm.resource_types = [...ruleForm.resource_types, resourceTypeInput.trim()];
		}
		resourceTypeInput = '';
	}

	function removeResourceType(type: string) {
		ruleForm.resource_types = ruleForm.resource_types.filter((t) => t !== type);
	}

	function addAction() {
		if (!actionInput.trim()) return;
		if (!ruleForm.actions.includes(actionInput.trim())) {
			ruleForm.actions = [...ruleForm.actions, actionInput.trim()];
		}
		actionInput = '';
	}

	function removeAction(action: string) {
		ruleForm.actions = ruleForm.actions.filter((a) => a !== action);
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp * 1000).toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	$effect(() => {
		if (selectedConditionType) {
			// Get the condition type metadata
			const typeInfo = conditionTypes.find((t) => t.type === selectedConditionType);
			if (typeInfo) {
				// Initialize params with defaults
				const newParams: Record<string, unknown> = {};
				for (const param of typeInfo.params) {
					if (param.type === 'string[]' || param.type === 'number[]') {
						newParams[param.name] = [];
					} else if (param.type === 'number') {
						newParams[param.name] = 0;
					} else {
						newParams[param.name] = '';
					}
				}
				conditionParams = newParams;
			}
		}
	});

	async function loadCustomRulesStatus() {
		customRulesLoading = true;
		customRulesError = '';

		try {
			const settings = await adminSettingsAPI.getSettings('feature-flags');
			customRulesEnabled = settings.values['feature.enable_custom_rules'] === true;
			featureFlagsVersion = settings.version;
		} catch (err) {
			console.error('Failed to load Custom Rules status:', err);
			customRulesError = 'Failed to load Custom Rules status';
		} finally {
			customRulesLoading = false;
		}
	}

	async function toggleCustomRules() {
		if (customRulesSaving) return;

		customRulesSaving = true;
		customRulesError = '';

		try {
			if (!featureFlagsVersion) {
				const settings = await adminSettingsAPI.getSettings('feature-flags');
				featureFlagsVersion = settings.version;
				customRulesEnabled = settings.values['feature.enable_custom_rules'] === true;
			}

			const newValue = !customRulesEnabled;
			const result = await adminSettingsAPI.updateSettings('feature-flags', {
				ifMatch: featureFlagsVersion,
				set: { 'feature.enable_custom_rules': newValue }
			});
			customRulesEnabled = newValue;
			featureFlagsVersion = result.newVersion;
		} catch (err) {
			console.error('Failed to update Custom Rules status:', err);
			customRulesError =
				err instanceof Error ? err.message : 'Failed to update Custom Rules status';
			await loadCustomRulesStatus();
		} finally {
			customRulesSaving = false;
		}
	}

	onMount(() => {
		loadCustomRulesStatus();
		loadRules();
		loadConditionTypes();
	});
</script>

<svelte:head>
	<title>Policy Rules - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<div class="page-header">
		<div>
			<h1 class="page-title">Policy Rules</h1>
			<p class="page-description">
				Combine RBAC, ABAC, and ReBAC conditions to create fine-grained access control rules.
			</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-secondary" onclick={openSimulateDialog} disabled={!customRulesEnabled}>
				<i class="i-ph-play"></i>
				Simulate
			</button>
			<button class="btn btn-primary" onclick={openCreateDialog} disabled={!customRulesEnabled}>
				<i class="i-ph-plus"></i>
				Create Policy
			</button>
		</div>
	</div>

	<!-- Custom Rules Feature Flag Toggle -->
	<div class="panel feature-toggle-panel">
		<div class="feature-toggle-row">
			<div class="feature-toggle-info">
				<h3 class="feature-toggle-title">Custom Policy Rules</h3>
				<p class="feature-toggle-description">
					Enable custom policy rules that combine RBAC roles, ABAC attributes, and ReBAC
					relationships for fine-grained access control.
				</p>
			</div>
			<div class="feature-toggle-control">
				{#if customRulesLoading}
					<span class="loading-text">Loading...</span>
				{:else}
					<ToggleSwitch
						checked={customRulesEnabled}
						disabled={customRulesSaving}
						onchange={toggleCustomRules}
					/>
				{/if}
			</div>
		</div>
		{#if customRulesError}
			<div class="alert alert-error alert-sm">{customRulesError}</div>
		{/if}
		{#if customRulesSaving}
			<div class="saving-indicator">Saving...</div>
		{/if}
	</div>

	{#if !customRulesEnabled && !customRulesLoading}
		<div class="alert alert-warning">
			<strong>Custom Rules are disabled.</strong> Enable above to create custom policy rules. Default
			policies based on roles will still apply.
		</div>
	{/if}

	{#if error}
		<div class="alert alert-error">
			<span>{error}</span>
			<button class="btn btn-secondary btn-sm" onclick={loadRules}>Retry</button>
		</div>
	{/if}

	<!-- Filters -->
	<div class="panel">
		<div class="filter-row">
			<div class="form-group" style="flex: 2;">
				<label for="filter-search" class="form-label">Search</label>
				<input
					id="filter-search"
					type="text"
					class="form-input"
					placeholder="Search policies..."
					bind:value={filterSearch}
					onkeydown={(e) => e.key === 'Enter' && applyFilters()}
				/>
			</div>
			<div class="form-group">
				<label for="filter-status" class="form-label">Status</label>
				<select
					id="filter-status"
					class="form-select"
					bind:value={filterEnabled}
					onchange={applyFilters}
				>
					<option value={undefined}>All Status</option>
					<option value={true}>Enabled</option>
					<option value={false}>Disabled</option>
				</select>
			</div>
			<div class="form-group form-group-action">
				<button class="btn btn-primary" onclick={applyFilters}>Apply</button>
				<button class="btn btn-secondary" onclick={clearFilters}>Clear</button>
			</div>
		</div>
	</div>

	<!-- Rules List -->
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading...</p>
		</div>
	{:else if rules.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">No policy rules found.</p>
				<button class="btn btn-primary" onclick={openCreateDialog}>Create Policy</button>
			</div>
		</div>
	{:else}
		<div class="policy-list">
			{#each rules as rule (rule.id)}
				<div class="policy-card" class:disabled={!rule.enabled}>
					<div class="policy-card-header">
						<div class="policy-info">
							<span class="policy-priority">#{rule.priority}</span>
							<h3 class="policy-name">{rule.name}</h3>
							<span class={rule.effect === 'allow' ? 'badge badge-success' : 'badge badge-danger'}>
								{getEffectLabel(rule.effect)}
							</span>
							{#if !rule.enabled}
								<span class="badge badge-neutral">Disabled</span>
							{/if}
						</div>
						<div class="action-buttons">
							<button
								class="btn-toggle"
								onclick={(e) => toggleEnabled(rule, e)}
								title={rule.enabled ? 'Disable' : 'Enable'}
							>
								<i class={rule.enabled ? 'i-ph-toggle-right' : 'i-ph-toggle-left'}></i>
							</button>
							<button class="btn btn-secondary btn-sm" onclick={() => openEditDialog(rule)}
								>Edit</button
							>
							<button class="btn btn-danger btn-sm" onclick={(e) => openDeleteDialog(rule, e)}>
								Delete
							</button>
						</div>
					</div>

					{#if rule.description}
						<p class="policy-description">{rule.description}</p>
					{/if}

					<div class="policy-details">
						{#if rule.resource_types.length > 0}
							<div class="detail-row">
								<span class="detail-label">Resources:</span>
								<span class="tag-list">
									{#each rule.resource_types as type (type)}
										<span class="tag">{type}</span>
									{/each}
								</span>
							</div>
						{/if}

						{#if rule.actions.length > 0}
							<div class="detail-row">
								<span class="detail-label">Actions:</span>
								<span class="tag-list">
									{#each rule.actions as action (action)}
										<span class="tag">{action}</span>
									{/each}
								</span>
							</div>
						{/if}

						{#if rule.conditions.length > 0}
							<div class="detail-row detail-row-vertical">
								<span class="detail-label">Conditions:</span>
								<div class="tag-list">
									{#each rule.conditions as condition, i (i)}
										<span class="tag tag-info">{formatCondition(condition)}</span>
									{/each}
								</div>
							</div>
						{/if}
					</div>

					<div class="policy-meta">
						<span class="muted">Updated {formatDate(rule.updated_at)}</span>
					</div>
				</div>
			{/each}
		</div>

		<!-- Pagination -->
		{#if pagination.total_pages > 1}
			<div class="pagination">
				<button
					class="btn btn-secondary btn-sm"
					disabled={pagination.page === 1}
					onclick={() => goToPage(pagination.page - 1)}
				>
					Previous
				</button>
				<span class="pagination-info">
					Page {pagination.page} of {pagination.total_pages} ({pagination.total} total)
				</span>
				<button
					class="btn btn-secondary btn-sm"
					disabled={pagination.page === pagination.total_pages}
					onclick={() => goToPage(pagination.page + 1)}
				>
					Next
				</button>
			</div>
		{/if}
	{/if}
</div>

<!-- Create/Edit Rule Dialog -->
{#if showRuleDialog}
	<div
		class="modal-overlay"
		onclick={() => (showRuleDialog = false)}
		onkeydown={(e) => e.key === 'Escape' && (showRuleDialog = false)}
		tabindex="-1"
		role="dialog"
		aria-modal="true"
	>
		<div class="modal-content modal-lg" onclick={(e) => e.stopPropagation()} role="document">
			<div class="modal-header">
				<h2 class="modal-title">{editingRule ? 'Edit Policy Rule' : 'Create Policy Rule'}</h2>
				<button class="modal-close" onclick={() => (showRuleDialog = false)} aria-label="Close">
					<i class="i-ph-x"></i>
				</button>
			</div>

			<div class="modal-body">
				{#if saveError}
					<div class="alert alert-error">{saveError}</div>
				{/if}

				<div class="form-row-inline">
					<div class="form-group" style="flex: 2;">
						<label for="rule-name" class="form-label">Name *</label>
						<input
							id="rule-name"
							type="text"
							class="form-input"
							bind:value={ruleForm.name}
							placeholder="e.g., Allow org admins to manage users"
						/>
					</div>
					<div class="form-group">
						<label for="rule-priority" class="form-label">Priority</label>
						<input
							id="rule-priority"
							type="number"
							class="form-input"
							bind:value={ruleForm.priority}
							min="1"
							max="1000"
						/>
					</div>
				</div>

				<div class="form-group">
					<label for="rule-description" class="form-label">Description</label>
					<textarea
						id="rule-description"
						class="form-input"
						bind:value={ruleForm.description}
						placeholder="Describe what this policy does..."
						rows="2"
					></textarea>
				</div>

				<div class="form-row-inline">
					<div class="form-group">
						<label for="rule-effect" class="form-label">Effect *</label>
						<select id="rule-effect" class="form-select" bind:value={ruleForm.effect}>
							<option value="allow">Allow</option>
							<option value="deny">Deny</option>
						</select>
					</div>
					<div class="form-group">
						<ToggleSwitch
							bind:checked={ruleForm.enabled}
							label="Enabled"
							description="Activate this policy rule"
						/>
					</div>
				</div>

				<!-- Resource Types -->
				<div class="form-group">
					<label class="form-label">Resource Types</label>
					<div class="input-with-button">
						<input
							type="text"
							class="form-input"
							bind:value={resourceTypeInput}
							placeholder="e.g., user, document, organization"
							onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), addResourceType())}
						/>
						<button type="button" class="btn btn-secondary" onclick={addResourceType}>Add</button>
					</div>
					{#if ruleForm.resource_types.length > 0}
						<div class="tag-list tag-list-removable">
							{#each ruleForm.resource_types as type (type)}
								<span class="tag tag-removable">
									{type}
									<button class="tag-remove" onclick={() => removeResourceType(type)}>×</button>
								</span>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Actions -->
				<div class="form-group">
					<label class="form-label">Actions</label>
					<div class="input-with-button">
						<input
							type="text"
							class="form-input"
							bind:value={actionInput}
							placeholder="e.g., read, write, delete, manage"
							onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), addAction())}
						/>
						<button type="button" class="btn btn-secondary" onclick={addAction}>Add</button>
					</div>
					{#if ruleForm.actions.length > 0}
						<div class="tag-list tag-list-removable">
							{#each ruleForm.actions as action (action)}
								<span class="tag tag-removable">
									{action}
									<button class="tag-remove" onclick={() => removeAction(action)}>×</button>
								</span>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Conditions -->
				<div class="form-group">
					<label class="form-label">Conditions</label>
					<button type="button" class="btn btn-secondary btn-sm" onclick={openConditionBuilder}>
						<i class="i-ph-plus"></i>
						Add Condition
					</button>
					{#if ruleForm.conditions.length > 0}
						<div class="condition-builder-list">
							{#each ruleForm.conditions as condition, i (i)}
								<div class="condition-item">
									<span class="condition-text">{formatCondition(condition)}</span>
									<button class="btn-icon" onclick={() => removeCondition(i)} aria-label="Remove">
										<i class="i-ph-x"></i>
									</button>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={() => (showRuleDialog = false)}>Cancel</button>
				<button class="btn btn-primary" onclick={saveRule} disabled={saving}>
					{saving ? 'Saving...' : editingRule ? 'Update' : 'Create'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Condition Builder Dialog -->
{#if showConditionDialog}
	<div
		class="modal-overlay"
		onclick={() => (showConditionDialog = false)}
		onkeydown={(e) => e.key === 'Escape' && (showConditionDialog = false)}
		tabindex="-1"
		role="dialog"
		aria-modal="true"
	>
		<div class="modal-content" onclick={(e) => e.stopPropagation()} role="document">
			<div class="modal-header">
				<h2 class="modal-title">Add Condition</h2>
				<button
					class="modal-close"
					onclick={() => (showConditionDialog = false)}
					aria-label="Close"
				>
					<i class="i-ph-x"></i>
				</button>
			</div>

			<div class="modal-body">
				{#if !selectedCategory}
					<!-- Category Selection -->
					<div class="category-grid">
						{#each categories as category (category.id)}
							<button class="category-card" onclick={() => selectCategory(category.id)}>
								<span class="category-icon">{getCategoryIcon(category.id)}</span>
								<span class="category-label">{category.label}</span>
							</button>
						{/each}
					</div>
				{:else if !selectedConditionType}
					<!-- Condition Type Selection -->
					<button class="btn-back" onclick={() => selectCategory('')}>
						<i class="i-ph-arrow-left"></i>
						Back to categories
					</button>
					<div class="type-list">
						{#each conditionTypes.filter((t) => t.category === selectedCategory) as type (type.type)}
							<button class="type-card" onclick={() => selectConditionType(type.type)}>
								<span class="type-label">{type.label}</span>
								<span class="type-description">{type.description}</span>
							</button>
						{/each}
					</div>
				{:else}
					<!-- Parameter Input -->
					{@const typeInfo = conditionTypes.find((t) => t.type === selectedConditionType)}
					<button class="btn-back" onclick={() => selectConditionType('')}>
						<i class="i-ph-arrow-left"></i>
						Back to types
					</button>

					{#if typeInfo}
						<h3 class="section-subtitle">{typeInfo.label}</h3>
						<p class="muted">{typeInfo.description}</p>

						{#each typeInfo.params as param (param.name)}
							<div class="form-group">
								<label for="param-{param.name}" class="form-label">
									{param.label}{param.required ? ' *' : ''}
								</label>
								{#if param.type === 'string'}
									<input
										id="param-{param.name}"
										type="text"
										class="form-input"
										bind:value={conditionParams[param.name]}
									/>
								{:else if param.type === 'number'}
									<input
										id="param-{param.name}"
										type="number"
										class="form-input"
										bind:value={conditionParams[param.name]}
									/>
								{:else if param.type === 'string[]'}
									<input
										id="param-{param.name}"
										type="text"
										class="form-input"
										placeholder="Comma-separated values"
										oninput={(e) => {
											conditionParams[param.name] = e.currentTarget.value
												.split(',')
												.map((s) => s.trim())
												.filter(Boolean);
										}}
									/>
								{:else if param.type === 'number[]'}
									<input
										id="param-{param.name}"
										type="text"
										class="form-input"
										placeholder="Comma-separated numbers"
										oninput={(e) => {
											conditionParams[param.name] = e.currentTarget.value
												.split(',')
												.map((s) => parseInt(s.trim()))
												.filter((n) => !isNaN(n));
										}}
									/>
								{/if}
							</div>
						{/each}

						<div class="modal-footer">
							<button class="btn btn-secondary" onclick={() => (showConditionDialog = false)}>
								Cancel
							</button>
							<button class="btn btn-primary" onclick={addCondition}>Add Condition</button>
						</div>
					{/if}
				{/if}
			</div>
		</div>
	</div>
{/if}

<!-- Delete Dialog -->
{#if showDeleteDialog && ruleToDelete}
	<div
		class="modal-overlay"
		onclick={() => (showDeleteDialog = false)}
		onkeydown={(e) => e.key === 'Escape' && (showDeleteDialog = false)}
		tabindex="-1"
		role="dialog"
		aria-modal="true"
		aria-labelledby="delete-dialog-title"
	>
		<div class="modal-content" onclick={(e) => e.stopPropagation()} role="document">
			<div class="modal-header">
				<h2 id="delete-dialog-title" class="modal-title">Delete Policy Rule</h2>
			</div>

			<div class="modal-body">
				{#if deleteError}
					<div class="alert alert-error">{deleteError}</div>
				{/if}

				<p class="modal-description">
					Are you sure you want to delete the policy rule <strong>{ruleToDelete.name}</strong>?
				</p>
				<p class="danger-text">This action cannot be undone.</p>
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={() => (showDeleteDialog = false)}>Cancel</button>
				<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
					{deleting ? 'Deleting...' : 'Delete'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Simulate Dialog -->
{#if showSimulateDialog}
	<div
		class="modal-overlay"
		onclick={() => (showSimulateDialog = false)}
		onkeydown={(e) => e.key === 'Escape' && (showSimulateDialog = false)}
		tabindex="-1"
		role="dialog"
		aria-modal="true"
	>
		<div class="modal-content modal-lg" onclick={(e) => e.stopPropagation()} role="document">
			<div class="modal-header">
				<h2 class="modal-title">Policy Simulator</h2>
				<button class="modal-close" onclick={() => (showSimulateDialog = false)} aria-label="Close">
					<i class="i-ph-x"></i>
				</button>
			</div>

			<div class="modal-body">
				<p class="muted">Test how policies evaluate against a given context.</p>

				{#if simulationError}
					<div class="alert alert-error">{simulationError}</div>
				{/if}

				<div class="simulation-form">
					<h3 class="section-subtitle">Subject</h3>
					<div class="form-row-inline">
						<div class="form-group">
							<label for="sim-subject-id" class="form-label">Subject ID *</label>
							<input
								id="sim-subject-id"
								type="text"
								class="form-input"
								bind:value={simulationContext.subject.id}
								placeholder="user_123"
							/>
						</div>
						<div class="form-group">
							<label for="sim-subject-org" class="form-label">Organization ID</label>
							<input
								id="sim-subject-org"
								type="text"
								class="form-input"
								bind:value={simulationContext.subject.orgId}
								placeholder="org_456"
							/>
						</div>
					</div>

					<h3 class="section-subtitle">Resource</h3>
					<div class="form-row-inline">
						<div class="form-group">
							<label for="sim-resource-type" class="form-label">Resource Type *</label>
							<input
								id="sim-resource-type"
								type="text"
								class="form-input"
								bind:value={simulationContext.resource.type}
								placeholder="document"
							/>
						</div>
						<div class="form-group">
							<label for="sim-resource-id" class="form-label">Resource ID *</label>
							<input
								id="sim-resource-id"
								type="text"
								class="form-input"
								bind:value={simulationContext.resource.id}
								placeholder="doc_789"
							/>
						</div>
					</div>

					<h3 class="section-subtitle">Action</h3>
					<div class="form-group">
						<label for="sim-action" class="form-label">Action Name *</label>
						<input
							id="sim-action"
							type="text"
							class="form-input"
							bind:value={simulationContext.action.name}
							placeholder="read, write, delete..."
						/>
					</div>

					<h3 class="section-subtitle">Environment (Optional)</h3>
					<div class="form-row-inline">
						<div class="form-group">
							<label for="sim-env-ip" class="form-label">Client IP</label>
							<input
								id="sim-env-ip"
								type="text"
								class="form-input"
								bind:value={simulationContext.environment!.clientIp}
								placeholder="192.168.1.1"
							/>
						</div>
						<div class="form-group">
							<label for="sim-env-country" class="form-label">Country Code</label>
							<input
								id="sim-env-country"
								type="text"
								class="form-input"
								bind:value={simulationContext.environment!.countryCode}
								placeholder="US, JP, DE..."
							/>
						</div>
					</div>
				</div>

				{#if simulationResult}
					<div
						class="simulation-result"
						class:simulation-result-allowed={simulationResult.allowed}
						class:simulation-result-denied={!simulationResult.allowed}
					>
						<div class="result-header">
							<i class={simulationResult.allowed ? 'i-ph-check-circle' : 'i-ph-x-circle'}></i>
							<span class="result-text">{simulationResult.allowed ? 'ALLOWED' : 'DENIED'}</span>
						</div>
						<div class="result-details">
							<p><strong>Reason:</strong> {simulationResult.reason}</p>
							{#if simulationResult.decided_by}
								<p><strong>Decided by:</strong> {simulationResult.decided_by}</p>
							{/if}
							<p><strong>Rules evaluated:</strong> {simulationResult.evaluated_rules}</p>
						</div>
					</div>
				{/if}
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={() => (showSimulateDialog = false)}>Close</button
				>
				<button class="btn btn-primary" onclick={runSimulation} disabled={simulating}>
					{simulating ? 'Simulating...' : 'Run Simulation'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* Feature Toggle Panel Styles */
	.feature-toggle-panel {
		margin-bottom: 1.5rem;
		padding: 1rem 1.25rem;
	}

	.feature-toggle-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
	}

	.feature-toggle-info {
		flex: 1;
	}

	.feature-toggle-title {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.feature-toggle-description {
		margin: 0.25rem 0 0;
		font-size: 0.875rem;
		color: var(--text-secondary);
	}

	.feature-toggle-control {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.loading-text {
		font-size: 0.875rem;
		color: var(--text-secondary);
	}

	.saving-indicator {
		margin-top: 0.5rem;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.alert-sm {
		margin-top: 0.75rem;
		padding: 0.5rem 0.75rem;
		font-size: 0.875rem;
	}

	.alert-warning {
		background-color: rgba(234, 179, 8, 0.1);
		border: 1px solid rgba(234, 179, 8, 0.3);
		border-radius: 0.375rem;
		padding: 0.75rem 1rem;
		color: var(--text-primary);
		margin-bottom: 1rem;
	}
</style>
