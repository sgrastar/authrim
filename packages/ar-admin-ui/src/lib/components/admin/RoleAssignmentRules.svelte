<script lang="ts">
	import { onMount } from 'svelte';
	import { LL } from '$i18n/i18n-svelte';
	import {
		adminRoleRulesAPI,
		type RoleAssignmentRule,
		type RuleCondition,
		type CompoundCondition,
		type RuleAction,
		createEqualsCondition,
		createAssignRoleAction
	} from '$lib/api/admin-role-rules';
	import { Modal, ToggleSwitch } from '$lib/components';
	import { formatScope } from '$lib/admin/roles-i18n';
	import AdminDataTable from './AdminDataTable.svelte';

	interface Props {
		showDescription?: boolean;
	}

	let { showDescription = true }: Props = $props();

	let rules: RoleAssignmentRule[] = $state([]);
	let loading = $state(true);
	let error = $state('');
	let total = $state(0);

	// Create dialog state
	let showCreateDialog = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let newName = $state('');
	let newDescription = $state('');
	let newRoleId = $state('');
	let newClaimName = $state('');
	let newClaimValue = $state('');
	let newPriority = $state(0);
	let newStopProcessing = $state(false);

	// Delete confirmation dialog state
	let showDeleteDialog = $state(false);
	let ruleToDelete: RoleAssignmentRule | null = $state(null);
	let deleting = $state(false);
	let deleteError = $state('');

	// Test dialog state
	let showTestDialog = $state(false);
	let ruleToTest: RoleAssignmentRule | null = $state(null);
	let testing = $state(false);
	let testError = $state('');
	let testClaims = $state('{}');
	let testResult: { matched: boolean; actions_applied: RuleAction[] } | null = $state(null);

	async function loadRules() {
		loading = true;
		error = '';

		try {
			const response = await adminRoleRulesAPI.list({ limit: 50 });
			rules = response.rules;
			total = response.total;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_roles_rules_load_failed();
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadRules();
	});

	function openCreateDialog() {
		newName = '';
		newDescription = '';
		newRoleId = '';
		newClaimName = 'email';
		newClaimValue = '';
		newPriority = 0;
		newStopProcessing = false;
		createError = '';
		showCreateDialog = true;
	}

	function closeCreateDialog() {
		showCreateDialog = false;
		createError = '';
	}

	async function confirmCreate() {
		if (!newName.trim() || !newRoleId.trim() || !newClaimName.trim() || !newClaimValue.trim()) {
			createError = $LL.admin_roles_rules_required();
			return;
		}

		creating = true;
		createError = '';

		try {
			const condition = createEqualsCondition(newClaimName.trim(), newClaimValue.trim());
			const action = createAssignRoleAction(newRoleId.trim());

			await adminRoleRulesAPI.create({
				name: newName.trim(),
				description: newDescription.trim() || undefined,
				role_id: newRoleId.trim(),
				condition,
				actions: [action],
				priority: newPriority,
				stop_processing: newStopProcessing,
				is_active: true
			});
			showCreateDialog = false;
			await loadRules();
		} catch (err) {
			createError = err instanceof Error ? err.message : $LL.admin_roles_rules_create_failed();
		} finally {
			creating = false;
		}
	}

	function openDeleteDialog(rule: RoleAssignmentRule, event: Event) {
		event.stopPropagation();
		ruleToDelete = rule;
		deleteError = '';
		showDeleteDialog = true;
	}

	function closeDeleteDialog() {
		showDeleteDialog = false;
		ruleToDelete = null;
		deleteError = '';
	}

	async function confirmDelete() {
		if (!ruleToDelete) return;

		deleting = true;
		deleteError = '';

		try {
			await adminRoleRulesAPI.delete(ruleToDelete.id);
			showDeleteDialog = false;
			ruleToDelete = null;
			await loadRules();
		} catch (err) {
			deleteError = err instanceof Error ? err.message : $LL.admin_roles_rules_delete_failed();
		} finally {
			deleting = false;
		}
	}

	function openTestDialog(rule: RoleAssignmentRule, event: Event) {
		event.stopPropagation();
		ruleToTest = rule;
		testError = '';
		testClaims = '{\n  "email": "user@example.com",\n  "groups": ["admin"]\n}';
		testResult = null;
		showTestDialog = true;
	}

	function closeTestDialog() {
		showTestDialog = false;
		ruleToTest = null;
		testError = '';
		testResult = null;
	}

	async function runTest() {
		if (!ruleToTest) return;

		testing = true;
		testError = '';
		testResult = null;

		try {
			const claims = JSON.parse(testClaims);
			const result = await adminRoleRulesAPI.testRule(ruleToTest.id, { claims });
			testResult = result;
		} catch (err) {
			if (err instanceof SyntaxError) {
				testError = $LL.admin_roles_rules_invalid_json();
			} else {
				testError = err instanceof Error ? err.message : $LL.admin_roles_rules_test_failed();
			}
		} finally {
			testing = false;
		}
	}

	async function toggleActive(rule: RoleAssignmentRule, event: Event) {
		event.stopPropagation();
		try {
			await adminRoleRulesAPI.update(rule.id, {
				is_active: !rule.is_active
			});
			await loadRules();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_roles_rules_update_failed();
		}
	}

	function formatCondition(condition: RuleCondition | CompoundCondition): string {
		if ('operator' in condition && ('and' === condition.operator || 'or' === condition.operator)) {
			const compound = condition as CompoundCondition;
			return $LL.admin_roles_condition_count({
				operator: compound.operator.toUpperCase(),
				count: compound.conditions.length
			});
		}
		const simple = condition as RuleCondition;
		const value = Array.isArray(simple.value) ? simple.value.join(', ') : simple.value;
		return `${simple.claim} ${simple.operator} "${value}"`;
	}

	function getScopeBadgeClass(scope: string): string {
		switch (scope) {
			case 'global':
				return 'badge-scope global';
			case 'organization':
				return 'badge-scope organization';
			case 'client':
				return 'badge-scope client';
			default:
				return 'badge-scope';
		}
	}
