<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminRoleRulesAPI,
		type RoleAssignmentRule,
		type RuleCondition,
		type CompoundCondition,
		type RuleAction,
		createEqualsCondition,
		createAssignRoleAction
	} from '$lib/api/admin-role-rules';
	import { ToggleSwitch } from '$lib/components';

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
			console.error('Failed to load role assignment rules:', err);
			error = 'Failed to load role assignment rules';
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
			createError = 'Name, Role ID, Claim Name, and Claim Value are required';
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
			createError = err instanceof Error ? err.message : 'Failed to create rule';
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
			deleteError = err instanceof Error ? err.message : 'Failed to delete rule';
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
				testError = 'Invalid JSON format for claims';
			} else {
				testError = err instanceof Error ? err.message : 'Failed to test rule';
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
			error = err instanceof Error ? err.message : 'Failed to update rule';
		}
	}

	function formatCondition(condition: RuleCondition | CompoundCondition): string {
		if ('operator' in condition && ('and' === condition.operator || 'or' === condition.operator)) {
			const compound = condition as CompoundCondition;
			return `${compound.operator.toUpperCase()}(${compound.conditions.length} conditions)`;
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
		<p class="rules-description">
			Configure automatic role assignment rules based on IdP claims. When users authenticate via
			external identity providers, their claims are evaluated against these rules.
		</p>
		<button class="btn btn-primary" onclick={openCreateDialog}>Add Rule</button>
	</div>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading rules...</p>
		</div>
	{:else if rules.length === 0}
		<div class="empty-state">
			<p>No role assignment rules configured.</p>
			<p class="text-muted">
				Add a rule to automatically assign roles to users based on their IdP claims.
			</p>
			<button class="btn btn-primary" onclick={openCreateDialog}>Add Your First Rule</button>
		</div>
	{:else}
		<div class="summary-bar">
			Showing {rules.length} of {total} rules
		</div>

		<div class="data-table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>Name</th>
						<th>Condition</th>
						<th>Role</th>
						<th>Scope</th>
						<th>Priority</th>
						<th>Status</th>
						<th class="text-right">Actions</th>
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
								<span class={getScopeBadgeClass(rule.scope_type)}>{rule.scope_type}</span>
							</td>
							<td>
								{rule.priority}
								{#if rule.stop_processing}
									<span class="stop-indicator">⬛ stops</span>
								{/if}
							</td>
							<td>
								<span class="badge {rule.is_active ? 'badge-success' : 'badge-neutral'}">
									{rule.is_active ? 'Active' : 'Inactive'}
								</span>
							</td>
							<td class="text-right">
								<div class="action-buttons">
									<button class="btn btn-secondary btn-sm" onclick={(e) => openTestDialog(rule, e)}>
										Test
									</button>
									<button class="btn btn-secondary btn-sm" onclick={(e) => toggleActive(rule, e)}>
										{rule.is_active ? 'Disable' : 'Enable'}
									</button>
									<button class="btn btn-danger btn-sm" onclick={(e) => openDeleteDialog(rule, e)}>
										Delete
									</button>
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<!-- Create Dialog -->
{#if showCreateDialog}
	<div
		class="modal-overlay"
		onclick={closeCreateDialog}
		onkeydown={(e) => e.key === 'Escape' && closeCreateDialog()}
		tabindex="-1"
		role="presentation"
	>
		<div
			class="modal-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
		>
			<div class="modal-header">
				<h2 class="modal-title">Add Role Assignment Rule</h2>
			</div>

			<div class="modal-body">
				{#if createError}
					<div class="alert alert-error">{createError}</div>
				{/if}

				<div class="form-group">
					<label for="rule-name" class="form-label">Rule Name</label>
					<input
						type="text"
						id="rule-name"
						class="form-input"
						bind:value={newName}
						placeholder="e.g., Assign Admin for IT Staff"
					/>
				</div>

				<div class="form-group">
					<label for="rule-desc" class="form-label">Description (optional)</label>
					<input
						type="text"
						id="rule-desc"
						class="form-input"
						bind:value={newDescription}
						placeholder="Brief description of the rule"
					/>
				</div>

				<div class="form-group">
					<label for="role-id" class="form-label">Role ID to Assign</label>
					<input
						type="text"
						id="role-id"
						class="form-input"
						bind:value={newRoleId}
						placeholder="e.g., admin, viewer, editor"
					/>
				</div>

				<div class="panel" style="margin: 16px 0;">
					<h3 class="form-label">Condition (Simple Match)</h3>

					<div class="form-row">
						<div class="form-group">
							<label for="claim-name" class="form-label">Claim Name</label>
							<input
								type="text"
								id="claim-name"
								class="form-input"
								bind:value={newClaimName}
								placeholder="e.g., email, groups, department"
							/>
						</div>
						<div class="form-group">
							<label for="claim-value" class="form-label">Claim Value</label>
							<input
								type="text"
								id="claim-value"
								class="form-input"
								bind:value={newClaimValue}
								placeholder="e.g., *@company.com, IT"
							/>
						</div>
					</div>
					<p class="cell-secondary">
						This creates a simple "equals" condition. For complex conditions, use the API directly.
					</p>
				</div>

				<div class="form-row">
					<div class="form-group">
						<label for="priority" class="form-label">Priority</label>
						<input
							type="number"
							id="priority"
							class="form-input"
							bind:value={newPriority}
							min="0"
							max="1000"
						/>
						<span class="cell-secondary">Higher priority rules are evaluated first</span>
					</div>
				</div>

				<div class="form-group">
					<ToggleSwitch
						bind:checked={newStopProcessing}
						label="Stop Processing"
						description="Stop processing subsequent rules if this rule matches"
					/>
				</div>
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={closeCreateDialog} disabled={creating}>
					Cancel
				</button>
				<button class="btn btn-primary" onclick={confirmCreate} disabled={creating}>
					{creating ? 'Creating...' : 'Create Rule'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Test Dialog -->
{#if showTestDialog && ruleToTest}
	<div
		class="modal-overlay"
		onclick={closeTestDialog}
		onkeydown={(e) => e.key === 'Escape' && closeTestDialog()}
		tabindex="-1"
		role="presentation"
	>
		<div
			class="modal-content modal-lg"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
		>
			<div class="modal-header">
				<h2 class="modal-title">Test Rule: {ruleToTest.name}</h2>
			</div>

			<div class="modal-body">
				{#if testError}
					<div class="alert alert-error">{testError}</div>
				{/if}

				<div class="form-group">
					<label for="test-claims" class="form-label">Test Claims (JSON)</label>
					<textarea id="test-claims" class="form-input" bind:value={testClaims} rows="6"></textarea>
					<span class="cell-secondary"
						>Enter the claims object that would be received from the IdP</span
					>
				</div>

				{#if testResult}
					<div class="panel {testResult.matched ? 'panel-success' : 'panel-neutral'}">
						<div class="cell-primary">
							{testResult.matched ? '✓ Rule Matched' : '✗ Rule Did Not Match'}
						</div>
						{#if testResult.matched && testResult.actions_applied.length > 0}
							<div style="margin-top: 8px;">
								<strong>Actions to apply:</strong>
								<ul style="margin: 8px 0 0 20px;">
									{#each testResult.actions_applied as action, i (i)}
										<li>{action.type}: {action.target}</li>
									{/each}
								</ul>
							</div>
						{/if}
					</div>
				{/if}
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={closeTestDialog}>Close</button>
				<button class="btn btn-primary" onclick={runTest} disabled={testing}>
					{testing ? 'Testing...' : 'Run Test'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Delete Confirmation Dialog -->
{#if showDeleteDialog && ruleToDelete}
	<div
		class="modal-overlay"
		onclick={closeDeleteDialog}
		onkeydown={(e) => e.key === 'Escape' && closeDeleteDialog()}
		tabindex="-1"
		role="presentation"
	>
		<div
			class="modal-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
		>
			<div class="modal-header">
				<h2 class="modal-title">Delete Role Assignment Rule</h2>
			</div>

			<div class="modal-body">
				{#if deleteError}
					<div class="alert alert-error">{deleteError}</div>
				{/if}

				<p class="modal-description">
					Are you sure you want to delete this role assignment rule? Users will no longer be
					automatically assigned the specified role based on this rule.
				</p>

				<div class="panel" style="margin-top: 16px;">
					<p><strong>Rule:</strong> {ruleToDelete.name}</p>
					<p><strong>Role:</strong> {ruleToDelete.role_id}</p>
					<p>
						<strong>Condition:</strong>
						<code class="condition-code">{formatCondition(ruleToDelete.condition)}</code>
					</p>
				</div>
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={closeDeleteDialog} disabled={deleting}>
					Cancel
				</button>
				<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
					{deleting ? 'Deleting...' : 'Delete Rule'}
				</button>
			</div>
		</div>
	</div>
{/if}

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
		color: var(--text-secondary);
		font-size: 0.875rem;
		max-width: 600px;
		margin: 0;
	}

	.summary-bar {
		font-size: 0.875rem;
		color: var(--text-secondary);
	}

	.condition-code {
		font-size: 0.8125rem;
		background: var(--bg-tertiary);
		padding: 2px 6px;
		border-radius: var(--radius-sm);
	}

	.stop-indicator {
		font-size: 0.75rem;
		color: var(--text-tertiary);
		margin-left: 4px;
	}

	.badge-scope {
		font-size: 0.75rem;
		padding: 2px 8px;
		border-radius: var(--radius-sm);
		background: var(--bg-tertiary);
		color: var(--text-secondary);
	}

	.badge-scope.global {
		background: rgba(139, 92, 246, 0.15);
		color: var(--purple);
	}

	.badge-scope.organization {
		background: rgba(34, 197, 94, 0.15);
		color: var(--success);
	}

	.badge-scope.client {
		background: rgba(59, 130, 246, 0.15);
		color: var(--primary);
	}

	.form-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
	}

	@media (max-width: 600px) {
		.form-row {
			grid-template-columns: 1fr;
		}

		.rules-header {
			flex-direction: column;
		}
	}

	.panel-success {
		border-left: 3px solid var(--success);
	}

	.panel-neutral {
		border-left: 3px solid var(--text-tertiary);
	}
</style>
