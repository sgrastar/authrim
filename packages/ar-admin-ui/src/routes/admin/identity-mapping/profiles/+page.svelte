<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingExternalSchemaSummary,
		type IdentityMappingProtocolSchemaSummary,
		type IdentityMappingSourceProfileColumn,
		type IdentityMappingSourceProfileSchema,
		type IdentityMappingSourceProfileSummary,
		type IdentityMappingTemplateSummary
	} from '$lib/api/admin-identity-mapping';
	import {
		createDestinationConsentSettingsDraft,
		summarizeDestinationConsentSettings,
		type DestinationConsentSettingsDraft
	} from '$lib/admin/identity-mapping-profile-settings';

	type ProfileKind = 'inbound' | 'outbound' | 'template';
	type CsvCreateMode = 'upload' | 'manual';
	type CsvDetailTab = 'summary' | 'parser' | 'columns' | 'warnings';

	interface ProfileItem {
		id: string;
		kind: ProfileKind;
		protocol: string;
		displayName: string;
		versionLabel: string;
		lifecycleState: string;
		source: string;
		sourceProfileId?: string;
		sourceProfileVersionId?: string;
	}

	const profileKinds: Array<ProfileKind | 'all'> = ['all', 'inbound', 'outbound', 'template'];
	const valueTypeOptions = ['string', 'email', 'phone', 'number', 'boolean', 'date', 'datetime'];
	const classificationOptions = ['internal', 'public', 'pii', 'regulated', 'secret'];
	const delimiterOptions = [
		{ value: 'auto', label: 'Auto' },
		{ value: ',', label: 'Comma' },
		{ value: '\\t', label: 'Tab' },
		{ value: ';', label: 'Semicolon' },
		{ value: '|', label: 'Pipe' }
	];

	let profiles = $state<ProfileItem[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let createMessage = $state<string | null>(null);
	let activeKind = $state<ProfileKind | 'all'>('all');
	let selectedProfileId = $state<string | null>(null);
	let consentDrafts = $state<Record<string, DestinationConsentSettingsDraft>>({});
	let csvMode = $state<CsvCreateMode>('upload');
	let csvDetailTab = $state<CsvDetailTab>('summary');
	let csvDisplayName = $state('');
	let csvProfileKey = $state('');
	let csvVersionLabel = $state('v1');
	let csvEncoding = $state('utf-8');
	let csvDelimiter = $state('auto');
	let csvHeaderMode = $state('auto');
	let selectedCsvFile = $state<File | null>(null);
	let parsingCsv = $state(false);
	let savingCsv = $state(false);
	let parsedCsvDraftId = $state<string | null>(null);
	let parsedCsvSchema = $state<IdentityMappingSourceProfileSchema | null>(null);
	let parsedCsvParserOptions = $state<Record<string, unknown>>({});
	let parsedCsvWarningSummary = $state<Record<string, unknown>>({});
	let blockingWarningsConfirmed = $state(false);
	let manualColumns = $state<IdentityMappingSourceProfileColumn[]>([
		createManualColumn('email', 'Email', 'email')
	]);

	onMount(() => {
		void loadProfiles();
	});

	const visibleProfiles = $derived(
		activeKind === 'all' ? profiles : profiles.filter((profile) => profile.kind === activeKind)
	);
	const selectedProfile = $derived(
		profiles.find((profile) => profile.id === selectedProfileId) ?? null
	);
	const selectedConsentDraft = $derived(
		selectedProfileId ? (consentDrafts[selectedProfileId] ?? null) : null
	);
	const inboundCount = $derived(profiles.filter((profile) => profile.kind === 'inbound').length);
	const outboundCount = $derived(profiles.filter((profile) => profile.kind === 'outbound').length);
	const activeCsvSchema = $derived(csvMode === 'manual' ? buildManualCsvSchema() : parsedCsvSchema);
	const csvBlockingWarningCount = $derived(getBlockingWarningCount(activeCsvSchema));
	const canSaveCsv = $derived(
		Boolean(csvDisplayName.trim()) &&
			Boolean(csvProfileKey.trim()) &&
			Boolean(activeCsvSchema) &&
			(csvBlockingWarningCount === 0 || blockingWarningsConfirmed)
	);

	async function loadProfiles() {
		loading = true;
		errorMessage = null;
		try {
			const [protocolSchemas, externalSchemas, loadedSourceProfiles, templates] = await Promise.all(
				[
					adminIdentityMappingAPI.listProtocolSchemas(),
					adminIdentityMappingAPI.listExternalSchemas(),
					adminIdentityMappingAPI.listSourceProfiles(),
					adminIdentityMappingAPI.listTemplates()
				]
			);
			const loadedProfiles = [
				...loadedSourceProfiles.sourceProfiles.map(sourceProfileToProfile),
				...protocolSchemas.protocolSchemas.map(protocolSchemaToProfile),
				...externalSchemas.externalSchemas.map(externalSchemaToProfile),
				...templates.templates.map(templateToProfile)
			];
			profiles = loadedProfiles;
			const firstOutbound = loadedProfiles.find((profile) => profile.kind === 'outbound');
			if (!selectedProfileId && firstOutbound) {
				selectConsentProfile(firstOutbound);
			}
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to load mapping profiles';
		} finally {
			loading = false;
		}
	}

	function selectConsentProfile(profile: ProfileItem) {
		if (profile.kind !== 'outbound') return;
		const existingDraft = consentDrafts[profile.id];
		selectedProfileId = profile.id;
		if (!existingDraft) {
			consentDrafts = {
				...consentDrafts,
				[profile.id]: createDestinationConsentSettingsDraft(profile.id)
			};
		}
	}

	function updateSelectedConsentDraft(patch: Partial<DestinationConsentSettingsDraft>) {
		if (!selectedProfileId || !selectedConsentDraft) return;
		consentDrafts = {
			...consentDrafts,
			[selectedProfileId]: {
				...selectedConsentDraft,
				...patch
			}
		};
	}

	function getInputValue(event: Event): string {
		return event.currentTarget instanceof HTMLInputElement ||
			event.currentTarget instanceof HTMLSelectElement
			? event.currentTarget.value
			: '';
	}

	function getCheckboxValue(event: Event): boolean {
		return event.currentTarget instanceof HTMLInputElement ? event.currentTarget.checked : false;
	}

	function sourceProfileToProfile(profile: IdentityMappingSourceProfileSummary): ProfileItem {
		return {
			id: profile.id,
			kind: 'inbound',
			protocol: profile.sourceType.toUpperCase(),
			displayName: profile.displayName,
			versionLabel: profile.version?.versionLabel ?? 'draft',
			lifecycleState: profile.version?.lifecycleState ?? profile.lifecycleState,
			source: profile.profileKey,
			sourceProfileId: profile.id,
			sourceProfileVersionId: profile.version?.id
		};
	}

	function protocolSchemaToProfile(schema: IdentityMappingProtocolSchemaSummary): ProfileItem {
		return {
			id: schema.id,
			kind: ['saml', 'oidc'].includes(schema.protocol.toLowerCase()) ? 'outbound' : 'inbound',
			protocol: schema.protocol,
			displayName: schema.displayName ?? schema.schemaKey,
			versionLabel: schema.versionLabel ?? schema.schemaVersion ?? 'current',
			lifecycleState: schema.lifecycleState,
			source: schema.schemaKey
		};
	}

	function externalSchemaToProfile(schema: IdentityMappingExternalSchemaSummary): ProfileItem {
		return {
			id: schema.id,
			kind: 'inbound',
			protocol: schema.sourceType,
			displayName: schema.displayName ?? schema.schemaKey,
			versionLabel: schema.versionLabel ?? `imported:${schema.importedAt ?? 'current'}`,
			lifecycleState: schema.lifecycleState,
			source: schema.sourceKey ?? schema.sourceId ?? schema.schemaKey
		};
	}

	function templateToProfile(template: IdentityMappingTemplateSummary): ProfileItem {
		return {
			id: template.id,
			kind: 'template',
			protocol: template.protocol,
			displayName: template.displayName,
			versionLabel: template.templateKey,
			lifecycleState: template.lifecycleState,
			source: template.templateKey
		};
	}

	async function parseSelectedCsv() {
		if (!selectedCsvFile) {
			createMessage = 'Choose a CSV file before parsing.';
			return;
		}
		parsingCsv = true;
		createMessage = null;
		try {
			const contentBase64 = await fileToBase64(selectedCsvFile);
			const response = await adminIdentityMappingAPI.parseCsvSourceProfile({
				contentBase64,
				encoding: csvEncoding,
				parserOptions: {
					delimiter: csvDelimiter === '\\t' ? '\t' : csvDelimiter,
					headerMode: csvHeaderMode,
					maxRows: 500,
					maxColumns: 200
				},
				sourceMetadata: {
					fileName: selectedCsvFile.name,
					fileSize: selectedCsvFile.size
				}
			});
			parsedCsvDraftId = response.result.parseDraftId;
			parsedCsvSchema = cloneSchema(response.result.schema);
			parsedCsvParserOptions = response.result.parserOptions;
			parsedCsvWarningSummary = response.result.warningSummary;
			blockingWarningsConfirmed = false;
			if (!csvDisplayName.trim()) {
				csvDisplayName = selectedCsvFile.name.replace(/\.[^.]+$/, '');
			}
			if (!csvProfileKey.trim()) {
				csvProfileKey = normalizeProfileKey(csvDisplayName || selectedCsvFile.name);
			}
			csvDetailTab = 'columns';
		} catch (error) {
			createMessage = error instanceof Error ? error.message : 'Failed to parse CSV';
		} finally {
			parsingCsv = false;
		}
	}

	async function saveCsvProfile() {
		const schema = activeCsvSchema;
		if (!schema) {
			createMessage = 'Parse a CSV file or add manual columns before saving.';
			return;
		}
		if (!canSaveCsv) {
			createMessage = 'Confirm PII and regulated candidates before saving the profile.';
			return;
		}
		savingCsv = true;
		createMessage = null;
		try {
			const warningSummary = {
				...(csvMode === 'manual' ? schema.summary : parsedCsvWarningSummary),
				confirmedBlockingWarningCount: blockingWarningsConfirmed ? csvBlockingWarningCount : 0
			};
			const response = await adminIdentityMappingAPI.createSourceProfile({
				sourceType: 'csv',
				profileKey: csvProfileKey.trim(),
				displayName: csvDisplayName.trim(),
				versionLabel: csvVersionLabel.trim() || 'v1',
				parseDraftId: csvMode === 'upload' ? (parsedCsvDraftId ?? undefined) : undefined,
				schema,
				parserOptions: csvMode === 'upload' ? parsedCsvParserOptions : {},
				warningSummary,
				sourceMetadata: {
					creationMode: csvMode,
					rawContentPersisted: false
				}
			});
			createMessage = `Saved ${response.result.displayName}. Review and activate it before Flow Editor use.`;
			resetCsvComposer();
			await loadProfiles();
		} catch (error) {
			createMessage = error instanceof Error ? error.message : 'Failed to save CSV source profile';
		} finally {
			savingCsv = false;
		}
	}

	async function reviewSourceProfile(profile: ProfileItem) {
		if (!profile.sourceProfileId || !profile.sourceProfileVersionId) return;
		try {
			await adminIdentityMappingAPI.reviewSourceProfileVersion(
				profile.sourceProfileId,
				profile.sourceProfileVersionId
			);
			createMessage = `Reviewed ${profile.displayName}.`;
			await loadProfiles();
		} catch (error) {
			createMessage =
				error instanceof Error ? error.message : 'Failed to review identity mapping source profile';
		}
	}

	async function activateSourceProfile(profile: ProfileItem) {
		if (!profile.sourceProfileId || !profile.sourceProfileVersionId) return;
		try {
			await adminIdentityMappingAPI.activateSourceProfileVersion(
				profile.sourceProfileId,
				profile.sourceProfileVersionId
			);
			createMessage = `Activated ${profile.displayName}.`;
			await loadProfiles();
		} catch (error) {
			createMessage =
				error instanceof Error
					? error.message
					: 'Failed to activate identity mapping source profile';
		}
	}

	function updateCsvColumn(
		index: number,
		field: keyof IdentityMappingSourceProfileColumn,
		value: string | boolean
	) {
		const schema = activeCsvSchema;
		if (!schema) return;
		const nextColumns = schema.columns.map((column, columnIndex) =>
			columnIndex === index ? { ...column, [field]: value } : column
		);
		if (csvMode === 'manual') {
			manualColumns = nextColumns;
		} else {
			parsedCsvSchema = { ...schema, columns: nextColumns };
		}
	}

	function addManualColumn() {
		manualColumns = [
			...manualColumns,
			createManualColumn(`column_${manualColumns.length + 1}`, `Column ${manualColumns.length + 1}`)
		];
	}

	function removeManualColumn(index: number) {
		manualColumns = manualColumns.filter((_, columnIndex) => columnIndex !== index);
	}

	function createManualColumn(
		headerName: string,
		label: string,
		valueType = 'string'
	): IdentityMappingSourceProfileColumn {
		return {
			stableColumnId: `csv.manual.${normalizeProfileKey(headerName)}.${Date.now()}`,
			headerName,
			label,
			valueType,
			required: false,
			classification: 'internal',
			candidates: {},
			warnings: [],
			emptyRate: 0,
			observedNonEmptyRows: 0
		};
	}

	function buildManualCsvSchema(): IdentityMappingSourceProfileSchema {
		return {
			sourceType: 'csv',
			columns: manualColumns,
			warnings: [],
			summary: {
				columnCount: manualColumns.length,
				rowSampleCount: 0,
				piiCandidateCount: 0,
				regulatedCandidateCount: 0,
				requiredCandidateCount: manualColumns.filter((column) => column.required).length,
				blockingWarningCount: 0
			}
		};
	}

	function getBlockingWarningCount(schema: IdentityMappingSourceProfileSchema | null): number {
		const summaryCount = schema?.summary?.blockingWarningCount;
		if (typeof summaryCount === 'number') return summaryCount;
		return (
			schema?.columns.filter(
				(column) =>
					column.candidates?.classification === 'pii' ||
					column.candidates?.classification === 'regulated'
			).length ?? 0
		);
	}

	function resetCsvComposer() {
		selectedCsvFile = null;
		parsedCsvDraftId = null;
		parsedCsvSchema = null;
		parsedCsvParserOptions = {};
		parsedCsvWarningSummary = {};
		blockingWarningsConfirmed = false;
	}

	function cloneSchema(
		schema: IdentityMappingSourceProfileSchema
	): IdentityMappingSourceProfileSchema {
		return {
			...schema,
			columns: schema.columns.map((column) => ({
				...column,
				candidates: { ...column.candidates }
			})),
			warnings: schema.warnings?.map((warning) => ({ ...warning })),
			summary: schema.summary ? { ...schema.summary } : {}
		};
	}

	async function fileToBase64(file: File): Promise<string> {
		const buffer = await file.arrayBuffer();
		const bytes = new Uint8Array(buffer);
		let binary = '';
		const chunkSize = 0x8000;
		for (let index = 0; index < bytes.length; index += chunkSize) {
			binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
		}
		return btoa(binary);
	}

	function normalizeProfileKey(value: string): string {
		return (
			value
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '_')
				.replace(/^_|_$/g, '') || 'csv_source'
		);
	}
