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

<div class="detail-page admin-page">
	<div class="page-header">
		<nav class="breadcrumb">
			<a href="/admin/rebac">ReBAC</a>
			<span>/</span>
			<a href="/admin/rebac/definitions">{$LL.admin_rebac_relation_definitions()}</a>
			<span>/</span>
			<span>{definition?.relation_name || $LL.admin_rebac_loading()}</span>
		</nav>

		{#if definition}
			<div class="header-row">
				<div class="header-content">
					<h1>
						<span class="object-type">{definition.object_type}</span>
						<span class="separator">#</span>
						<span class="relation-name">{definition.relation_name}</span>
					</h1>
					{#if definition.description}
						<p class="description">{definition.description}</p>
					{/if}
				</div>
				<div class="action-buttons">
					{#if !isEditing}
						<button class="btn btn-secondary" onclick={startEditing}
							>{$LL.admin_rebac_definition_detail_edit()}</button
						>
						<button
							class="status-badge"
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
				</div>
			</div>
		{/if}
	</div>

	{#if error}
		<div class="error-banner">
			<span>{error}</span>
			<button onclick={loadDefinition}>{$LL.admin_rebac_retry()}</button>
		</div>
	{/if}

	{#if saveError}
		<div class="error-banner">
			<span>{saveError}</span>
			<button onclick={() => (saveError = '')}>{$LL.admin_rebac_definition_detail_dismiss()}</button
			>
		</div>
	{/if}

	{#if loading}
		<div class="loading-state">{$LL.admin_rebac_loading()}</div>
	{:else if definition}
		<div class="content-grid">
			<!-- Main Details -->
			<div class="detail-card">
				<h2>{$LL.admin_rebac_definition_detail_details()}</h2>
				{#if isEditing}
					<div class="form-group">
						<label for="edit-description" class="form-label"
							>{$LL.admin_rebac_definitions_description_label()}</label
						>
						<textarea
							id="edit-description"
							class="form-input"
							bind:value={editForm.description}
							placeholder={$LL.admin_rebac_definitions_description_placeholder()}
							rows="3"
						></textarea>
					</div>

					<div class="form-group">
						<label for="edit-priority" class="form-label"
							>{$LL.admin_rebac_definitions_priority()}</label
						>
						<input
							id="edit-priority"
							class="form-input"
							type="number"
							bind:value={editForm.priority}
							min="0"
							max="1000"
						/>
						<p class="form-hint">{$LL.admin_rebac_definitions_priority_hint()}</p>
					</div>

					<div class="form-group">
						<ToggleSwitch
							bind:checked={editForm.is_active}
							label={$LL.admin_rebac_definitions_active()}
							description={$LL.admin_rebac_definition_detail_enable_description()}
						/>
					</div>

					<div class="form-actions">
						<button class="btn btn-secondary" onclick={cancelEditing}
							>{$LL.admin_rebac_tuples_cancel()}</button
						>
						<button class="btn btn-primary" onclick={saveChanges} disabled={saving}>
							{saving ? $LL.admin_rebac_saving() : $LL.admin_rebac_definition_detail_save_changes()}
						</button>
					</div>
				{:else}
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
						<span class="source-badge"> {$LL.admin_rebac_definitions_tenant()} </span>
					</div>
					<div class="info-row">
						<span class="info-label">{$LL.admin_rebac_tuples_created()}</span>
						<span class="info-value">{formatDate(definition.created_at)}</span>
					</div>
					<div class="info-row">
						<span class="info-label">{$LL.admin_rebac_definitions_updated()}</span>
						<span class="info-value">{formatDate(definition.updated_at)}</span>
					</div>
				{/if}
			</div>

			<!-- Expression -->
			<div class="detail-card">
				<div class="card-header">
					<h2>{$LL.admin_rebac_definition_detail_relation_expression()}</h2>
					<span class="expr-type-badge"
						>{formatExpressionTypeLabel(definition.definition.type)}</span
					>
				</div>

				{#if isEditing && showExpressionEditor}
					<div class="expression-editor">
						<label for="expr-json">{$LL.admin_rebac_definition_detail_expression_json()}</label>
						<textarea id="expr-json" bind:value={expressionJson} rows="12"></textarea>
						{#if expressionError}
							<div class="field-error">{expressionError}</div>
						{/if}
						<small>{$LL.admin_rebac_definition_detail_expression_json_help()}</small>
					</div>
				{:else if isEditing}
					<button class="btn-edit-expr" onclick={() => (showExpressionEditor = true)}>
						{$LL.admin_rebac_definition_detail_edit_expression_json()}
					</button>
				{/if}

				<div class="expression-display">
					<div class="expression-formula">
						<span class="label">{$LL.admin_rebac_definition_detail_formula()}</span>
						<code>{formatRelationExpression(definition.definition)}</code>
					</div>

					<div class="expression-tree">
						<span class="label">{$LL.admin_rebac_definition_detail_structure()}</span>
						<pre>{renderExpressionTree(definition.definition)}</pre>
					</div>
				</div>
			</div>

			<!-- Test Panel -->
			<div class="detail-card test-panel">
				<div class="card-header">
					<h2>{$LL.admin_rebac_definition_detail_test_permission()}</h2>
					<button class="btn-toggle-panel" onclick={() => (showTestPanel = !showTestPanel)}>
						{showTestPanel
							? $LL.admin_rebac_definition_detail_hide()
							: $LL.admin_rebac_definition_detail_show()}
					</button>
				</div>

				{#if showTestPanel}
					<p class="test-description">
						{$LL.admin_rebac_definition_detail_test_prefix()}
						<strong>{definition.relation_name}</strong>
						{$LL.admin_rebac_definition_detail_test_middle()}
						<strong>{definition.object_type}</strong>
						{$LL.admin_rebac_definition_detail_test_suffix()}
					</p>

					<div class="test-form">
						<div class="form-group">
							<label for="test-user" class="form-label">{$LL.admin_rebac_user_id()}</label>
							<input
								id="test-user"
								type="text"
								class="form-input"
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
						<div class="test-error">{testError}</div>
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
									<span class="label">{$LL.admin_rebac_resolved_via_label()}</span>
									<span class="value">{testResult.resolved_via}</span>
								</div>
							{/if}
							{#if testResult.path && testResult.path.length > 0}
								<div class="result-detail">
									<span class="label">{$LL.admin_rebac_path_label()}</span>
									<span class="value path">{testResult.path.join(' → ')}</span>
								</div>
							{/if}
						</div>
					{/if}
				{/if}
			</div>
		</div>

		<!-- Expression Type Reference -->
		<div class="reference-section">
			<h3>{$LL.admin_rebac_definition_detail_reference_title()}</h3>
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
		</div>
	{/if}
</div>
