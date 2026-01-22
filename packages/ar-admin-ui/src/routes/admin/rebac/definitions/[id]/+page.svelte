<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import {
		adminReBACAPI,
		type RelationDefinition,
		type RelationExpression,
		formatRelationExpression,
		getExpressionTypeLabel
	} from '$lib/api/admin-rebac';
	import { ToggleSwitch } from '$lib/components';

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

	const definitionId = $derived($page.params.id);

	async function loadDefinition() {
		if (!definitionId) {
			error = 'Invalid definition ID';
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
			console.error('Failed to load definition:', err);
			error = err instanceof Error ? err.message : 'Failed to load definition';
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
					saveError = 'Invalid JSON in expression';
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
			console.error('Failed to update definition:', err);
			saveError = err instanceof Error ? err.message : 'Failed to update definition';
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
			console.error('Failed to toggle status:', err);
			saveError = err instanceof Error ? err.message : 'Failed to toggle status';
		} finally {
			saving = false;
		}
	}

	async function runTestPermission() {
		if (!definition || !testUserId) {
			testError = 'User ID is required';
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
			console.error('Failed to test permission:', err);
			testError = err instanceof Error ? err.message : 'Failed to test permission';
		} finally {
			testing = false;
		}
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function renderExpressionTree(expr: RelationExpression, depth: number = 0): string {
		const indent = '  '.repeat(depth);
		switch (expr.type) {
			case 'direct':
				return `${indent}• Direct: ${expr.relation}`;
			case 'union':
				return `${indent}• Union (OR)\n${expr.children.map((c) => renderExpressionTree(c, depth + 1)).join('\n')}`;
			case 'intersection':
				return `${indent}• Intersection (AND)\n${expr.children.map((c) => renderExpressionTree(c, depth + 1)).join('\n')}`;
			case 'exclusion':
				return `${indent}• Exclusion\n${indent}  Base:\n${renderExpressionTree(expr.base, depth + 2)}\n${indent}  Subtract:\n${renderExpressionTree(expr.subtract, depth + 2)}`;
			case 'tuple_to_userset':
				return `${indent}• Inherited: ${expr.tupleset.relation} → ${expr.computed_userset.relation}`;
			default:
				return `${indent}• Unknown`;
		}
	}

	onMount(() => {
		loadDefinition();
	});
</script>

<div class="detail-page admin-page">
	<div class="page-header">
		<nav class="breadcrumb">
			<a href="/admin/rebac">ReBAC</a>
			<span>/</span>
			<a href="/admin/rebac/definitions">Relation Definitions</a>
			<span>/</span>
			<span>{definition?.relation_name || 'Loading...'}</span>
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
						{#if definition.tenant_id !== 'default'}
							<button class="btn btn-secondary" onclick={startEditing}>Edit</button>
						{/if}
						<button
							class="status-badge"
							class:status-active={definition.is_active}
							class:status-inactive={!definition.is_active}
							onclick={toggleActive}
							disabled={saving}
						>
							{definition.is_active ? 'Active' : 'Inactive'}
						</button>
					{/if}
				</div>
			</div>
		{/if}
	</div>

	{#if error}
		<div class="error-banner">
			<span>{error}</span>
			<button onclick={loadDefinition}>Retry</button>
		</div>
	{/if}

	{#if saveError}
		<div class="error-banner">
			<span>{saveError}</span>
			<button onclick={() => (saveError = '')}>Dismiss</button>
		</div>
	{/if}

	{#if loading}
		<div class="loading-state">Loading...</div>
	{:else if definition}
		<div class="content-grid">
			<!-- Main Details -->
			<div class="detail-card">
				<h2>Details</h2>
				{#if isEditing}
					<div class="form-group">
						<label for="edit-description" class="form-label">Description</label>
						<textarea
							id="edit-description"
							class="form-input"
							bind:value={editForm.description}
							placeholder="Optional description..."
							rows="3"
						></textarea>
					</div>

					<div class="form-group">
						<label for="edit-priority" class="form-label">Priority</label>
						<input
							id="edit-priority"
							class="form-input"
							type="number"
							bind:value={editForm.priority}
							min="0"
							max="1000"
						/>
						<p class="form-hint">Higher priority definitions are evaluated first</p>
					</div>

					<div class="form-group">
						<ToggleSwitch
							bind:checked={editForm.is_active}
							label="Active"
							description="Enable this relation definition"
						/>
					</div>

					<div class="form-actions">
						<button class="btn btn-secondary" onclick={cancelEditing}>Cancel</button>
						<button class="btn btn-primary" onclick={saveChanges} disabled={saving}>
							{saving ? 'Saving...' : 'Save Changes'}
						</button>
					</div>
				{:else}
					<div class="info-row">
						<span class="info-label">ID</span>
						<span class="info-value mono">{definition.id}</span>
					</div>
					<div class="info-row">
						<span class="info-label">Object Type</span>
						<span class="info-value">{definition.object_type}</span>
					</div>
					<div class="info-row">
						<span class="info-label">Relation Name</span>
						<span class="info-value mono">{definition.relation_name}</span>
					</div>
					<div class="info-row">
						<span class="info-label">Priority</span>
						<span class="info-value">{definition.priority}</span>
					</div>
					<div class="info-row">
						<span class="info-label">Status</span>
						<span
							class="status-badge"
							class:status-active={definition.is_active}
							class:status-inactive={!definition.is_active}
						>
							{definition.is_active ? 'Active' : 'Inactive'}
						</span>
					</div>
					<div class="info-row">
						<span class="info-label">Source</span>
						<span class="source-badge" class:default={definition.tenant_id === 'default'}>
							{definition.tenant_id === 'default' ? 'Default' : 'Custom'}
						</span>
					</div>
					<div class="info-row">
						<span class="info-label">Created</span>
						<span class="info-value">{formatDate(definition.created_at)}</span>
					</div>
					<div class="info-row">
						<span class="info-label">Updated</span>
						<span class="info-value">{formatDate(definition.updated_at)}</span>
					</div>
				{/if}
			</div>

			<!-- Expression -->
			<div class="detail-card">
				<div class="card-header">
					<h2>Relation Expression</h2>
					<span class="expr-type-badge">{getExpressionTypeLabel(definition.definition.type)}</span>
				</div>

				{#if isEditing && showExpressionEditor}
					<div class="expression-editor">
						<label for="expr-json">Expression JSON</label>
						<textarea id="expr-json" bind:value={expressionJson} rows="12"></textarea>
						{#if expressionError}
							<div class="field-error">{expressionError}</div>
						{/if}
						<small>Edit the JSON structure of the relation expression</small>
					</div>
				{:else if isEditing}
					<button class="btn-edit-expr" onclick={() => (showExpressionEditor = true)}>
						Edit Expression JSON
					</button>
				{/if}

				<div class="expression-display">
					<div class="expression-formula">
						<span class="label">Formula</span>
						<code>{formatRelationExpression(definition.definition)}</code>
					</div>

					<div class="expression-tree">
						<span class="label">Structure</span>
						<pre>{renderExpressionTree(definition.definition)}</pre>
					</div>
				</div>
			</div>

			<!-- Test Panel -->
			<div class="detail-card test-panel">
				<div class="card-header">
					<h2>Test Permission</h2>
					<button class="btn-toggle-panel" onclick={() => (showTestPanel = !showTestPanel)}>
						{showTestPanel ? 'Hide' : 'Show'}
					</button>
				</div>

				{#if showTestPanel}
					<p class="test-description">
						Test if a user would have the <strong>{definition.relation_name}</strong> relation on a
						<strong>{definition.object_type}</strong> object.
					</p>

					<div class="test-form">
						<div class="form-group">
							<label for="test-user" class="form-label">User ID</label>
							<input
								id="test-user"
								type="text"
								class="form-input"
								bind:value={testUserId}
								placeholder="user_123"
							/>
						</div>

						<button class="btn btn-primary" onclick={runTestPermission} disabled={testing}>
							{testing ? 'Testing...' : 'Run Test'}
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
								{testResult.allowed ? '✅ ALLOWED' : '❌ DENIED'}
							</div>
							{#if testResult.resolved_via}
								<div class="result-detail">
									<span class="label">Resolved via:</span>
									<span class="value">{testResult.resolved_via}</span>
								</div>
							{/if}
							{#if testResult.path && testResult.path.length > 0}
								<div class="result-detail">
									<span class="label">Path:</span>
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
			<h3>Expression Types Reference</h3>
			<div class="reference-grid">
				<div class="reference-item">
					<strong>Direct</strong>
					<p>Checks for a direct relationship tuple in the database.</p>
					<code>direct:viewer</code>
				</div>
				<div class="reference-item">
					<strong>Union (OR)</strong>
					<p>User has the relation if ANY child expression is satisfied.</p>
					<code>(viewer OR editor OR owner)</code>
				</div>
				<div class="reference-item">
					<strong>Intersection (AND)</strong>
					<p>User has the relation if ALL child expressions are satisfied.</p>
					<code>(member AND verified)</code>
				</div>
				<div class="reference-item">
					<strong>Exclusion (NOT)</strong>
					<p>User has the relation if base is satisfied but subtract is not.</p>
					<code>(member EXCEPT blocked)</code>
				</div>
				<div class="reference-item">
					<strong>Inherited (Tuple-to-Userset)</strong>
					<p>Inherits relation from a parent object through a relation chain.</p>
					<code>parent→viewer</code>
				</div>
			</div>
		</div>
	{/if}
</div>