</script>

<svelte:head>
	<title>Source & Destination Profiles - Authrim Admin</title>
</svelte:head>

<div class="profiles-page">
	<div class="page-heading">
		<div>
			<a class="back-link" href="/admin/identity-mapping">Back to Identity Mapping</a>
			<p class="eyebrow">Identity Mapping</p>
			<h1>Source &amp; Destination Profiles</h1>
			<p class="summary">
				Register source profiles from CSV files or manual column definitions, then select them in
				the Flow Editor. SAML, SCIM, OIDC, VC, DID, MCP, A2A, and client-credential sources will use
				this same surface as their adapters are added.
			</p>
		</div>
		<div class="status-panel">
			<div>
				<span>Inbound</span>
				<strong>{inboundCount}</strong>
			</div>
			<div>
				<span>Outbound</span>
				<strong>{outboundCount}</strong>
			</div>
		</div>
	</div>

	<section class="profiles-panel">
		<div class="panel-heading">
			<div>
				<p class="eyebrow">Create Source Profile</p>
				<h2>CSV source profile</h2>
			</div>
			<div class="filter-bar" aria-label="CSV create mode">
				<button
					type="button"
					class:active={csvMode === 'upload'}
					onclick={() => (csvMode = 'upload')}
				>
					Upload CSV
				</button>
				<button
					type="button"
					class:active={csvMode === 'manual'}
					onclick={() => (csvMode = 'manual')}
				>
					Manual columns
				</button>
			</div>
		</div>

		<div class="settings-grid">
			<label>
				<span>Display name</span>
				<input
					value={csvDisplayName}
					placeholder="Workday CSV 2026"
					oninput={(event) => {
						csvDisplayName = getInputValue(event);
						if (!csvProfileKey.trim()) csvProfileKey = normalizeProfileKey(csvDisplayName);
					}}
				/>
			</label>
			<label>
				<span>Profile key</span>
				<input
					value={csvProfileKey}
					placeholder="workday_csv_2026"
					oninput={(event) => (csvProfileKey = normalizeProfileKey(getInputValue(event)))}
				/>
			</label>
			<label>
				<span>Version label</span>
				<input
					value={csvVersionLabel}
					oninput={(event) => (csvVersionLabel = getInputValue(event))}
				/>
			</label>
		</div>

		{#if csvMode === 'upload'}
			<div class="settings-grid parser-grid">
				<label>
					<span>CSV file</span>
					<input
						type="file"
						accept=".csv,text/csv,text/plain"
						onchange={(event) => {
							selectedCsvFile =
								event.currentTarget instanceof HTMLInputElement
									? (event.currentTarget.files?.[0] ?? null)
									: null;
						}}
					/>
				</label>
				<label>
					<span>Encoding</span>
					<select value={csvEncoding} onchange={(event) => (csvEncoding = getInputValue(event))}>
						<option value="utf-8">UTF-8</option>
						<option value="shift_jis">Shift_JIS</option>
						<option value="cp932">CP932</option>
						<option value="euc-jp">EUC-JP</option>
					</select>
				</label>
				<label>
					<span>Delimiter</span>
					<select value={csvDelimiter} onchange={(event) => (csvDelimiter = getInputValue(event))}>
						{#each delimiterOptions as option (option.value)}
							<option value={option.value}>{option.label}</option>
						{/each}
					</select>
				</label>
				<label>
					<span>Header row</span>
					<select
						value={csvHeaderMode}
						onchange={(event) => (csvHeaderMode = getInputValue(event))}
					>
						<option value="auto">Auto detect</option>
						<option value="first_row">First row</option>
						<option value="none">No header</option>
					</select>
				</label>
			</div>
			<div class="action-row">
				<button type="button" onclick={parseSelectedCsv} disabled={parsingCsv || !selectedCsvFile}>
					{parsingCsv ? 'Parsing...' : 'Parse CSV'}
				</button>
				<span>Raw CSV rows are parsed server-side and are not persisted.</span>
			</div>
		{:else}
			<div class="action-row">
				<button type="button" onclick={addManualColumn}>Add column</button>
				<span
					>Create a CSV profile from scratch, then optionally import a file as a later version.</span
				>
			</div>
		{/if}

		{#if activeCsvSchema}
			<div class="csv-detail">
				<div class="filter-bar" aria-label="CSV profile detail tabs">
					{#each ['summary', 'parser', 'columns', 'warnings'] as tab (tab)}
						<button
							type="button"
							class:active={csvDetailTab === tab}
							onclick={() => (csvDetailTab = tab as CsvDetailTab)}
						>
							{tab}
						</button>
					{/each}
				</div>

				{#if csvDetailTab === 'summary'}
					<div class="metrics-grid">
						<div>
							<span>Columns</span>
							<strong>{activeCsvSchema.columns.length}</strong>
						</div>
						<div>
							<span>PII / regulated candidates</span>
							<strong>{csvBlockingWarningCount}</strong>
						</div>
						<div>
							<span>Rows sampled</span>
							<strong>{activeCsvSchema.summary?.rowSampleCount ?? 0}</strong>
						</div>
					</div>
				{:else if csvDetailTab === 'parser'}
					<pre>{JSON.stringify(activeCsvSchema.parser ?? parsedCsvParserOptions, null, 2)}</pre>
				{:else if csvDetailTab === 'warnings'}
					{#if (activeCsvSchema.warnings ?? []).length === 0}
						<div class="empty-state">No parser warnings for this profile draft.</div>
					{:else}
						<div class="warning-list">
							{#each activeCsvSchema.warnings ?? [] as warning, index (index)}
								<div>
									<strong>{String(warning.code ?? 'warning')}</strong>
									<span>{String(warning.message ?? '')}</span>
								</div>
							{/each}
						</div>
					{/if}
				{:else}
					<div class="column-table">
						<div class="column-header">
							<span>Header</span>
							<span>Label</span>
							<span>Type</span>
							<span>Class</span>
							<span>Required</span>
							<span></span>
						</div>
						{#each activeCsvSchema.columns as column, index (column.stableColumnId)}
							<div class="column-row">
								<input
									value={column.headerName}
									oninput={(event) => updateCsvColumn(index, 'headerName', getInputValue(event))}
								/>
								<input
									value={column.label}
									oninput={(event) => updateCsvColumn(index, 'label', getInputValue(event))}
								/>
								<select
									value={column.valueType}
									onchange={(event) => updateCsvColumn(index, 'valueType', getInputValue(event))}
								>
									{#each valueTypeOptions as option (option)}
										<option value={option}>{option}</option>
									{/each}
								</select>
								<select
									value={column.classification}
									onchange={(event) =>
										updateCsvColumn(index, 'classification', getInputValue(event))}
								>
									{#each classificationOptions as option (option)}
										<option value={option}>{option}</option>
									{/each}
								</select>
								<label class="mini-check">
									<input
										type="checkbox"
										checked={column.required}
										onchange={(event) =>
											updateCsvColumn(index, 'required', getCheckboxValue(event))}
									/>
								</label>
								{#if csvMode === 'manual'}
									<button type="button" onclick={() => removeManualColumn(index)}>Remove</button>
								{/if}
							</div>
						{/each}
					</div>
				{/if}

				{#if csvBlockingWarningCount > 0}
					<label class="checkbox-row">
						<input
							type="checkbox"
							checked={blockingWarningsConfirmed}
							onchange={(event) => (blockingWarningsConfirmed = getCheckboxValue(event))}
						/>
						<span>Confirm PII and regulated candidates for this CSV profile version</span>
					</label>
				{/if}
				<div class="action-row">
					<button type="button" onclick={saveCsvProfile} disabled={savingCsv || !canSaveCsv}>
						{savingCsv ? 'Saving...' : 'Save draft profile'}
					</button>
					<a href="/admin/identity-mapping">Open Flow Editor</a>
				</div>
			</div>
		{/if}

		{#if createMessage}
			<div class="empty-state">{createMessage}</div>
		{/if}
	</section>

	<section class="profiles-panel">
		<div class="panel-heading">
			<div class="filter-bar" aria-label="Profile filters">
				{#each profileKinds as kind (kind)}
					<button
						type="button"
						class:active={activeKind === kind}
						onclick={() => (activeKind = kind)}
					>
						{kind}
					</button>
				{/each}
			</div>
			<button type="button" onclick={loadProfiles} disabled={loading}>Refresh</button>
		</div>

		{#if loading}
			<div class="empty-state">Loading source and destination profiles.</div>
		{:else if errorMessage}
			<div class="empty-state">{errorMessage}</div>
		{:else if visibleProfiles.length === 0}
			<div class="empty-state">No profiles match this filter.</div>
		{:else}
			<div class="profile-grid">
				{#each visibleProfiles as profile (profile.id)}
					<article class:selected={profile.id === selectedProfileId}>
						<div class="profile-heading">
							<span>{profile.kind}</span>
							<strong>{profile.lifecycleState}</strong>
						</div>
						<h2>{profile.displayName}</h2>
						<p>{profile.protocol} / {profile.source}</p>
						<small>{profile.versionLabel}</small>
						{#if profile.kind === 'outbound'}
							<button type="button" onclick={() => selectConsentProfile(profile)}>
								Configure release consent
							</button>
						{/if}
						{#if profile.sourceProfileId && profile.sourceProfileVersionId}
							<div class="profile-actions">
								<button type="button" onclick={() => reviewSourceProfile(profile)}>Review</button>
								<button type="button" onclick={() => activateSourceProfile(profile)}
									>Activate</button
								>
							</div>
						{/if}
					</article>
				{/each}
			</div>
		{/if}
	</section>

	{#if selectedProfile && selectedConsentDraft}
		<section
			id="destination-consent"
			class="consent-panel"
			aria-label="Destination attribute release consent settings"
		>
			<div>
				<p class="eyebrow">Destination Consent Settings</p>
				<h2>{selectedProfile.displayName}</h2>
				<p class="summary">
					Set tenant defaults and client overrides for attribute release consent. Flow Editor
					previews use the same legal basis, challenge mode, and policy version fields without
					showing raw attribute values.
				</p>
			</div>

			<div class="settings-grid">
				<label>
					<span>Scope</span>
					<select
						value={selectedConsentDraft.scope}
						onchange={(event) =>
							updateSelectedConsentDraft({
								scope: getInputValue(event) as DestinationConsentSettingsDraft['scope']
							})}
					>
						<option value="tenant_default">Tenant default</option>
						<option value="client_override">Client override</option>
					</select>
				</label>

				<label>
					<span>Client override ID</span>
					<input
						value={selectedConsentDraft.clientId}
						placeholder="client id for override"
						disabled={selectedConsentDraft.scope === 'tenant_default'}
						oninput={(event) => updateSelectedConsentDraft({ clientId: getInputValue(event) })}
					/>
				</label>

				<label>
					<span>Consent mode</span>
					<select
						value={selectedConsentDraft.consentMode}
						onchange={(event) =>
							updateSelectedConsentDraft({
								consentMode: getInputValue(event) as DestinationConsentSettingsDraft['consentMode']
							})}
					>
						<option value="once">Once</option>
						<option value="every_time">Every time</option>
						<option value="until_attributes_change">Until attributes change</option>
					</select>
				</label>

				<label>
					<span>Legal basis</span>
					<select
						value={selectedConsentDraft.legalBasis}
						onchange={(event) =>
							updateSelectedConsentDraft({
								legalBasis: getInputValue(event) as DestinationConsentSettingsDraft['legalBasis']
							})}
					>
						<option value="consent">Consent</option>
						<option value="legal_obligation">Legal obligation</option>
						<option value="contract">Contract</option>
						<option value="legitimate_interest">Legitimate interest</option>
					</select>
				</label>

				<label>
					<span>Purpose</span>
					<input
						value={selectedConsentDraft.purpose}
						oninput={(event) => updateSelectedConsentDraft({ purpose: getInputValue(event) })}
					/>
				</label>

				<label>
					<span>Attribute set policy version</span>
					<input
						value={selectedConsentDraft.attributeSetPolicyVersion}
						oninput={(event) =>
							updateSelectedConsentDraft({ attributeSetPolicyVersion: getInputValue(event) })}
					/>
				</label>

				<label>
					<span>Terms version</span>
					<input
						value={selectedConsentDraft.termsVersion}
						oninput={(event) => updateSelectedConsentDraft({ termsVersion: getInputValue(event) })}
					/>
				</label>

				<label>
					<span>Privacy Policy version</span>
					<input
						value={selectedConsentDraft.privacyPolicyVersion}
						oninput={(event) =>
							updateSelectedConsentDraft({ privacyPolicyVersion: getInputValue(event) })}
					/>
				</label>

				<label>
					<span>Challenge handling</span>
					<select
						value={selectedConsentDraft.challengeExperience}
						onchange={(event) =>
							updateSelectedConsentDraft({
								challengeExperience: getInputValue(
									event
								) as DestinationConsentSettingsDraft['challengeExperience']
							})}
					>
						<option value="login_flow">Login flow challenge</option>
						<option value="step_up_required">Step-up required</option>
					</select>
				</label>

				<label class="checkbox-row">
					<input
						type="checkbox"
						checked={selectedConsentDraft.regulatedPurposeGuard}
						onchange={(event) =>
							updateSelectedConsentDraft({
								regulatedPurposeGuard: getCheckboxValue(event)
							})}
					/>
					<span>Require purpose guard for regulated attributes</span>
				</label>
			</div>

			<div class="consent-preview">
				<span>Preview</span>
				<strong>{summarizeDestinationConsentSettings(selectedConsentDraft)}</strong>
				<small>Raw attribute values remain {selectedConsentDraft.rawValueDisplay}.</small>
			</div>
		</section>
	{/if}
</div>

<style>
	.profiles-page {
		display: grid;
		gap: 18px;
	}

	.page-heading,
	.panel-heading,
	.profile-heading,
	.action-row,
	.profile-actions {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 18px;
	}

	.action-row,
	.profile-actions {
		align-items: center;
		justify-content: flex-start;
	}

	.back-link,
	.action-row a {
		display: inline-flex;
		color: var(--color-primary);
		font-size: 13px;
		font-weight: 700;
		text-decoration: none;
	}

	.back-link {
		margin-bottom: 12px;
	}

	.eyebrow,
	.status-panel span,
	.metrics-grid span,
	.profile-heading span,
	.profile-grid small,
	label span {
		margin: 0;
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 800;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	h1,
	h2,
	p {
		margin: 0;
	}

	h1 {
		color: var(--text-primary);
		font-size: 28px;
	}

	h2,
	.status-panel strong,
	.metrics-grid strong,
	.profile-heading strong {
		color: var(--text-primary);
	}

	h2 {
		font-size: 16px;
		line-height: 1.35;
	}

	.summary,
	.profile-grid p,
	.action-row span {
		color: var(--text-secondary);
		font-size: 13px;
		line-height: 1.45;
	}

	.summary {
		max-width: 820px;
		margin-top: 8px;
		font-size: 14px;
	}

	.status-panel,
	.profiles-panel,
	.consent-panel,
	.empty-state,
	.profile-grid article,
	.csv-detail,
	.metrics-grid div,
	.warning-list div {
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--bg-card);
	}

	.status-panel {
		min-width: 260px;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
		padding: 14px;
	}

	.status-panel strong,
	.metrics-grid strong {
		display: block;
		margin-top: 4px;
		font-size: 22px;
	}

	.profiles-panel,
	.consent-panel,
	.csv-detail {
		display: grid;
		gap: 14px;
		padding: 16px;
	}

	.filter-bar {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	button {
		min-height: 34px;
		padding: 0 12px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		color: var(--text-secondary);
		background: var(--bg-card);
		font-weight: 800;
		text-transform: capitalize;
	}

	button.active {
		color: var(--text-primary);
		border-color: var(--color-primary);
		background: var(--bg-hover);
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	input,
	select {
		min-height: 36px;
		width: 100%;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		color: var(--text-primary);
		background: var(--bg-card);
		padding: 0 10px;
	}

	label {
		display: grid;
		gap: 6px;
	}

	pre {
		overflow: auto;
		margin: 0;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		padding: 12px;
		color: var(--text-secondary);
		background: var(--bg-hover);
	}

	.empty-state {
		padding: 18px;
		color: var(--text-secondary);
	}

	.profile-grid,
	.metrics-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 12px;
	}

	.profile-grid article {
		display: grid;
		gap: 8px;
		padding: 14px;
	}

	.profile-grid article.selected {
		border-color: var(--color-primary);
		background: var(--bg-hover);
	}

	.metrics-grid div {
		padding: 14px;
	}

	.settings-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 12px;
	}

	.parser-grid {
		grid-template-columns: minmax(260px, 2fr) repeat(3, minmax(0, 1fr));
	}

	.column-table {
		display: grid;
		gap: 8px;
	}

	.column-header,
	.column-row {
		display: grid;
		grid-template-columns: 1.2fr 1.2fr 0.9fr 0.9fr 90px 90px;
		gap: 8px;
		align-items: center;
	}

	.column-header {
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 800;
		text-transform: uppercase;
	}

	.mini-check,
	.checkbox-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.mini-check input,
	.checkbox-row input {
		width: auto;
		min-height: auto;
	}

	.warning-list {
		display: grid;
		gap: 8px;
	}

	.warning-list div {
		display: grid;
		gap: 4px;
		padding: 12px;
	}

	.warning-list span,
	.consent-preview small {
		color: var(--text-secondary);
	}

	.consent-preview {
		display: grid;
		gap: 4px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--bg-hover);
		padding: 14px;
	}

	.consent-preview span {
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 800;
		text-transform: uppercase;
	}

	.consent-preview strong {
		color: var(--text-primary);
	}

	@media (max-width: 1020px) {
		.page-heading,
		.panel-heading {
			display: grid;
		}

		.status-panel,
		.settings-grid,
		.parser-grid,
		.profile-grid,
		.metrics-grid {
			grid-template-columns: 1fr;
		}

		.column-header {
			display: none;
		}

		.column-row {
			grid-template-columns: 1fr;
			border: 1px solid var(--border-color);
			border-radius: 8px;
			padding: 10px;
		}
	}
</style>
