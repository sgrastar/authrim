<script lang="ts">
	import { onMount } from 'svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		adminPoliciesAPI,
		type PolicyRule,
		type PolicyCondition,
		type ConditionTypeMetadata,
		type ConditionCategory,
		type PolicyContext,
		type SimulationResult,
		getCategoryIcon,
		createEmptyContext
	} from '$lib/api/admin-policies';
	import { adminSettingsAPI } from '$lib/api/admin-settings';
	import { Modal, ToggleSwitch } from '$lib/components';
	import { getLocale, LL } from '$i18n/i18n-svelte';

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
	let loadedTenantId = $state('');

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
			error = err instanceof Error ? err.message : $LL.admin_policies_load_failed();
		} finally {
			loading = false;
		}
	}

	async function loadConditionTypes() {
		try {
			const response = await adminPoliciesAPI.getConditionTypes();
			conditionTypes = response.condition_types;
			categories = response.categories;
		} catch {
			conditionTypes = [];
			categories = [];
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
			saveError = $LL.admin_policies_name_required();
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
			saveError = err instanceof Error ? err.message : $LL.admin_policies_save_failed();
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
			deleteError = err instanceof Error ? err.message : $LL.admin_policies_delete_failed();
		} finally {
			deleting = false;
		}
	}

	async function toggleEnabled(rule: PolicyRule, event: Event) {
		event.stopPropagation();
		try {
			await adminPoliciesAPI.updatePolicy(rule.id, { enabled: !rule.enabled });
			loadRules();
		} catch {
			error = $LL.admin_policies_toggle_failed();
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
			simulationError = err instanceof Error ? err.message : $LL.admin_policies_simulation_failed();
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
		return new Date(timestamp * 1000).toLocaleDateString(getLocale() === 'ja' ? 'ja-JP' : 'en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function formatEffect(effect: 'allow' | 'deny'): string {
		return effect === 'allow' ? $LL.admin_policies_allow() : $LL.admin_policies_deny();
	}

	function formatConditionLocalized(condition: PolicyCondition): string {
		const { type, params } = condition;
		switch (type) {
			case 'has_role':
				return $LL.admin_policies_condition_has_role({
					role: String(params.role ?? ''),
					scope: params.scope ? ` (${String(params.scope)})` : ''
				});
			case 'has_any_role':
				return $LL.admin_policies_condition_has_any_role({
					roles: ((params.roles as string[]) ?? []).join(', ')
				});
			case 'has_all_roles':
				return $LL.admin_policies_condition_has_all_roles({
					roles: ((params.roles as string[]) ?? []).join(', ')
				});
			case 'is_resource_owner':
				return $LL.admin_policies_condition_is_resource_owner();
			case 'same_organization':
				return $LL.admin_policies_condition_same_organization();
			case 'attribute_equals':
				return $LL.admin_policies_condition_attribute_equals({
					attribute: String(params.attribute ?? ''),
					value: String(params.value ?? '')
				});
			case 'attribute_exists':
				return $LL.admin_policies_condition_attribute_exists({
					attribute: String(params.attribute ?? '')
				});
			case 'attribute_in':
				return $LL.admin_policies_condition_attribute_in({
					attribute: String(params.attribute ?? ''),
					values: ((params.values as string[]) ?? []).join(', ')
				});
			case 'time_in_range':
				return $LL.admin_policies_condition_time_in_range({
					start: String(params.start_hour ?? ''),
					end: String(params.end_hour ?? '')
				});
			case 'day_of_week':
				return $LL.admin_policies_condition_day_of_week({
					days: ((params.days as number[]) ?? []).join(', ')
				});
			case 'valid_during':
				return $LL.admin_policies_condition_valid_during({
					start: String(params.start ?? $LL.admin_policies_now()),
					end: String(params.end ?? $LL.admin_policies_infinity())
				});
			case 'country_in':
				return $LL.admin_policies_condition_country_in({
					countries: ((params.countries as string[]) ?? []).join(', ')
				});
			case 'country_not_in':
				return $LL.admin_policies_condition_country_not_in({
					countries: ((params.countries as string[]) ?? []).join(', ')
				});
			case 'ip_in_range':
				return $LL.admin_policies_condition_ip_in_range({
					cidr: String(params.cidr ?? '')
				});
			case 'numeric_gt':
				return `${params.attribute} > ${params.threshold}`;
			case 'numeric_gte':
				return `${params.attribute} >= ${params.threshold}`;
			case 'numeric_lt':
				return `${params.attribute} < ${params.threshold}`;
			case 'numeric_lte':
				return `${params.attribute} <= ${params.threshold}`;
			case 'numeric_between':
				return `${params.min} <= ${params.attribute} <= ${params.max}`;
			case 'request_count_lt':
				return $LL.admin_policies_condition_request_count_lt({ limit: String(params.limit ?? '') });
			case 'request_count_lte':
				return $LL.admin_policies_condition_request_count_lte({
					limit: String(params.limit ?? '')
				});
			case 'request_count_gt':
				return $LL.admin_policies_condition_request_count_gt({ limit: String(params.limit ?? '') });
			case 'request_count_gte':
				return $LL.admin_policies_condition_request_count_gte({
					limit: String(params.limit ?? '')
				});
			default:
				return JSON.stringify(condition);
		}
	}

	function formatCategoryLabel(category: ConditionCategory): string {
		switch (category.id) {
			case 'rbac':
				return $LL.admin_policies_category_rbac();
			case 'ownership':
				return $LL.admin_policies_category_ownership();
			case 'abac':
				return $LL.admin_policies_category_abac();
			case 'time':
				return $LL.admin_policies_category_time();
			case 'numeric':
				return $LL.admin_policies_category_numeric();
			case 'geo':
				return $LL.admin_policies_category_geo();
			case 'rate':
				return $LL.admin_policies_category_rate();
			default:
				return category.label;
		}
	}

	function formatConditionTypeLabel(type: ConditionTypeMetadata): string {
		switch (type.type) {
			case 'has_role':
				return $LL.admin_policies_type_has_role();
			case 'has_any_role':
				return $LL.admin_policies_type_has_any_role();
			case 'has_all_roles':
				return $LL.admin_policies_type_has_all_roles();
			case 'is_resource_owner':
				return $LL.admin_policies_type_is_resource_owner();
			case 'same_organization':
				return $LL.admin_policies_type_same_organization();
			case 'attribute_equals':
				return $LL.admin_policies_type_attribute_equals();
			case 'attribute_exists':
				return $LL.admin_policies_type_attribute_exists();
			case 'attribute_in':
				return $LL.admin_policies_type_attribute_in();
			case 'time_in_range':
				return $LL.admin_policies_type_time_in_range();
			case 'day_of_week':
				return $LL.admin_policies_type_day_of_week();
			case 'valid_during':
				return $LL.admin_policies_type_valid_during();
			case 'numeric_gt':
				return $LL.admin_policies_type_numeric_gt();
			case 'numeric_gte':
				return $LL.admin_policies_type_numeric_gte();
			case 'numeric_lt':
				return $LL.admin_policies_type_numeric_lt();
			case 'numeric_lte':
				return $LL.admin_policies_type_numeric_lte();
			case 'numeric_between':
				return $LL.admin_policies_type_numeric_between();
			case 'country_in':
				return $LL.admin_policies_type_country_in();
			case 'country_not_in':
				return $LL.admin_policies_type_country_not_in();
			case 'ip_in_range':
				return $LL.admin_policies_type_ip_in_range();
			case 'request_count_lt':
				return $LL.admin_policies_type_request_count_lt();
			case 'request_count_lte':
				return $LL.admin_policies_type_request_count_lte();
			case 'request_count_gt':
				return $LL.admin_policies_type_request_count_gt();
			case 'request_count_gte':
				return $LL.admin_policies_type_request_count_gte();
			default:
				return type.label;
		}
	}

	function formatConditionTypeDescription(type: ConditionTypeMetadata): string {
		switch (type.type) {
			case 'has_role':
				return $LL.admin_policies_type_desc_has_role();
			case 'has_any_role':
				return $LL.admin_policies_type_desc_has_any_role();
			case 'has_all_roles':
				return $LL.admin_policies_type_desc_has_all_roles();
			case 'is_resource_owner':
				return $LL.admin_policies_type_desc_is_resource_owner();
			case 'same_organization':
				return $LL.admin_policies_type_desc_same_organization();
			case 'attribute_equals':
				return $LL.admin_policies_type_desc_attribute_equals();
			case 'attribute_exists':
				return $LL.admin_policies_type_desc_attribute_exists();
			case 'attribute_in':
				return $LL.admin_policies_type_desc_attribute_in();
			case 'time_in_range':
				return $LL.admin_policies_type_desc_time_in_range();
			case 'day_of_week':
				return $LL.admin_policies_type_desc_day_of_week();
			case 'valid_during':
				return $LL.admin_policies_type_desc_valid_during();
			case 'numeric_gt':
				return $LL.admin_policies_type_desc_numeric_gt();
			case 'numeric_gte':
				return $LL.admin_policies_type_desc_numeric_gte();
			case 'numeric_lt':
				return $LL.admin_policies_type_desc_numeric_lt();
			case 'numeric_lte':
				return $LL.admin_policies_type_desc_numeric_lte();
			case 'numeric_between':
				return $LL.admin_policies_type_desc_numeric_between();
			case 'country_in':
				return $LL.admin_policies_type_desc_country_in();
			case 'country_not_in':
				return $LL.admin_policies_type_desc_country_not_in();
			case 'ip_in_range':
				return $LL.admin_policies_type_desc_ip_in_range();
			case 'request_count_lt':
				return $LL.admin_policies_type_desc_request_count_lt();
			case 'request_count_lte':
				return $LL.admin_policies_type_desc_request_count_lte();
			case 'request_count_gt':
				return $LL.admin_policies_type_desc_request_count_gt();
			case 'request_count_gte':
				return $LL.admin_policies_type_desc_request_count_gte();
			default:
				return type.description;
		}
	}

	function formatParamLabel(param: { name: string; label: string }): string {
		switch (param.name) {
			case 'role':
				return $LL.admin_policies_param_role();
			case 'roles':
				return $LL.admin_policies_param_roles();
			case 'scope':
				return $LL.admin_policies_param_scope();
			case 'attribute':
				return $LL.admin_policies_param_attribute();
			case 'value':
				return $LL.admin_policies_param_value();
			case 'values':
				return $LL.admin_policies_param_values();
			case 'start_hour':
				return $LL.admin_policies_param_start_hour();
			case 'end_hour':
				return $LL.admin_policies_param_end_hour();
			case 'days':
				return $LL.admin_policies_param_days();
			case 'start':
				return $LL.admin_policies_param_start();
			case 'end':
				return $LL.admin_policies_param_end();
			case 'countries':
				return $LL.admin_policies_param_countries();
			case 'cidr':
				return $LL.admin_policies_param_cidr();
			case 'threshold':
				return $LL.admin_policies_param_threshold();
			case 'min':
				return $LL.admin_policies_param_min();
			case 'max':
				return $LL.admin_policies_param_max();
			case 'limit':
				return $LL.admin_policies_param_limit();
			default:
				return param.label;
		}
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
			customRulesError =
				err instanceof Error ? err.message : $LL.admin_policies_custom_rules_load_failed();
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
			featureFlagsVersion = result.version;
		} catch (err) {
			customRulesError =
				err instanceof Error ? err.message : $LL.admin_policies_custom_rules_update_failed();
			await loadCustomRulesStatus();
		} finally {
			customRulesSaving = false;
		}
	}

	onMount(async () => {
		await settingsContext.initialize();
	});

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (!tenantId || tenantId === loadedTenantId) return;
		loadedTenantId = tenantId;
		pagination.page = 1;
		simulationResult = null;
		simulationError = '';
		loadCustomRulesStatus();
		loadRules();
		loadConditionTypes();
	});
