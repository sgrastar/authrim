<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		adminReBACAPI,
		type RelationDefinition,
		type RelationExpression,
		formatRelationExpression,
		type RelationExpressionType
	} from '$lib/api/admin-rebac';
	import { ToggleSwitch } from '$lib/components';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';
	import { getLocale, LL } from '$i18n/i18n-svelte';

	// State
	let definition: RelationDefinition | null = $state(null);
	let loading = $state(true);
	let error = $state('');

	// Edit state
	let isEditing = $state(false);
	let saving = $state(false);
	let saveError = $state('');
	let editForm = $state({
		description: '',
		priority: 0,
		is_active: true
	});

	// Expression editor state
	let showExpressionEditor = $state(false);
	let expressionJson = $state('');
	let expressionError = $state('');

	// Test permission state
	let showTestPanel = $state(false);
	let testUserId = $state('');
	let testResult: { allowed: boolean; resolved_via?: string; path?: string[] } | null =
		$state(null);
	let testing = $state(false);
	let testError = $state('');
	let loadedTenantId = $state('');

	const definitionId = $derived($page.params.id);
	const pageTitle = $derived(formatPageTitle(definition));
	const pageDescription = $derived(formatPageDescription(definition));
	const expressionTypeLabel = $derived(formatDefinitionExpressionTypeLabel(definition));

	function formatPageTitle(currentDefinition: RelationDefinition | null): string {
		if (!currentDefinition) return $LL.admin_rebac_relation_definitions();
		return `${currentDefinition.object_type}#${currentDefinition.relation_name}`;
	}

	function formatPageDescription(currentDefinition: RelationDefinition | null): string {
		return currentDefinition?.description || $LL.admin_rebac_relation_definitions_description();
	}

	function formatDefinitionExpressionTypeLabel(
		currentDefinition: RelationDefinition | null
	): string {
		if (!currentDefinition) return '';
		return formatExpressionTypeLabel(currentDefinition.definition.type);
	}

	async function loadDefinition() {
		if (!definitionId) {
			error = $LL.admin_rebac_definition_detail_invalid_id();
			return;
		}

		loading = true;
		error = '';

		try {
			const response = await adminReBACAPI.getDefinition(definitionId);
			definition = response.definition;
			editForm = {
				description: definition.description || '',
				priority: definition.priority,
				is_active: definition.is_active
			};
			expressionJson = JSON.stringify(definition.definition, null, 2);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_rebac_definition_detail_load_failed();
		} finally {
			loading = false;
		}
	}

	function startEditing() {
		if (!definition) return;
		editForm = {
			description: definition.description || '',
			priority: definition.priority,
			is_active: definition.is_active
		};
		expressionJson = JSON.stringify(definition.definition, null, 2);
		saveError = '';
		isEditing = true;
	}

	function cancelEditing() {
		isEditing = false;
		saveError = '';
		expressionError = '';
	}

	async function saveChanges() {
		if (!definition) return;

		saving = true;
		saveError = '';

		try {
			// Parse expression if edited
			let newDefinition: RelationExpression | undefined;
			const currentJson = JSON.stringify(definition.definition, null, 2);
			if (expressionJson !== currentJson) {
				try {
					newDefinition = JSON.parse(expressionJson);
				} catch {
					saveError = $LL.admin_rebac_definition_detail_invalid_json();
					saving = false;
					return;
				}
			}

			await adminReBACAPI.updateDefinition(definition.id, {
				definition: newDefinition,
				description: editForm.description || undefined,
				priority: editForm.priority,
				is_active: editForm.is_active
			});

			isEditing = false;
			loadDefinition();
		} catch (err) {
			saveError =
				err instanceof Error ? err.message : $LL.admin_rebac_definition_detail_update_failed();
		} finally {
			saving = false;
		}
	}

	async function toggleActive() {
		if (!definition) return;

		saving = true;
		try {
			await adminReBACAPI.updateDefinition(definition.id, {
				is_active: !definition.is_active
			});
			loadDefinition();
		} catch (err) {
			saveError =
				err instanceof Error ? err.message : $LL.admin_rebac_definition_detail_toggle_failed();
		} finally {
			saving = false;
		}
	}

	async function runTestPermission() {
		if (!definition || !testUserId) {
			testError = $LL.admin_rebac_definition_detail_user_id_required();
			return;
		}

		testing = true;
		testError = '';
		testResult = null;

		try {
			testResult = await adminReBACAPI.checkPermission({
				user_id: testUserId,
				relation: definition.relation_name,
				object: `${definition.object_type}:test_object`,
				object_type: definition.object_type
			});
		} catch (err) {
			testError =
				err instanceof Error ? err.message : $LL.admin_rebac_definition_detail_test_failed();
		} finally {
			testing = false;
		}
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleString(getLocale() === 'ja' ? 'ja-JP' : 'en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function formatExpressionTypeLabel(type: RelationExpressionType): string {
		switch (type) {
			case 'direct':
				return $LL.admin_rebac_expr_direct();
			case 'union':
				return $LL.admin_rebac_expr_union();
			case 'intersection':
				return $LL.admin_rebac_expr_intersection();
			case 'exclusion':
				return $LL.admin_rebac_expr_exclusion();
			case 'tuple_to_userset':
				return $LL.admin_rebac_expr_inherited();
			default:
				return type;
		}
	}

	function renderExpressionTree(expr: RelationExpression, depth: number = 0): string {
		const indent = '  '.repeat(depth);
		switch (expr.type) {
			case 'direct':
				return `${indent}• ${$LL.admin_rebac_expr_direct()}: ${expr.relation}`;
			case 'union':
				return `${indent}• ${$LL.admin_rebac_expr_union()}\n${expr.children.map((c) => renderExpressionTree(c, depth + 1)).join('\n')}`;
			case 'intersection':
				return `${indent}• ${$LL.admin_rebac_expr_intersection()}\n${expr.children.map((c) => renderExpressionTree(c, depth + 1)).join('\n')}`;
			case 'exclusion':
				return `${indent}• ${$LL.admin_rebac_expr_exclusion()}\n${indent}  ${$LL.admin_rebac_definition_detail_base()}:\n${renderExpressionTree(expr.base, depth + 2)}\n${indent}  ${$LL.admin_rebac_definition_detail_subtract()}:\n${renderExpressionTree(expr.subtract, depth + 2)}`;
			case 'tuple_to_userset':
				return `${indent}• ${$LL.admin_rebac_expr_inherited()}: ${expr.tupleset.relation} → ${expr.computed_userset.relation}`;
			default:
				return `${indent}• ${$LL.admin_rebac_definition_detail_unknown()}`;
		}
	}

	onMount(async () => {
		await settingsContext.initialize();
	});

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (!tenantId || tenantId === loadedTenantId) return;
		loadedTenantId = tenantId;
		definition = null;
		isEditing = false;
		saveError = '';
		expressionError = '';
		showExpressionEditor = false;
		showTestPanel = false;
		testResult = null;
		testError = '';
		loadDefinition();
	});