</script>

<div class="rules-container">
	<div class="rules-header">
		{#if showDescription}
			<p class="rules-description">{$LL.admin_roles_rules_description()}</p>
		{/if}
		<button class="btn btn-primary" onclick={openCreateDialog}>{$LL.admin_roles_rules_add()}</button
		>
	</div>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_roles_rules_loading()}</p>
		</div>
	{:else if rules.length === 0}
		<div class="empty-state">
			<p>{$LL.admin_roles_rules_empty()}</p>
			<p class="empty-state-hint">{$LL.admin_roles_rules_empty_hint()}</p>
			<button class="btn btn-primary" onclick={openCreateDialog}>
				{$LL.admin_roles_rules_add_first()}
			</button>
		</div>
	{:else}
		<div class="summary-bar">
			{$LL.admin_roles_rules_result_count({ shown: rules.length, total })}
		</div>

		<AdminDataTable width="wide">
			<thead>
				<tr>
					<th>{$LL.admin_roles_name()}</th>
					<th>{$LL.admin_roles_rules_condition()}</th>
					<th>{$LL.admin_roles_rules_role()}</th>
					<th>{$LL.admin_roles_scope()}</th>
					<th>{$LL.admin_roles_rules_priority()}</th>
					<th>{$LL.admin_roles_rules_status()}</th>
					<th class="text-right">{$LL.admin_roles_actions()}</th>
				</tr>
			</thead>
			<tbody>
				{#each rules as rule (rule.id)}
					<tr>
						<td>
							<div class="cell-primary">{rule.name}</div>
							{#if rule.description}
								<div class="cell-secondary">{rule.description}</div>
							{/if}
						</td>
						<td>
							<code class="condition-code">{formatCondition(rule.condition)}</code>
						</td>
						<td class="mono">{rule.role_id}</td>
						<td>
							<span class={getScopeBadgeClass(rule.scope_type)}>
								{formatScope(rule.scope_type, $LL)}
							</span>
						</td>
						<td>
							{rule.priority}
							{#if rule.stop_processing}
								<span class="stop-indicator">{$LL.admin_roles_rules_stops()}</span>
							{/if}
						</td>
						<td>
							<span class="badge {rule.is_active ? 'badge-success' : 'badge-neutral'}">
								{rule.is_active ? $LL.admin_roles_rules_active() : $LL.admin_roles_rules_inactive()}
							</span>
						</td>
						<td class="text-right">
							<div class="action-buttons">
								<button class="btn btn-secondary btn-sm" onclick={(e) => openTestDialog(rule, e)}>
									{$LL.admin_roles_rules_test()}
								</button>
								<button class="btn btn-secondary btn-sm" onclick={(e) => toggleActive(rule, e)}>
									{rule.is_active
										? $LL.admin_roles_rules_disable()
										: $LL.admin_roles_rules_enable()}
								</button>
								<button class="btn btn-danger btn-sm" onclick={(e) => openDeleteDialog(rule, e)}>
									{$LL.admin_roles_delete()}
								</button>
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</AdminDataTable>
	{/if}
</div>

<!-- Create Dialog -->
<Modal
	open={showCreateDialog}
	onClose={closeCreateDialog}
	title={$LL.admin_roles_rules_add_title()}
	size="md"
>
	{#if createError}
		<div class="alert alert-error">{createError}</div>
	{/if}

	<div class="admin-field dialog-field">
		<label for="rule-name" class="admin-field__label">{$LL.admin_roles_rules_name()}</label>
		<input
			type="text"
			id="rule-name"
			class="admin-input"
			bind:value={newName}
			placeholder={$LL.admin_roles_rules_name_placeholder()}
		/>
	</div>

	<div class="admin-field dialog-field">
		<label for="rule-desc" class="admin-field__label">
			{$LL.admin_roles_rules_description_optional()}
		</label>
		<input
			type="text"
			id="rule-desc"
			class="admin-input"
			bind:value={newDescription}
			placeholder={$LL.admin_roles_rules_description_placeholder()}
		/>
	</div>

	<div class="admin-field dialog-field">
		<label for="role-id" class="admin-field__label">{$LL.admin_roles_rules_role_id()}</label>
		<input
			type="text"
			id="role-id"
			class="admin-input"
			bind:value={newRoleId}
			placeholder={$LL.admin_roles_rules_role_id_placeholder()}
		/>
	</div>

	<div class="rule-callout">
		<h3 class="rule-callout-title">{$LL.admin_roles_rules_condition_simple()}</h3>

		<div class="dialog-grid">
			<div class="admin-field dialog-field">
				<label for="claim-name" class="admin-field__label">
					{$LL.admin_roles_rules_claim_name()}
				</label>
				<input
					type="text"
					id="claim-name"
					class="admin-input"
					bind:value={newClaimName}
					placeholder={$LL.admin_roles_rules_claim_name_placeholder()}
				/>
			</div>
			<div class="admin-field dialog-field">
				<label for="claim-value" class="admin-field__label">
					{$LL.admin_roles_rules_claim_value()}
				</label>
				<input
					type="text"
					id="claim-value"
					class="admin-input"
					bind:value={newClaimValue}
					placeholder={$LL.admin_roles_rules_claim_value_placeholder()}
				/>
			</div>
		</div>
		<p class="cell-secondary">
			{$LL.admin_roles_rules_condition_hint()}
		</p>
	</div>

	<div class="dialog-grid">
		<div class="admin-field dialog-field">
			<label for="priority" class="admin-field__label">{$LL.admin_roles_rules_priority()}</label>
			<input
				type="number"
				id="priority"
				class="admin-input"
				bind:value={newPriority}
				min="0"
				max="1000"
			/>
			<span class="cell-secondary">{$LL.admin_roles_rules_priority_hint()}</span>
		</div>
	</div>

	<div class="admin-field dialog-field">
		<ToggleSwitch
			bind:checked={newStopProcessing}
			label={$LL.admin_roles_rules_stop_processing()}
			description={$LL.admin_roles_rules_stop_processing_desc()}
		/>
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeCreateDialog} disabled={creating}>
			{$LL.admin_roles_cancel()}
		</button>
		<button class="btn btn-primary" onclick={confirmCreate} disabled={creating}>
			{creating ? $LL.admin_roles_rules_creating() : $LL.admin_roles_rules_create()}
		</button>
	{/snippet}
</Modal>

<!-- Test Dialog -->
<Modal
	open={showTestDialog && !!ruleToTest}
	onClose={closeTestDialog}
	title={$LL.admin_roles_rules_test_title({ rule: ruleToTest?.name ?? '' })}
	size="lg"
>
	{#if testError}
		<div class="alert alert-error">{testError}</div>
	{/if}

	<div class="admin-field dialog-field">
		<label for="test-claims" class="admin-field__label">
			{$LL.admin_roles_rules_test_claims()}
		</label>
		<textarea id="test-claims" class="admin-input code-input" bind:value={testClaims} rows="6"
		></textarea>
		<span class="cell-secondary">{$LL.admin_roles_rules_test_claims_hint()}</span>
	</div>

	{#if testResult}
		<div class="test-result {testResult.matched ? 'test-result--matched' : 'test-result--neutral'}">
			<div class="cell-primary">
				{testResult.matched
					? `✓ ${$LL.admin_roles_rules_matched()}`
					: `✗ ${$LL.admin_roles_rules_not_matched()}`}
			</div>
			{#if testResult.matched && testResult.actions_applied.length > 0}
				<div class="test-result-actions">
					<strong>{$LL.admin_roles_rules_actions_to_apply()}</strong>
					<ul>
						{#each testResult.actions_applied as action, i (i)}
							<li>{action.type}: {action.target}</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeTestDialog}>
			{$LL.admin_roles_rules_close()}
		</button>
		<button class="btn btn-primary" onclick={runTest} disabled={testing}>
			{testing ? $LL.admin_roles_rules_testing() : $LL.admin_roles_rules_run_test()}
		</button>
	{/snippet}
</Modal>

<!-- Delete Confirmation Dialog -->
<Modal
	open={showDeleteDialog && !!ruleToDelete}
	onClose={closeDeleteDialog}
	title={$LL.admin_roles_rules_delete_title()}
	size="md"
>
	{#if deleteError}
		<div class="alert alert-error">{deleteError}</div>
	{/if}

	<p class="modal-description">
		{$LL.admin_roles_rules_delete_description()}
	</p>

	{#if ruleToDelete}
		<div class="rule-info-summary">
			<p><strong>{$LL.admin_roles_rules_rule_label()}</strong> {ruleToDelete.name}</p>
			<p><strong>{$LL.admin_roles_rules_role_label()}</strong> {ruleToDelete.role_id}</p>
			<p>
				<strong>{$LL.admin_roles_rules_condition_label()}</strong>
				<code class="condition-code">{formatCondition(ruleToDelete.condition)}</code>
			</p>
		</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeDeleteDialog} disabled={deleting}>
			{$LL.admin_roles_cancel()}
		</button>
		<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
			{deleting ? $LL.admin_roles_rules_deleting() : $LL.admin_roles_rules_delete()}
		</button>
	{/snippet}
</Modal>

<style>
	.rules-container {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.rules-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 16px;
	}

	.rules-description {
		color: var(--color-text-muted);
		font-size: 0.875rem;
		max-width: 600px;
		margin: 0;
	}

	.summary-bar {
		font-size: 0.875rem;
		color: var(--color-text-muted);
	}

	.condition-code {
		font-size: 0.8125rem;
		background: var(--color-surface-subtle);
		padding: 0.18rem 0.4rem;
		border-radius: var(--radius-sm);
		color: var(--color-text);
	}

	.stop-indicator {
		font-size: 0.75rem;
		color: var(--color-text-subtle);
		margin-left: 0.25rem;
	}

	.badge-scope {
		font-size: 0.75rem;
		padding: 0.16rem 0.5rem;
		border-radius: var(--radius-sm);
		background: var(--color-surface-subtle);
		color: var(--color-text-muted);
	}

	.badge-scope.global {
		background: color-mix(in srgb, var(--color-accent) 14%, transparent);
		color: var(--color-accent);
	}

	.badge-scope.organization {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.badge-scope.client {
		background: color-mix(in srgb, var(--color-primary) 14%, transparent);
		color: var(--color-primary);
	}

	.rule-callout,
	.rule-info-summary,
	.test-result {
		margin-block: 1rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface-subtle);
		padding: 1rem;
	}

	.rule-callout-title {
		margin: 0 0 0.75rem;
		color: var(--color-text);
		font-size: 0.9rem;
		font-weight: 700;
	}

	.dialog-field {
		margin-bottom: 1rem;
	}

	.dialog-field :global(.admin-input) {
		width: 100%;
	}

	.code-input {
		font-family: var(--font-mono);
	}

	.test-result-actions {
		margin-top: 0.5rem;
	}

	.test-result-actions ul {
		margin: 0.5rem 0 0 1.25rem;
	}

	.test-result--matched {
		border-left: 3px solid var(--color-success);
	}

	.test-result--neutral {
		border-left: 3px solid var(--color-text-subtle);
	}

	.rule-info-summary p {
		margin: 0 0 0.5rem;
		color: var(--color-text);
	}

	.rule-info-summary p:last-child {
		margin-bottom: 0;
	}

	@media (max-width: 600px) {
		.rules-header {
			flex-direction: column;
		}
	}
</style>