</script>

<svelte:head>
	<title>{$LL.admin_policies_head_title()}</title>
</svelte:head>

<div class="admin-page">
	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_policies_title()}</h1>
			<p class="page-description">
				{$LL.admin_policies_description()}
			</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-secondary" onclick={openSimulateDialog} disabled={!customRulesEnabled}>
				<i class="i-ph-play"></i>
				{$LL.admin_policies_simulate()}
			</button>
			<button class="btn btn-primary" onclick={openCreateDialog} disabled={!customRulesEnabled}>
				<i class="i-ph-plus"></i>
				{$LL.admin_policies_create_policy()}
			</button>
		</div>
	</div>

	<!-- Custom Rules Feature Flag Toggle -->
	<div class="panel feature-toggle-panel">
		<div class="feature-toggle-row">
			<div class="feature-toggle-info">
				<h3 class="feature-toggle-title">{$LL.admin_policies_custom_rules()}</h3>
				<p class="feature-toggle-description">
					{$LL.admin_policies_custom_rules_description()}
				</p>
			</div>
			<div class="feature-toggle-control">
				{#if customRulesLoading}
					<span class="loading-text">{$LL.admin_policies_loading()}</span>
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
			<div class="saving-indicator">{$LL.admin_policies_saving()}</div>
		{/if}
	</div>

	{#if !customRulesEnabled && !customRulesLoading}
		<div class="alert alert-warning">
			<strong>{$LL.admin_policies_custom_rules_disabled_title()}</strong>
			{$LL.admin_policies_custom_rules_disabled_description()}
		</div>
	{/if}

	{#if error}
		<div class="alert alert-error">
			<span>{error}</span>
			<button class="btn btn-secondary btn-sm" onclick={loadRules}
				>{$LL.admin_policies_retry()}</button
			>
		</div>
	{/if}

	<!-- Filters -->
	<div class="panel">
		<div class="filter-row">
			<div class="form-group" style="flex: 2;">
				<label for="filter-search" class="form-label">{$LL.admin_policies_search()}</label>
				<input
					id="filter-search"
					type="text"
					class="form-input"
					placeholder={$LL.admin_policies_search_placeholder()}
					bind:value={filterSearch}
					onkeydown={(e) => e.key === 'Enter' && applyFilters()}
				/>
			</div>
			<div class="form-group">
				<label for="filter-status" class="form-label">{$LL.admin_policies_status()}</label>
				<select
					id="filter-status"
					class="form-select"
					bind:value={filterEnabled}
					onchange={applyFilters}
				>
					<option value={undefined}>{$LL.admin_policies_all_status()}</option>
					<option value={true}>{$LL.admin_policies_enabled()}</option>
					<option value={false}>{$LL.admin_policies_disabled()}</option>
				</select>
			</div>
			<div class="form-group form-group-action">
				<button class="btn btn-primary" onclick={applyFilters}>{$LL.admin_policies_apply()}</button>
				<button class="btn btn-secondary" onclick={clearFilters}
					>{$LL.admin_policies_clear()}</button
				>
			</div>
		</div>
	</div>

	<!-- Rules List -->
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_policies_loading()}</p>
		</div>
	{:else if rules.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">{$LL.admin_policies_empty()}</p>
				<button class="btn btn-primary" onclick={openCreateDialog}
					>{$LL.admin_policies_create_policy()}</button
				>
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
								{formatEffect(rule.effect)}
							</span>
							{#if !rule.enabled}
								<span class="badge badge-neutral">{$LL.admin_policies_disabled()}</span>
							{/if}
						</div>
						<div class="action-buttons">
							<button
								class="btn-toggle"
								onclick={(e) => toggleEnabled(rule, e)}
								title={rule.enabled ? $LL.admin_policies_disable() : $LL.admin_policies_enable()}
							>
								<i class={rule.enabled ? 'i-ph-toggle-right' : 'i-ph-toggle-left'}></i>
							</button>
							<button class="btn btn-secondary btn-sm" onclick={() => openEditDialog(rule)}
								>{$LL.admin_policies_edit()}</button
							>
							<button class="btn btn-danger btn-sm" onclick={(e) => openDeleteDialog(rule, e)}>
								{$LL.admin_policies_delete()}
							</button>
						</div>
					</div>

					{#if rule.description}
						<p class="policy-description">{rule.description}</p>
					{/if}

					<div class="policy-details">
						{#if rule.resource_types.length > 0}
							<div class="detail-row">
								<span class="detail-label">{$LL.admin_policies_resources_label()}</span>
								<span class="tag-list">
									{#each rule.resource_types as type (type)}
										<span class="tag">{type}</span>
									{/each}
								</span>
							</div>
						{/if}

						{#if rule.actions.length > 0}
							<div class="detail-row">
								<span class="detail-label">{$LL.admin_policies_actions_label()}</span>
								<span class="tag-list">
									{#each rule.actions as action (action)}
										<span class="tag">{action}</span>
									{/each}
								</span>
							</div>
						{/if}

						{#if rule.conditions.length > 0}
							<div class="detail-row detail-row-vertical">
								<span class="detail-label">{$LL.admin_policies_conditions_label()}</span>
								<div class="tag-list">
									{#each rule.conditions as condition, i (i)}
										<span class="tag tag-info">{formatConditionLocalized(condition)}</span>
									{/each}
								</div>
							</div>
						{/if}
					</div>

					<div class="policy-meta">
						<span class="muted"
							>{$LL.admin_policies_updated_at({ date: formatDate(rule.updated_at) })}</span
						>
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
					{$LL.admin_policies_previous()}
				</button>
				<span class="pagination-info">
					{$LL.admin_policies_page_of({
						page: pagination.page,
						totalPages: pagination.total_pages,
						count: pagination.total
					})}
				</span>
				<button
					class="btn btn-secondary btn-sm"
					disabled={pagination.page === pagination.total_pages}
					onclick={() => goToPage(pagination.page + 1)}
				>
					{$LL.admin_policies_next()}
				</button>
			</div>
		{/if}
	{/if}
</div>

<!-- Create/Edit Rule Dialog -->
<Modal
	open={showRuleDialog}
	onClose={() => (showRuleDialog = false)}
	title={editingRule ? $LL.admin_policies_edit_rule() : $LL.admin_policies_create_rule()}
	size="lg"
>
	{#if saveError}
		<div class="alert alert-error">{saveError}</div>
	{/if}

	<div class="form-row-inline">
		<div class="form-group" style="flex: 2;">
			<label for="rule-name" class="form-label">{$LL.admin_policies_name_required_label()}</label>
			<input
				id="rule-name"
				type="text"
				class="form-input"
				bind:value={ruleForm.name}
				placeholder={$LL.admin_policies_name_placeholder()}
			/>
		</div>
		<div class="form-group">
			<label for="rule-priority" class="form-label">{$LL.admin_policies_priority()}</label>
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
		<label for="rule-description" class="form-label">{$LL.admin_policies_rule_description()}</label>
		<textarea
			id="rule-description"
			class="form-input"
			bind:value={ruleForm.description}
			placeholder={$LL.admin_policies_description_placeholder()}
			rows="2"
		></textarea>
	</div>

	<div class="form-row-inline">
		<div class="form-group">
			<label for="rule-effect" class="form-label">{$LL.admin_policies_effect_required()}</label>
			<select id="rule-effect" class="form-select" bind:value={ruleForm.effect}>
				<option value="allow">{$LL.admin_policies_allow()}</option>
				<option value="deny">{$LL.admin_policies_deny()}</option>
			</select>
		</div>
		<div class="form-group">
			<ToggleSwitch
				bind:checked={ruleForm.enabled}
				label={$LL.admin_policies_enabled()}
				description={$LL.admin_policies_activate_rule()}
			/>
		</div>
	</div>

	<!-- Resource Types -->
	<div class="form-group">
		<!-- svelte-ignore a11y_label_has_associated_control -->
		<label class="form-label">{$LL.admin_policies_resource_types()}</label>
		<div class="input-with-button">
			<input
				type="text"
				class="form-input"
				bind:value={resourceTypeInput}
				placeholder={$LL.admin_policies_resource_types_placeholder()}
				onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), addResourceType())}
			/>
			<button type="button" class="btn btn-secondary" onclick={addResourceType}
				>{$LL.admin_policies_add()}</button
			>
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
		<!-- svelte-ignore a11y_label_has_associated_control -->
		<label class="form-label">{$LL.admin_policies_actions()}</label>
		<div class="input-with-button">
			<input
				type="text"
				class="form-input"
				bind:value={actionInput}
				placeholder={$LL.admin_policies_actions_placeholder()}
				onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), addAction())}
			/>
			<button type="button" class="btn btn-secondary" onclick={addAction}
				>{$LL.admin_policies_add()}</button
			>
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
		<!-- svelte-ignore a11y_label_has_associated_control -->
		<label class="form-label">{$LL.admin_policies_conditions()}</label>
		<button type="button" class="btn btn-secondary btn-sm" onclick={openConditionBuilder}>
			<i class="i-ph-plus"></i>
			{$LL.admin_policies_add_condition()}
		</button>
		{#if ruleForm.conditions.length > 0}
			<div class="condition-builder-list">
				{#each ruleForm.conditions as condition, i (i)}
					<div class="condition-item">
						<span class="condition-text">{formatConditionLocalized(condition)}</span>
						<button
							class="btn-icon"
							onclick={() => removeCondition(i)}
							aria-label={$LL.admin_policies_remove()}
						>
							<i class="i-ph-x"></i>
						</button>
					</div>
				{/each}
			</div>
		{/if}
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showRuleDialog = false)}
			>{$LL.admin_policies_cancel()}</button
		>
		<button class="btn btn-primary" onclick={saveRule} disabled={saving}>
			{saving
				? $LL.admin_policies_saving()
				: editingRule
					? $LL.admin_policies_update()
					: $LL.admin_policies_create()}
		</button>
	{/snippet}
</Modal>

<!-- Condition Builder Dialog -->
<Modal
	open={showConditionDialog}
	onClose={() => (showConditionDialog = false)}
	title={$LL.admin_policies_add_condition()}
	size="md"
>
	{#if !selectedCategory}
		<!-- Category Selection -->
		<div class="category-grid">
			{#each categories as category (category.id)}
				<button class="category-card" onclick={() => selectCategory(category.id)}>
					<span class="category-icon">{getCategoryIcon(category.id)}</span>
					<span class="category-label">{formatCategoryLabel(category)}</span>
				</button>
			{/each}
		</div>
	{:else if !selectedConditionType}
		<!-- Condition Type Selection -->
		<button class="btn-back" onclick={() => selectCategory('')}>
			<i class="i-ph-arrow-left"></i>
			{$LL.admin_policies_back_to_categories()}
		</button>
		<div class="type-list">
			{#each conditionTypes.filter((t) => t.category === selectedCategory) as type (type.type)}
				<button class="type-card" onclick={() => selectConditionType(type.type)}>
					<span class="type-label">{formatConditionTypeLabel(type)}</span>
					<span class="type-description">{formatConditionTypeDescription(type)}</span>
				</button>
			{/each}
		</div>
	{:else}
		<!-- Parameter Input -->
		{@const typeInfo = conditionTypes.find((t) => t.type === selectedConditionType)}
		<button class="btn-back" onclick={() => selectConditionType('')}>
			<i class="i-ph-arrow-left"></i>
			{$LL.admin_policies_back_to_types()}
		</button>

		{#if typeInfo}
			<h3 class="section-subtitle">{formatConditionTypeLabel(typeInfo)}</h3>
			<p class="muted">{formatConditionTypeDescription(typeInfo)}</p>

			{#each typeInfo.params as param (param.name)}
				<div class="form-group">
					<label for="param-{param.name}" class="form-label">
						{formatParamLabel(param)}{param.required ? ' *' : ''}
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
							placeholder={$LL.admin_policies_comma_values()}
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
							placeholder={$LL.admin_policies_comma_numbers()}
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
		{/if}
	{/if}

	{#snippet footer()}
		{#if selectedConditionType}
			<button class="btn btn-secondary" onclick={() => (showConditionDialog = false)}>
				{$LL.admin_policies_cancel()}
			</button>
			<button class="btn btn-primary" onclick={addCondition}
				>{$LL.admin_policies_add_condition()}</button
			>
		{/if}
	{/snippet}
</Modal>

<!-- Delete Dialog -->
<Modal
	open={showDeleteDialog && !!ruleToDelete}
	onClose={() => (showDeleteDialog = false)}
	title={$LL.admin_policies_delete_rule()}
	size="md"
>
	{#if deleteError}
		<div class="alert alert-error">{deleteError}</div>
	{/if}

	<p class="modal-description">
		{$LL.admin_policies_delete_confirm_prefix()}<strong>{ruleToDelete?.name ?? ''}</strong
		>{$LL.admin_policies_delete_confirm_suffix()}
	</p>
	<p class="danger-text">{$LL.admin_policies_cannot_be_undone()}</p>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showDeleteDialog = false)}
			>{$LL.admin_policies_cancel()}</button
		>
		<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
			{deleting ? $LL.admin_policies_deleting() : $LL.admin_policies_delete()}
		</button>
	{/snippet}
</Modal>

<!-- Simulate Dialog -->
<Modal
	open={showSimulateDialog}
	onClose={() => (showSimulateDialog = false)}
	title={$LL.admin_policies_simulator_title()}
	size="lg"
>
	<p class="muted">{$LL.admin_policies_simulator_description()}</p>

	{#if simulationError}
		<div class="alert alert-error">{simulationError}</div>
	{/if}

	<div class="simulation-form">
		<h3 class="section-subtitle">{$LL.admin_policies_subject()}</h3>
		<div class="form-row-inline">
			<div class="form-group">
				<label for="sim-subject-id" class="form-label"
					>{$LL.admin_policies_subject_id_required()}</label
				>
				<input
					id="sim-subject-id"
					type="text"
					class="form-input"
					bind:value={simulationContext.subject.id}
					placeholder="user_123"
				/>
			</div>
			<div class="form-group">
				<label for="sim-subject-org" class="form-label"
					>{$LL.admin_policies_organization_id()}</label
				>
				<input
					id="sim-subject-org"
					type="text"
					class="form-input"
					bind:value={simulationContext.subject.orgId}
					placeholder="org_456"
				/>
			</div>
		</div>

		<h3 class="section-subtitle">{$LL.admin_policies_resource()}</h3>
		<div class="form-row-inline">
			<div class="form-group">
				<label for="sim-resource-type" class="form-label"
					>{$LL.admin_policies_resource_type_required()}</label
				>
				<input
					id="sim-resource-type"
					type="text"
					class="form-input"
					bind:value={simulationContext.resource.type}
					placeholder="document"
				/>
			</div>
			<div class="form-group">
				<label for="sim-resource-id" class="form-label"
					>{$LL.admin_policies_resource_id_required()}</label
				>
				<input
					id="sim-resource-id"
					type="text"
					class="form-input"
					bind:value={simulationContext.resource.id}
					placeholder="doc_789"
				/>
			</div>
		</div>

		<h3 class="section-subtitle">{$LL.admin_policies_action()}</h3>
		<div class="form-group">
			<label for="sim-action" class="form-label">{$LL.admin_policies_action_name_required()}</label>
			<input
				id="sim-action"
				type="text"
				class="form-input"
				bind:value={simulationContext.action.name}
				placeholder="read, write, delete..."
			/>
		</div>

		<h3 class="section-subtitle">{$LL.admin_policies_environment_optional()}</h3>
		<div class="form-row-inline">
			<div class="form-group">
				<label for="sim-env-ip" class="form-label">{$LL.admin_policies_client_ip()}</label>
				<input
					id="sim-env-ip"
					type="text"
					class="form-input"
					bind:value={simulationContext.environment!.clientIp}
					placeholder="192.168.1.1"
				/>
			</div>
			<div class="form-group">
				<label for="sim-env-country" class="form-label">{$LL.admin_policies_country_code()}</label>
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
				<span class="result-text"
					>{simulationResult.allowed
						? $LL.admin_policies_result_allowed()
						: $LL.admin_policies_result_denied()}</span
				>
			</div>
			<div class="result-details">
				<p><strong>{$LL.admin_policies_reason_label()}</strong> {simulationResult.reason}</p>
				{#if simulationResult.decided_by}
					<p>
						<strong>{$LL.admin_policies_decided_by_label()}</strong>
						{simulationResult.decided_by}
					</p>
				{/if}
				<p>
					<strong>{$LL.admin_policies_rules_evaluated_label()}</strong>
					{simulationResult.evaluated_rules}
				</p>
			</div>
		</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showSimulateDialog = false)}
			>{$LL.admin_policies_close()}</button
		>
		<button class="btn btn-primary" onclick={runSimulation} disabled={simulating}>
			{simulating ? $LL.admin_policies_simulating() : $LL.admin_policies_run_simulation()}
		</button>
	{/snippet}
</Modal>

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
