<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingDestinationProfileSummary,
		type IdentityMappingExternalSchemaSummary,
		type IdentityMappingOidcCustomClaim,
		type IdentityMappingOidcCustomScope,
		type IdentityMappingOidcSurface,
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
	type ProfileTab = 'sources' | 'destinations' | 'registries';
	type CsvCreateMode = 'upload' | 'manual';
	type CsvDetailTab = 'summary' | 'parser' | 'columns' | 'warnings';
	type DestinationKind = 'oidc' | 'csv';

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
		destinationProfileId?: string;
		destinationProfileVersionId?: string;
	}

	interface OidcClaimDraft {
		claimName: string;
		label: string;
		valueType: string;
		classification: string;
		surfaces: IdentityMappingOidcSurface[];
		requiredScopes: string;
		releaseCondition: string;
		formatter: string;
	}

	interface CsvDestinationColumnDraft {
		columnName: string;
		label: string;
		order: number;
		valueType: string;
		classification: string;
		required: boolean;
		formatter: string;
		nullHandling: string;
		requiredMissingPolicy: string;
		legalBasis: string;
		purpose: string;
	}

	const profileKinds: Array<ProfileKind | 'all'> = ['all', 'inbound', 'outbound', 'template'];
	const profileTabs: ProfileTab[] = ['sources', 'destinations', 'registries'];
	const valueTypeOptions = ['string', 'email', 'phone', 'number', 'boolean', 'date', 'datetime'];
	const classificationOptions = ['internal', 'public', 'pii', 'regulated', 'secret'];
	const ownerScopeOptions = ['tenant', 'platform', 'client'];
	const registryOwnerScopeOptions = ['tenant', 'platform'];
	const oidcSurfaceOptions: IdentityMappingOidcSurface[] = ['id_token', 'userinfo'];
	const nullHandlingOptions = ['empty', 'omit', 'literal_null'];
	const requiredMissingPolicyOptions = ['error', 'review', 'omit'];
	const oidcClaimsParameterPlaceholder =
		'{"userinfo":{"email":{"essential":true}},"acr_values":["urn:authrim:loa:2"]}';
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
	let activeTab = $state<ProfileTab>('sources');
	let activeKind = $state<ProfileKind | 'all'>('all');
	let selectedProfileId = $state<string | null>(null);
	let protocolSchemaOptions = $state<IdentityMappingProtocolSchemaSummary[]>([]);
	let customScopes = $state<IdentityMappingOidcCustomScope[]>([]);
	let customClaims = $state<IdentityMappingOidcCustomClaim[]>([]);
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
	let destinationKind = $state<DestinationKind>('oidc');
	let destinationDisplayName = $state('');
	let destinationProfileKey = $state('');
	let destinationVersionLabel = $state('v1');
	let destinationOwnerScopeType = $state<'tenant' | 'platform' | 'client'>('tenant');
	let destinationOwnerScopeId = $state('');
	let destinationProtocolSchemaRef = $state('');
	let destinationBlockingWarningsConfirmed = $state(false);
	let savingDestination = $state(false);
	let deletingProfileId = $state<string | null>(null);
	let oidcClaimsParameterJson = $state('');
	let oidcClaims = $state<OidcClaimDraft[]>([
		createOidcClaimDraft(
			'sub',
			'Subject',
			'string',
			'internal',
			['id_token', 'userinfo'],
			'openid'
		),
		createOidcClaimDraft('email', 'Email', 'email', 'pii', ['userinfo'], 'email')
	]);
	let csvDestinationEncoding = $state('utf-8');
	let csvDestinationIncludeHeader = $state(true);
	let csvDestinationNullHandling = $state('empty');
	let csvDestinationRequiredMissingPolicy = $state('review');
	let csvDestinationColumns = $state<CsvDestinationColumnDraft[]>([
		createCsvDestinationColumnDraft('email', 'Email', 1, 'email', 'pii')
	]);
	let scopeKey = $state('');
	let scopeDisplayName = $state('');
	let scopeDescription = $state('');
	let scopeOwnerScopeType = $state<'tenant' | 'platform'>('tenant');
	let scopeAllowedClaims = $state('');
	let claimName = $state('');
	let claimDisplayName = $state('');
	let claimValueType = $state('string');
	let claimClassification = $state('internal');
	let claimOwnerScopeType = $state<'tenant' | 'platform'>('tenant');
	let claimSurfaces = $state<IdentityMappingOidcSurface[]>(['userinfo']);
	let savingRegistry = $state(false);

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
	const destinationBlockingWarningCount = $derived(getDestinationBlockingWarningCount());
	const canSaveCsv = $derived(
		Boolean(csvDisplayName.trim()) &&
			Boolean(csvProfileKey.trim()) &&
			Boolean(activeCsvSchema) &&
			(csvBlockingWarningCount === 0 || blockingWarningsConfirmed)
	);
	const canSaveDestination = $derived(
		Boolean(destinationDisplayName.trim()) &&
			Boolean(destinationProfileKey.trim()) &&
			(destinationKind === 'oidc'
				? oidcClaims.some((claim) => claim.claimName.trim() === 'sub')
				: csvDestinationColumns.length > 0) &&
			(destinationBlockingWarningCount === 0 || destinationBlockingWarningsConfirmed)
	);

	async function loadProfiles() {
		loading = true;
		errorMessage = null;
		try {
			const [
				protocolSchemas,
				externalSchemas,
				loadedSourceProfiles,
				loadedDestinationProfiles,
				loadedCustomScopes,
				loadedCustomClaims,
				templates
			] = await Promise.all([
				adminIdentityMappingAPI.listProtocolSchemas(),
				adminIdentityMappingAPI.listExternalSchemas(),
				adminIdentityMappingAPI.listSourceProfiles(),
				adminIdentityMappingAPI.listDestinationProfiles(),
				adminIdentityMappingAPI.listOidcCustomScopes(),
				adminIdentityMappingAPI.listOidcCustomClaims(),
				adminIdentityMappingAPI.listTemplates()
			]);
			customScopes = loadedCustomScopes.customScopes;
			customClaims = loadedCustomClaims.customClaims;
			protocolSchemaOptions = protocolSchemas.protocolSchemas;
			const loadedProfiles = [
				...loadedSourceProfiles.sourceProfiles.map(sourceProfileToProfile),
				...loadedDestinationProfiles.destinationProfiles.map(destinationProfileToProfile),
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
			event.currentTarget instanceof HTMLSelectElement ||
			event.currentTarget instanceof HTMLTextAreaElement
			? event.currentTarget.value
			: '';
	}

	function getCheckboxValue(event: Event): boolean {
		return event.currentTarget instanceof HTMLInputElement ? event.currentTarget.checked : false;
	}

	function sourceProfileToProfile(profile: IdentityMappingSourceProfileSummary): ProfileItem {
		return {
			id: `source:${profile.id}`,
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

	function destinationProfileToProfile(
		profile: IdentityMappingDestinationProfileSummary
	): ProfileItem {
		return {
			id: `destination:${profile.id}`,
			kind: 'outbound',
			protocol: profile.destinationType.toUpperCase(),
			displayName: profile.displayName,
			versionLabel: profile.version?.versionLabel ?? 'draft',
			lifecycleState: profile.version?.lifecycleState ?? profile.lifecycleState,
			source: `${profile.ownerScopeType} / ${profile.profileKey}`,
			destinationProfileId: profile.id,
			destinationProfileVersionId: profile.version?.id
		};
	}

	function protocolSchemaToProfile(schema: IdentityMappingProtocolSchemaSummary): ProfileItem {
		return {
			id: `protocol:${schema.id}`,
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
			id: `external:${schema.id}`,
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
			id: `template:${template.id}`,
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
		if (profile.lifecycleState !== 'reviewed' && profile.lifecycleState !== 'active') {
			createMessage = `Review ${profile.displayName} before activating it.`;
			return;
		}
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

	async function saveDestinationProfile() {
		if (!canSaveDestination) {
			createMessage = 'Complete the destination profile and confirm blocking release warnings.';
			return;
		}
		savingDestination = true;
		createMessage = null;
		try {
			const schema =
				destinationKind === 'oidc' ? buildOidcDestinationSchema() : buildCsvDestinationSchema();
			const response = await adminIdentityMappingAPI.createDestinationProfile({
				destinationType: destinationKind,
				profileKey: destinationProfileKey.trim(),
				displayName: destinationDisplayName.trim(),
				versionLabel: destinationVersionLabel.trim() || 'v1',
				ownerScopeType: destinationOwnerScopeType,
				ownerScopeId:
					destinationOwnerScopeType === 'tenant' ? null : destinationOwnerScopeId.trim(),
				schema,
				warningSummary: {
					blockingWarningCount: destinationBlockingWarningCount,
					confirmedBlockingWarningCount: destinationBlockingWarningsConfirmed
						? destinationBlockingWarningCount
						: 0
				}
			});
			createMessage = `Saved ${response.result.displayName}. Review and activate it before Flow Editor use.`;
			resetDestinationComposer();
			await loadProfiles();
			activeTab = 'destinations';
		} catch (error) {
			createMessage = error instanceof Error ? error.message : 'Failed to save destination profile';
		} finally {
			savingDestination = false;
		}
	}

	async function reviewDestinationProfile(profile: ProfileItem) {
		if (!profile.destinationProfileId || !profile.destinationProfileVersionId) return;
		try {
			await adminIdentityMappingAPI.reviewDestinationProfileVersion(
				profile.destinationProfileId,
				profile.destinationProfileVersionId
			);
			createMessage = `Reviewed ${profile.displayName}.`;
			await loadProfiles();
		} catch (error) {
			createMessage =
				error instanceof Error
					? error.message
					: 'Failed to review identity mapping destination profile';
		}
	}

	async function activateDestinationProfile(profile: ProfileItem) {
		if (!profile.destinationProfileId || !profile.destinationProfileVersionId) return;
		if (profile.lifecycleState !== 'reviewed' && profile.lifecycleState !== 'active') {
			createMessage = `Review ${profile.displayName} before activating it.`;
			return;
		}
		try {
			await adminIdentityMappingAPI.activateDestinationProfileVersion(
				profile.destinationProfileId,
				profile.destinationProfileVersionId
			);
			createMessage = `Activated ${profile.displayName}.`;
			await loadProfiles();
		} catch (error) {
			createMessage =
				error instanceof Error
					? error.message
					: 'Failed to activate identity mapping destination profile';
		}
	}

	async function deleteProfile(profile: ProfileItem) {
		if (profile.kind !== 'inbound' && profile.kind !== 'outbound') return;
		const profileId = profile.sourceProfileId ?? profile.destinationProfileId;
		if (!profileId) return;
		const confirmed = window.confirm(
			`Delete ${profile.displayName}? This removes the profile and its versions. Existing draft graph references may need to be reconnected.`
		);
		if (!confirmed) return;
		deletingProfileId = profile.id;
		createMessage = null;
		try {
			if (profile.sourceProfileId) {
				await adminIdentityMappingAPI.deleteSourceProfile(profile.sourceProfileId);
			} else if (profile.destinationProfileId) {
				await adminIdentityMappingAPI.deleteDestinationProfile(profile.destinationProfileId);
			}
			if (selectedProfileId === profile.id) {
				selectedProfileId = null;
			}
			consentDrafts = Object.fromEntries(
				Object.entries(consentDrafts).filter(([key]) => key !== profile.id)
			);
			createMessage = `Deleted ${profile.displayName}.`;
			await loadProfiles();
		} catch (error) {
			createMessage = error instanceof Error ? error.message : 'Failed to delete profile';
		} finally {
			deletingProfileId = null;
		}
	}

	async function saveCustomScope() {
		savingRegistry = true;
		createMessage = null;
		try {
			await adminIdentityMappingAPI.createOidcCustomScope({
				scopeKey: scopeKey.trim(),
				displayName: scopeDisplayName.trim(),
				description: scopeDescription.trim() || null,
				ownerScopeType: scopeOwnerScopeType,
				allowedClaims: splitCsv(scopeAllowedClaims)
			});
			scopeKey = '';
			scopeDisplayName = '';
			scopeDescription = '';
			scopeAllowedClaims = '';
			createMessage = 'Saved OIDC custom scope.';
			await loadProfiles();
			activeTab = 'registries';
		} catch (error) {
			createMessage = error instanceof Error ? error.message : 'Failed to save OIDC custom scope';
		} finally {
			savingRegistry = false;
		}
	}

	async function saveCustomClaim() {
		savingRegistry = true;
		createMessage = null;
		try {
			await adminIdentityMappingAPI.createOidcCustomClaim({
				claimName: claimName.trim(),
				displayName: claimDisplayName.trim(),
				valueType: claimValueType,
				classification: claimClassification,
				ownerScopeType: claimOwnerScopeType,
				allowedSurfaces: claimSurfaces
			});
			claimName = '';
			claimDisplayName = '';
			claimValueType = 'string';
			claimClassification = 'internal';
			claimSurfaces = ['userinfo'];
			createMessage = 'Saved OIDC custom claim.';
			await loadProfiles();
			activeTab = 'registries';
		} catch (error) {
			createMessage = error instanceof Error ? error.message : 'Failed to save OIDC custom claim';
		} finally {
			savingRegistry = false;
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

	function updateOidcClaim(index: number, field: keyof OidcClaimDraft, value: string) {
		oidcClaims = oidcClaims.map((claim, claimIndex) =>
			claimIndex === index ? { ...claim, [field]: value } : claim
		);
	}

	function toggleOidcClaimSurface(
		index: number,
		surface: IdentityMappingOidcSurface,
		checked: boolean
	) {
		oidcClaims = oidcClaims.map((claim, claimIndex) => {
			if (claimIndex !== index) return claim;
			const surfaces = checked
				? Array.from(new Set([...claim.surfaces, surface]))
				: claim.surfaces.filter((item) => item !== surface);
			return { ...claim, surfaces };
		});
	}

	function addOidcClaim() {
		oidcClaims = [
			...oidcClaims,
			createOidcClaimDraft(`custom_claim_${oidcClaims.length + 1}`, 'Custom claim')
		];
	}

	function removeOidcClaim(index: number) {
		oidcClaims = oidcClaims.filter((_, claimIndex) => claimIndex !== index);
	}

	function updateCsvDestinationColumn(
		index: number,
		field: keyof CsvDestinationColumnDraft,
		value: string | boolean
	) {
		csvDestinationColumns = csvDestinationColumns.map((column, columnIndex) =>
			columnIndex === index ? { ...column, [field]: value } : column
		);
	}

	function addCsvDestinationColumn() {
		const order = csvDestinationColumns.length + 1;
		csvDestinationColumns = [
			...csvDestinationColumns,
			createCsvDestinationColumnDraft(`column_${order}`, `Column ${order}`, order)
		];
	}

	function removeCsvDestinationColumn(index: number) {
		csvDestinationColumns = csvDestinationColumns.filter((_, columnIndex) => columnIndex !== index);
	}

	function toggleClaimSurface(surface: IdentityMappingOidcSurface, checked: boolean) {
		claimSurfaces = checked
			? Array.from(new Set([...claimSurfaces, surface]))
			: claimSurfaces.filter((item) => item !== surface);
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

	function createOidcClaimDraft(
		claimName: string,
		label: string,
		valueType = 'string',
		classification = 'internal',
		surfaces: IdentityMappingOidcSurface[] = ['userinfo'],
		requiredScopes = ''
	): OidcClaimDraft {
		return {
			claimName,
			label,
			valueType,
			classification,
			surfaces,
			requiredScopes,
			releaseCondition: '',
			formatter: ''
		};
	}

	function createCsvDestinationColumnDraft(
		columnName: string,
		label: string,
		order: number,
		valueType = 'string',
		classification = 'internal'
	): CsvDestinationColumnDraft {
		return {
			columnName,
			label,
			order,
			valueType,
			classification,
			required: false,
			formatter: '',
			nullHandling: csvDestinationNullHandling,
			requiredMissingPolicy: csvDestinationRequiredMissingPolicy,
			legalBasis: classification === 'pii' ? 'consent' : 'legitimate_interest',
			purpose: 'attribute_release'
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

	function buildOidcDestinationSchema(): Record<string, unknown> {
		return {
			destinationType: 'oidc',
			subjectContract: {
				required: true,
				strategySource: 'tenant_default_with_client_override'
			},
			claims: oidcClaims.map((claim) => ({
				claimName: claim.claimName.trim(),
				label: claim.label.trim() || claim.claimName.trim(),
				valueType: claim.valueType,
				classification: claim.classification,
				surfaces: claim.surfaces,
				requiredScopes: splitCsv(claim.requiredScopes),
				releaseCondition: claim.releaseCondition.trim() || undefined,
				formatter: claim.formatter.trim() ? { operation: claim.formatter.trim() } : undefined
			})),
			protocolSchemaRef: destinationProtocolSchemaRef
				? { type: 'protocol_schema', id: destinationProtocolSchemaRef }
				: undefined,
			claimsParameter: parseOptionalJsonObject(oidcClaimsParameterJson, 'claims parameter policy')
		};
	}

	function buildCsvDestinationSchema(): Record<string, unknown> {
		return {
			destinationType: 'csv',
			defaults: {
				encoding: csvDestinationEncoding,
				includeHeader: csvDestinationIncludeHeader,
				nullHandling: csvDestinationNullHandling,
				requiredMissingPolicy: csvDestinationRequiredMissingPolicy
			},
			columns: csvDestinationColumns.map((column) => ({
				columnName: column.columnName.trim(),
				label: column.label.trim() || column.columnName.trim(),
				order: column.order,
				valueType: column.valueType,
				classification: column.classification,
				required: column.required,
				formatter: column.formatter.trim() ? { operation: column.formatter.trim() } : undefined,
				nullHandling: column.nullHandling,
				requiredMissingPolicy: column.requiredMissingPolicy,
				exportPolicy: {
					legalBasis: column.legalBasis,
					purpose: column.purpose.trim() || 'attribute_release'
				}
			})),
			protocolSchemaRef: destinationProtocolSchemaRef
				? { type: 'protocol_schema', id: destinationProtocolSchemaRef }
				: undefined
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

	function getDestinationBlockingWarningCount(): number {
		if (destinationKind === 'oidc') {
			return oidcClaims.filter(
				(claim) =>
					['pii', 'regulated'].includes(claim.classification) &&
					splitCsv(claim.requiredScopes).length === 0
			).length;
		}
		return csvDestinationColumns.filter(
			(column) =>
				['pii', 'regulated'].includes(column.classification) &&
				(!column.legalBasis.trim() || !column.purpose.trim())
		).length;
	}

	function resetCsvComposer() {
		selectedCsvFile = null;
		parsedCsvDraftId = null;
		parsedCsvSchema = null;
		parsedCsvParserOptions = {};
		parsedCsvWarningSummary = {};
		blockingWarningsConfirmed = false;
	}

	function resetDestinationComposer() {
		destinationDisplayName = '';
		destinationProfileKey = '';
		destinationVersionLabel = 'v1';
		destinationOwnerScopeType = 'tenant';
		destinationOwnerScopeId = '';
		destinationProtocolSchemaRef = '';
		destinationBlockingWarningsConfirmed = false;
		oidcClaimsParameterJson = '';
		oidcClaims = [
			createOidcClaimDraft(
				'sub',
				'Subject',
				'string',
				'internal',
				['id_token', 'userinfo'],
				'openid'
			),
			createOidcClaimDraft('email', 'Email', 'email', 'pii', ['userinfo'], 'email')
		];
		csvDestinationColumns = [createCsvDestinationColumnDraft('email', 'Email', 1, 'email', 'pii')];
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

	function splitCsv(value: string): string[] {
		return value
			.split(',')
			.map((item) => item.trim())
			.filter(Boolean);
	}

	function parseOptionalJsonObject(
		value: string,
		label: string
	): Record<string, unknown> | undefined {
		if (!value.trim()) return undefined;
		try {
			const parsed = JSON.parse(value) as unknown;
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// Fall through to the stable UI error below.
		}
		throw new Error(`${label} must be a valid JSON object`);
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

	<div class="profile-tabs" aria-label="Profile workspace tabs">
		{#each profileTabs as tab (tab)}
			<button type="button" class:active={activeTab === tab} onclick={() => (activeTab = tab)}>
				{tab}
			</button>
		{/each}
	</div>

	{#if activeTab === 'sources'}
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
						<select
							value={csvDelimiter}
							onchange={(event) => (csvDelimiter = getInputValue(event))}
						>
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
					<button
						type="button"
						onclick={parseSelectedCsv}
						disabled={parsingCsv || !selectedCsvFile}
					>
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
	{:else if activeTab === 'destinations'}
		<section class="profiles-panel">
			<div class="panel-heading">
				<div>
					<p class="eyebrow">Create Destination Profile</p>
					<h2>{destinationKind.toUpperCase()} destination profile</h2>
				</div>
				<div class="filter-bar" aria-label="Destination profile type">
					<button
						type="button"
						class:active={destinationKind === 'oidc'}
						onclick={() => (destinationKind = 'oidc')}
					>
						OIDC
					</button>
					<button
						type="button"
						class:active={destinationKind === 'csv'}
						onclick={() => (destinationKind = 'csv')}
					>
						CSV
					</button>
				</div>
			</div>

			<div class="settings-grid">
				<label>
					<span>Display name</span>
					<input
						value={destinationDisplayName}
						placeholder={destinationKind === 'oidc' ? 'Library OIDC claims' : 'Weekly CSV export'}
						oninput={(event) => {
							destinationDisplayName = getInputValue(event);
							if (!destinationProfileKey.trim()) {
								destinationProfileKey = normalizeProfileKey(destinationDisplayName);
							}
						}}
					/>
				</label>
				<label>
					<span>Profile key</span>
					<input
						value={destinationProfileKey}
						placeholder={destinationKind === 'oidc' ? 'library_oidc' : 'weekly_csv_export'}
						oninput={(event) => (destinationProfileKey = normalizeProfileKey(getInputValue(event)))}
					/>
				</label>
				<label>
					<span>Version label</span>
					<input
						value={destinationVersionLabel}
						oninput={(event) => (destinationVersionLabel = getInputValue(event))}
					/>
				</label>
				<label>
					<span>Owner scope</span>
					<select
						value={destinationOwnerScopeType}
						onchange={(event) =>
							(destinationOwnerScopeType = getInputValue(
								event
							) as typeof destinationOwnerScopeType)}
					>
						{#each ownerScopeOptions as option (option)}
							<option value={option}>{option}</option>
						{/each}
					</select>
				</label>
				<label>
					<span>Owner scope ID</span>
					<input
						value={destinationOwnerScopeId}
						placeholder="client override id; platform can stay blank"
						disabled={destinationOwnerScopeType === 'tenant'}
						oninput={(event) => (destinationOwnerScopeId = getInputValue(event))}
					/>
				</label>
				<label>
					<span>Reference schema</span>
					<select
						value={destinationProtocolSchemaRef}
						onchange={(event) => (destinationProtocolSchemaRef = getInputValue(event))}
					>
						<option value="">No schema reference</option>
						{#each protocolSchemaOptions.filter((schema) => schema.protocol.toLowerCase() === destinationKind) as schema (schema.id)}
							<option value={schema.id}>{schema.displayName ?? schema.schemaKey}</option>
						{/each}
					</select>
				</label>
			</div>

			{#if destinationKind === 'oidc'}
				<div class="action-row">
					<button type="button" onclick={addOidcClaim}>Add claim</button>
					<span>OIDC sub is required. Subject strategy is tenant default with client override.</span
					>
				</div>
				<div class="claim-table">
					<div class="claim-header">
						<span>Claim</span>
						<span>Label</span>
						<span>Type</span>
						<span>Class</span>
						<span>Surfaces</span>
						<span>Scopes</span>
						<span></span>
					</div>
					{#each oidcClaims as claim, index (`${claim.claimName}-${index}`)}
						<div class="claim-row">
							<input
								value={claim.claimName}
								oninput={(event) => updateOidcClaim(index, 'claimName', getInputValue(event))}
							/>
							<input
								value={claim.label}
								oninput={(event) => updateOidcClaim(index, 'label', getInputValue(event))}
							/>
							<select
								value={claim.valueType}
								onchange={(event) => updateOidcClaim(index, 'valueType', getInputValue(event))}
							>
								{#each valueTypeOptions as option (option)}
									<option value={option}>{option}</option>
								{/each}
							</select>
							<select
								value={claim.classification}
								onchange={(event) => updateOidcClaim(index, 'classification', getInputValue(event))}
							>
								{#each classificationOptions as option (option)}
									<option value={option}>{option}</option>
								{/each}
							</select>
							<div class="surface-checks">
								{#each oidcSurfaceOptions as surface (surface)}
									<label class="mini-check">
										<input
											type="checkbox"
											checked={claim.surfaces.includes(surface)}
											onchange={(event) =>
												toggleOidcClaimSurface(index, surface, getCheckboxValue(event))}
										/>
										<span>{surface}</span>
									</label>
								{/each}
							</div>
							<input
								value={claim.requiredScopes}
								placeholder="openid,email"
								oninput={(event) => updateOidcClaim(index, 'requiredScopes', getInputValue(event))}
							/>
							<button
								type="button"
								onclick={() => removeOidcClaim(index)}
								disabled={claim.claimName === 'sub'}
							>
								Remove
							</button>
						</div>
					{/each}
				</div>
				<label>
					<span>Claims parameter policy JSON</span>
					<textarea
						rows="4"
						value={oidcClaimsParameterJson}
						placeholder={oidcClaimsParameterPlaceholder}
						oninput={(event) => (oidcClaimsParameterJson = getInputValue(event))}
					></textarea>
				</label>
			{:else}
				<div class="settings-grid">
					<label>
						<span>Encoding default</span>
						<select
							value={csvDestinationEncoding}
							onchange={(event) => (csvDestinationEncoding = getInputValue(event))}
						>
							<option value="utf-8">UTF-8</option>
							<option value="utf-8-bom">UTF-8 BOM</option>
							<option value="shift_jis">Shift_JIS</option>
							<option value="cp932">CP932</option>
						</select>
					</label>
					<label class="checkbox-row">
						<input
							type="checkbox"
							checked={csvDestinationIncludeHeader}
							onchange={(event) => (csvDestinationIncludeHeader = getCheckboxValue(event))}
						/>
						<span>Include header row by default</span>
					</label>
					<label>
						<span>Null handling default</span>
						<select
							value={csvDestinationNullHandling}
							onchange={(event) => (csvDestinationNullHandling = getInputValue(event))}
						>
							{#each nullHandlingOptions as option (option)}
								<option value={option}>{option}</option>
							{/each}
						</select>
					</label>
					<label>
						<span>Required missing policy</span>
						<select
							value={csvDestinationRequiredMissingPolicy}
							onchange={(event) => (csvDestinationRequiredMissingPolicy = getInputValue(event))}
						>
							{#each requiredMissingPolicyOptions as option (option)}
								<option value={option}>{option}</option>
							{/each}
						</select>
					</label>
				</div>
				<div class="action-row">
					<button type="button" onclick={addCsvDestinationColumn}>Add column</button>
					<span
						>CSV destination profiles define export shape only; delivery is configured by export
						jobs.</span
					>
				</div>
				<div class="column-table">
					<div class="destination-column-header">
						<span>Column</span>
						<span>Label</span>
						<span>Type</span>
						<span>Class</span>
						<span>Required</span>
						<span>Legal basis</span>
						<span>Purpose</span>
						<span></span>
					</div>
					{#each csvDestinationColumns as column, index (`${column.columnName}-${index}`)}
						<div class="destination-column-row">
							<input
								value={column.columnName}
								oninput={(event) =>
									updateCsvDestinationColumn(index, 'columnName', getInputValue(event))}
							/>
							<input
								value={column.label}
								oninput={(event) =>
									updateCsvDestinationColumn(index, 'label', getInputValue(event))}
							/>
							<select
								value={column.valueType}
								onchange={(event) =>
									updateCsvDestinationColumn(index, 'valueType', getInputValue(event))}
							>
								{#each valueTypeOptions as option (option)}
									<option value={option}>{option}</option>
								{/each}
							</select>
							<select
								value={column.classification}
								onchange={(event) =>
									updateCsvDestinationColumn(index, 'classification', getInputValue(event))}
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
										updateCsvDestinationColumn(index, 'required', getCheckboxValue(event))}
								/>
							</label>
							<input
								value={column.legalBasis}
								oninput={(event) =>
									updateCsvDestinationColumn(index, 'legalBasis', getInputValue(event))}
							/>
							<input
								value={column.purpose}
								oninput={(event) =>
									updateCsvDestinationColumn(index, 'purpose', getInputValue(event))}
							/>
							<button type="button" onclick={() => removeCsvDestinationColumn(index)}>Remove</button
							>
						</div>
					{/each}
				</div>
			{/if}

			{#if destinationBlockingWarningCount > 0}
				<label class="checkbox-row">
					<input
						type="checkbox"
						checked={destinationBlockingWarningsConfirmed}
						onchange={(event) => (destinationBlockingWarningsConfirmed = getCheckboxValue(event))}
					/>
					<span>Confirm blocking release warnings for this destination profile version</span>
				</label>
			{/if}

			<div class="impact-preview">
				<span>Release impact</span>
				<strong>
					{#if destinationKind === 'oidc'}
						{oidcClaims.length} claims, {oidcClaims.filter(
							(claim) => claim.classification === 'pii'
						).length}
						PII claims
					{:else}
						{csvDestinationColumns.length} columns, {csvDestinationColumns.filter(
							(column) => column.classification === 'pii'
						).length}
						PII columns
					{/if}
				</strong>
				<small>{destinationBlockingWarningCount} blocking warning(s)</small>
			</div>

			<div class="action-row">
				<button
					type="button"
					onclick={saveDestinationProfile}
					disabled={savingDestination || !canSaveDestination}
				>
					{savingDestination ? 'Saving...' : 'Save destination draft'}
				</button>
				<a href="/admin/identity-mapping">Open Flow Editor</a>
			</div>

			{#if createMessage}
				<div class="empty-state">{createMessage}</div>
			{/if}
		</section>
	{:else}
		<section class="profiles-panel">
			<div class="panel-heading">
				<div>
					<p class="eyebrow">OIDC Registries</p>
					<h2>Custom scopes and claims</h2>
				</div>
				<button type="button" onclick={loadProfiles} disabled={loading}>Refresh</button>
			</div>
			<div class="registry-grid">
				<div class="registry-card">
					<h2>Custom scope</h2>
					<label>
						<span>Scope key</span>
						<input
							value={scopeKey}
							placeholder="library"
							oninput={(event) => (scopeKey = getInputValue(event))}
						/>
					</label>
					<label>
						<span>Display name</span>
						<input
							value={scopeDisplayName}
							placeholder="Library"
							oninput={(event) => (scopeDisplayName = getInputValue(event))}
						/>
					</label>
					<label>
						<span>Owner scope</span>
						<select
							value={scopeOwnerScopeType}
							onchange={(event) =>
								(scopeOwnerScopeType = getInputValue(event) as typeof scopeOwnerScopeType)}
						>
							{#each registryOwnerScopeOptions as option (option)}
								<option value={option}>{option}</option>
							{/each}
						</select>
					</label>
					<label>
						<span>Allowed claims</span>
						<input
							value={scopeAllowedClaims}
							placeholder="library_card,patron_type"
							oninput={(event) => (scopeAllowedClaims = getInputValue(event))}
						/>
					</label>
					<label>
						<span>Description</span>
						<input
							value={scopeDescription}
							oninput={(event) => (scopeDescription = getInputValue(event))}
						/>
					</label>
					<button
						type="button"
						onclick={saveCustomScope}
						disabled={savingRegistry || !scopeKey.trim() || !scopeDisplayName.trim()}
					>
						Save custom scope
					</button>
				</div>
				<div class="registry-card">
					<h2>Custom claim</h2>
					<label>
						<span>Claim name</span>
						<input
							value={claimName}
							placeholder="library_card"
							oninput={(event) => (claimName = getInputValue(event))}
						/>
					</label>
					<label>
						<span>Display name</span>
						<input
							value={claimDisplayName}
							placeholder="Library card"
							oninput={(event) => (claimDisplayName = getInputValue(event))}
						/>
					</label>
					<label>
						<span>Owner scope</span>
						<select
							value={claimOwnerScopeType}
							onchange={(event) =>
								(claimOwnerScopeType = getInputValue(event) as typeof claimOwnerScopeType)}
						>
							{#each registryOwnerScopeOptions as option (option)}
								<option value={option}>{option}</option>
							{/each}
						</select>
					</label>
					<label>
						<span>Value type</span>
						<select
							value={claimValueType}
							onchange={(event) => (claimValueType = getInputValue(event))}
						>
							{#each valueTypeOptions as option (option)}
								<option value={option}>{option}</option>
							{/each}
						</select>
					</label>
					<label>
						<span>Classification</span>
						<select
							value={claimClassification}
							onchange={(event) => (claimClassification = getInputValue(event))}
						>
							{#each classificationOptions as option (option)}
								<option value={option}>{option}</option>
							{/each}
						</select>
					</label>
					<div class="surface-checks">
						{#each oidcSurfaceOptions as surface (surface)}
							<label class="mini-check">
								<input
									type="checkbox"
									checked={claimSurfaces.includes(surface)}
									onchange={(event) => toggleClaimSurface(surface, getCheckboxValue(event))}
								/>
								<span>{surface}</span>
							</label>
						{/each}
					</div>
					<button
						type="button"
						onclick={saveCustomClaim}
						disabled={savingRegistry ||
							!claimName.trim() ||
							!claimDisplayName.trim() ||
							claimSurfaces.length === 0}
					>
						Save custom claim
					</button>
				</div>
			</div>
			<div class="registry-grid">
				<div class="registry-card">
					<h2>Scopes</h2>
					{#each customScopes as scope (scope.id)}
						<p><strong>{scope.scopeKey}</strong> / {scope.allowedClaims.join(', ')}</p>
					{:else}
						<p>No custom scopes registered.</p>
					{/each}
				</div>
				<div class="registry-card">
					<h2>Claims</h2>
					{#each customClaims as claim (claim.id)}
						<p>
							<strong>{claim.claimName}</strong> / {claim.classification} / {claim.allowedSurfaces.join(
								', '
							)}
						</p>
					{:else}
						<p>No custom claims registered.</p>
					{/each}
				</div>
			</div>
			{#if createMessage}
				<div class="empty-state">{createMessage}</div>
			{/if}
		</section>
	{/if}

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
								<button
									type="button"
									disabled={profile.lifecycleState !== 'reviewed' && profile.lifecycleState !== 'active'}
									title={profile.lifecycleState === 'draft'
										? 'Review this profile before activation.'
										: undefined}
									onclick={() => activateSourceProfile(profile)}
									>Activate</button
								>
							</div>
						{/if}
						{#if profile.destinationProfileId && profile.destinationProfileVersionId}
							<div class="profile-actions">
								<button type="button" onclick={() => reviewDestinationProfile(profile)}
									>Review</button
								>
								<button
									type="button"
									disabled={profile.lifecycleState !== 'reviewed' && profile.lifecycleState !== 'active'}
									title={profile.lifecycleState === 'draft'
										? 'Review this profile before activation.'
										: undefined}
									onclick={() => activateDestinationProfile(profile)}
									>Activate</button
								>
							</div>
						{/if}
						{#if profile.sourceProfileId || profile.destinationProfileId}
							<div class="profile-actions danger-actions">
								<button
									type="button"
									class="danger-button"
									disabled={deletingProfileId === profile.id}
									onclick={() => deleteProfile(profile)}
								>
									{deletingProfileId === profile.id ? 'Deleting...' : 'Delete'}
								</button>
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

	.danger-actions {
		margin-top: 4px;
	}

	.danger-button {
		border-color: color-mix(in srgb, var(--color-danger, #dc2626) 45%, var(--border-color));
		color: var(--color-danger, #dc2626);
	}

	.danger-button:hover:not(:disabled),
	.danger-button:focus-visible:not(:disabled) {
		border-color: var(--color-danger, #dc2626);
		background: color-mix(in srgb, var(--color-danger, #dc2626) 10%, transparent);
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
	.registry-card,
	.impact-preview,
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

	.profile-tabs {
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
	select,
	textarea {
		min-height: 36px;
		width: 100%;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		color: var(--text-primary);
		background: var(--bg-card);
		padding: 0 10px;
	}

	textarea {
		min-height: 92px;
		padding: 10px;
		resize: vertical;
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
		overflow-x: auto;
	}

	.claim-table {
		display: grid;
		gap: 8px;
		overflow-x: auto;
	}

	.column-header,
	.column-row,
	.claim-header,
	.claim-row,
	.destination-column-header,
	.destination-column-row {
		display: grid;
		gap: 8px;
		align-items: center;
	}

	.column-header,
	.column-row {
		grid-template-columns: 1.2fr 1.2fr 0.9fr 0.9fr 90px 90px;
	}

	.claim-header,
	.claim-row {
		grid-template-columns: 1fr 1fr 0.8fr 0.8fr 1.2fr 1fr 90px;
		min-width: 980px;
	}

	.destination-column-header,
	.destination-column-row {
		grid-template-columns: 1fr 1fr 0.8fr 0.8fr 80px 1fr 1fr 90px;
		min-width: 1040px;
	}

	.column-header,
	.claim-header,
	.destination-column-header {
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 800;
		text-transform: uppercase;
	}

	.mini-check,
	.checkbox-row,
	.surface-checks {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.surface-checks {
		flex-wrap: wrap;
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

	.impact-preview,
	.registry-card {
		display: grid;
		gap: 10px;
		padding: 14px;
	}

	.impact-preview span,
	.registry-card p {
		color: var(--text-secondary);
		font-size: 13px;
	}

	.impact-preview strong {
		color: var(--text-primary);
	}

	.registry-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
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
		.registry-grid,
		.metrics-grid {
			grid-template-columns: 1fr;
		}

		.column-header,
		.claim-header,
		.destination-column-header {
			display: none;
		}

		.column-row,
		.claim-row,
		.destination-column-row {
			grid-template-columns: 1fr;
			min-width: 0;
			border: 1px solid var(--border-color);
			border-radius: 8px;
			padding: 10px;
		}
	}
</style>
