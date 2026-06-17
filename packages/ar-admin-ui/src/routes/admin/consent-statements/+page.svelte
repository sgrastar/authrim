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
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminTabs,
		type AdminTabItem
	} from '$lib/components/admin';
	import { LL } from '$i18n/i18n-svelte';

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------
	let activeTab = $state<'statements' | 'versions' | 'localizations' | 'requirements'>(
		'statements'
	);
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
	const selectedStatement = $derived(statements.find((s) => s.id === selectedStatementId) || null);
	const consentTabs = $derived<AdminTabItem[]>([
		{
			id: 'statements',
			label: $LL.admin_consent_statements_tab_statements(),
			panelId: 'consent-statements-panel'
		},
		{
			id: 'versions',
			label: selectedStatement
				? `${$LL.admin_consent_statements_tab_versions()} (${selectedStatement.slug})`
				: $LL.admin_consent_statements_tab_versions(),
			panelId: 'consent-versions-panel',
			disabled: !selectedStatementId
		},
		{
			id: 'localizations',
			label: $LL.admin_consent_statements_tab_localizations(),
			panelId: 'consent-localizations-panel',
			disabled: !selectedVersionId
		},
		{
			id: 'requirements',
			label: $LL.admin_consent_statements_tab_requirements(),
			panelId: 'consent-requirements-panel'
		}
	]);

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

	const LEGAL_BASES = ['consent', 'legitimate_interest', 'contract', 'legal_obligation'];

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
			error = err instanceof Error ? err.message : $LL.admin_consent_statements_error_load();
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
			error = err instanceof Error ? err.message : $LL.admin_consent_versions_error_load();
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
			error = err instanceof Error ? err.message : $LL.admin_consent_localizations_error_load();
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
			error = err instanceof Error ? err.message : $LL.admin_consent_requirements_error_load();
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

	function handleTabChange(tab: string) {
		if (
			tab === 'statements' ||
			tab === 'versions' ||
			tab === 'localizations' ||
			tab === 'requirements'
		) {
			switchTab(tab);
		}
	}

	// ---------------------------------------------------------------------------
	// Statement Actions
	// ---------------------------------------------------------------------------
	async function saveStatement() {
		error = '';
		try {
			if (editingStatementId) {
				await adminConsentStatementsAPI.updateStatement(editingStatementId, statementFormData);
				successMessage = $LL.admin_consent_statements_updated_success();
			} else {
				await adminConsentStatementsAPI.createStatement(statementFormData);
				successMessage = $LL.admin_consent_statements_created_success();
			}
			showStatementForm = false;
			editingStatementId = null;
			resetStatementForm();
			await loadStatements();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_statements_error_save();
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
			error = err instanceof Error ? err.message : $LL.admin_consent_statements_error_update();
		}
	}

	async function deleteStatement(stmt: ConsentStatement) {
		if (!confirm($LL.admin_consent_statements_delete_confirm({ slug: stmt.slug }))) return;
		try {
			await adminConsentStatementsAPI.deleteStatement(stmt.id);
			successMessage = $LL.admin_consent_statements_deleted_success();
			if (selectedStatementId === stmt.id) selectedStatementId = null;
			await loadStatements();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_statements_error_delete();
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
			successMessage = $LL.admin_consent_versions_created_success();
			showVersionForm = false;
			versionFormData = { version: '', content_type: 'url', effective_at: '' };
			await loadVersions();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_versions_error_save();
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
			successMessage = $LL.admin_consent_versions_activated_success();
			showActivateConfirm = false;
			activatingVersionId = null;
			await loadVersions();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_versions_error_activate();
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
		if (!confirm($LL.admin_consent_versions_delete_confirm())) return;
		try {
			await adminConsentStatementsAPI.deleteVersion(selectedStatementId, versionId);
			successMessage = $LL.admin_consent_versions_deleted_success();
			if (selectedVersionId === versionId) selectedVersionId = null;
			await loadVersions();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_versions_error_delete();
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
			successMessage = editingLanguage
				? $LL.admin_consent_localizations_updated_success()
				: $LL.admin_consent_localizations_created_success();
			showLocalizationForm = false;
			editingLanguage = null;
			resetLocalizationForm();
			await loadLocalizations();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_localizations_error_save();
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
		if (!confirm($LL.admin_consent_localizations_delete_confirm({ language: lang }))) return;
		try {
			await adminConsentStatementsAPI.deleteLocalization(
				selectedStatementId,
				selectedVersionId,
				lang
			);
			successMessage = $LL.admin_consent_localizations_deleted_success();
			await loadLocalizations();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_localizations_error_delete();
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
			successMessage = $LL.admin_consent_requirements_saved_success();
			showRequirementForm = false;
			resetRequirementForm();
			await loadRequirements();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_requirements_error_save();
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
		if (!confirm($LL.admin_consent_requirements_delete_confirm())) return;
		try {
			await adminConsentStatementsAPI.deleteRequirement(statementId);
			successMessage = $LL.admin_consent_requirements_deleted_success();
			await loadRequirements();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_requirements_error_delete();
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

	function getCategoryLabel(category: string): string {
		switch (category) {
			case 'terms_of_service':
				return $LL.admin_consent_category_terms_of_service();
			case 'privacy_policy':
				return $LL.admin_consent_category_privacy_policy();
			case 'cookie_policy':
				return $LL.admin_consent_category_cookie_policy();
			case 'marketing':
				return $LL.admin_consent_category_marketing();
			case 'data_sharing':
				return $LL.admin_consent_category_data_sharing();
			case 'analytics':
				return $LL.admin_consent_category_analytics();
			case 'do_not_sell':
				return $LL.admin_consent_category_do_not_sell();
			default:
				return $LL.admin_consent_category_custom();
		}
	}

	function getLegalBasisLabel(legalBasis: string): string {
		switch (legalBasis) {
			case 'consent':
				return $LL.admin_consent_legal_basis_consent();
			case 'legitimate_interest':
				return $LL.admin_consent_legal_basis_legitimate_interest();
			case 'contract':
				return $LL.admin_consent_legal_basis_contract();
			case 'legal_obligation':
				return $LL.admin_consent_legal_basis_legal_obligation();
			default:
				return legalBasis;
		}
	}

	function getVersionStatusLabel(status: string): string {
		switch (status) {
			case 'active':
				return $LL.admin_consent_versions_status_active();
			case 'archived':
				return $LL.admin_consent_versions_status_archived();
			default:
				return $LL.admin_consent_versions_status_draft();
		}
	}

	function getEnforcementLabel(enforcement: string): string {
		if (enforcement === 'allow_continue') {
			return $LL.admin_consent_requirements_enforcement_allow_continue();
		}
		return $LL.admin_consent_requirements_enforcement_block();
	}

	function getStatementSlug(id: string): string {
		return statements.find((s) => s.id === id)?.slug || id;
	}
</script>

<svelte:head>
	<title>{$LL.admin_consent_statements_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_consent_statements_title()}
		description={$LL.admin_consent_statements_subtitle()}
	/>

	<!-- Messages -->
	{#if error}
		<div class="admin-alert admin-alert--error admin-alert--stacked">
			<span>{error}</span>
			<button onclick={() => (error = '')}>x</button>
		</div>
	{/if}
	{#if successMessage}
		<div class="admin-alert admin-alert--success admin-alert--stacked">
			<span>{successMessage}</span>
			<button onclick={() => (successMessage = '')}>x</button>
		</div>
	{/if}

	<AdminTabs
		items={consentTabs}
		active={activeTab}
		onChange={handleTabChange}
		ariaLabel={$LL.admin_consent_statements_title()}
	/>

	<!-- Tab Content -->
	{#if loading}
		<div class="admin-loading">{$LL.admin_consent_statements_loading()}</div>
	{:else if activeTab === 'statements'}
		<!-- ===== STATEMENTS TAB ===== -->
		<div class="admin-section" id="consent-statements-panel" role="tabpanel">
			<div class="admin-section__header">
				<h2>{$LL.admin_consent_statements_consent_statements()}</h2>
				<button
					class="admin-btn admin-btn--primary"
					onclick={() => {
						editingStatementId = null;
						resetStatementForm();
						showStatementForm = true;
					}}
				>
					+ {$LL.admin_consent_statements_new()}
				</button>
			</div>

			{#if showStatementForm}
				<div class="admin-form-card admin-form-card--stacked">
					<h3 class="admin-form-card__title">
						{editingStatementId
							? $LL.admin_consent_statements_edit()
							: $LL.admin_consent_statements_new()}
					</h3>
					<div class="admin-form-grid">
						<div class="admin-form-group">
							<label for="stmt-slug">{$LL.admin_consent_statements_slug()}</label>
							<input
								id="stmt-slug"
								type="text"
								class="admin-input"
								bind:value={statementFormData.slug}
								placeholder={$LL.admin_consent_statements_placeholder_slug()}
							/>
						</div>
						<div class="admin-form-group">
							<label for="stmt-category">{$LL.admin_consent_statements_category()}</label>
							<select
								id="stmt-category"
								class="admin-input"
								bind:value={statementFormData.category}
							>
								{#each CATEGORIES as cat (cat)}
									<option value={cat}>{getCategoryLabel(cat)}</option>
								{/each}
							</select>
						</div>
						<div class="admin-form-group">
							<label for="stmt-legal-basis">{$LL.admin_consent_statements_legal_basis()}</label>
							<select
								id="stmt-legal-basis"
								class="admin-input"
								bind:value={statementFormData.legal_basis}
							>
								{#each LEGAL_BASES as basis (basis)}
									<option value={basis}>{getLegalBasisLabel(basis)}</option>
								{/each}
							</select>
						</div>
						<div class="admin-form-group">
							<label for="stmt-order">{$LL.admin_consent_statements_order()}</label>
							<input
								id="stmt-order"
								type="number"
								class="admin-input"
								bind:value={statementFormData.display_order}
							/>
						</div>
						<div class="admin-form-group admin-form-group--full">
							<label for="stmt-purpose">{$LL.admin_consent_statements_purpose()}</label>
							<textarea
								id="stmt-purpose"
								class="admin-input"
								bind:value={statementFormData.processing_purpose}
								rows="2"
								placeholder={$LL.admin_consent_statements_placeholder_purpose()}
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
							{$LL.admin_consent_statements_cancel()}
						</button>
						<button class="admin-btn admin-btn--primary" onclick={saveStatement}>
							{editingStatementId
								? $LL.admin_consent_statements_update()
								: $LL.admin_consent_statements_create()}
						</button>
					</div>
				</div>
			{/if}

			<AdminDataTable width="wide">
				<thead>
					<tr>
						<th>{$LL.admin_consent_statements_slug()}</th>
						<th>{$LL.admin_consent_statements_category()}</th>
						<th>{$LL.admin_consent_statements_legal_basis()}</th>
						<th>{$LL.admin_consent_statements_order()}</th>
						<th>{$LL.admin_consent_statements_active()}</th>
						<th>{$LL.admin_consent_statements_created()}</th>
						<th>{$LL.admin_consent_statements_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each statements as stmt (stmt.id)}
						<tr
							class:admin-table__row--selected={selectedStatementId === stmt.id}
							data-clickable="true"
							onclick={() => selectStatement(stmt.id)}
						>
							<td>
								<code class="admin-code">{stmt.slug}</code>
							</td>
							<td>
								<span class="admin-badge admin-badge--category" data-category={stmt.category}>
									{getCategoryLabel(stmt.category)}
								</span>
							</td>
							<td class="admin-table-cell--compact">{getLegalBasisLabel(stmt.legal_basis)}</td>
							<td class="admin-table-cell--compact">{stmt.display_order}</td>
							<td>
								<button
									class="admin-badge admin-badge--toggle"
									data-state={stmt.is_active ? 'active' : 'inactive'}
									onclick={(e) => {
										e.stopPropagation();
										toggleStatementActive(stmt);
									}}
								>
									{stmt.is_active
										? $LL.admin_consent_statements_active()
										: $LL.admin_consent_statements_inactive()}
								</button>
							</td>
							<td class="admin-table-cell--compact">{formatDate(stmt.created_at)}</td>
							<td>
								<div class="admin-actions-cell">
									<button
										class="admin-btn admin-btn--ghost admin-btn--sm"
										onclick={(e) => {
											e.stopPropagation();
											editStatement(stmt);
										}}
									>
										{$LL.admin_consent_statements_edit_action()}
									</button>
									<button
										class="admin-btn admin-btn--ghost admin-btn--sm admin-btn--danger"
										onclick={(e) => {
											e.stopPropagation();
											deleteStatement(stmt);
										}}
									>
										{$LL.admin_consent_statements_delete_action()}
									</button>
								</div>
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="7" class="admin-table-empty">
								{$LL.admin_consent_statements_empty()}
							</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>

			{#if selectedStatementId}
				<p class="selection-hint">
					{$LL.admin_consent_statements_selected({ slug: selectedStatement?.slug || '' })}
				</p>
			{/if}
		</div>
	{:else if activeTab === 'versions'}
		<!-- ===== VERSIONS TAB ===== -->
		<div class="admin-section" id="consent-versions-panel" role="tabpanel">
			<div class="admin-section__header">
				<h2>
					{$LL.admin_consent_versions_title({ slug: selectedStatement?.slug || '' })}
				</h2>
				<button class="admin-btn admin-btn--primary" onclick={() => (showVersionForm = true)}>
					+ {$LL.admin_consent_versions_new()}
				</button>
			</div>

			{#if showVersionForm}
				<div class="admin-form-card admin-form-card--stacked">
					<h3 class="admin-form-card__title">{$LL.admin_consent_versions_new()}</h3>
					<div class="admin-form-grid">
						<div class="admin-form-group">
							<label for="ver-version">{$LL.admin_consent_versions_version()}</label>
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
							<label for="ver-content-type">{$LL.admin_consent_versions_content_type()}</label>
							<select
								id="ver-content-type"
								class="admin-input"
								bind:value={versionFormData.content_type}
							>
								<option value="url">{$LL.admin_consent_content_type_url()}</option>
								<option value="inline">{$LL.admin_consent_content_type_inline()}</option>
							</select>
						</div>
						<div class="admin-form-group">
							<label for="ver-effective">{$LL.admin_consent_versions_effective()}</label>
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
							{$LL.admin_consent_statements_cancel()}
						</button>
						<button class="admin-btn admin-btn--primary" onclick={saveVersion}>
							{$LL.admin_consent_statements_create()}
						</button>
					</div>
				</div>
			{/if}

			<AdminDataTable width="wide">
				<thead>
					<tr>
						<th>{$LL.admin_consent_versions_version()}</th>
						<th>{$LL.admin_consent_versions_content_type()}</th>
						<th>{$LL.admin_consent_statements_status()}</th>
						<th>{$LL.admin_consent_versions_effective()}</th>
						<th>{$LL.admin_consent_versions_hash()}</th>
						<th>{$LL.admin_consent_statements_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each versions as ver (ver.id)}
						<tr
							class:admin-table__row--selected={selectedVersionId === ver.id}
							data-clickable="true"
							onclick={() => selectVersion(ver.id)}
						>
							<td>
								<code class="admin-code">{ver.version}</code>
								{#if ver.is_current}
									<span class="admin-badge admin-badge--success admin-badge--inline">
										{$LL.admin_consent_versions_current()}
									</span>
								{/if}
							</td>
							<td class="admin-table-cell--compact">
								{ver.content_type === 'inline'
									? $LL.admin_consent_content_type_inline()
									: $LL.admin_consent_content_type_url()}
							</td>
							<td>
								<span class="admin-badge admin-badge--version" data-status={ver.status}>
									{getVersionStatusLabel(ver.status)}
								</span>
							</td>
							<td class="admin-table-cell--compact">{formatDate(ver.effective_at)}</td>
							<td class="admin-table-cell--compact">
								{ver.content_hash ? ver.content_hash.slice(0, 8) + '...' : '-'}
							</td>
							<td>
								<div class="admin-actions-cell">
									{#if ver.status === 'draft'}
										<button
											class="admin-btn admin-btn--ghost admin-btn--sm admin-btn--success"
											onclick={(e) => {
												e.stopPropagation();
												confirmActivate(ver.id);
											}}
										>
											{$LL.admin_consent_versions_activate()}
										</button>
										<button
											class="admin-btn admin-btn--ghost admin-btn--sm admin-btn--danger"
											onclick={(e) => {
												e.stopPropagation();
												deleteVersion(ver.id);
											}}
										>
											{$LL.admin_consent_statements_delete_action()}
										</button>
									{/if}
								</div>
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="6" class="admin-table-empty">
								{$LL.admin_consent_versions_empty()}
							</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>

			{#if selectedVersionId}
				<p class="selection-hint">
					{$LL.admin_consent_versions_selected()}
				</p>
			{/if}
		</div>

		<!-- Activate Confirmation Modal -->
		{#if showActivateConfirm}
			<div
				class="admin-modal-overlay"
				role="button"
				tabindex="0"
				aria-label={$LL.admin_consent_versions_dialog_close()}
				onclick={(event) => {
					if (event.target === event.currentTarget) {
						showActivateConfirm = false;
					}
				}}
				onkeydown={(event) => closeOnBackdropKeydown(event, () => (showActivateConfirm = false))}
			>
				<div class="admin-modal" role="dialog" aria-modal="true">
					<h3 class="admin-modal__title">{$LL.admin_consent_versions_dialog_title()}</h3>
					<p class="admin-modal__text">
						{$LL.admin_consent_versions_activate_confirm()}
					</p>
					<div class="admin-modal__actions">
						<button
							class="admin-btn admin-btn--secondary"
							onclick={() => (showActivateConfirm = false)}
						>
							{$LL.admin_consent_statements_cancel()}
						</button>
						<button class="admin-btn admin-btn--primary" onclick={activateVersion}>
							{$LL.admin_consent_versions_activate()}
						</button>
					</div>
				</div>
			</div>
		{/if}
	{:else if activeTab === 'localizations'}
		<!-- ===== LOCALIZATIONS TAB ===== -->
		<div class="admin-section" id="consent-localizations-panel" role="tabpanel">
			<div class="admin-section__header">
				<h2>{$LL.admin_consent_statements_tab_localizations()}</h2>
				<button
					class="admin-btn admin-btn--primary"
					onclick={() => {
						editingLanguage = null;
						resetLocalizationForm();
						showLocalizationForm = true;
					}}
				>
					+ {$LL.admin_consent_localizations_add()}
				</button>
			</div>

			{#if showLocalizationForm}
				<div class="admin-form-card admin-form-card--stacked">
					<h3 class="admin-form-card__title">
						{editingLanguage
							? $LL.admin_consent_localizations_edit({ language: editingLanguage })
							: $LL.admin_consent_localizations_new()}
					</h3>
					<div class="admin-form-grid">
						<div class="admin-form-group">
							<label for="loc-lang">{$LL.admin_consent_localizations_language()}</label>
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
							<label for="loc-title">{$LL.admin_consent_localizations_title()}</label>
							<input
								id="loc-title"
								type="text"
								class="admin-input"
								bind:value={localizationFormData.title}
								placeholder={$LL.admin_consent_localizations_placeholder_title()}
							/>
						</div>
						<div class="admin-form-group admin-form-group--full">
							<label for="loc-desc">{$LL.admin_consent_localizations_description()}</label>
							<textarea
								id="loc-desc"
								class="admin-input"
								bind:value={localizationFormData.description}
								rows="2"
								placeholder={$LL.admin_consent_localizations_placeholder_description()}
							></textarea>
						</div>
						<div class="admin-form-group">
							<label for="loc-url">{$LL.admin_consent_localizations_url()}</label>
							<input
								id="loc-url"
								type="url"
								class="admin-input"
								bind:value={localizationFormData.document_url}
								placeholder="https://example.com/policy.html"
							/>
						</div>
						<div class="admin-form-group admin-form-group--full">
							<label for="loc-inline">{$LL.admin_consent_localizations_inline()}</label>
							<textarea
								id="loc-inline"
								class="admin-input"
								bind:value={localizationFormData.inline_content}
								rows="4"
								placeholder={$LL.admin_consent_localizations_placeholder_inline()}
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
							{$LL.admin_consent_statements_cancel()}
						</button>
						<button class="admin-btn admin-btn--primary" onclick={saveLocalization}>
							{editingLanguage
								? $LL.admin_consent_statements_update()
								: $LL.admin_consent_statements_create()}
						</button>
					</div>
				</div>
			{/if}

			<AdminDataTable width="wide">
				<thead>
					<tr>
						<th>{$LL.admin_consent_localizations_language()}</th>
						<th>{$LL.admin_consent_localizations_title()}</th>
						<th>{$LL.admin_consent_localizations_description()}</th>
						<th>{$LL.admin_consent_localizations_url()}</th>
						<th>{$LL.admin_consent_statements_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each localizations as loc (loc.id)}
						<tr>
							<td>
								<code class="admin-code">{loc.language}</code>
							</td>
							<td class="admin-table-cell--compact">{loc.title}</td>
							<td class="admin-table-cell--compact admin-cell--truncate">
								{loc.description}
							</td>
							<td class="admin-table-cell--compact">
								{#if loc.document_url}
									<a
										href={loc.document_url}
										target="_blank"
										rel="noopener noreferrer"
										class="admin-link"
									>
										{$LL.admin_consent_localizations_link()}
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
										{$LL.admin_consent_statements_edit_action()}
									</button>
									<button
										class="admin-btn admin-btn--ghost admin-btn--sm admin-btn--danger"
										onclick={() => deleteLocalization(loc.language)}
									>
										{$LL.admin_consent_statements_delete_action()}
									</button>
								</div>
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="5" class="admin-table-empty">
								{$LL.admin_consent_localizations_empty()}
							</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		</div>
	{:else if activeTab === 'requirements'}
		<!-- ===== REQUIREMENTS TAB ===== -->
		<div class="admin-section" id="consent-requirements-panel" role="tabpanel">
			<div class="admin-section__header">
				<h2>{$LL.admin_consent_requirements_title()}</h2>
				<button
					class="admin-btn admin-btn--primary"
					onclick={() => {
						resetRequirementForm();
						showRequirementForm = true;
					}}
				>
					+ {$LL.admin_consent_requirements_add()}
				</button>
			</div>

			{#if showRequirementForm}
				<div class="admin-form-card admin-form-card--stacked">
					<h3 class="admin-form-card__title">
						{requirementFormData.statement_id
							? $LL.admin_consent_requirements_edit()
							: $LL.admin_consent_requirements_new()}
					</h3>
					<div class="admin-form-grid">
						<div class="admin-form-group">
							<label for="req-statement">{$LL.admin_consent_requirements_statement()}</label>
							<select
								id="req-statement"
								class="admin-input"
								bind:value={requirementFormData.statement_id}
							>
								<option value="">{$LL.admin_consent_requirements_select_placeholder()}</option>
								{#each statements as stmt (stmt.id)}
									<option value={stmt.id}>{stmt.slug}</option>
								{/each}
							</select>
						</div>
						<div class="admin-form-group">
							<label for="req-required">{$LL.admin_consent_requirements_required()}</label>
							<select
								id="req-required"
								class="admin-input"
								value={requirementFormData.is_required}
								onchange={(e) => {
									requirementFormData.is_required = parseInt(
										(e.currentTarget as HTMLSelectElement).value
									);
								}}
							>
								<option value={1}>{$LL.admin_consent_requirements_required()}</option>
								<option value={0}>{$LL.admin_consent_requirements_optional()}</option>
							</select>
						</div>
						<div class="admin-form-group">
							<label for="req-enforcement">{$LL.admin_consent_requirements_enforcement()}</label>
							<select
								id="req-enforcement"
								class="admin-input"
								bind:value={requirementFormData.enforcement}
							>
								<option value="block">{$LL.admin_consent_requirements_enforcement_block()}</option>
								<option value="allow_continue"
									>{$LL.admin_consent_requirements_enforcement_allow_continue()}</option
								>
							</select>
						</div>
						<div class="admin-form-group">
							<label for="req-min-version"
								>{$LL.admin_consent_requirements_min_version_yyyymmdd()}</label
							>
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
							<label for="req-order">{$LL.admin_consent_statements_order()}</label>
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
										requirementFormData.show_deletion_link = (e.currentTarget as HTMLInputElement)
											.checked
											? 1
											: 0;
									}}
								/>
								{$LL.admin_consent_requirements_deletion_link()}
							</label>
						</div>
						{#if requirementFormData.show_deletion_link}
							<div class="admin-form-group">
								<label for="req-deletion-url">{$LL.admin_consent_requirements_deletion_url()}</label
								>
								<input
									id="req-deletion-url"
									type="url"
									class="admin-input"
									bind:value={requirementFormData.deletion_url}
									placeholder="https://example.com/delete-account"
								/>
							</div>
						{/if}
						<div class="admin-form-group admin-form-group--full">
							<label for="req-rules">{$LL.admin_consent_requirements_rules()}</label>
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
							{$LL.admin_consent_statements_cancel()}
						</button>
						<button class="admin-btn admin-btn--primary" onclick={saveRequirement}>
							{$LL.admin_consent_requirements_save()}
						</button>
					</div>
				</div>
			{/if}

			<AdminDataTable width="wide">
				<thead>
					<tr>
						<th>{$LL.admin_consent_requirements_statement()}</th>
						<th>{$LL.admin_consent_requirements_required()}</th>
						<th>{$LL.admin_consent_requirements_enforcement()}</th>
						<th>{$LL.admin_consent_requirements_min_version()}</th>
						<th>{$LL.admin_consent_statements_order()}</th>
						<th>{$LL.admin_consent_statements_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each requirements as req (req.id)}
						<tr>
							<td>
								<code class="admin-code">{getStatementSlug(req.statement_id)}</code>
							</td>
							<td>
								<span
									class="admin-badge admin-badge--requirement"
									data-required={req.is_required ? 'true' : 'false'}
								>
									{req.is_required
										? $LL.admin_consent_requirements_required()
										: $LL.admin_consent_requirements_optional()}
								</span>
							</td>
							<td class="admin-table-cell--compact">{getEnforcementLabel(req.enforcement)}</td>
							<td class="admin-table-cell--compact">{req.min_version || '-'}</td>
							<td class="admin-table-cell--compact">{req.display_order}</td>
							<td>
								<div class="admin-actions-cell">
									<button
										class="admin-btn admin-btn--ghost admin-btn--sm"
										onclick={() => editRequirement(req)}
									>
										{$LL.admin_consent_statements_edit_action()}
									</button>
									<button
										class="admin-btn admin-btn--ghost admin-btn--sm admin-btn--danger"
										onclick={() => deleteRequirement(req.statement_id)}
									>
										{$LL.admin_consent_statements_delete_action()}
									</button>
								</div>
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="6" class="admin-table-empty">
								{$LL.admin_consent_requirements_empty()}
							</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		</div>
	{/if}
</AdminPageShell>

<style>
	.admin-section,
	.admin-section *,
	.admin-section *::before,
	.admin-section *::after,
	.admin-modal,
	.admin-modal *,
	.admin-modal *::before,
	.admin-modal *::after {
		box-sizing: border-box;
	}

	.admin-section {
		background: var(--settings-panel-bg, var(--color-surface));
		border: var(--settings-panel-border, 1px solid var(--color-border));
		border-radius: var(--settings-panel-radius, var(--radius-panel));
		padding: var(--settings-panel-padding, 20px);
		box-shadow: var(--settings-panel-shadow, var(--card-shadow, none));
		min-width: 0;
	}

	.admin-section__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 16px;
	}

	.admin-section__header h2 {
		font-size: var(--settings-section-title-size, 1.125rem);
		font-weight: var(--settings-section-title-weight, 600);
		color: var(--color-text);
	}

	.admin-alert {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px;
		border-radius: var(--radius-control);
		font-size: 0.875rem;
	}

	.admin-alert--error {
		background: color-mix(in srgb, var(--color-danger) 12%, transparent);
		color: var(--color-danger);
	}

	.admin-alert--success {
		background: color-mix(in srgb, var(--color-success) 12%, transparent);
		color: var(--color-success);
	}

	.admin-alert button {
		background: none;
		border: none;
		cursor: pointer;
		font-size: 1rem;
		color: inherit;
		opacity: 0.7;
	}

	.admin-alert--stacked,
	.admin-form-card--stacked {
		margin-bottom: 1rem;
	}

	.admin-form-card {
		background: var(--settings-card-bg, var(--color-surface-muted));
		border: var(--settings-card-border, 1px solid var(--color-border));
		border-radius: var(--settings-card-radius, var(--radius-control));
		padding: 16px;
	}

	.admin-form-card__title {
		font-size: 0.875rem;
		font-weight: 600;
		margin-bottom: 12px;
		color: var(--color-text);
	}

	.admin-form-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
		min-width: 0;
	}

	.admin-form-group {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.admin-form-group--full {
		grid-column: 1 / -1;
	}

	.admin-form-group label {
		font-size: var(--settings-label-size, 0.75rem);
		font-weight: var(--settings-label-weight, 500);
		color: var(--color-text-muted);
	}

	.admin-input {
		min-height: var(--control-height, 38px);
		padding: var(--control-padding, 8px 12px);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		font-size: 0.875rem;
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
	}

	.admin-input:focus {
		outline: none;
		border-color: var(--color-accent);
		box-shadow: 0 0 0 2px var(--color-accent-muted);
	}

	textarea.admin-input {
		resize: vertical;
	}

	.admin-form-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		justify-content: flex-end;
		margin-top: 12px;
	}

	.admin-btn {
		padding: 6px 14px;
		border-radius: var(--radius-control);
		font-size: 0.813rem;
		font-weight: 500;
		cursor: pointer;
		border: 1px solid transparent;
		transition: all 0.15s;
	}

	.admin-btn--primary {
		background: var(--color-accent);
		color: var(--color-accent-contrast);
	}

	.admin-btn--primary:hover {
		opacity: 0.9;
	}

	.admin-btn--secondary {
		background: var(--color-surface);
		border-color: var(--color-border);
		color: var(--color-text);
	}

	.admin-btn--ghost {
		background: none;
		color: var(--color-accent);
		padding: 4px 8px;
	}

	.admin-btn--ghost:hover {
		background: var(--color-accent-muted);
	}

	.admin-btn--sm {
		font-size: 0.75rem;
		padding: 2px 8px;
	}

	.admin-btn--danger {
		color: var(--color-danger);
	}

	.admin-btn--success {
		color: var(--color-success);
	}

	.admin-btn--danger:hover {
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
	}

	:global(.admin-table__row--selected) {
		background: var(--color-accent-muted) !important;
	}

	.admin-table-empty,
	.selection-hint {
		color: var(--color-text-muted);
	}

	.admin-table-empty {
		text-align: center;
		font-size: 0.875rem;
	}

	.selection-hint {
		margin: 0.75rem 0 0;
		font-size: 0.875rem;
		line-height: 1.5;
	}

	.admin-code,
	.admin-table-cell--compact {
		font-size: 0.875rem;
	}

	.admin-code {
		font-family: var(--font-mono);
		color: var(--color-text);
	}

	.admin-cell--truncate {
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.admin-link {
		color: var(--color-accent);
	}

	.admin-badge {
		display: inline-block;
		padding: var(--settings-badge-padding, 2px 8px);
		border: var(--settings-badge-border, none);
		border-radius: var(--settings-badge-radius, 12px);
		font-size: var(--settings-badge-size, 0.75rem);
		font-weight: 500;
		letter-spacing: var(--settings-badge-letter-spacing, 0);
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
	}

	.admin-badge--inline {
		margin-left: 4px;
	}

	.admin-badge--toggle {
		cursor: pointer;
	}

	.admin-badge--success,
	.admin-badge--toggle[data-state='active'],
	.admin-badge--version[data-status='active'] {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.admin-badge--toggle[data-state='inactive'],
	.admin-badge--version[data-status='draft'],
	.admin-badge--requirement[data-required='false'] {
		background: var(--color-surface-muted);
		color: var(--color-text-subtle);
	}

	.admin-badge--version[data-status='archived'] {
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
	}

	.admin-badge--requirement[data-required='true'],
	.admin-badge--category[data-category='do_not_sell'] {
		background: color-mix(in srgb, var(--color-danger) 12%, transparent);
		color: var(--color-danger);
	}

	.admin-badge--category[data-category='cookie_policy'] {
		background: color-mix(in srgb, var(--color-warning) 12%, transparent);
		color: var(--color-warning);
	}

	.admin-badge--category[data-category='marketing'] {
		background: color-mix(in srgb, var(--color-success) 12%, transparent);
		color: var(--color-success);
	}

	.admin-badge--category[data-category='terms_of_service'],
	.admin-badge--category[data-category='privacy_policy'],
	.admin-badge--category[data-category='data_sharing'],
	.admin-badge--category[data-category='analytics'] {
		background: var(--color-accent-muted);
		color: var(--color-accent);
	}

	.admin-actions-cell {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.admin-loading {
		text-align: center;
		padding: 48px;
		color: var(--color-text-subtle);
	}

	.admin-modal-overlay {
		position: fixed;
		inset: 0;
		background: var(--color-overlay-scrim);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}

	.admin-modal {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		padding: 24px;
		max-width: 480px;
		width: 90%;
		box-shadow: var(--card-shadow, var(--shadow-panel));
	}

	.admin-modal__title {
		font-size: 1.125rem;
		font-weight: 600;
		margin-bottom: 8px;
		color: var(--color-text);
	}

	.admin-modal__text {
		font-size: 0.875rem;
		color: var(--color-text-muted);
		margin-bottom: 20px;
		line-height: 1.5;
	}

	.admin-modal__actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		justify-content: flex-end;
	}

	@media (max-width: 640px) {
		.admin-section {
			padding: 16px;
		}

		.admin-section__header {
			align-items: flex-start;
			flex-direction: column;
		}

		.admin-form-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
