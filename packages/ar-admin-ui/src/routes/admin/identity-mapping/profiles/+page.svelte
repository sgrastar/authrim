<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingAttributeField,
		type IdentityMappingAttributeGroup,
		type IdentityMappingAttributeProtocol,
		type IdentityMappingDestinationProfileSummary,
		type IdentityMappingExternalSchemaSummary,
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
	import {
		destinationTemplates,
		type DestinationTemplate
	} from '$lib/admin/identity-mapping-destination-templates';

	type ProfileKind = 'inbound' | 'outbound' | 'template';
	type ProfileTab = 'sources' | 'destinations' | 'registries';
	type CsvCreateMode = 'upload' | 'manual';
	type CsvDetailTab = 'summary' | 'parser' | 'columns' | 'warnings';
	type DestinationKind = 'oidc' | 'csv' | 'saml';

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
		destinationTemplateId?: string;
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

	interface SamlAttributeDraft {
		name: string;
		label: string;
		nameFormat: string;
		valueType: string;
		classification: string;
		required: boolean;
		releaseCondition: string;
		formatter: string;
		legalBasis: string;
		purpose: string;
	}

	const profileKinds: Array<ProfileKind | 'all'> = ['all', 'inbound', 'outbound', 'template'];
	const profileTabs: ProfileTab[] = ['sources', 'destinations', 'registries'];
	const valueTypeOptions = [
		'string',
		'email',
		'phone',
		'number',
		'boolean',
		'json',
		'date',
		'datetime'
	];
	const classificationOptions = ['internal', 'public', 'pii', 'regulated', 'secret'];
	const ownerScopeOptions = ['tenant', 'platform', 'client'];
	const registryOwnerScopeOptions = ['tenant', 'platform'];
	const attributeProtocolOptions: IdentityMappingAttributeProtocol[] = ['oidc', 'saml', 'vc'];
	const attributeGroupTypeOptions = [
		'scope',
		'attribute_release',
		'credential_type',
		'presentation_definition'
	];
	const oidcSurfaceOptions: IdentityMappingOidcSurface[] = ['id_token', 'userinfo'];
	const nullHandlingOptions = ['empty', 'omit', 'literal_null'];
	const requiredMissingPolicyOptions = ['error', 'review', 'omit'];
	const oidcClaimsParameterPlaceholder =
		'{"userinfo":{"email":{"essential":true}},"acr_values":["urn:authrim:loa:2"]}';
	const csvSourceProfileMaxBytes = 2 * 1024 * 1024;
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
	let sourceProfiles = $state<IdentityMappingSourceProfileSummary[]>([]);
	let destinationProfiles = $state<IdentityMappingDestinationProfileSummary[]>([]);
	let protocolSchemaOptions = $state<IdentityMappingProtocolSchemaSummary[]>([]);
	let attributeGroups = $state<IdentityMappingAttributeGroup[]>([]);
	let attributeFields = $state<IdentityMappingAttributeField[]>([]);
	let consentDrafts = $state<Record<string, DestinationConsentSettingsDraft>>({});
	let csvMode = $state<CsvCreateMode>('upload');
	let csvDetailTab = $state<CsvDetailTab>('summary');
	let editingSourceProfileId = $state<string | null>(null);
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
	let editingDestinationProfileId = $state<string | null>(null);
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
	let samlNameIdFormat = $state('urn:oasis:names:tc:SAML:2.0:nameid-format:persistent');
	let samlNameIdSource = $state('subject_identifier');
	let samlAttributes = $state<SamlAttributeDraft[]>([
		createSamlAttributeDraft('urn:oid:0.9.2342.19200300.100.1.3', 'Email', 'email', 'pii')
	]);
	let groupProtocol = $state<IdentityMappingAttributeProtocol>('oidc');
	let groupType = $state('scope');
	let groupKey = $state('');
	let groupDisplayName = $state('');
	let groupDescription = $state('');
	let groupOwnerScopeType = $state<'tenant' | 'platform'>('tenant');
	let groupFieldKeys = $state('');
	let fieldProtocol = $state<IdentityMappingAttributeProtocol>('oidc');
	let fieldKey = $state('');
	let fieldDisplayName = $state('');
	let fieldValueType = $state('string');
	let fieldClassification = $state('internal');
	let fieldOwnerScopeType = $state<'tenant' | 'platform'>('tenant');
	let fieldSurfaces = $state<string[]>(['userinfo']);
	let savingRegistry = $state(false);

	onMount(() => {
		void loadProfiles();
	});

	const visibleProfiles = $derived(
		activeKind === 'all' ? profiles : profiles.filter((profile) => profile.kind === activeKind)
	);
	const sourceProfileListItems = $derived(
		profiles.filter((profile) => profile.kind === 'inbound' && profile.sourceProfileId)
	);
	const destinationProfileListItems = $derived(
		profiles.filter((profile) => profile.kind === 'outbound' && profile.destinationProfileId)
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
				: destinationKind === 'saml'
					? Boolean(samlNameIdFormat.trim()) &&
						Boolean(samlNameIdSource.trim()) &&
						samlAttributes.length > 0
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
				loadedAttributeGroups,
				loadedAttributeFields,
				templates
			] = await Promise.all([
				adminIdentityMappingAPI.listProtocolSchemas(),
				adminIdentityMappingAPI.listExternalSchemas(),
				adminIdentityMappingAPI.listSourceProfiles(),
				adminIdentityMappingAPI.listDestinationProfiles(),
				adminIdentityMappingAPI.listAttributeGroups(),
				adminIdentityMappingAPI.listAttributeFields(),
				adminIdentityMappingAPI.listTemplates()
			]);
			attributeGroups = loadedAttributeGroups.attributeGroups;
			attributeFields = loadedAttributeFields.attributeFields;
			sourceProfiles = loadedSourceProfiles.sourceProfiles;
			destinationProfiles = loadedDestinationProfiles.destinationProfiles;
			protocolSchemaOptions = protocolSchemas.protocolSchemas;
			const loadedProfiles = [
				...loadedSourceProfiles.sourceProfiles.map(sourceProfileToProfile),
				...loadedDestinationProfiles.destinationProfiles.map(destinationProfileToProfile),
				...destinationTemplates.map(destinationTemplateToProfile),
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

	function destinationTemplateToProfile(template: DestinationTemplate): ProfileItem {
		return {
			id: `destination-template:${template.id}`,
			kind: 'template',
			protocol: template.destinationType.toUpperCase(),
			displayName: template.displayName,
			versionLabel: 'template',
			lifecycleState: 'template',
			source: template.profileKey,
			destinationTemplateId: template.id
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
		if (selectedCsvFile.size > csvSourceProfileMaxBytes) {
			createMessage = `CSV source profile files must be ${formatFileSize(csvSourceProfileMaxBytes)} or smaller.`;
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
			const request = {
				sourceType: 'csv',
				profileKey: csvProfileKey.trim(),
				displayName: csvDisplayName.trim(),
				versionLabel: csvVersionLabel.trim() || 'v1',
				parseDraftId:
					csvMode === 'upload' && !editingSourceProfileId
						? (parsedCsvDraftId ?? undefined)
						: undefined,
				schema,
				parserOptions: csvMode === 'upload' ? parsedCsvParserOptions : {},
				warningSummary,
				sourceMetadata: {
					creationMode: editingSourceProfileId ? 'edit' : csvMode,
					rawContentPersisted: false
				}
			} satisfies Parameters<typeof adminIdentityMappingAPI.createSourceProfile>[0];
			const response = editingSourceProfileId
				? await adminIdentityMappingAPI.updateSourceProfile(editingSourceProfileId, request)
				: await adminIdentityMappingAPI.createSourceProfile(request);
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
				destinationKind === 'oidc'
					? buildOidcDestinationSchema()
					: destinationKind === 'saml'
						? buildSamlDestinationSchema()
						: buildCsvDestinationSchema();
			const request = {
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
			} satisfies Parameters<typeof adminIdentityMappingAPI.createDestinationProfile>[0];
			const response = editingDestinationProfileId
				? await adminIdentityMappingAPI.updateDestinationProfile(
						editingDestinationProfileId,
						request
					)
				: await adminIdentityMappingAPI.createDestinationProfile(request);
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

	function editSourceProfile(profile: ProfileItem) {
		if (!profile.sourceProfileId) return;
		void goto(
			`/admin/identity-mapping/profiles/edit?kind=source&id=${encodeURIComponent(profile.sourceProfileId)}`
		);
	}

	function copySourceProfile(profile: ProfileItem) {
		if (!profile.sourceProfileId) return;
		const sourceProfile = sourceProfiles.find((item) => item.id === profile.sourceProfileId);
		const schema = sourceProfile?.version?.schema;
		if (!sourceProfile || !schema) {
			createMessage = 'Source profile version schema is not available for copying.';
			return;
		}
		activeTab = 'sources';
		editingSourceProfileId = null;
		csvMode = 'upload';
		csvDetailTab = 'columns';
		csvDisplayName = `${sourceProfile.displayName} copy`;
		csvProfileKey = uniqueProfileKey(`${sourceProfile.profileKey}_copy`, sourceProfiles);
		csvVersionLabel = 'v1';
		selectedCsvFile = null;
		parsedCsvDraftId = null;
		parsedCsvSchema = cloneSchema(schema);
		parsedCsvParserOptions = schema.parser ?? {};
		parsedCsvWarningSummary = sourceProfile.version?.warningSummary ?? {};
		blockingWarningsConfirmed = getBlockingWarningCount(parsedCsvSchema) === 0;
		createMessage = `Copied ${sourceProfile.displayName}. Save it as a new source profile.`;
	}

	function editDestinationProfile(profile: ProfileItem) {
		if (!profile.destinationProfileId) return;
		void goto(
			`/admin/identity-mapping/profiles/edit?kind=destination&id=${encodeURIComponent(profile.destinationProfileId)}`
		);
	}

	function copyDestinationProfile(profile: ProfileItem) {
		if (profile.destinationTemplateId) {
			const template = destinationTemplates.find(
				(item) => item.id === profile.destinationTemplateId
			);
			if (template) {
				copyDestinationTemplate(template);
			}
			return;
		}
		if (!profile.destinationProfileId) return;
		const destinationProfile = destinationProfiles.find(
			(item) => item.id === profile.destinationProfileId
		);
		const schema = destinationProfile?.version?.schema;
		if (!destinationProfile || !schema) {
			createMessage = 'Destination profile version schema is not available for copying.';
			return;
		}
		activeTab = 'destinations';
		editingDestinationProfileId = null;
		destinationKind = destinationProfile.destinationType;
		destinationDisplayName = `${destinationProfile.displayName} copy`;
		destinationProfileKey = uniqueProfileKey(
			`${destinationProfile.profileKey}_copy`,
			destinationProfiles
		);
		destinationVersionLabel = 'v1';
		destinationOwnerScopeType = destinationProfile.ownerScopeType;
		destinationOwnerScopeId = destinationProfile.ownerScopeId ?? '';
		loadDestinationSchemaDraft(schema);
		destinationBlockingWarningsConfirmed = getDestinationBlockingWarningCount() === 0;
		createMessage = `Copied ${destinationProfile.displayName}. Save it as a new destination profile.`;
	}

	function copyDestinationTemplate(template: DestinationTemplate) {
		activeTab = 'destinations';
		editingDestinationProfileId = null;
		destinationKind = template.destinationType;
		destinationDisplayName = template.displayName.replace(/^Standard /, '');
		destinationProfileKey = uniqueProfileKey(template.profileKey, destinationProfiles);
		destinationVersionLabel = 'v1';
		destinationOwnerScopeType = 'tenant';
		destinationOwnerScopeId = '';
		loadDestinationSchemaDraft(template.schema);
		destinationBlockingWarningsConfirmed = getDestinationBlockingWarningCount() === 0;
		createMessage = `Copied template ${template.displayName}. Save it as a new destination profile.`;
	}

	async function saveAttributeGroup() {
		savingRegistry = true;
		createMessage = null;
		try {
			await adminIdentityMappingAPI.createAttributeGroup({
				protocol: groupProtocol,
				groupType: groupType.trim(),
				groupKey: groupKey.trim(),
				displayName: groupDisplayName.trim(),
				description: groupDescription.trim() || null,
				ownerScopeType: groupOwnerScopeType,
				fieldKeys: splitCsv(groupFieldKeys)
			});
			groupKey = '';
			groupDisplayName = '';
			groupDescription = '';
			groupFieldKeys = '';
			createMessage = 'Saved attribute group.';
			await loadProfiles();
			activeTab = 'registries';
		} catch (error) {
			createMessage = error instanceof Error ? error.message : 'Failed to save attribute group';
		} finally {
			savingRegistry = false;
		}
	}

	async function saveAttributeField() {
		savingRegistry = true;
		createMessage = null;
		try {
			await adminIdentityMappingAPI.createAttributeField({
				protocol: fieldProtocol,
				fieldKey: fieldKey.trim(),
				displayName: fieldDisplayName.trim(),
				valueType: fieldValueType,
				classification: fieldClassification,
				ownerScopeType: fieldOwnerScopeType,
				surfaces: fieldProtocol === 'oidc' ? fieldSurfaces : []
			});
			fieldKey = '';
			fieldDisplayName = '';
			fieldValueType = 'string';
			fieldClassification = 'internal';
			fieldSurfaces = ['userinfo'];
			createMessage = 'Saved attribute field.';
			await loadProfiles();
			activeTab = 'registries';
		} catch (error) {
			createMessage = error instanceof Error ? error.message : 'Failed to save attribute field';
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

	function updateSamlAttribute(
		index: number,
		field: keyof SamlAttributeDraft,
		value: string | boolean
	) {
		samlAttributes = samlAttributes.map((attribute, attributeIndex) =>
			attributeIndex === index ? { ...attribute, [field]: value } : attribute
		);
	}

	function addSamlAttribute() {
		const order = samlAttributes.length + 1;
		samlAttributes = [
			...samlAttributes,
			createSamlAttributeDraft(`urn:authrim:attribute:${order}`, `Attribute ${order}`)
		];
	}

	function removeSamlAttribute(index: number) {
		samlAttributes = samlAttributes.filter((_, attributeIndex) => attributeIndex !== index);
	}

	function toggleClaimSurface(surface: IdentityMappingOidcSurface, checked: boolean) {
		fieldSurfaces = checked
			? Array.from(new Set([...fieldSurfaces, surface]))
			: fieldSurfaces.filter((item) => item !== surface);
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

	function createSamlAttributeDraft(
		name: string,
		label: string,
		valueType = 'string',
		classification = 'internal'
	): SamlAttributeDraft {
		return {
			name,
			label,
			nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri',
			valueType,
			classification,
			required: false,
			releaseCondition: '',
			formatter: '',
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

	function buildSamlDestinationSchema(): Record<string, unknown> {
		return {
			destinationType: 'saml',
			nameId: {
				format: samlNameIdFormat,
				source: samlNameIdSource
			},
			attributes: samlAttributes.map((attribute) => ({
				name: attribute.name.trim(),
				label: attribute.label.trim() || attribute.name.trim(),
				nameFormat: attribute.nameFormat.trim(),
				valueType: attribute.valueType,
				classification: attribute.classification,
				required: attribute.required,
				releaseCondition: attribute.releaseCondition.trim() || undefined,
				formatter: attribute.formatter.trim()
					? { operation: attribute.formatter.trim() }
					: undefined,
				releasePolicy: {
					legalBasis: attribute.legalBasis,
					purpose: attribute.purpose.trim() || 'attribute_release'
				}
			})),
			protocolSchemaRef: destinationProtocolSchemaRef
				? { type: 'protocol_schema', id: destinationProtocolSchemaRef }
				: undefined
		};
	}

	function loadDestinationSchemaDraft(schema: Record<string, unknown>) {
		destinationProtocolSchemaRef = getProtocolSchemaRef(schema);
		if (schema.destinationType === 'csv') {
			const defaults = isRecord(schema.defaults) ? schema.defaults : {};
			csvDestinationEncoding = String(defaults.encoding ?? 'utf-8');
			csvDestinationIncludeHeader = defaults.includeHeader !== false;
			csvDestinationNullHandling = String(defaults.nullHandling ?? 'empty');
			csvDestinationRequiredMissingPolicy = String(defaults.requiredMissingPolicy ?? 'review');
			csvDestinationColumns = Array.isArray(schema.columns)
				? schema.columns
						.filter(isRecord)
						.map((column, index) =>
							createCsvDestinationColumnDraft(
								String(column.columnName ?? `column_${index + 1}`),
								String(column.label ?? column.columnName ?? `Column ${index + 1}`),
								typeof column.order === 'number' ? column.order : index + 1,
								String(column.valueType ?? 'string'),
								String(column.classification ?? 'internal')
							)
						)
				: [createCsvDestinationColumnDraft('email', 'Email', 1, 'email', 'pii')];
			csvDestinationColumns = csvDestinationColumns.map((column, index) => {
				const source =
					Array.isArray(schema.columns) && isRecord(schema.columns[index])
						? schema.columns[index]
						: {};
				const exportPolicy = isRecord(source.exportPolicy) ? source.exportPolicy : {};
				return {
					...column,
					required: Boolean(source.required),
					formatter: isRecord(source.formatter) ? String(source.formatter.operation ?? '') : '',
					nullHandling: String(source.nullHandling ?? column.nullHandling),
					requiredMissingPolicy: String(
						source.requiredMissingPolicy ?? column.requiredMissingPolicy
					),
					legalBasis: String(exportPolicy.legalBasis ?? column.legalBasis),
					purpose: String(exportPolicy.purpose ?? column.purpose)
				};
			});
			return;
		}
		if (schema.destinationType === 'saml') {
			const nameId = isRecord(schema.nameId) ? schema.nameId : {};
			samlNameIdFormat = String(
				nameId.format ?? 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent'
			);
			samlNameIdSource = String(nameId.source ?? 'subject_identifier');
			samlAttributes = Array.isArray(schema.attributes)
				? schema.attributes.filter(isRecord).map((attribute) => {
						const releasePolicy = isRecord(attribute.releasePolicy) ? attribute.releasePolicy : {};
						const formatter = isRecord(attribute.formatter) ? attribute.formatter : {};
						return {
							...createSamlAttributeDraft(
								String(attribute.name ?? ''),
								String(attribute.label ?? attribute.name ?? ''),
								String(attribute.valueType ?? 'string'),
								String(attribute.classification ?? 'internal')
							),
							nameFormat: String(
								attribute.nameFormat ?? 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri'
							),
							required: Boolean(attribute.required),
							releaseCondition: String(attribute.releaseCondition ?? ''),
							formatter: String(formatter.operation ?? ''),
							legalBasis: String(releasePolicy.legalBasis ?? 'legitimate_interest'),
							purpose: String(releasePolicy.purpose ?? 'attribute_release')
						};
					})
				: [createSamlAttributeDraft('urn:oid:0.9.2342.19200300.100.1.3', 'Email', 'email', 'pii')];
			return;
		}

		const claimsParameter = isRecord(schema.claimsParameter)
			? JSON.stringify(schema.claimsParameter, null, 2)
			: '';
		oidcClaimsParameterJson = claimsParameter;
		oidcClaims = Array.isArray(schema.claims)
			? schema.claims.filter(isRecord).map((claim) => {
					const formatter = isRecord(claim.formatter) ? claim.formatter : {};
					return {
						...createOidcClaimDraft(
							String(claim.claimName ?? ''),
							String(claim.label ?? claim.claimName ?? ''),
							String(claim.valueType ?? 'string'),
							String(claim.classification ?? 'internal'),
							Array.isArray(claim.surfaces)
								? (claim.surfaces
										.map(String)
										.filter((surface) =>
											oidcSurfaceOptions.includes(surface as IdentityMappingOidcSurface)
										) as IdentityMappingOidcSurface[])
								: ['userinfo'],
							Array.isArray(claim.requiredScopes) ? claim.requiredScopes.map(String).join(',') : ''
						),
						releaseCondition: String(claim.releaseCondition ?? ''),
						formatter: String(formatter.operation ?? '')
					};
				})
			: [
					createOidcClaimDraft(
						'sub',
						'Subject',
						'string',
						'internal',
						['id_token', 'userinfo'],
						'openid'
					)
				];
		if (!oidcClaims.some((claim) => claim.claimName === 'sub')) {
			oidcClaims = [
				createOidcClaimDraft('sub', 'Subject', 'string', 'internal', ['id_token'], 'openid'),
				...oidcClaims
			];
		}
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
		if (destinationKind === 'saml') {
			return samlAttributes.filter(
				(attribute) =>
					['pii', 'regulated'].includes(attribute.classification) &&
					(!attribute.legalBasis.trim() || !attribute.purpose.trim())
			).length;
		}
		return csvDestinationColumns.filter(
			(column) =>
				['pii', 'regulated'].includes(column.classification) &&
				(!column.legalBasis.trim() || !column.purpose.trim())
		).length;
	}

	function resetCsvComposer() {
		editingSourceProfileId = null;
		csvMode = 'upload';
		csvDetailTab = 'summary';
		csvDisplayName = '';
		csvProfileKey = '';
		csvVersionLabel = 'v1';
		selectedCsvFile = null;
		parsedCsvDraftId = null;
		parsedCsvSchema = null;
		parsedCsvParserOptions = {};
		parsedCsvWarningSummary = {};
		blockingWarningsConfirmed = false;
		manualColumns = [createManualColumn('email', 'Email', 'email')];
	}

	function createSourceProfile() {
		void goto('/admin/identity-mapping/profiles/edit?kind=source');
	}

	function resetDestinationComposer() {
		editingDestinationProfileId = null;
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
		samlNameIdFormat = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
		samlNameIdSource = 'subject_identifier';
		samlAttributes = [
			createSamlAttributeDraft('urn:oid:0.9.2342.19200300.100.1.3', 'Email', 'email', 'pii')
		];
	}

	function createDestinationProfile() {
		void goto('/admin/identity-mapping/profiles/edit?kind=destination');
	}

	function nextVersionLabel(value: string | null | undefined): string {
		const label = value?.trim();
		if (!label) return 'v2';
		const match = /^v(\d+)$/i.exec(label);
		if (match) return `v${Number(match[1]) + 1}`;
		return `${label}-edit`;
	}

	function getProtocolSchemaRef(schema: Record<string, unknown>): string {
		const protocolSchemaRef = schema.protocolSchemaRef;
		if (isRecord(protocolSchemaRef) && typeof protocolSchemaRef.id === 'string') {
			return protocolSchemaRef.id;
		}
		return '';
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

	function formatFileSize(bytes: number): string {
		if (bytes >= 1024 * 1024) {
			return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
		}
		return `${Math.round(bytes / 1024)} KB`;
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

	function uniqueProfileKey(base: string, existingProfiles: Array<{ profileKey: string }>): string {
		const normalizedBase = normalizeProfileKey(base);
		const existingKeys = new Set(existingProfiles.map((profile) => profile.profileKey));
		if (!existingKeys.has(normalizedBase)) return normalizedBase;
		for (let index = 2; index < 1000; index += 1) {
			const candidate = `${normalizedBase}_${index}`;
			if (!existingKeys.has(candidate)) return candidate;
		}
		return `${normalizedBase}_${Date.now()}`;
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

	<section class="profile-list-panel" aria-labelledby="profile-list-heading">
		<div class="panel-heading">
			<div>
				<p class="eyebrow">Profile inventory</p>
				<h2 id="profile-list-heading">Source and destination profile lists</h2>
			</div>
			<button type="button" onclick={loadProfiles} disabled={loading}>Refresh</button>
		</div>

		{#if loading}
			<div class="empty-state">Loading source and destination profiles.</div>
		{:else if errorMessage}
			<div class="empty-state">{errorMessage}</div>
		{:else}
			<div class="profile-list-columns">
				<section class="profile-list-column" aria-labelledby="source-profile-list-heading">
					<div class="column-heading">
						<h3 id="source-profile-list-heading">Source profiles</h3>
						<button type="button" onclick={createSourceProfile}>Create source profile</button>
					</div>
					{#if sourceProfileListItems.length === 0}
						<div class="column-empty">No source profiles.</div>
					{:else}
						<div class="profile-list">
							{#each sourceProfileListItems as profile (profile.id)}
								<button
									type="button"
									class="profile-list-item"
									onclick={() => editSourceProfile(profile)}
								>
									<div class="profile-list-main">
										<h4>{profile.displayName}</h4>
										<span>{profile.protocol} / {profile.source}</span>
									</div>
									<div class="profile-list-meta">
										<span class="state-pill" class:active={profile.lifecycleState === 'active'}
											>{profile.lifecycleState}</span
										>
										<span>{profile.versionLabel}</span>
									</div>
								</button>
							{/each}
						</div>
					{/if}
				</section>

				<section class="profile-list-column" aria-labelledby="destination-profile-list-heading">
					<div class="column-heading">
						<h3 id="destination-profile-list-heading">Destination profiles</h3>
						<button type="button" onclick={createDestinationProfile}>
							Create destination profile
						</button>
					</div>
					{#if destinationProfileListItems.length === 0}
						<div class="column-empty">No destination profiles.</div>
					{:else}
						<div class="profile-list">
							{#each destinationProfileListItems as profile (profile.id)}
								<button
									type="button"
									class="profile-list-item"
									onclick={() => editDestinationProfile(profile)}
								>
									<div class="profile-list-main">
										<h4>{profile.displayName}</h4>
										<span>{profile.protocol} / {profile.source}</span>
									</div>
									<div class="profile-list-meta">
										<span class="state-pill" class:active={profile.lifecycleState === 'active'}
											>{profile.lifecycleState}</span
										>
										<span>{profile.versionLabel}</span>
									</div>
								</button>
							{/each}
						</div>
					{/if}
				</section>
			</div>
		{/if}
	</section>
</div>

<style>
	.profiles-page {
		display: grid;
		gap: 18px;
	}

	.page-heading,
	.panel-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 18px;
	}

	.back-link {
		display: inline-flex;
		margin-bottom: 10px;
		color: var(--color-primary);
		font-size: 13px;
		font-weight: 700;
		text-decoration: none;
	}

	h1,
	h2,
	h3,
	h4,
	p {
		margin: 0;
	}

	h1 {
		color: var(--text-primary);
		font-size: 28px;
	}

	h2,
	h3,
	h4 {
		color: var(--text-primary);
	}

	.summary {
		max-width: 840px;
		color: var(--text-secondary);
		font-size: 14px;
		line-height: 1.5;
	}

	.eyebrow,
	.status-panel span {
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 800;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.status-panel,
	.profile-list-panel,
	.empty-state {
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--bg-card);
	}

	.status-panel {
		display: flex;
		gap: 16px;
		padding: 14px;
	}

	.status-panel div {
		display: grid;
		gap: 4px;
	}

	.status-panel strong {
		color: var(--text-primary);
		font-size: 18px;
	}

	.profile-list-panel {
		display: grid;
		gap: 16px;
		padding: 16px;
	}

	.empty-state {
		padding: 14px;
		color: var(--text-secondary);
	}

	.profile-list-columns {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}

	.profile-list-column {
		display: grid;
		align-content: start;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		overflow: hidden;
	}

	.column-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 14px;
		border-bottom: 1px solid var(--border-color);
	}

	.column-empty {
		padding: 18px 14px;
		color: var(--text-secondary);
	}

	.profile-list {
		display: grid;
	}

	.profile-list-item {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 16px;
		align-items: center;
		width: 100%;
		min-height: 72px;
		padding: 14px;
		border: 0;
		border-bottom: 1px solid var(--border-color);
		border-radius: 0;
		background: transparent;
		text-align: left;
	}

	.profile-list-item:hover,
	.profile-list-item:focus-visible {
		background: var(--bg-hover);
	}

	.profile-list-main,
	.profile-list-meta {
		display: grid;
		gap: 4px;
	}

	.profile-list-main span,
	.profile-list-meta span {
		color: var(--text-secondary);
		font-size: 13px;
	}

	.profile-list-meta {
		justify-items: end;
	}

	.state-pill {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 24px;
		border-radius: 999px;
		background: var(--bg-hover);
		padding: 0 10px;
		font-weight: 800;
	}

	.state-pill.active {
		color: var(--color-success, #10b981);
	}

	button {
		min-height: 34px;
		padding: 0 12px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		color: var(--text-secondary);
		background: var(--bg-card);
		font-weight: 800;
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	@media (max-width: 1020px) {
		.page-heading,
		.panel-heading {
			display: grid;
		}

		.status-panel,
		.profile-list-columns {
			grid-template-columns: 1fr;
		}

		.profile-list-item {
			grid-template-columns: 1fr;
		}

		.profile-list-meta {
			justify-items: start;
		}
	}
</style>