</script>

<svelte:head>
	<title>{$LL.admin_rebac_definition_detail_head_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader title={pageTitle} description={pageDescription}>
		{#snippet actions()}
			{#if definition && !isEditing}
				<button class="btn btn-secondary" onclick={startEditing}>
					{$LL.admin_rebac_definition_detail_edit()}
				</button>
				<button
					class="status-badge status-button"
					class:status-active={definition.is_active}
					class:status-inactive={!definition.is_active}
					onclick={toggleActive}
					disabled={saving}
				>
					{definition.is_active
						? $LL.admin_rebac_definitions_active()
						: $LL.admin_rebac_definitions_inactive()}
				</button>
			{/if}
		{/snippet}
	</AdminPageHeader>

	{#if error}
		<div class="alert alert-error">
			<span>{error}</span>
			<button class="btn btn-secondary btn-sm" onclick={loadDefinition}>
				{$LL.admin_rebac_retry()}
			</button>
		</div>
	{/if}

	{#if saveError}
		<div class="alert alert-error">
			<span>{saveError}</span>
			<button class="btn btn-secondary btn-sm" onclick={() => (saveError = '')}>
				{$LL.admin_rebac_definition_detail_dismiss()}
			</button>
		</div>
	{/if}

	{#if loading}
		<div class="loading-state">{$LL.admin_rebac_loading()}</div>
	{:else if definition}
		<div class="content-grid">
			<AdminSection title={$LL.admin_rebac_definition_detail_details()}>
				{#if isEditing}
					<div class="edit-form">
						<div class="admin-field dialog-field">
							<label for="edit-description" class="admin-field__label">
								{$LL.admin_rebac_definitions_description_label()}
							</label>
							<textarea
								id="edit-description"
								class="admin-input"
								bind:value={editForm.description}
								placeholder={$LL.admin_rebac_definitions_description_placeholder()}
								rows="3"
							></textarea>
						</div>

						<div class="admin-field dialog-field">
							<label for="edit-priority" class="admin-field__label">
								{$LL.admin_rebac_definitions_priority()}
							</label>
							<input
								id="edit-priority"
								class="admin-input"
								type="number"
								bind:value={editForm.priority}
								min="0"
								max="1000"
							/>
							<span class="field-hint">{$LL.admin_rebac_definitions_priority_hint()}</span>
						</div>

						<div class="toggle-field">
							<ToggleSwitch
								bind:checked={editForm.is_active}
								label={$LL.admin_rebac_definitions_active()}
								description={$LL.admin_rebac_definition_detail_enable_description()}
							/>
						</div>

						<div class="form-actions">
							<button class="btn btn-secondary" onclick={cancelEditing}>
								{$LL.admin_rebac_tuples_cancel()}
							</button>
							<button class="btn btn-primary" onclick={saveChanges} disabled={saving}>
								{saving
									? $LL.admin_rebac_saving()
									: $LL.admin_rebac_definition_detail_save_changes()}
							</button>
						</div>
					</div>
				{:else}
					<div class="info-grid">
						<div class="info-row">
							<span class="info-label">ID</span>
							<span class="info-value mono">{definition.id}</span>
						</div>
						<div class="info-row">
							<span class="info-label">{$LL.admin_rebac_definitions_object_type()}</span>
							<span class="info-value">{definition.object_type}</span>
						</div>
						<div class="info-row">
							<span class="info-label">{$LL.admin_rebac_definitions_relation_name()}</span>
							<span class="info-value mono">{definition.relation_name}</span>
						</div>
						<div class="info-row">
							<span class="info-label">{$LL.admin_rebac_definitions_priority()}</span>
							<span class="info-value">{definition.priority}</span>
						</div>
						<div class="info-row">
							<span class="info-label">{$LL.admin_rebac_definitions_status()}</span>
							<span
								class="status-badge"
								class:status-active={definition.is_active}
								class:status-inactive={!definition.is_active}
							>
								{definition.is_active
									? $LL.admin_rebac_definitions_active()
									: $LL.admin_rebac_definitions_inactive()}
							</span>
						</div>
						<div class="info-row">
							<span class="info-label">{$LL.admin_rebac_definitions_source()}</span>
							<span class="source-badge">{$LL.admin_rebac_definitions_tenant()}</span>
						</div>
						<div class="info-row">
							<span class="info-label">{$LL.admin_rebac_tuples_created()}</span>
							<span class="info-value">{formatDate(definition.created_at)}</span>
						</div>
						<div class="info-row">
							<span class="info-label">{$LL.admin_rebac_definitions_updated()}</span>
							<span class="info-value">{formatDate(definition.updated_at)}</span>
						</div>
					</div>
				{/if}
			</AdminSection>

			<AdminSection title={$LL.admin_rebac_definition_detail_relation_expression()}>
				{#snippet actions()}
					<span class="expr-type-badge">
						{expressionTypeLabel}
					</span>
				{/snippet}

				{#if isEditing && showExpressionEditor}
					<div class="admin-field expression-editor">
						<label for="expr-json" class="admin-field__label">
							{$LL.admin_rebac_definition_detail_expression_json()}
						</label>
						<textarea
							id="expr-json"
							class="admin-input code-input"
							bind:value={expressionJson}
							rows="12"
						></textarea>
						{#if expressionError}
							<div class="field-error">{expressionError}</div>
						{/if}
						<span class="field-hint">
							{$LL.admin_rebac_definition_detail_expression_json_help()}
						</span>
					</div>
				{:else if isEditing}
					<button class="btn btn-secondary btn-sm" onclick={() => (showExpressionEditor = true)}>
						{$LL.admin_rebac_definition_detail_edit_expression_json()}
					</button>
				{/if}

				<div class="expression-display">
					<div class="expression-block">
						<span class="block-label">{$LL.admin_rebac_definition_detail_formula()}</span>
						<code>{formatRelationExpression(definition.definition)}</code>
					</div>

					<div class="expression-block">
						<span class="block-label">{$LL.admin_rebac_definition_detail_structure()}</span>
						<pre>{renderExpressionTree(definition.definition)}</pre>
					</div>
				</div>
			</AdminSection>

			<AdminSection title={$LL.admin_rebac_definition_detail_test_permission()}>
				{#snippet actions()}
					<button class="btn btn-secondary btn-sm" onclick={() => (showTestPanel = !showTestPanel)}>
						{showTestPanel
							? $LL.admin_rebac_definition_detail_hide()
							: $LL.admin_rebac_definition_detail_show()}
					</button>
				{/snippet}

				{#if showTestPanel}
					<p class="test-description">
						{$LL.admin_rebac_definition_detail_test_prefix()}
						<strong>{definition.relation_name}</strong>
						{$LL.admin_rebac_definition_detail_test_middle()}
						<strong>{definition.object_type}</strong>
						{$LL.admin_rebac_definition_detail_test_suffix()}
					</p>

					<div class="test-form">
						<div class="admin-field">
							<label for="test-user" class="admin-field__label">{$LL.admin_rebac_user_id()}</label>
							<input
								id="test-user"
								type="text"
								class="admin-input"
								bind:value={testUserId}
								placeholder="user_123"
							/>
						</div>

						<button class="btn btn-primary" onclick={runTestPermission} disabled={testing}>
							{testing
								? $LL.admin_rebac_definition_detail_testing()
								: $LL.admin_rebac_definition_detail_run_test()}
						</button>
					</div>

					{#if testError}
						<div class="alert alert-error alert-sm">{testError}</div>
					{/if}

					{#if testResult}
						<div
							class="test-result"
							class:allowed={testResult.allowed}
							class:denied={!testResult.allowed}
						>
							<div class="result-status">
								{testResult.allowed
									? $LL.admin_rebac_result_allowed()
									: $LL.admin_rebac_result_denied()}
							</div>
							{#if testResult.resolved_via}
								<div class="result-detail">
									<span class="block-label">{$LL.admin_rebac_resolved_via_label()}</span>
									<span class="value">{testResult.resolved_via}</span>
								</div>
							{/if}
							{#if testResult.path && testResult.path.length > 0}
								<div class="result-detail">
									<span class="block-label">{$LL.admin_rebac_path_label()}</span>
									<span class="value path">{testResult.path.join(' → ')}</span>
								</div>
							{/if}
						</div>
					{/if}
				{/if}
			</AdminSection>
		</div>

		<AdminSection title={$LL.admin_rebac_definition_detail_reference_title()}>
			<div class="reference-grid">
				<div class="reference-item">
					<strong>{$LL.admin_rebac_expr_direct()}</strong>
					<p>{$LL.admin_rebac_definition_detail_ref_direct()}</p>
					<code>direct:viewer</code>
				</div>
				<div class="reference-item">
					<strong>{$LL.admin_rebac_expr_union()}</strong>
					<p>{$LL.admin_rebac_definition_detail_ref_union()}</p>
					<code>(viewer OR editor OR owner)</code>
				</div>
				<div class="reference-item">
					<strong>{$LL.admin_rebac_expr_intersection()}</strong>
					<p>{$LL.admin_rebac_definition_detail_ref_intersection()}</p>
					<code>(member AND verified)</code>
				</div>
				<div class="reference-item">
					<strong>{$LL.admin_rebac_expr_exclusion()}</strong>
					<p>{$LL.admin_rebac_definition_detail_ref_exclusion()}</p>
					<code>(member EXCEPT blocked)</code>
				</div>
				<div class="reference-item">
					<strong>{$LL.admin_rebac_expr_inherited()}</strong>
					<p>{$LL.admin_rebac_definition_detail_ref_inherited()}</p>
					<code>parent→viewer</code>
				</div>
			</div>
		</AdminSection>
	{/if}
</AdminPageShell>

<style>
	.content-grid {
		display: grid;
		grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
		gap: 22px;
	}

	.content-grid :global(.admin-section:nth-child(3)) {
		grid-column: 1 / -1;
	}

	.info-grid,
	.edit-form,
	.expression-display {
		display: grid;
		gap: 14px;
	}

	.info-row {
		display: grid;
		grid-template-columns: minmax(120px, 0.34fr) minmax(0, 1fr);
		gap: 12px;
		align-items: start;
		padding-block: 0.55rem;
		border-bottom: 1px solid var(--color-border-subtle, var(--color-border));
	}

	.info-row:last-child {
		border-bottom: 0;
	}

	.info-label,
	.block-label {
		color: var(--color-text-muted);
		font-family: var(--font-meta, var(--font-body));
		font-size: 0.75rem;
		font-weight: 700;
	}

	.info-value,
	.value {
		min-width: 0;
		color: var(--color-text);
		font-size: 0.88rem;
		overflow-wrap: anywhere;
	}

	.mono,
	code,
	pre,
	.code-input {
		font-family: var(--font-mono);
	}

	.status-badge,
	.source-badge,
	.expr-type-badge {
		display: inline-flex;
		align-items: center;
		width: fit-content;
		border-radius: var(--radius-sm);
		padding: 0.16rem 0.5rem;
		font-size: 0.78rem;
		font-weight: 700;
	}

	.status-button {
		border: 0;
		cursor: pointer;
	}

	.status-button:disabled {
		cursor: wait;
		opacity: 0.65;
	}

	.status-active {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.status-inactive,
	.source-badge,
	.expr-type-badge {
		background: var(--color-surface-subtle);
		color: var(--color-text-muted);
	}

	.toggle-field {
		padding: 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface-subtle);
	}

	.form-actions,
	.test-form {
		display: flex;
		align-items: flex-end;
		gap: 10px;
		flex-wrap: wrap;
	}

	.admin-field {
		min-width: 0;
	}

	.dialog-field :global(.admin-field__label),
	.admin-field__label {
		display: block;
		margin-bottom: 0.5rem;
		color: var(--color-text);
		font-size: 0.875rem;
		font-weight: 600;
	}

	.dialog-field :global(.admin-input),
	.admin-input {
		width: 100%;
		padding: 0.58rem 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
		font-size: 0.875rem;
	}

	.dialog-field :global(.admin-input:focus),
	.admin-input:focus {
		outline: none;
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.field-hint {
		display: block;
		margin-top: 0.35rem;
		color: var(--color-text-muted);
		font-size: 0.8rem;
		line-height: 1.5;
	}

	.field-error {
		margin-top: 0.45rem;
		color: var(--color-danger);
		font-size: 0.82rem;
	}

	.expression-block {
		display: grid;
		gap: 8px;
		min-width: 0;
	}

	.expression-block code,
	.expression-block pre {
		margin: 0;
		padding: 0.85rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface-subtle);
		color: var(--color-text);
		font-size: 0.82rem;
		line-height: 1.6;
		overflow: auto;
	}

	.test-description {
		margin: 0 0 1rem;
		color: var(--color-text-muted);
		font-size: 0.9rem;
		line-height: 1.7;
	}

	.test-result {
		display: grid;
		gap: 0.6rem;
		margin-top: 1rem;
		padding: 0.9rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface-subtle);
	}

	.test-result.allowed {
		border-color: color-mix(in srgb, var(--color-success) 42%, var(--color-border));
	}

	.test-result.denied {
		border-color: color-mix(in srgb, var(--color-danger) 42%, var(--color-border));
	}

	.result-status {
		color: var(--color-text);
		font-weight: 700;
	}

	.result-detail {
		display: grid;
		grid-template-columns: minmax(120px, 0.26fr) minmax(0, 1fr);
		gap: 10px;
		align-items: start;
	}

	.path {
		font-family: var(--font-mono);
		font-size: 0.82rem;
	}

	.reference-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 12px;
	}

	.reference-item {
		display: grid;
		gap: 0.45rem;
		padding: 0.9rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface-subtle);
	}

	.reference-item strong {
		color: var(--color-text);
		font-size: 0.9rem;
	}

	.reference-item p {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.8rem;
		line-height: 1.55;
	}

	.reference-item code {
		width: fit-content;
		max-width: 100%;
		padding: 0.25rem 0.45rem;
		border-radius: var(--radius-sm);
		background: var(--color-surface);
		color: var(--color-text);
		font-size: 0.75rem;
		overflow-wrap: anywhere;
	}

	@media (max-width: 980px) {
		.content-grid {
			grid-template-columns: 1fr;
		}

		.info-row,
		.result-detail {
			grid-template-columns: 1fr;
			gap: 4px;
		}
	}
</style>
