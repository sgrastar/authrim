<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminConsentStatementsAPI,
		type ConsentStatement,
		type ConsentStatementVersion,
		type ConsentStatementLocalization,
		type TenantConsentRequirement
	} from '$lib/api/admin-consent-statements';
	import { adminClientsAPI } from '$lib/api/admin-clients';

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------
	let activeTab = $state<'statements' | 'versions' | 'localizations' | 'requirements'>('statements');
	let loading = $state(true);
	let error = $state('');
	let successMessage = $state('');

	// Statements
	let statements = $state<ConsentStatement[]>([]);
	let selectedStatementId = $state<string | null>(null);
	let showStatementForm = $state(false);
	let statementFormData = $state({
		slug: '',
		category: 'custom' as string,
		legal_basis: 'consent' as string,
		processing_purpose: '',
		display_order: 0
	});
	let editingStatementId = $state<string | null>(null);

	// Versions
	let versions = $state<ConsentStatementVersion[]>([]);
	let showVersionForm = $state(false);
	let versionFormData = $state({
		version: '',
		content_type: 'url' as string,
		effective_at: ''
	});
	let selectedVersionId = $state<string | null>(null);
	let showActivateConfirm = $state(false);
	let activatingVersionId = $state<string | null>(null);

	// Localizations
	let localizations = $state<ConsentStatementLocalization[]>([]);
	let showLocalizationForm = $state(false);
	let localizationFormData = $state({
		language: 'en',
		title: '',
		description: '',
		document_url: '',
		inline_content: ''
	});
	let editingLanguage = $state<string | null>(null);

	// Requirements
	let requirements = $state<TenantConsentRequirement[]>([]);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let _clients = $state<any[]>([]); // OAuth clients for requirement management (future use)
	let showRequirementForm = $state(false);
	let requirementFormData = $state({
		statement_id: '',
		is_required: 1,
		min_version: '',
		enforcement: 'block' as string,
		show_deletion_link: 0,
		deletion_url: '',
		conditional_rules_json: '',
		display_order: 0
	});

	// Derived
	const selectedStatement = $derived(
		statements.find((s) => s.id === selectedStatementId) || null
	);

	const CATEGORIES = [
		'terms_of_service',
		'privacy_policy',
		'cookie_policy',
		'marketing',
		'data_sharing',
		'analytics',
		'do_not_sell',
		'custom'
	];

	const LEGAL_BASES = [
		'consent',
		'legitimate_interest',
		'contract',
		'legal_obligation'
	];

	const VERSION_STATUSES: Record<string, { label: string; color: string }> = {
		draft: { label: 'Draft', color: 'var(--text-muted)' },
		active: { label: 'Active', color: 'var(--success)' },
		archived: { label: 'Archived', color: 'var(--warning)' }
	};

	// ---------------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------------
	onMount(async () => {
		await loadStatements();
	});

	// ---------------------------------------------------------------------------
	// Data Loading
	// ---------------------------------------------------------------------------
	async function loadStatements() {
		loading = true;
		error = '';
		try {
			const result = await adminConsentStatementsAPI.listStatements();
			statements = result.statements || [];
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load statements';
		} finally {
			loading = false;
		}
	}

	async function loadVersions() {
		if (!selectedStatementId) return;
		loading = true;
		error = '';
		try {
			const result = await adminConsentStatementsAPI.listVersions(selectedStatementId);
			versions = result.versions || [];
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load versions';
		} finally {
			loading = false;
		}
	}

	async function loadLocalizations() {
		if (!selectedStatementId || !selectedVersionId) return;
		loading = true;
		error = '';
		try {
			const result = await adminConsentStatementsAPI.listLocalizations(
				selectedStatementId,
				selectedVersionId
			);
			localizations = result.localizations || [];
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load localizations';
		} finally {
			loading = false;
		}
	}

	async function loadRequirements() {
		loading = true;
		error = '';
		try {
			const [reqResult, clientResult] = await Promise.all([
				adminConsentStatementsAPI.listRequirements(),
				adminClientsAPI.list({ limit: 100 })
			]);
			requirements = reqResult.requirements || [];
			_clients = clientResult.clients || [];
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load requirements';
		} finally {
			loading = false;
		}
	}

	// ---------------------------------------------------------------------------
	// Tab Switch
	// ---------------------------------------------------------------------------
	function switchTab(tab: typeof activeTab) {
		activeTab = tab;
		error = '';
		successMessage = '';
		if (tab === 'statements') loadStatements();
		else if (tab === 'versions') loadVersions();
		else if (tab === 'localizations') loadLocalizations();
		else if (tab === 'requirements') loadRequirements();
	}

	// ---------------------------------------------------------------------------
	// Statement Actions
	// ---------------------------------------------------------------------------
	async function saveStatement() {
		error = '';
		try {
			if (editingStatementId) {
				await adminConsentStatementsAPI.updateStatement(editingStatementId, statementFormData);
				successMessage = 'Statement updated successfully';
			} else {
				await adminConsentStatementsAPI.createStatement(statementFormData);
				successMessage = 'Statement created successfully';
			}
			showStatementForm = false;
			editingStatementId = null;
			resetStatementForm();
			await loadStatements();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save statement';
		}
	}

	function editStatement(stmt: ConsentStatement) {
		editingStatementId = stmt.id;
		statementFormData = {
			slug: stmt.slug,
			category: stmt.category,
			legal_basis: stmt.legal_basis,
			processing_purpose: stmt.processing_purpose || '',
			display_order: stmt.display_order
		};
		showStatementForm = true;
	}

	async function toggleStatementActive(stmt: ConsentStatement) {
		try {
			await adminConsentStatementsAPI.updateStatement(stmt.id, {
				is_active: stmt.is_active ? 0 : 1
			});
			await loadStatements();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to update statement';
		}
	}

	async function deleteStatement(stmt: ConsentStatement) {
		if (!confirm(`Delete consent statement "${stmt.slug}"?`)) return;
		try {
			await adminConsentStatementsAPI.deleteStatement(stmt.id);
			successMessage = 'Statement deleted';
			if (selectedStatementId === stmt.id) selectedStatementId = null;
			await loadStatements();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to delete statement';
		}
	}

	function resetStatementForm() {
		statementFormData = {
			slug: '',
			category: 'custom',
			legal_basis: 'consent',
			processing_purpose: '',
			display_order: 0
		};
	}

	function selectStatement(id: string) {
		selectedStatementId = id;
		selectedVersionId = null;
		versions = [];
		localizations = [];
	}

	// ---------------------------------------------------------------------------
	// Version Actions
	// ---------------------------------------------------------------------------
	async function saveVersion() {
		if (!selectedStatementId) return;
		error = '';
		try {
			await adminConsentStatementsAPI.createVersion(selectedStatementId, {
				version: versionFormData.version,
				content_type: versionFormData.content_type,
				effective_at: new Date(versionFormData.effective_at).getTime()
			});
			successMessage = 'Version created successfully';
			showVersionForm = false;
			versionFormData = { version: '', content_type: 'url', effective_at: '' };
			await loadVersions();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save version';
		}
	}

	function confirmActivate(versionId: string) {
		activatingVersionId = versionId;
		showActivateConfirm = true;
	}

	async function activateVersion() {
		if (!selectedStatementId || !activatingVersionId) return;
		error = '';
		try {
			await adminConsentStatementsAPI.activateVersion(selectedStatementId, activatingVersionId);
			successMessage = 'Version activated successfully';
			showActivateConfirm = false;
			activatingVersionId = null;
			await loadVersions();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to activate version';
		}
	}

	function closeOnBackdropKeydown(event: KeyboardEvent, close: () => void) {
		if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			close();
		}
	}

	async function deleteVersion(versionId: string) {
		if (!selectedStatementId) return;
		if (!confirm('Delete this draft version?')) return;
		try {
			await adminConsentStatementsAPI.deleteVersion(selectedStatementId, versionId);
			successMessage = 'Version deleted';
			if (selectedVersionId === versionId) selectedVersionId = null;
			await loadVersions();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to delete version';
		}
	}

	function selectVersion(id: string) {
		selectedVersionId = id;
		localizations = [];
	}

	// ---------------------------------------------------------------------------
	// Localization Actions
	// ---------------------------------------------------------------------------
	async function saveLocalization() {
		if (!selectedStatementId || !selectedVersionId) return;
		error = '';
		try {
			await adminConsentStatementsAPI.upsertLocalization(
				selectedStatementId,
				selectedVersionId,
				localizationFormData.language,
				{
					title: localizationFormData.title,
					description: localizationFormData.description,
					document_url: localizationFormData.document_url || undefined,
					inline_content: localizationFormData.inline_content || undefined
				}
			);
			successMessage = editingLanguage ? 'Localization updated' : 'Localization created';
			showLocalizationForm = false;
			editingLanguage = null;
			resetLocalizationForm();
			await loadLocalizations();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save localization';
		}
	}

	function editLocalization(loc: ConsentStatementLocalization) {
		editingLanguage = loc.language;
		localizationFormData = {
			language: loc.language,
			title: loc.title,
			description: loc.description,
			document_url: loc.document_url || '',
			inline_content: loc.inline_content || ''
		};
		showLocalizationForm = true;
	}

	async function deleteLocalization(lang: string) {
		if (!selectedStatementId || !selectedVersionId) return;
		if (!confirm(`Delete "${lang}" localization?`)) return;
		try {
			await adminConsentStatementsAPI.deleteLocalization(
				selectedStatementId,
				selectedVersionId,
				lang
			);
			successMessage = 'Localization deleted';
			await loadLocalizations();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to delete localization';
		}
	}

	function resetLocalizationForm() {
		localizationFormData = {
			language: 'en',
			title: '',
			description: '',
			document_url: '',
			inline_content: ''
		};
	}

	// ---------------------------------------------------------------------------
	// Requirement Actions
	// ---------------------------------------------------------------------------
	async function saveRequirement() {
		error = '';
		try {
			await adminConsentStatementsAPI.upsertRequirement(requirementFormData.statement_id, {
				is_required: requirementFormData.is_required,
				min_version: requirementFormData.min_version || undefined,
				enforcement: requirementFormData.enforcement,
				show_deletion_link: requirementFormData.show_deletion_link,
				deletion_url: requirementFormData.deletion_url || undefined,
				conditional_rules_json: requirementFormData.conditional_rules_json || undefined,
				display_order: requirementFormData.display_order
			});
			successMessage = 'Requirement saved successfully';
			showRequirementForm = false;
			resetRequirementForm();
			await loadRequirements();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save requirement';
		}
	}

	function editRequirement(req: TenantConsentRequirement) {
		requirementFormData = {
			statement_id: req.statement_id,
			is_required: req.is_required,
			min_version: req.min_version || '',
			enforcement: req.enforcement,
			show_deletion_link: req.show_deletion_link,
			deletion_url: req.deletion_url || '',
			conditional_rules_json: req.conditional_rules_json || '',
			display_order: req.display_order
		};
		showRequirementForm = true;
	}

	async function deleteRequirement(statementId: string) {
		if (!confirm('Remove this requirement?')) return;
		try {
			await adminConsentStatementsAPI.deleteRequirement(statementId);
			successMessage = 'Requirement removed';
			await loadRequirements();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to delete requirement';
		}
	}

	function resetRequirementForm() {
		requirementFormData = {
			statement_id: '',
			is_required: 1,
			min_version: '',
			enforcement: 'block',
			show_deletion_link: 0,
			deletion_url: '',
			conditional_rules_json: '',
			display_order: 0
		};
	}

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------
	function formatDate(ts: number): string {
		return new Date(ts).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function getCategoryBadgeColor(category: string): string {
		const colors: Record<string, string> = {
			terms_of_service: '#6366f1',
			privacy_policy: '#8b5cf6',
			cookie_policy: '#f59e0b',
			marketing: '#10b981',
			data_sharing: '#3b82f6',
			analytics: '#06b6d4',
			do_not_sell: '#ef4444',
			custom: '#6b7280'
		};
		return colors[category] || colors.custom;
	}

	function getStatementSlug(id: string): string {
		return statements.find((s) => s.id === id)?.slug || id;
	}
</script>

<div class="admin-page">
	<div class="admin-page__header">
		<h1 class="admin-page__title">Consent Statement Management</h1>
		<p class="admin-page__subtitle">
			Manage consent items, versions, localizations, and requirements
		</p>
	</div>

	<!-- Messages -->
	{#if error}
		<div class="admin-alert admin-alert--error mb-4">
			<span>{error}</span>
			<button onclick={() => (error = '')}>x</button>
		</div>
	{/if}
	{#if successMessage}
		<div class="admin-alert admin-alert--success mb-4">
			<span>{successMessage}</span>
			<button onclick={() => (successMessage = '')}>x</button>
		</div>
	{/if}

	<!-- Tab Navigation -->
	<div class="admin-tabs mb-6">
		<button
			class="admin-tab"
			class:admin-tab--active={activeTab === 'statements'}
			onclick={() => switchTab('statements')}
		>
			Statements
		</button>
		<button
			class="admin-tab"
			class:admin-tab--active={activeTab === 'versions'}
			onclick={() => switchTab('versions')}
			disabled={!selectedStatementId}
		>
			Versions {selectedStatement ? `(${selectedStatement.slug})` : ''}
		</button>
		<button
			class="admin-tab"
			class:admin-tab--active={activeTab === 'localizations'}
			onclick={() => switchTab('localizations')}
			disabled={!selectedVersionId}
		>
			Localizations
		</button>
		<button
			class="admin-tab"
			class:admin-tab--active={activeTab === 'requirements'}
			onclick={() => switchTab('requirements')}
		>
			Requirements
		</button>
	</div>

	<!-- Tab Content -->
	{#if loading}
		<div class="admin-loading">Loading...</div>
	{:else if activeTab === 'statements'}
		<!-- ===== STATEMENTS TAB ===== -->
		<div class="admin-section">
			<div class="admin-section__header">
				<h2>Consent Statements</h2>
				<button
					class="admin-btn admin-btn--primary"
					onclick={() => {
						editingStatementId = null;
						resetStatementForm();
						showStatementForm = true;
					}}
				>
					+ New Statement
				</button>
			</div>

			{#if showStatementForm}
				<div class="admin-form-card mb-4">
					<h3 class="admin-form-card__title">
						{editingStatementId ? 'Edit Statement' : 'New Statement'}
					</h3>
					<div class="admin-form-grid">
						<div class="admin-form-group">
							<label for="stmt-slug">Slug</label>
							<input
								id="stmt-slug"
								type="text"
								class="admin-input"
								bind:value={statementFormData.slug}
								placeholder="e.g., marketing_emails"
							/>
						</div>
						<div class="admin-form-group">
							<label for="stmt-category">Category</label>
							<select
								id="stmt-category"
								class="admin-input"
								bind:value={statementFormData.category}
							>
								{#each CATEGORIES as cat (cat)}
									<option value={cat}>{cat.replace(/_/g, ' ')}</option>
								{/each}
							</select>
						</div>
						<div class="admin-form-group">
							<label for="stmt-legal-basis">Legal Basis</label>
							<select
								id="stmt-legal-basis"
								class="admin-input"
								bind:value={statementFormData.legal_basis}
							>
								{#each LEGAL_BASES as basis (basis)}
									<option value={basis}>{basis.replace(/_/g, ' ')}</option>
								{/each}
							</select>
						</div>
						<div class="admin-form-group">
							<label for="stmt-order">Display Order</label>
							<input
								id="stmt-order"
								type="number"
								class="admin-input"
								bind:value={statementFormData.display_order}
							/>
						</div>
						<div class="admin-form-group" style="grid-column: 1 / -1;">
							<label for="stmt-purpose">Processing Purpose</label>
							<textarea
								id="stmt-purpose"
								class="admin-input"
								bind:value={statementFormData.processing_purpose}
								rows="2"
								placeholder="GDPR Art13/14: Data processing purpose description"
							></textarea>
						</div>
					</div>
					<div class="admin-form-actions">
						<button
							class="admin-btn admin-btn--secondary"
							onclick={() => {
								showStatementForm = false;
								editingStatementId = null;
							}}
						>
							Cancel
						</button>
						<button class="admin-btn admin-btn--primary" onclick={saveStatement}>
							{editingStatementId ? 'Update' : 'Create'}
						</button>
					</div>
				</div>
			{/if}

			<div class="admin-table-container">
				<table class="admin-table">
					<thead>
						<tr>
							<th>Slug</th>
							<th>Category</th>
							<th>Legal Basis</th>
							<th>Order</th>
							<th>Active</th>
							<th>Created</th>
							<th>Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each statements as stmt (stmt.id)}
							<tr
								class:admin-table__row--selected={selectedStatementId === stmt.id}
								onclick={() => selectStatement(stmt.id)}
								style="cursor: pointer;"
							>
								<td>
									<code class="text-sm">{stmt.slug}</code>
								</td>
								<td>
									<span
										class="admin-badge"
										style="background: {getCategoryBadgeColor(stmt.category)}20; color: {getCategoryBadgeColor(stmt.category)};"
									>
										{stmt.category.replace(/_/g, ' ')}
									</span>
								</td>
								<td class="text-sm">{stmt.legal_basis.replace(/_/g, ' ')}</td>
								<td class="text-sm">{stmt.display_order}</td>
								<td>
									<button
										class="admin-badge"
										style="background: {stmt.is_active ? 'var(--success)' : 'var(--text-muted)'}20; color: {stmt.is_active ? 'var(--success)' : 'var(--text-muted)'}; cursor: pointer;"
										onclick={(e) => { e.stopPropagation(); toggleStatementActive(stmt); }}
									>
										{stmt.is_active ? 'Active' : 'Inactive'}
									</button>
								</td>
								<td class="text-sm">{formatDate(stmt.created_at)}</td>
								<td>
									<div class="admin-actions-cell">
										<button
											class="admin-btn admin-btn--ghost admin-btn--sm"
											onclick={(e) => { e.stopPropagation(); editStatement(stmt); }}
										>
											Edit
										</button>
										<button
											class="admin-btn admin-btn--ghost admin-btn--sm admin-btn--danger"
											onclick={(e) => { e.stopPropagation(); deleteStatement(stmt); }}
										>
											Delete
										</button>
									</div>
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="7" class="text-center text-sm" style="color: var(--text-muted);">
									No consent statements yet. Create one to get started.
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			{#if selectedStatementId}
				<p class="mt-3 text-sm" style="color: var(--text-secondary);">
					Selected: <strong>{selectedStatement?.slug}</strong> — Switch to Versions tab to manage versions.
				</p>
			{/if}
		</div>
	{:else if activeTab === 'versions'}
		<!-- ===== VERSIONS TAB ===== -->
		<div class="admin-section">
			<div class="admin-section__header">
				<h2>Versions — {selectedStatement?.slug}</h2>
				<button
					class="admin-btn admin-btn--primary"
					onclick={() => (showVersionForm = true)}
				>
					+ New Version
				</button>
			</div>

			{#if showVersionForm}
				<div class="admin-form-card mb-4">
					<h3 class="admin-form-card__title">New Version</h3>
					<div class="admin-form-grid">
						<div class="admin-form-group">
							<label for="ver-version">Version (YYYYMMDD)</label>
							<input
								id="ver-version"
								type="text"
								class="admin-input"
								bind:value={versionFormData.version}
								placeholder="20250206"
								maxlength="8"
								pattern="\d{8}"
							/>
						</div>
						<div class="admin-form-group">
							<label for="ver-content-type">Content Type</label>
							<select
								id="ver-content-type"
								class="admin-input"
								bind:value={versionFormData.content_type}
							>
								<option value="url">URL (external document)</option>
								<option value="inline">Inline (text content)</option>
							</select>
						</div>
						<div class="admin-form-group">
							<label for="ver-effective">Effective Date</label>
							<input
								id="ver-effective"
								type="date"
								class="admin-input"
								bind:value={versionFormData.effective_at}
							/>
						</div>
					</div>
					<div class="admin-form-actions">
						<button
							class="admin-btn admin-btn--secondary"
							onclick={() => (showVersionForm = false)}
						>
							Cancel
						</button>
						<button class="admin-btn admin-btn--primary" onclick={saveVersion}>
							Create
						</button>
					</div>
				</div>
			{/if}

			<div class="admin-table-container">
				<table class="admin-table">
					<thead>
						<tr>
							<th>Version</th>
							<th>Content Type</th>
							<th>Status</th>
							<th>Effective</th>
							<th>Hash</th>
							<th>Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each versions as ver (ver.id)}
							{@const statusInfo = VERSION_STATUSES[ver.status] || VERSION_STATUSES.draft}
							<tr
								class:admin-table__row--selected={selectedVersionId === ver.id}
								onclick={() => selectVersion(ver.id)}
								style="cursor: pointer;"
							>
								<td>
									<code class="text-sm">{ver.version}</code>
									{#if ver.is_current}
										<span class="admin-badge" style="background: var(--success)20; color: var(--success); margin-left: 4px;">
											current
										</span>
									{/if}
								</td>
								<td class="text-sm">{ver.content_type}</td>
								<td>
									<span
										class="admin-badge"
										style="background: {statusInfo.color}20; color: {statusInfo.color};"
									>
										{statusInfo.label}
									</span>
								</td>
								<td class="text-sm">{formatDate(ver.effective_at)}</td>
								<td class="text-sm">
									{ver.content_hash ? ver.content_hash.slice(0, 8) + '...' : '-'}
								</td>
								<td>
									<div class="admin-actions-cell">
										{#if ver.status === 'draft'}
											<button
												class="admin-btn admin-btn--ghost admin-btn--sm"
												style="color: var(--success);"
												onclick={(e) => { e.stopPropagation(); confirmActivate(ver.id); }}
											>
												Activate
											</button>
											<button
												class="admin-btn admin-btn--ghost admin-btn--sm admin-btn--danger"
												onclick={(e) => { e.stopPropagation(); deleteVersion(ver.id); }}
											>
												Delete
											</button>
										{/if}
									</div>
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="6" class="text-center text-sm" style="color: var(--text-muted);">
									No versions yet. Create a version for this statement.
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			{#if selectedVersionId}
				<p class="mt-3 text-sm" style="color: var(--text-secondary);">
					Selected version — Switch to Localizations tab to manage translations.
				</p>
			{/if}
		</div>

			<!-- Activate Confirmation Modal -->
			{#if showActivateConfirm}
				<div
					class="admin-modal-overlay"
					role="button"
					tabindex="0"
					aria-label="Close activate version dialog"
					onclick={(event) => {
						if (event.target === event.currentTarget) {
							showActivateConfirm = false;
						}
					}}
					onkeydown={(event) =>
						closeOnBackdropKeydown(event, () => (showActivateConfirm = false))}
				>
					<div class="admin-modal" role="dialog" aria-modal="true">
						<h3 class="admin-modal__title">Activate Version</h3>
					<p class="admin-modal__text">
						Activating this version may require existing users to re-consent.
						This action has legal implications. Are you sure?
					</p>
					<div class="admin-modal__actions">
						<button
							class="admin-btn admin-btn--secondary"
							onclick={() => (showActivateConfirm = false)}
						>
							Cancel
						</button>
						<button class="admin-btn admin-btn--primary" onclick={activateVersion}>
							Activate
						</button>
					</div>
				</div>
			</div>
		{/if}
	{:else if activeTab === 'localizations'}
		<!-- ===== LOCALIZATIONS TAB ===== -->
		<div class="admin-section">
			<div class="admin-section__header">
				<h2>Localizations</h2>
				<button
					class="admin-btn admin-btn--primary"
					onclick={() => {
						editingLanguage = null;
						resetLocalizationForm();
						showLocalizationForm = true;
					}}
				>
					+ Add Language
				</button>
			</div>

			{#if showLocalizationForm}
				<div class="admin-form-card mb-4">
					<h3 class="admin-form-card__title">
						{editingLanguage ? `Edit: ${editingLanguage}` : 'New Localization'}
					</h3>
					<div class="admin-form-grid">
						<div class="admin-form-group">
							<label for="loc-lang">Language (BCP 47)</label>
							<input
								id="loc-lang"
								type="text"
								class="admin-input"
								bind:value={localizationFormData.language}
								placeholder="en"
								disabled={!!editingLanguage}
							/>
						</div>
						<div class="admin-form-group">
							<label for="loc-title">Title</label>
							<input
								id="loc-title"
								type="text"
								class="admin-input"
								bind:value={localizationFormData.title}
								placeholder="Consent title"
							/>
						</div>
						<div class="admin-form-group" style="grid-column: 1 / -1;">
							<label for="loc-desc">Description</label>
							<textarea
								id="loc-desc"
								class="admin-input"
								bind:value={localizationFormData.description}
								rows="2"
								placeholder="Short description for consent screen"
							></textarea>
						</div>
						<div class="admin-form-group">
							<label for="loc-url">Document URL</label>
							<input
								id="loc-url"
								type="url"
								class="admin-input"
								bind:value={localizationFormData.document_url}
								placeholder="https://example.com/policy.html"
							/>
						</div>
						<div class="admin-form-group" style="grid-column: 1 / -1;">
							<label for="loc-inline">Inline Content</label>
							<textarea
								id="loc-inline"
								class="admin-input"
								bind:value={localizationFormData.inline_content}
								rows="4"
								placeholder="Full text content (when content_type is inline)"
							></textarea>
						</div>
					</div>
					<div class="admin-form-actions">
						<button
							class="admin-btn admin-btn--secondary"
							onclick={() => {
								showLocalizationForm = false;
								editingLanguage = null;
							}}
						>
							Cancel
						</button>
						<button class="admin-btn admin-btn--primary" onclick={saveLocalization}>
							{editingLanguage ? 'Update' : 'Create'}
						</button>
					</div>
				</div>
			{/if}

			<div class="admin-table-container">
				<table class="admin-table">
					<thead>
						<tr>
							<th>Language</th>
							<th>Title</th>
							<th>Description</th>
							<th>URL</th>
							<th>Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each localizations as loc (loc.id)}
							<tr>
								<td>
									<code class="text-sm">{loc.language}</code>
								</td>
								<td class="text-sm">{loc.title}</td>
								<td class="text-sm" style="max-width: 200px; overflow: hidden; text-overflow: ellipsis;">
									{loc.description}
								</td>
								<td class="text-sm">
									{#if loc.document_url}
										<a href={loc.document_url} target="_blank" rel="noopener noreferrer"
											style="color: var(--primary);">
											Link
										</a>
									{:else}
										-
									{/if}
								</td>
								<td>
									<div class="admin-actions-cell">
										<button
											class="admin-btn admin-btn--ghost admin-btn--sm"
											onclick={() => editLocalization(loc)}
										>
											Edit
										</button>
										<button
											class="admin-btn admin-btn--ghost admin-btn--sm admin-btn--danger"
											onclick={() => deleteLocalization(loc.language)}
										>
											Delete
										</button>
									</div>
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="5" class="text-center text-sm" style="color: var(--text-muted);">
									No localizations yet. Add at least one language before activating the version.
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{:else if activeTab === 'requirements'}
		<!-- ===== REQUIREMENTS TAB ===== -->
		<div class="admin-section">
			<div class="admin-section__header">
				<h2>Tenant Consent Requirements</h2>
				<button
					class="admin-btn admin-btn--primary"
					onclick={() => {
						resetRequirementForm();
						showRequirementForm = true;
					}}
				>
					+ Add Requirement
				</button>
			</div>

			{#if showRequirementForm}
				<div class="admin-form-card mb-4">
					<h3 class="admin-form-card__title">
						{requirementFormData.statement_id ? 'Edit Requirement' : 'New Requirement'}
					</h3>
					<div class="admin-form-grid">
						<div class="admin-form-group">
							<label for="req-statement">Statement</label>
							<select
								id="req-statement"
								class="admin-input"
								bind:value={requirementFormData.statement_id}
							>
								<option value="">-- Select --</option>
								{#each statements as stmt (stmt.id)}
									<option value={stmt.id}>{stmt.slug}</option>
								{/each}
							</select>
						</div>
						<div class="admin-form-group">
							<label for="req-required">Required</label>
							<select
								id="req-required"
								class="admin-input"
								value={requirementFormData.is_required}
							onchange={(e) => {
								requirementFormData.is_required = parseInt((e.currentTarget as HTMLSelectElement).value);
							}}
							>
								<option value={1}>Required</option>
								<option value={0}>Optional</option>
							</select>
						</div>
						<div class="admin-form-group">
							<label for="req-enforcement">Enforcement</label>
							<select
								id="req-enforcement"
								class="admin-input"
								bind:value={requirementFormData.enforcement}
							>
								<option value="block">Block (must consent)</option>
								<option value="allow_continue">Allow Continue</option>
							</select>
						</div>
						<div class="admin-form-group">
							<label for="req-min-version">Min Version (YYYYMMDD)</label>
							<input
								id="req-min-version"
								type="text"
								class="admin-input"
								bind:value={requirementFormData.min_version}
								placeholder="20250206"
								maxlength="8"
							/>
						</div>
						<div class="admin-form-group">
							<label for="req-order">Display Order</label>
							<input
								id="req-order"
								type="number"
								class="admin-input"
								bind:value={requirementFormData.display_order}
							/>
						</div>
						<div class="admin-form-group">
							<label for="req-deletion">
								<input
									id="req-deletion"
									type="checkbox"
									checked={requirementFormData.show_deletion_link === 1}
							onchange={(e) => {
								requirementFormData.show_deletion_link = (e.currentTarget as HTMLInputElement).checked ? 1 : 0;
							}}
								/>
								Show Deletion Link
							</label>
						</div>
						{#if requirementFormData.show_deletion_link}
							<div class="admin-form-group">
								<label for="req-deletion-url">Deletion URL</label>
								<input
									id="req-deletion-url"
									type="url"
									class="admin-input"
									bind:value={requirementFormData.deletion_url}
									placeholder="https://example.com/delete-account"
								/>
							</div>
						{/if}
						<div class="admin-form-group" style="grid-column: 1 / -1;">
							<label for="req-rules">Conditional Rules (JSON)</label>
							<textarea
								id="req-rules"
								class="admin-input"
								bind:value={requirementFormData.conditional_rules_json}
								rows="3"
								placeholder={'[{"claim": "address.country", "op": "in", "value": ["DE"], "result": "required"}]'}
							></textarea>
						</div>
					</div>
					<div class="admin-form-actions">
						<button
							class="admin-btn admin-btn--secondary"
							onclick={() => (showRequirementForm = false)}
						>
							Cancel
						</button>
						<button class="admin-btn admin-btn--primary" onclick={saveRequirement}>
							Save
						</button>
					</div>
				</div>
			{/if}

			<div class="admin-table-container">
				<table class="admin-table">
					<thead>
						<tr>
							<th>Statement</th>
							<th>Required</th>
							<th>Enforcement</th>
							<th>Min Version</th>
							<th>Order</th>
							<th>Actions</th>
						</tr>
					</thead>
					<tbody>
						{#each requirements as req (req.id)}
							<tr>
								<td>
									<code class="text-sm">{getStatementSlug(req.statement_id)}</code>
								</td>
								<td>
									<span
										class="admin-badge"
										style="background: {req.is_required ? 'var(--danger)' : 'var(--text-muted)'}20; color: {req.is_required ? 'var(--danger)' : 'var(--text-muted)'};"
									>
										{req.is_required ? 'Required' : 'Optional'}
									</span>
								</td>
								<td class="text-sm">{req.enforcement}</td>
								<td class="text-sm">{req.min_version || '-'}</td>
								<td class="text-sm">{req.display_order}</td>
								<td>
									<div class="admin-actions-cell">
										<button
											class="admin-btn admin-btn--ghost admin-btn--sm"
											onclick={() => editRequirement(req)}
										>
											Edit
										</button>
										<button
											class="admin-btn admin-btn--ghost admin-btn--sm admin-btn--danger"
											onclick={() => deleteRequirement(req.statement_id)}
										>
											Delete
										</button>
									</div>
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="6" class="text-center text-sm" style="color: var(--text-muted);">
									No requirements configured. Add one to enforce consent on login.
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</div>

<style>
	.admin-page {
		max-width: 1200px;
		margin: 0 auto;
		padding: 24px;
	}

	.admin-page__header {
		margin-bottom: 24px;
	}

	.admin-page__title {
		font-size: 1.5rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.admin-page__subtitle {
		font-size: 0.875rem;
		color: var(--text-secondary);
		margin-top: 4px;
	}

	.admin-tabs {
		display: flex;
		gap: 4px;
		border-bottom: 1px solid var(--border);
		padding-bottom: 0;
	}

	.admin-tab {
		padding: 8px 16px;
		font-size: 0.875rem;
		color: var(--text-secondary);
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		cursor: pointer;
		transition: all 0.15s;
	}

	.admin-tab:hover:not(:disabled) {
		color: var(--text-primary);
	}

	.admin-tab--active {
		color: var(--primary);
		border-bottom-color: var(--primary);
		font-weight: 500;
	}

	.admin-tab:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.admin-section {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 20px;
	}

	.admin-section__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 16px;
	}

	.admin-section__header h2 {
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.admin-alert {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px;
		border-radius: 8px;
		font-size: 0.875rem;
	}

	.admin-alert--error {
		background: var(--danger-light, #fef2f2);
		color: var(--danger);
	}

	.admin-alert--success {
		background: var(--success-light, #f0fdf4);
		color: var(--success);
	}

	.admin-alert button {
		background: none;
		border: none;
		cursor: pointer;
		font-size: 1rem;
		color: inherit;
		opacity: 0.7;
	}

	.admin-form-card {
		background: var(--surface-secondary, #f9fafb);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 16px;
	}

	.admin-form-card__title {
		font-size: 0.875rem;
		font-weight: 600;
		margin-bottom: 12px;
		color: var(--text-primary);
	}

	.admin-form-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}

	.admin-form-group {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.admin-form-group label {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--text-secondary);
	}

	.admin-input {
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		font-size: 0.875rem;
		background: var(--surface);
		color: var(--text-primary);
	}

	.admin-input:focus {
		outline: none;
		border-color: var(--primary);
		box-shadow: 0 0 0 2px var(--primary-light, rgba(59, 130, 246, 0.15));
	}

	textarea.admin-input {
		resize: vertical;
	}

	.admin-form-actions {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
		margin-top: 12px;
	}

	.admin-btn {
		padding: 6px 14px;
		border-radius: 6px;
		font-size: 0.813rem;
		font-weight: 500;
		cursor: pointer;
		border: 1px solid transparent;
		transition: all 0.15s;
	}

	.admin-btn--primary {
		background: var(--primary);
		color: white;
	}

	.admin-btn--primary:hover {
		opacity: 0.9;
	}

	.admin-btn--secondary {
		background: var(--surface);
		border-color: var(--border);
		color: var(--text-primary);
	}

	.admin-btn--ghost {
		background: none;
		color: var(--primary);
		padding: 4px 8px;
	}

	.admin-btn--ghost:hover {
		background: var(--primary-light, rgba(59, 130, 246, 0.1));
	}

	.admin-btn--sm {
		font-size: 0.75rem;
		padding: 2px 8px;
	}

	.admin-btn--danger {
		color: var(--danger);
	}

	.admin-btn--danger:hover {
		background: var(--danger-light, rgba(239, 68, 68, 0.1));
	}

	.admin-table-container {
		overflow-x: auto;
	}

	.admin-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
	}

	.admin-table th {
		text-align: left;
		padding: 8px 12px;
		font-weight: 500;
		color: var(--text-secondary);
		border-bottom: 1px solid var(--border);
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.admin-table td {
		padding: 10px 12px;
		border-bottom: 1px solid var(--border);
		color: var(--text-primary);
	}

	.admin-table tbody tr:hover {
		background: var(--surface-secondary, #f9fafb);
	}

	:global(.admin-table__row--selected) {
		background: var(--primary-light, rgba(59, 130, 246, 0.08)) !important;
	}

	.admin-badge {
		display: inline-block;
		padding: 2px 8px;
		border-radius: 12px;
		font-size: 0.75rem;
		font-weight: 500;
		border: none;
	}

	.admin-actions-cell {
		display: flex;
		gap: 4px;
	}

	.admin-loading {
		text-align: center;
		padding: 48px;
		color: var(--text-muted);
	}

	.admin-modal-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}

	.admin-modal {
		background: var(--surface);
		border-radius: 12px;
		padding: 24px;
		max-width: 480px;
		width: 90%;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
	}

	.admin-modal__title {
		font-size: 1.125rem;
		font-weight: 600;
		margin-bottom: 8px;
		color: var(--text-primary);
	}

	.admin-modal__text {
		font-size: 0.875rem;
		color: var(--text-secondary);
		margin-bottom: 20px;
		line-height: 1.5;
	}

	.admin-modal__actions {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
	}
</style>
