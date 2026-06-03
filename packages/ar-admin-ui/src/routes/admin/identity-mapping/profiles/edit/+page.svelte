<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingAttributeField,
		type IdentityMappingAttributeGroup,
		type IdentityMappingAttributeProtocol,
		type IdentityMappingDestinationProfileSummary,
		type IdentityMappingDestinationType,
		type IdentityMappingOidcSurface,
		type IdentityMappingSourceProfileColumn,
		type IdentityMappingSourceProfileSchema,
		type IdentityMappingSourceProfileSummary
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

	type EditorKind = 'source' | 'destination';
	type CsvCreateMode = 'upload' | 'manual';
	type CsvDetailTab = 'summary' | 'parser' | 'columns' | 'warnings';
	type DestinationCreateMode = 'existing' | 'template' | 'manual';

	interface OidcClaimDraft {
		claimName: string;
		label: string;
		valueType: string;
		allowedValues: string;
		valueMultiplicity: 'single' | 'multi';
		nullable: boolean;
		classification: string;
		surfaces: IdentityMappingOidcSurface[];
		requiredScopes: string;
		releaseCondition: string;
		legalBasis: string;
		purpose: string;
		formatter: string;
	}

	interface CsvDestinationColumnDraft {
		columnName: string;
		label: string;
		order: number;
		valueType: string;
		allowedValues: string;
		valueMultiplicity: 'single' | 'multi';
		nullable: boolean;
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
		examples: unknown[];
		note: string;
		allowedValues: string;
		valueMultiplicity: 'single' | 'multi';
		nullable: boolean;
		classification: string;
		required: boolean;
		releaseCondition: string;
		formatter: string;
		legalBasis: string;
		purpose: string;
	}

	interface TemplatePreviewRow {
		name: string;
		label: string;
		type: string;
		required: boolean;
	}

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
	const valueMultiplicityOptions = ['single', 'multi'] as const;
	const classificationOptions = ['internal', 'public', 'pii', 'regulated', 'secret'];
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
	const csvSourceProfileMaxBytes = 2 * 1024 * 1024;
	const delimiterOptions = [
		{ value: 'auto', label: 'Auto' },
		{ value: ',', label: 'Comma' },
		{ value: '\\t', label: 'Tab' },
		{ value: ';', label: 'Semicolon' },
		{ value: '|', label: 'Pipe' }
	];
	const customOptionValue = '__custom__';
	const persistentNameIdFormat = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
	const samlNameIdFormatOptions = [
		{ value: persistentNameIdFormat, label: 'Persistent' },
		{
			value: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
			label: 'Email address'
		},
		{ value: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient', label: 'Transient' },
		{ value: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified', label: 'Unspecified' },
		{ value: 'urn:oasis:names:tc:SAML:2.0:nameid-format:entity', label: 'Entity' },
		{ value: customOptionValue, label: 'Custom' }
	];
	const samlNameIdValueOptions = [
		{ value: 'subject_identifier', label: 'Subject identifier' },
		{ value: 'email', label: 'Email' },
		{ value: 'eduPersonTargetedID', label: 'eduPersonTargetedID' },
		{ value: 'eduPersonPrincipalName', label: 'eduPersonPrincipalName' },
		{ value: 'pairwise_id', label: 'Pairwise ID' },
		{ value: customOptionValue, label: 'Custom field' }
	];
	let editorKind = $state<EditorKind>('source');
	let loading = $state(true);
	let message = $state<string | null>(null);
	let sourceProfiles = $state<IdentityMappingSourceProfileSummary[]>([]);
	let destinationProfiles = $state<IdentityMappingDestinationProfileSummary[]>([]);
	let attributeGroups = $state<IdentityMappingAttributeGroup[]>([]);
	let attributeFields = $state<IdentityMappingAttributeField[]>([]);

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
	let sourceProfileVersionId = $state<string | null>(null);
	let sourceProfileVersionState = $state<string | null>(null);
	let sourceAdvancedSettings = $state(false);
	let manualColumns = $state<IdentityMappingSourceProfileColumn[]>([
		createManualColumn('email', 'Email', 'email')
	]);

	let destinationKind = $state<IdentityMappingDestinationType>('oidc');
	let editingDestinationProfileId = $state<string | null>(null);
	let destinationDisplayName = $state('');
	let destinationProfileKey = $state('');
	let destinationVersionLabel = $state('v1');
	let destinationOwnerScopeType = $state<'tenant' | 'platform' | 'client'>('tenant');
	let destinationOwnerScopeId = $state('');
	let destinationProtocolSchemaRef = $state('');
	let destinationBlockingWarningsConfirmed = $state(false);
	let destinationProfileVersionId = $state<string | null>(null);
	let destinationProfileVersionState = $state<string | null>(null);
	let savingDestination = $state(false);
	let reviewingProfile = $state(false);
	let activatingProfile = $state(false);
	let deletingProfile = $state(false);
	let destinationAdvancedSettings = $state(false);
	let destinationCreateMode = $state<DestinationCreateMode>('manual');
	let selectedExistingDestinationId = $state('');
	let selectedTemplateCategory = $state('');
	let selectedTemplateId = $state('');
	let previewTemplate = $state<DestinationTemplate | null>(null);
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
	let samlNameIdFormatOption = $state(persistentNameIdFormat);
	let customSamlNameIdFormat = $state('');
	let samlNameIdValueOption = $state('subject_identifier');
	let customSamlNameIdValue = $state('');
	let samlAttributes = $state<SamlAttributeDraft[]>([
		createSamlAttributeDraft('urn:oid:0.9.2342.19200300.100.1.3', 'Email', 'email', 'pii')
	]);
	let consentDraft = $state<DestinationConsentSettingsDraft>(
		createDestinationConsentSettingsDraft('destination-draft')
	);

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

	const activeCsvSchema = $derived(csvMode === 'manual' ? buildManualCsvSchema() : parsedCsvSchema);
	const csvBlockingWarningCount = $derived(getBlockingWarningCount(activeCsvSchema));
	const destinationBlockingWarningCount = $derived(getDestinationBlockingWarningCount());
	const selectedTemplate = $derived(selectedDestinationTemplate());
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
					? Boolean(selectedSamlNameIdFormat().trim()) &&
						Boolean(selectedSamlNameIdValue().trim()) &&
						samlAttributes.length > 0
					: csvDestinationColumns.length > 0) &&
			(destinationBlockingWarningCount === 0 || destinationBlockingWarningsConfirmed)
	);
	const canSaveCsvDraft = $derived(canSaveCsv && canSaveDraft(sourceProfileVersionState));
	const canReviewCsvDraft = $derived(
		Boolean(editingSourceProfileId) &&
			Boolean(sourceProfileVersionId) &&
			sourceProfileVersionState === 'draft'
	);
	const canActivateCsvDraft = $derived(
		Boolean(editingSourceProfileId) &&
			Boolean(sourceProfileVersionId) &&
			sourceProfileVersionState === 'reviewed'
	);
	const canSaveDestinationDraft = $derived(
		canSaveDestination && canSaveDraft(destinationProfileVersionState)
	);
	const canReviewDestinationDraft = $derived(
		Boolean(editingDestinationProfileId) &&
			Boolean(destinationProfileVersionId) &&
			destinationProfileVersionState === 'draft'
	);
	const canActivateDestinationDraft = $derived(
		Boolean(editingDestinationProfileId) &&
			Boolean(destinationProfileVersionId) &&
			destinationProfileVersionState === 'reviewed'
	);

	onMount(() => {
		editorKind = getRequestedKind();
		void loadEditor();
	});

	function getRequestedKind(): EditorKind {
		return $page.url.searchParams.get('kind') === 'destination' ? 'destination' : 'source';
	}

	function getRequestedId(): string | null {
		return $page.url.searchParams.get('id');
	}

	async function loadEditor() {
		loading = true;
		message = null;
		try {
			const [
				loadedSourceProfiles,
				loadedDestinationProfiles,
				loadedAttributeGroups,
				loadedAttributeFields
			] = await Promise.all([
				adminIdentityMappingAPI.listSourceProfiles(),
				adminIdentityMappingAPI.listDestinationProfiles(),
				adminIdentityMappingAPI.listAttributeGroups(),
				adminIdentityMappingAPI.listAttributeFields()
			]);
			sourceProfiles = loadedSourceProfiles.sourceProfiles;
			destinationProfiles = loadedDestinationProfiles.destinationProfiles;
			attributeGroups = loadedAttributeGroups.attributeGroups;
			attributeFields = loadedAttributeFields.attributeFields;
			applyRequestedProfile();
		} catch (error) {
			message = error instanceof Error ? error.message : 'Failed to load profile editor';
		} finally {
			loading = false;
		}
	}

	function applyRequestedProfile() {
		const profileId = getRequestedId();
		if (!profileId) {
			if (editorKind === 'source') resetCsvComposer();
			else resetDestinationComposer();
			return;
		}
		if (editorKind === 'source') {
			const sourceProfile = sourceProfiles.find((item) => item.id === profileId);
			const schema = sourceProfile?.version?.schema;
			if (!sourceProfile || !schema) {
				message = 'Source profile version schema is not available for editing.';
				return;
			}
			editingSourceProfileId = sourceProfile.id;
			csvMode = 'upload';
			csvDetailTab = 'columns';
			csvDisplayName = sourceProfile.displayName;
			csvProfileKey = sourceProfile.profileKey;
			csvVersionLabel = nextVersionLabel(sourceProfile.version?.versionLabel);
			sourceProfileVersionId = sourceProfile.version?.id ?? null;
			sourceProfileVersionState = sourceProfile.version?.lifecycleState ?? null;
			selectedCsvFile = null;
			parsedCsvDraftId = null;
			parsedCsvSchema = cloneSchema(schema);
			parsedCsvParserOptions = schema.parser ?? {};
			parsedCsvWarningSummary = sourceProfile.version?.warningSummary ?? {};
			blockingWarningsConfirmed = getBlockingWarningCount(parsedCsvSchema) === 0;
			message = `Editing ${sourceProfile.displayName}. Saving creates a new draft version.`;
			return;
		}

		const destinationProfile = destinationProfiles.find((item) => item.id === profileId);
		const schema = destinationProfile?.version?.schema;
		if (!destinationProfile || !schema) {
			message = 'Destination profile version schema is not available for editing.';
			return;
		}
		editingDestinationProfileId = destinationProfile.id;
		destinationKind = destinationProfile.destinationType;
		destinationDisplayName = destinationProfile.displayName;
		destinationProfileKey = destinationProfile.profileKey;
		destinationVersionLabel = nextVersionLabel(destinationProfile.version?.versionLabel);
		destinationProfileVersionId = destinationProfile.version?.id ?? null;
		destinationProfileVersionState = destinationProfile.version?.lifecycleState ?? null;
		destinationOwnerScopeType = destinationProfile.ownerScopeType;
		destinationOwnerScopeId = destinationProfile.ownerScopeId ?? '';
		loadDestinationSchemaDraft(schema);
		destinationBlockingWarningsConfirmed = getDestinationBlockingWarningCount() === 0;
		consentDraft = createDestinationConsentSettingsDraft(destinationProfile.id);
		message = `Editing ${destinationProfile.displayName}. Saving creates a new draft version.`;
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

	function canSaveDraft(versionState: string | null) {
		return versionState !== 'draft' && versionState !== 'reviewed';
	}

	function selectedSamlNameIdFormat() {
		return samlNameIdFormatOption === customOptionValue
			? customSamlNameIdFormat.trim()
			: samlNameIdFormatOption;
	}

	function selectedSamlNameIdValue() {
		return samlNameIdValueOption === customOptionValue
			? customSamlNameIdValue.trim()
			: samlNameIdValueOption;
	}

	function setSamlNameIdFormat(value: string) {
		if (samlNameIdFormatOptions.some((option) => option.value === value)) {
			samlNameIdFormatOption = value;
			customSamlNameIdFormat = '';
			return;
		}
		samlNameIdFormatOption = customOptionValue;
		customSamlNameIdFormat = value;
	}

	function setSamlNameIdValue(value: string) {
		if (samlNameIdValueOptions.some((option) => option.value === value)) {
			samlNameIdValueOption = value;
			customSamlNameIdValue = '';
			return;
		}
		samlNameIdValueOption = customOptionValue;
		customSamlNameIdValue = value;
	}

	function setSamlNameIdFormatOption(value: string) {
		samlNameIdFormatOption = value;
		if (value !== customOptionValue) customSamlNameIdFormat = '';
	}

	function setSamlNameIdValueOption(value: string) {
		samlNameIdValueOption = value;
		if (value !== customOptionValue) customSamlNameIdValue = '';
	}

	function updateConsentDraft(patch: Partial<DestinationConsentSettingsDraft>) {
		consentDraft = { ...consentDraft, ...patch };
	}

	async function parseSelectedCsv() {
		if (!selectedCsvFile) {
			message = 'Choose a CSV file before parsing.';
			return;
		}
		if (selectedCsvFile.size > csvSourceProfileMaxBytes) {
			message = `CSV source profile files must be ${formatFileSize(csvSourceProfileMaxBytes)} or smaller.`;
			return;
		}
		parsingCsv = true;
		message = null;
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
			if (!csvDisplayName.trim()) csvDisplayName = selectedCsvFile.name.replace(/\.[^.]+$/, '');
			if (!csvProfileKey.trim())
				csvProfileKey = normalizeProfileKey(csvDisplayName || selectedCsvFile.name);
			csvDetailTab = 'columns';
		} catch (error) {
			message = error instanceof Error ? error.message : 'Failed to parse CSV';
		} finally {
			parsingCsv = false;
		}
	}

	async function saveCsvProfile() {
		const schema = activeCsvSchema;
		if (!schema || !canSaveCsvDraft) {
			message = 'Parse a CSV file or add manual columns before saving.';
			return;
		}
		savingCsv = true;
		message = null;
		try {
			const request = {
				sourceType: 'csv' as const,
				profileKey: csvProfileKey.trim(),
				displayName: csvDisplayName.trim(),
				versionLabel: csvVersionLabel.trim() || 'v1',
				parseDraftId:
					csvMode === 'upload' && !editingSourceProfileId
						? (parsedCsvDraftId ?? undefined)
						: undefined,
				schema,
				parserOptions: csvMode === 'upload' ? parsedCsvParserOptions : {},
				warningSummary: {
					...(csvMode === 'manual' ? schema.summary : parsedCsvWarningSummary),
					confirmedBlockingWarningCount: blockingWarningsConfirmed ? csvBlockingWarningCount : 0
				},
				sourceMetadata: {
					creationMode: editingSourceProfileId ? 'edit' : csvMode,
					rawContentPersisted: false
				}
			};
			const response = editingSourceProfileId
				? await adminIdentityMappingAPI.updateSourceProfile(editingSourceProfileId, request)
				: await adminIdentityMappingAPI.createSourceProfile(request);
			message = `Saved ${response.result.displayName}. Review and activate it before Flow Editor use.`;
			editingSourceProfileId = response.result.id;
			sourceProfileVersionId = response.result.version?.id ?? null;
			sourceProfileVersionState = response.result.version?.lifecycleState ?? 'draft';
		} catch (error) {
			message = error instanceof Error ? error.message : 'Failed to save CSV source profile';
		} finally {
			savingCsv = false;
		}
	}

	async function saveDestinationProfile() {
		if (!canSaveDestinationDraft) {
			message = 'Complete the destination profile and confirm blocking release warnings.';
			return;
		}
		savingDestination = true;
		message = null;
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
			};
			const response = editingDestinationProfileId
				? await adminIdentityMappingAPI.updateDestinationProfile(
						editingDestinationProfileId,
						request
					)
				: await adminIdentityMappingAPI.createDestinationProfile(request);
			message = `Saved ${response.result.displayName}. Review and activate it before Flow Editor use.`;
			editingDestinationProfileId = response.result.id;
			destinationProfileVersionId = response.result.version?.id ?? null;
			destinationProfileVersionState = response.result.version?.lifecycleState ?? 'draft';
		} catch (error) {
			message = error instanceof Error ? error.message : 'Failed to save destination profile';
		} finally {
			savingDestination = false;
		}
	}

	async function reviewCurrentProfileVersion() {
		reviewingProfile = true;
		message = null;
		try {
			if (editorKind === 'source') {
				if (!editingSourceProfileId || !sourceProfileVersionId || !canReviewCsvDraft) return;
				await adminIdentityMappingAPI.reviewSourceProfileVersion(
					editingSourceProfileId,
					sourceProfileVersionId
				);
				sourceProfileVersionState = 'reviewed';
				message = 'Source profile draft reviewed. Activate it before Flow Editor use.';
				return;
			}
			if (
				!editingDestinationProfileId ||
				!destinationProfileVersionId ||
				!canReviewDestinationDraft
			)
				return;
			await adminIdentityMappingAPI.reviewDestinationProfileVersion(
				editingDestinationProfileId,
				destinationProfileVersionId
			);
			destinationProfileVersionState = 'reviewed';
			message = 'Destination profile draft reviewed. Activate it before Flow Editor use.';
		} catch (error) {
			message = error instanceof Error ? error.message : 'Failed to review profile draft';
		} finally {
			reviewingProfile = false;
		}
	}

	async function activateCurrentProfileVersion() {
		activatingProfile = true;
		message = null;
		try {
			if (editorKind === 'source') {
				if (!editingSourceProfileId || !sourceProfileVersionId || !canActivateCsvDraft) return;
				await adminIdentityMappingAPI.activateSourceProfileVersion(
					editingSourceProfileId,
					sourceProfileVersionId
				);
				sourceProfileVersionState = 'active';
				message = 'Source profile version activated.';
				return;
			}
			if (
				!editingDestinationProfileId ||
				!destinationProfileVersionId ||
				!canActivateDestinationDraft
			)
				return;
			await adminIdentityMappingAPI.activateDestinationProfileVersion(
				editingDestinationProfileId,
				destinationProfileVersionId
			);
			destinationProfileVersionState = 'active';
			message = 'Destination profile version activated.';
		} catch (error) {
			message = error instanceof Error ? error.message : 'Failed to activate profile version';
		} finally {
			activatingProfile = false;
		}
	}

	async function deleteCurrentProfile() {
		const profileId =
			editorKind === 'source' ? editingSourceProfileId : editingDestinationProfileId;
		if (!profileId) return;
		const label = editorKind === 'source' ? csvDisplayName : destinationDisplayName;
		if (
			!window.confirm(
				`Delete ${label || 'this profile'}? This removes the profile and its versions.`
			)
		) {
			return;
		}
		deletingProfile = true;
		message = null;
		try {
			if (editorKind === 'source') {
				await adminIdentityMappingAPI.deleteSourceProfile(profileId);
			} else {
				await adminIdentityMappingAPI.deleteDestinationProfile(profileId);
			}
			await goto('/admin/identity-mapping/profiles');
		} catch (error) {
			message = error instanceof Error ? error.message : 'Failed to delete profile';
		} finally {
			deletingProfile = false;
		}
	}

	function scrollToReleaseConsent() {
		document.getElementById('destination-consent')?.scrollIntoView({
			behavior: 'smooth',
			block: 'start'
		});
	}

	async function saveAttributeGroup() {
		savingRegistry = true;
		message = null;
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
			message = 'Saved attribute group.';
			const loaded = await adminIdentityMappingAPI.listAttributeGroups();
			attributeGroups = loaded.attributeGroups;
		} catch (error) {
			message = error instanceof Error ? error.message : 'Failed to save attribute group';
		} finally {
			savingRegistry = false;
		}
	}

	async function saveAttributeField() {
		savingRegistry = true;
		message = null;
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
			message = 'Saved attribute field.';
			const loaded = await adminIdentityMappingAPI.listAttributeFields();
			attributeFields = loaded.attributeFields;
		} catch (error) {
			message = error instanceof Error ? error.message : 'Failed to save attribute field';
		} finally {
			savingRegistry = false;
		}
	}

	function updateCsvColumn(
		index: number,
		field: keyof IdentityMappingSourceProfileColumn,
		value: string | boolean | string[] | unknown[] | null
	) {
		const schema = activeCsvSchema;
		if (!schema) return;
		const nextColumns = schema.columns.map((column, columnIndex) =>
			columnIndex === index ? { ...column, [field]: value } : column
		);
		if (csvMode === 'manual') manualColumns = nextColumns;
		else parsedCsvSchema = { ...schema, columns: nextColumns };
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

	function updateOidcClaim(index: number, field: keyof OidcClaimDraft, value: string | boolean) {
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

	function toggleFieldSurface(surface: IdentityMappingOidcSurface, checked: boolean) {
		fieldSurfaces = checked
			? Array.from(new Set([...fieldSurfaces, surface]))
			: fieldSurfaces.filter((item) => item !== surface);
	}

	function setDestinationKind(kind: IdentityMappingDestinationType) {
		destinationKind = kind;
		destinationAdvancedSettings = false;
		selectedExistingDestinationId = '';
		selectedTemplateCategory = '';
		selectedTemplateId = '';
	}

	function destinationProfilesForCurrentKind() {
		return destinationProfiles.filter((profile) => profile.destinationType === destinationKind);
	}

	function destinationTemplatesForCurrentKind() {
		return destinationTemplates.filter((template) => template.destinationType === destinationKind);
	}

	function destinationTemplateCategories() {
		return Array.from(
			new Set(destinationTemplatesForCurrentKind().map((template) => template.category))
		);
	}

	function destinationTemplateCategoryCount(category: string) {
		return destinationTemplatesForCurrentKind().filter((template) => template.category === category)
			.length;
	}

	function templateCategoryIcon(category: string): string {
		switch (category) {
			case 'General settings':
				return 'i-ph-gear';
			case 'Vendor specific':
				return 'i-ph-briefcase';
			case 'Academic federation':
				return 'i-ph-graduation-cap';
			default:
				return 'i-ph-folder';
		}
	}

	function currentTemplateCategory() {
		const categories = destinationTemplateCategories();
		return categories.includes(selectedTemplateCategory)
			? selectedTemplateCategory
			: (categories[0] ?? '');
	}

	function destinationTemplatesForCurrentCategory() {
		const category = currentTemplateCategory();
		return destinationTemplatesForCurrentKind().filter(
			(template) => template.category === category
		);
	}

	function selectedDestinationTemplate() {
		const templates = destinationTemplatesForCurrentCategory();
		return templates.find((template) => template.id === selectedTemplateId) ?? templates[0] ?? null;
	}

	function templatePreviewRows(template: DestinationTemplate | null): TemplatePreviewRow[] {
		if (!template) return [];
		if (template.destinationType === 'saml' && Array.isArray(template.schema.attributes)) {
			return template.schema.attributes.filter(isRecord).map((attribute) => ({
				name: String(attribute.name ?? ''),
				label: String(attribute.label ?? attribute.name ?? ''),
				type: String(attribute.valueType ?? 'string'),
				required: Boolean(attribute.required)
			}));
		}
		if (template.destinationType === 'csv' && Array.isArray(template.schema.columns)) {
			return template.schema.columns.filter(isRecord).map((column) => ({
				name: String(column.columnName ?? ''),
				label: String(column.label ?? column.columnName ?? ''),
				type: String(column.valueType ?? 'string'),
				required: Boolean(column.required)
			}));
		}
		if (Array.isArray(template.schema.claims)) {
			return template.schema.claims.filter(isRecord).map((claim) => {
				const claimName = String(claim.claimName ?? '');
				return {
					name: claimName,
					label: String(claim.label ?? claimName),
					type: String(claim.valueType ?? 'string'),
					required: Boolean(claim.required) || claimName === 'sub'
				};
			});
		}
		return [];
	}

	function copyExistingDestinationProfile() {
		const selected = destinationProfiles.find(
			(profile) => profile.id === selectedExistingDestinationId
		);
		const schema = selected?.version?.schema;
		if (!selected || !schema) {
			message = 'Choose an existing destination profile with an editable schema.';
			return;
		}

		const copyDisplayName = uniqueCopyDisplayName(
			selected.displayName,
			destinationProfiles.map((profile) => profile.displayName)
		);
		editingDestinationProfileId = null;
		destinationKind = selected.destinationType;
		destinationDisplayName = copyDisplayName;
		destinationProfileKey = uniqueProfileKey(copyDisplayName, destinationProfiles);
		destinationVersionLabel = 'v1';
		destinationOwnerScopeType = selected.ownerScopeType;
		destinationOwnerScopeId = selected.ownerScopeId ?? '';
		loadDestinationSchemaDraft(schema);
		destinationBlockingWarningsConfirmed = getDestinationBlockingWarningCount() === 0;
		consentDraft = createDestinationConsentSettingsDraft('destination-draft');
		message = `Copied ${selected.displayName}. Save it as a new destination profile.`;
	}

	function copyDestinationTemplate(template: DestinationTemplate) {
		editorKind = 'destination';
		resetDestinationComposer();
		destinationKind = template.destinationType;
		destinationDisplayName = template.displayName.replace(/^Standard /, '');
		destinationProfileKey = uniqueProfileKey(template.profileKey, destinationProfiles);
		loadDestinationSchemaDraft(template.schema);
		previewTemplate = null;
		message = `Copied template ${template.displayName}. Save it as a new destination profile.`;
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
			examples: [],
			note: null,
			allowedValues: [],
			valueMultiplicity: 'single',
			nullable: false,
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
			allowedValues: '',
			valueMultiplicity: 'single',
			nullable: false,
			classification,
			surfaces,
			requiredScopes,
			releaseCondition: '',
			legalBasis: ['pii', 'regulated'].includes(classification) ? 'consent' : 'legitimate_interest',
			purpose: 'attribute_release',
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
			allowedValues: '',
			valueMultiplicity: 'single',
			nullable: false,
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
			examples: [],
			note: '',
			allowedValues: '',
			valueMultiplicity: 'single',
			nullable: false,
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
				allowedValues: splitCsv(claim.allowedValues),
				valueMultiplicity: claim.valueMultiplicity,
				nullable: claim.nullable,
				classification: claim.classification,
				surfaces: claim.surfaces,
				requiredScopes: splitCsv(claim.requiredScopes),
				releaseCondition: claim.releaseCondition.trim() || undefined,
				releasePolicy: {
					legalBasis: claim.legalBasis,
					purpose: claim.purpose.trim() || 'attribute_release'
				},
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
				allowedValues: splitCsv(column.allowedValues),
				valueMultiplicity: column.valueMultiplicity,
				nullable: column.nullable,
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
				format: selectedSamlNameIdFormat(),
				source: selectedSamlNameIdValue()
			},
			attributes: samlAttributes.map((attribute) => ({
				name: attribute.name.trim(),
				label: attribute.label.trim() || attribute.name.trim(),
				nameFormat: attribute.nameFormat.trim(),
				valueType: attribute.valueType,
				examples: attribute.examples,
				note: attribute.note.trim() || undefined,
				allowedValues: splitCsv(attribute.allowedValues),
				valueMultiplicity: attribute.valueMultiplicity,
				nullable: attribute.nullable,
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
				? schema.columns.filter(isRecord).map((column, index) => {
						const exportPolicy = isRecord(column.exportPolicy) ? column.exportPolicy : {};
						const formatter = isRecord(column.formatter) ? column.formatter : {};
						return {
							...createCsvDestinationColumnDraft(
								String(column.columnName ?? `column_${index + 1}`),
								String(column.label ?? column.columnName ?? `Column ${index + 1}`),
								typeof column.order === 'number' ? column.order : index + 1,
								String(column.valueType ?? 'string'),
								String(column.classification ?? 'internal')
							),
							required: Boolean(column.required),
							allowedValues: Array.isArray(column.allowedValues)
								? column.allowedValues.map(String).join(',')
								: '',
							valueMultiplicity: column.valueMultiplicity === 'multi' ? 'multi' : 'single',
							nullable: Boolean(column.nullable),
							formatter: String(formatter.operation ?? ''),
							nullHandling: String(column.nullHandling ?? 'empty'),
							requiredMissingPolicy: String(column.requiredMissingPolicy ?? 'review'),
							legalBasis: String(exportPolicy.legalBasis ?? 'legitimate_interest'),
							purpose: String(exportPolicy.purpose ?? 'attribute_release')
						};
					})
				: [createCsvDestinationColumnDraft('email', 'Email', 1, 'email', 'pii')];
			return;
		}
		if (schema.destinationType === 'saml') {
			const nameId = isRecord(schema.nameId) ? schema.nameId : {};
			setSamlNameIdFormat(String(nameId.format ?? persistentNameIdFormat));
			setSamlNameIdValue(String(nameId.source ?? 'subject_identifier'));
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
							examples: Array.isArray(attribute.examples) ? attribute.examples : [],
							note: String(attribute.note ?? ''),
							allowedValues: Array.isArray(attribute.allowedValues)
								? attribute.allowedValues.map(String).join(',')
								: '',
							valueMultiplicity: attribute.valueMultiplicity === 'multi' ? 'multi' : 'single',
							nullable: Boolean(attribute.nullable),
							releaseCondition: String(attribute.releaseCondition ?? ''),
							formatter: String(formatter.operation ?? ''),
							legalBasis: String(releasePolicy.legalBasis ?? 'legitimate_interest'),
							purpose: String(releasePolicy.purpose ?? 'attribute_release')
						};
					})
				: [createSamlAttributeDraft('urn:oid:0.9.2342.19200300.100.1.3', 'Email', 'email', 'pii')];
			return;
		}

		oidcClaimsParameterJson = isRecord(schema.claimsParameter)
			? JSON.stringify(schema.claimsParameter, null, 2)
			: '';
		oidcClaims = Array.isArray(schema.claims)
			? schema.claims.filter(isRecord).map((claim) => {
					const formatter = isRecord(claim.formatter) ? claim.formatter : {};
					const releasePolicy = isRecord(claim.releasePolicy) ? claim.releasePolicy : {};
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
						allowedValues: Array.isArray(claim.allowedValues)
							? claim.allowedValues.map(String).join(',')
							: '',
						valueMultiplicity: claim.valueMultiplicity === 'multi' ? 'multi' : 'single',
						nullable: Boolean(claim.nullable),
						releaseCondition: String(claim.releaseCondition ?? ''),
						legalBasis: String(
							releasePolicy.legalBasis ??
								(['pii', 'regulated'].includes(String(claim.classification ?? 'internal'))
									? 'consent'
									: 'legitimate_interest')
						),
						purpose: String(releasePolicy.purpose ?? 'attribute_release'),
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
		sourceProfileVersionId = null;
		sourceProfileVersionState = null;
		manualColumns = [createManualColumn('email', 'Email', 'email')];
	}

	function resetDestinationComposer() {
		editingDestinationProfileId = null;
		destinationAdvancedSettings = false;
		destinationDisplayName = '';
		destinationProfileKey = '';
		destinationVersionLabel = 'v1';
		destinationOwnerScopeType = 'tenant';
		destinationOwnerScopeId = '';
		destinationProtocolSchemaRef = '';
		destinationBlockingWarningsConfirmed = false;
		destinationProfileVersionId = null;
		destinationProfileVersionState = null;
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
		setSamlNameIdFormat(persistentNameIdFormat);
		setSamlNameIdValue('subject_identifier');
		samlAttributes = [
			createSamlAttributeDraft('urn:oid:0.9.2342.19200300.100.1.3', 'Email', 'email', 'pii')
		];
		consentDraft = createDestinationConsentSettingsDraft('destination-draft');
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
		if (isRecord(protocolSchemaRef) && typeof protocolSchemaRef.id === 'string')
			return protocolSchemaRef.id;
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
		for (const byte of bytes) binary += String.fromCharCode(byte);
		return btoa(binary);
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
		const trimmed = value.trim();
		if (!trimmed) return undefined;
		const parsed = JSON.parse(trimmed) as unknown;
		if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object`);
		return parsed;
	}

	function normalizeProfileKey(value: string): string {
		return value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '')
			.slice(0, 80);
	}

	function uniqueProfileKey(baseKey: string, existing: Array<{ profileKey: string }>): string {
		const normalized = normalizeProfileKey(baseKey) || 'profile';
		const keys = new Set(existing.map((item) => item.profileKey));
		if (!keys.has(normalized)) return normalized;
		for (let index = 2; index < 1000; index += 1) {
			const candidate = `${normalized}_${index}`;
			if (!keys.has(candidate)) return candidate;
		}
		return `${normalized}_${Date.now()}`;
	}

	function uniqueCopyDisplayName(baseName: string, existingNames: string[]): string {
		const names = new Set(existingNames.map((name) => name.trim().toLowerCase()));
		const first = `${baseName} copy`;
		if (!names.has(first.toLowerCase())) return first;
		for (let index = 2; index < 1000; index += 1) {
			const candidate = `${baseName} copy ${index}`;
			if (!names.has(candidate.toLowerCase())) return candidate;
		}
		return `${baseName} copy ${Date.now()}`;
	}

	function formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
		return `${Math.round(bytes / (1024 * 1024))} MiB`;
	}
</script>

<div class="profile-editor-page">
	<a class="back-link" href="/admin/identity-mapping/profiles">Back to profiles</a>

	<div class="page-heading">
		<div>
			<h1>{editorKind === 'source' ? 'Source Profile' : 'Destination Profile'}</h1>
			<p class="summary">
				{#if editorKind === 'source'}
					Register source profiles from CSV files or manual column definitions.
				{:else}
					Define destination release contracts, attribute groups, and consent settings.
				{/if}
			</p>
		</div>
		{#if getRequestedId()}
			<button
				type="button"
				class="danger-button"
				onclick={deleteCurrentProfile}
				disabled={deletingProfile}
			>
				{deletingProfile ? 'Deleting...' : 'Delete'}
			</button>
		{/if}
	</div>

	{#if !loading}
		<div
			class="profile-tabs"
			aria-label={editorKind === 'source' ? 'Source profile type' : 'Destination profile type'}
		>
			{#if editorKind === 'source'}
				<button
					type="button"
					class:active={csvMode === 'upload'}
					onclick={() => (csvMode = 'upload')}
				>
					CSV
				</button>
				<button
					type="button"
					class:active={csvMode === 'manual'}
					onclick={() => (csvMode = 'manual')}
				>
					Manual
				</button>
			{:else}
				<button
					type="button"
					class:active={destinationKind === 'oidc'}
					onclick={() => setDestinationKind('oidc')}>OIDC</button
				>
				<button
					type="button"
					class:active={destinationKind === 'saml'}
					onclick={() => setDestinationKind('saml')}>SAML</button
				>
				<button
					type="button"
					class:active={destinationKind === 'csv'}
					onclick={() => setDestinationKind('csv')}>CSV</button
				>
			{/if}
		</div>
	{/if}

	{#if loading}
		<section class="panel">
			<div class="empty-state">Loading profile editor.</div>
		</section>
	{:else if editorKind === 'source'}
		<section class="panel">
			<div class="panel-heading">
				<div>
					<p class="eyebrow">
						{editingSourceProfileId ? 'Edit Source Profile' : 'Create Source Profile'}
					</p>
					<h2>CSV source profile</h2>
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
				<p class="profile-note">Create a CSV profile from scratch.</p>
			{/if}

			{#if activeCsvSchema}
				<div class="detail-panel">
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
							<div><span>Columns</span><strong>{activeCsvSchema.columns.length}</strong></div>
							<div>
								<span>PII / regulated candidates</span><strong>{csvBlockingWarningCount}</strong>
							</div>
							<div>
								<span>Rows sampled</span><strong
									>{activeCsvSchema.summary?.rowSampleCount ?? 0}</strong
								>
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
						<div class="table-toolbar">
							<span></span>
							<label class="checkbox-row advanced-toggle">
								<input
									type="checkbox"
									checked={sourceAdvancedSettings}
									onchange={(event) => (sourceAdvancedSettings = getCheckboxValue(event))}
								/>
								<span>Advanced settings</span>
							</label>
						</div>
						<div class="column-table">
							<div class="column-header" class:advanced={sourceAdvancedSettings}>
								<span>Header</span><span>Label</span><span>Type</span><span>Allowed</span><span
									>Multiplicity</span
								><span>Nullable</span><span>Class</span><span>Required</span>{#if sourceAdvancedSettings}<span
										>Examples</span
									><span>Note</span>{/if}<span></span>
							</div>
							{#each activeCsvSchema.columns as column, index (column.stableColumnId)}
								<div class="column-row" class:advanced={sourceAdvancedSettings}>
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
										{#each valueTypeOptions as option (option)}<option value={option}
												>{option}</option
											>{/each}
									</select>
									<input
										value={(column.allowedValues ?? []).join(',')}
										placeholder="student,faculty"
										oninput={(event) =>
											updateCsvColumn(index, 'allowedValues', splitCsv(getInputValue(event)))}
									/>
									<select
										value={column.valueMultiplicity ?? 'single'}
										onchange={(event) =>
											updateCsvColumn(index, 'valueMultiplicity', getInputValue(event))}
									>
										{#each valueMultiplicityOptions as option (option)}
											<option value={option}>{option}</option>
										{/each}
									</select>
									<label class="mini-check">
										<input
											type="checkbox"
											checked={column.nullable === true}
											onchange={(event) =>
												updateCsvColumn(index, 'nullable', getCheckboxValue(event))}
										/>
									</label>
									<select
										value={column.classification}
										onchange={(event) =>
											updateCsvColumn(index, 'classification', getInputValue(event))}
									>
										{#each classificationOptions as option (option)}<option value={option}
												>{option}</option
											>{/each}
									</select>
									<label class="mini-check">
										<input
											type="checkbox"
											checked={column.required}
											onchange={(event) =>
												updateCsvColumn(index, 'required', getCheckboxValue(event))}
										/>
									</label>
									{#if sourceAdvancedSettings}
										<input
											value={(column.examples ?? []).map(String).join(',')}
											placeholder="sample1,sample2"
											oninput={(event) =>
												updateCsvColumn(index, 'examples', splitCsv(getInputValue(event)))}
										/>
										<input
											value={column.note ?? ''}
											placeholder="Field note"
											oninput={(event) => updateCsvColumn(index, 'note', getInputValue(event))}
										/>
									{/if}
									{#if csvMode === 'manual'}
										<button type="button" onclick={() => removeManualColumn(index)}>Remove</button>
									{/if}
								</div>
							{/each}
						</div>
						{#if csvMode === 'manual'}
							<div class="table-add-action">
								<button type="button" onclick={addManualColumn}>Add column</button>
							</div>
						{/if}
					{/if}
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

			<div class="profile-actions">
				<button type="button" onclick={saveCsvProfile} disabled={savingCsv || !canSaveCsvDraft}>
					{savingCsv ? 'Saving...' : 'Save draft profile'}
				</button>
				<div class="profile-action-row">
					<button
						type="button"
						onclick={reviewCurrentProfileVersion}
						disabled={!canReviewCsvDraft || reviewingProfile}
					>
						{reviewingProfile ? 'Reviewing...' : 'Review'}
					</button>
					<button
						type="button"
						onclick={activateCurrentProfileVersion}
						disabled={!canActivateCsvDraft || activatingProfile}
					>
						{activatingProfile ? 'Activating...' : 'Activate'}
					</button>
				</div>
			</div>
		</section>
	{:else}
		{#if !getRequestedId()}
			<section class="panel">
				<div class="panel-heading">
					<div>
						<p class="eyebrow">Create method</p>
						<h2>Start from a profile source</h2>
					</div>
				</div>
				<div class="profile-tabs" aria-label="Destination create method">
					<button
						type="button"
						class:active={destinationCreateMode === 'existing'}
						onclick={() => (destinationCreateMode = 'existing')}
					>
						Create from existing
					</button>
					<button
						type="button"
						class:active={destinationCreateMode === 'template'}
						onclick={() => (destinationCreateMode = 'template')}
					>
						Create from template
					</button>
					<button
						type="button"
						class:active={destinationCreateMode === 'manual'}
						onclick={() => (destinationCreateMode = 'manual')}
					>
						Manual
					</button>
				</div>

				{#if destinationCreateMode === 'existing'}
					<div class="creation-source-grid">
						<label>
							<span>Existing {destinationKind.toUpperCase()} destination</span>
							<select
								value={selectedExistingDestinationId}
								onchange={(event) => (selectedExistingDestinationId = getInputValue(event))}
							>
								<option value="">Choose destination profile</option>
								{#each destinationProfilesForCurrentKind() as profile (profile.id)}
									<option value={profile.id}>{profile.displayName}</option>
								{/each}
							</select>
						</label>
						<button
							type="button"
							onclick={copyExistingDestinationProfile}
							disabled={!selectedExistingDestinationId}
						>
							Copy
						</button>
					</div>
				{:else if destinationCreateMode === 'template'}
					<div class="template-browser" aria-label="Destination template browser">
						<div class="template-pane template-category-pane">
							{#each destinationTemplateCategories() as category (category)}
								<button
									type="button"
									class:active={currentTemplateCategory() === category}
									onclick={() => {
										selectedTemplateCategory = category;
										selectedTemplateId = '';
									}}
								>
									<i
										class={`template-category-icon ${templateCategoryIcon(category)}`}
										aria-hidden="true"
									></i>
									<span>{category}</span>
									<small>({destinationTemplateCategoryCount(category)})</small>
								</button>
							{/each}
						</div>
						<div class="template-pane">
							{#each destinationTemplatesForCurrentCategory() as template (template.id)}
								<button
									type="button"
									class:active={selectedDestinationTemplate()?.id === template.id}
									onclick={() => (selectedTemplateId = template.id)}
								>
									{template.displayName}
								</button>
							{/each}
						</div>
						<div class="template-detail">
							{#if selectedTemplate}
								<span>{selectedTemplate.destinationType.toUpperCase()} template</span>
								<strong>{selectedTemplate.displayName}</strong>
								<p>{selectedTemplate.description}</p>
								<dl>
									<div>
										<dt>Version</dt>
										<dd>{selectedTemplate.version}</dd>
									</div>
									<div>
										<dt>Updated</dt>
										<dd>{selectedTemplate.updatedAt}</dd>
									</div>
								</dl>
								<div class="template-detail-actions">
									<button type="button" onclick={() => (previewTemplate = selectedTemplate)}>
										Preview
									</button>
									<button type="button" onclick={() => copyDestinationTemplate(selectedTemplate)}>
										Use template
									</button>
								</div>
							{:else}
								<div class="empty-state">
									No templates are registered for this destination type.
								</div>
							{/if}
						</div>
					</div>
				{:else}
					<div class="empty-state">
						Start with a blank {destinationKind.toUpperCase()} destination profile.
					</div>
				{/if}
			</section>
		{/if}

		<section class="panel">
			<div class="panel-heading">
				<div>
					<p class="eyebrow">
						{editingDestinationProfileId
							? 'Edit Destination Profile'
							: 'Create Destination Profile'}
					</p>
					<h2>{destinationKind.toUpperCase()} destination profile</h2>
				</div>
			</div>

			<div class="settings-grid">
				<label>
					<span>Display name</span>
					<input
						value={destinationDisplayName}
						placeholder={destinationKind === 'oidc'
							? 'Library OIDC claims'
							: destinationKind === 'saml'
								? 'Library SAML attributes'
								: 'Weekly CSV export'}
						oninput={(event) => {
							destinationDisplayName = getInputValue(event);
							if (!destinationProfileKey.trim())
								destinationProfileKey = normalizeProfileKey(destinationDisplayName);
						}}
					/>
				</label>
			</div>

			{#if destinationKind === 'oidc'}
				<p class="profile-note">
					OIDC sub is required. Subject strategy is tenant default with client override.
				</p>
				<div class="table-toolbar">
					<span></span>
					<label class="checkbox-row advanced-toggle">
						<input
							type="checkbox"
							checked={destinationAdvancedSettings}
							onchange={(event) => (destinationAdvancedSettings = getCheckboxValue(event))}
						/>
						<span>Advanced settings</span>
					</label>
				</div>
				<div class="claim-table">
					<div class="claim-header" class:advanced={destinationAdvancedSettings}>
						<span>Claim</span><span>Label</span><span>Type</span><span>Allowed</span><span
							>Multiplicity</span
						><span>Nullable</span><span>Class</span><span>Surfaces</span><span>Scopes</span
						>{#if destinationAdvancedSettings}<span>Legal basis</span>{/if}<span></span>
					</div>
					<!-- ALLOWED may move behind Advanced if fixed-value constraints make the main table too dense. -->
					<!-- OIDC SURFACES may move behind Advanced, but it stays visible for now because ID Token vs UserInfo changes the release surface. -->
					{#each oidcClaims as claim, index (`${claim.claimName}-${index}`)}
						<div class="claim-row" class:advanced={destinationAdvancedSettings}>
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
								{#each valueTypeOptions as option (option)}<option value={option}>{option}</option
									>{/each}
							</select>
							<input
								value={claim.allowedValues}
								placeholder="student,faculty"
								oninput={(event) => updateOidcClaim(index, 'allowedValues', getInputValue(event))}
							/>
							<select
								value={claim.valueMultiplicity}
								onchange={(event) =>
									updateOidcClaim(index, 'valueMultiplicity', getInputValue(event))}
							>
								{#each valueMultiplicityOptions as option (option)}
									<option value={option}>{option}</option>
								{/each}
							</select>
							<label class="mini-check">
								<input
									type="checkbox"
									checked={claim.nullable}
									onchange={(event) => updateOidcClaim(index, 'nullable', getCheckboxValue(event))}
								/>
							</label>
							<select
								value={claim.classification}
								onchange={(event) => updateOidcClaim(index, 'classification', getInputValue(event))}
							>
								{#each classificationOptions as option (option)}<option value={option}
										>{option}</option
									>{/each}
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
							{#if destinationAdvancedSettings}
								<input
									value={claim.legalBasis}
									oninput={(event) => updateOidcClaim(index, 'legalBasis', getInputValue(event))}
								/>
							{/if}
							<button
								type="button"
								onclick={() => removeOidcClaim(index)}
								disabled={claim.claimName === 'sub'}>Remove</button
							>
						</div>
					{/each}
				</div>
				<div class="table-add-action">
					<button type="button" onclick={addOidcClaim}>Add claim</button>
				</div>
				<label>
					<span>Claims parameter policy JSON</span>
					<textarea
						rows="4"
						value={oidcClaimsParameterJson}
						oninput={(event) => (oidcClaimsParameterJson = getInputValue(event))}
					></textarea>
				</label>
			{:else if destinationKind === 'csv'}
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
							{#each nullHandlingOptions as option (option)}<option value={option}>{option}</option
								>{/each}
						</select>
					</label>
					<label>
						<span>Required missing policy</span>
						<select
							value={csvDestinationRequiredMissingPolicy}
							onchange={(event) => (csvDestinationRequiredMissingPolicy = getInputValue(event))}
						>
							{#each requiredMissingPolicyOptions as option (option)}<option value={option}
									>{option}</option
								>{/each}
						</select>
					</label>
				</div>
				<div class="table-toolbar">
					<span></span>
					<label class="checkbox-row advanced-toggle">
						<input
							type="checkbox"
							checked={destinationAdvancedSettings}
							onchange={(event) => (destinationAdvancedSettings = getCheckboxValue(event))}
						/>
						<span>Advanced settings</span>
					</label>
				</div>
				<div class="column-table">
					{#each csvDestinationColumns as column, index (`${column.columnName}-${index}`)}
						<div class="destination-column-row" class:advanced={destinationAdvancedSettings}>
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
								{#each valueTypeOptions as option (option)}<option value={option}>{option}</option
									>{/each}
							</select>
							<input
								value={column.allowedValues}
								placeholder="student,faculty"
								oninput={(event) =>
									updateCsvDestinationColumn(index, 'allowedValues', getInputValue(event))}
							/>
							<select
								value={column.valueMultiplicity}
								onchange={(event) =>
									updateCsvDestinationColumn(index, 'valueMultiplicity', getInputValue(event))}
							>
								{#each valueMultiplicityOptions as option (option)}
									<option value={option}>{option}</option>
								{/each}
							</select>
							<label class="mini-check">
								<input
									type="checkbox"
									checked={column.nullable}
									onchange={(event) =>
										updateCsvDestinationColumn(index, 'nullable', getCheckboxValue(event))}
								/>
							</label>
							<select
								value={column.classification}
								onchange={(event) =>
									updateCsvDestinationColumn(index, 'classification', getInputValue(event))}
							>
								{#each classificationOptions as option (option)}<option value={option}
										>{option}</option
									>{/each}
							</select>
							<label class="mini-check"
								><input
									type="checkbox"
									checked={column.required}
									onchange={(event) =>
										updateCsvDestinationColumn(index, 'required', getCheckboxValue(event))}
								/></label
							>
							{#if destinationAdvancedSettings}
								<input
									value={column.legalBasis}
									oninput={(event) =>
										updateCsvDestinationColumn(index, 'legalBasis', getInputValue(event))}
								/>
							{/if}
							<button type="button" onclick={() => removeCsvDestinationColumn(index)}>Remove</button
							>
						</div>
					{/each}
				</div>
				<div class="table-add-action">
					<button type="button" onclick={addCsvDestinationColumn}>Add column</button>
				</div>
			{:else}
				<div class="settings-grid">
					<label>
						<span>NameID format</span>
						<select
							value={samlNameIdFormatOption}
							onchange={(event) => setSamlNameIdFormatOption(getInputValue(event))}
						>
							{#each samlNameIdFormatOptions as option (option.value)}
								<option value={option.value}>{option.label}</option>
							{/each}
						</select>
					</label>
					<label>
						<span>NameID value</span>
						<select
							value={samlNameIdValueOption}
							onchange={(event) => setSamlNameIdValueOption(getInputValue(event))}
						>
							{#each samlNameIdValueOptions as option (option.value)}
								<option value={option.value}>{option.label}</option>
							{/each}
						</select>
					</label>
					{#if samlNameIdFormatOption === customOptionValue}
						<label>
							<span>Custom NameID format</span>
							<input
								value={customSamlNameIdFormat}
								placeholder="urn:oasis:names:tc:SAML:..."
								oninput={(event) => (customSamlNameIdFormat = getInputValue(event))}
							/>
						</label>
					{/if}
					{#if samlNameIdValueOption === customOptionValue}
						<label>
							<span>Custom NameID value</span>
							<input
								value={customSamlNameIdValue}
								placeholder="field_key"
								oninput={(event) => (customSamlNameIdValue = getInputValue(event))}
							/>
						</label>
					{/if}
				</div>
				<p class="profile-note">
					SAML attributes are defined here for destination profile creation.
				</p>
				<div class="table-toolbar">
					<span></span>
					<label class="checkbox-row advanced-toggle">
						<input
							type="checkbox"
							checked={destinationAdvancedSettings}
							onchange={(event) => (destinationAdvancedSettings = getCheckboxValue(event))}
						/>
						<span>Advanced settings</span>
					</label>
				</div>
				<div class="saml-attribute-table">
					<div class="saml-attribute-header" class:advanced={destinationAdvancedSettings}>
						<span>Name</span><span>Label</span>{#if destinationAdvancedSettings}<span
								>Name format</span
							>{/if}<span>Type</span><span>Allowed</span><span>Multiplicity</span><span
							>Nullable</span
						><span>Class</span><span>Required</span>{#if destinationAdvancedSettings}<span
								>Legal basis</span
							>{/if}<span></span>
					</div>
					{#each samlAttributes as attribute, index (`${attribute.name}-${index}`)}
						<div class="saml-attribute-row" class:advanced={destinationAdvancedSettings}>
							<input
								value={attribute.name}
								oninput={(event) => updateSamlAttribute(index, 'name', getInputValue(event))}
							/>
							<input
								value={attribute.label}
								oninput={(event) => updateSamlAttribute(index, 'label', getInputValue(event))}
							/>
							{#if destinationAdvancedSettings}
								<input
									value={attribute.nameFormat}
									oninput={(event) =>
										updateSamlAttribute(index, 'nameFormat', getInputValue(event))}
								/>
							{/if}
							<select
								value={attribute.valueType}
								onchange={(event) => updateSamlAttribute(index, 'valueType', getInputValue(event))}
							>
								{#each valueTypeOptions as option (option)}<option value={option}>{option}</option
									>{/each}
							</select>
							<input
								value={attribute.allowedValues}
								placeholder="student,faculty"
								oninput={(event) =>
									updateSamlAttribute(index, 'allowedValues', getInputValue(event))}
							/>
							<select
								value={attribute.valueMultiplicity}
								onchange={(event) =>
									updateSamlAttribute(index, 'valueMultiplicity', getInputValue(event))}
							>
								{#each valueMultiplicityOptions as option (option)}
									<option value={option}>{option}</option>
								{/each}
							</select>
							<label class="mini-check">
								<input
									type="checkbox"
									checked={attribute.nullable}
									onchange={(event) =>
										updateSamlAttribute(index, 'nullable', getCheckboxValue(event))}
								/>
							</label>
							<select
								value={attribute.classification}
								onchange={(event) =>
									updateSamlAttribute(index, 'classification', getInputValue(event))}
							>
								{#each classificationOptions as option (option)}<option value={option}
										>{option}</option
									>{/each}
							</select>
							<label class="mini-check"
								><input
									type="checkbox"
									checked={attribute.required}
									onchange={(event) =>
										updateSamlAttribute(index, 'required', getCheckboxValue(event))}
								/></label
							>
							{#if destinationAdvancedSettings}
								<input
									value={attribute.legalBasis}
									oninput={(event) =>
										updateSamlAttribute(index, 'legalBasis', getInputValue(event))}
								/>
							{/if}
							<button type="button" onclick={() => removeSamlAttribute(index)}>Remove</button>
						</div>
					{/each}
				</div>
				<div class="table-add-action">
					<button type="button" onclick={addSamlAttribute}>Add SAML attribute</button>
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
						{oidcClaims.length} claims
					{:else if destinationKind === 'saml'}
						{samlAttributes.length} attributes
					{:else}
						{csvDestinationColumns.length} columns
					{/if}
				</strong>
				<small>{destinationBlockingWarningCount} blocking warning(s)</small>
			</div>

			<div class="profile-actions">
				<div class="profile-action-row">
					<button type="button" onclick={scrollToReleaseConsent}>
						Configure Release Consent
					</button>
					<button
						type="button"
						onclick={saveDestinationProfile}
						disabled={savingDestination || !canSaveDestinationDraft}
					>
						{savingDestination ? 'Saving...' : 'Save destination draft'}
					</button>
				</div>
				<div class="profile-action-row">
					<button
						type="button"
						onclick={reviewCurrentProfileVersion}
						disabled={!canReviewDestinationDraft || reviewingProfile}
					>
						{reviewingProfile ? 'Reviewing...' : 'Review'}
					</button>
					<button
						type="button"
						onclick={activateCurrentProfileVersion}
						disabled={!canActivateDestinationDraft || activatingProfile}
					>
						{activatingProfile ? 'Activating...' : 'Activate'}
					</button>
				</div>
			</div>
		</section>

		<section id="destination-consent" class="panel" aria-label="Destination consent settings">
			<div>
				<p class="eyebrow">Destination Consent Settings</p>
				<h2>Release consent</h2>
			</div>
			<div class="settings-grid">
				<label>
					<span>Scope</span>
					<select
						value={consentDraft.scope}
						onchange={(event) =>
							updateConsentDraft({
								scope: getInputValue(event) as DestinationConsentSettingsDraft['scope']
							})}
					>
						<option value="tenant_default">Tenant default</option>
						<option value="destination_override">Destination override</option>
					</select>
				</label>
				<label>
					<span>Consent mode</span>
					<select
						value={consentDraft.consentMode}
						onchange={(event) =>
							updateConsentDraft({
								consentMode: getInputValue(event) as DestinationConsentSettingsDraft['consentMode']
							})}
					>
						<option value="once">Once</option>
						<option value="every_time">Every time</option>
						<option value="until_attributes_change">Until attributes change</option>
					</select>
				</label>
				<label class="checkbox-row">
					<input
						type="checkbox"
						checked={consentDraft.regulatedPurposeGuard}
						onchange={(event) =>
							updateConsentDraft({ regulatedPurposeGuard: getCheckboxValue(event) })}
					/>
					<span>Require purpose guard for regulated attributes</span>
				</label>
			</div>
			<div class="impact-preview">
				<span>Preview</span>
				<strong>{summarizeDestinationConsentSettings(consentDraft)}</strong>
				<small>Raw attribute values remain {consentDraft.rawValueDisplay}.</small>
			</div>
		</section>

		<section id="registries" class="panel">
			<div class="panel-heading">
				<div>
					<p class="eyebrow">Attribute Registry</p>
					<h2>Groups and fields</h2>
				</div>
			</div>
			<div class="registry-grid">
				<div class="registry-card">
					<h2>Attribute group</h2>
					<label
						><span>Protocol</span><select
							value={groupProtocol}
							onchange={(event) =>
								(groupProtocol = getInputValue(event) as IdentityMappingAttributeProtocol)}
							>{#each attributeProtocolOptions as option (option)}<option value={option}
									>{option}</option
								>{/each}</select
						></label
					>
					<label
						><span>Group type</span><select
							value={groupType}
							onchange={(event) => (groupType = getInputValue(event))}
							>{#each attributeGroupTypeOptions as option (option)}<option value={option}
									>{option}</option
								>{/each}</select
						></label
					>
					<label
						><span>Group key</span><input
							value={groupKey}
							placeholder="library"
							oninput={(event) => (groupKey = getInputValue(event))}
						/></label
					>
					<label
						><span>Display name</span><input
							value={groupDisplayName}
							placeholder="Library"
							oninput={(event) => (groupDisplayName = getInputValue(event))}
						/></label
					>
					<label
						><span>Owner scope</span><select
							value={groupOwnerScopeType}
							onchange={(event) =>
								(groupOwnerScopeType = getInputValue(event) as typeof groupOwnerScopeType)}
							>{#each registryOwnerScopeOptions as option (option)}<option value={option}
									>{option}</option
								>{/each}</select
						></label
					>
					<label
						><span>Field keys</span><input
							value={groupFieldKeys}
							placeholder="library_card,patron_type"
							oninput={(event) => (groupFieldKeys = getInputValue(event))}
						/></label
					>
					<label
						><span>Description</span><input
							value={groupDescription}
							oninput={(event) => (groupDescription = getInputValue(event))}
						/></label
					>
					<button
						type="button"
						onclick={saveAttributeGroup}
						disabled={savingRegistry ||
							!groupType.trim() ||
							!groupKey.trim() ||
							!groupDisplayName.trim()}>Save attribute group</button
					>
				</div>
				<div class="registry-card">
					<h2>Attribute field</h2>
					<label
						><span>Protocol</span><select
							value={fieldProtocol}
							onchange={(event) =>
								(fieldProtocol = getInputValue(event) as IdentityMappingAttributeProtocol)}
							>{#each attributeProtocolOptions as option (option)}<option value={option}
									>{option}</option
								>{/each}</select
						></label
					>
					<label
						><span>Field key</span><input
							value={fieldKey}
							placeholder="library_card"
							oninput={(event) => (fieldKey = getInputValue(event))}
						/></label
					>
					<label
						><span>Display name</span><input
							value={fieldDisplayName}
							placeholder="Library card"
							oninput={(event) => (fieldDisplayName = getInputValue(event))}
						/></label
					>
					<label
						><span>Owner scope</span><select
							value={fieldOwnerScopeType}
							onchange={(event) =>
								(fieldOwnerScopeType = getInputValue(event) as typeof fieldOwnerScopeType)}
							>{#each registryOwnerScopeOptions as option (option)}<option value={option}
									>{option}</option
								>{/each}</select
						></label
					>
					<label
						><span>Value type</span><select
							value={fieldValueType}
							onchange={(event) => (fieldValueType = getInputValue(event))}
							>{#each valueTypeOptions as option (option)}<option value={option}>{option}</option
								>{/each}</select
						></label
					>
					<label
						><span>Classification</span><select
							value={fieldClassification}
							onchange={(event) => (fieldClassification = getInputValue(event))}
							>{#each classificationOptions as option (option)}<option value={option}
									>{option}</option
								>{/each}</select
						></label
					>
					<div class="surface-checks">
						{#each oidcSurfaceOptions as surface (surface)}
							<label class="mini-check"
								><input
									type="checkbox"
									disabled={fieldProtocol !== 'oidc'}
									checked={fieldSurfaces.includes(surface)}
									onchange={(event) => toggleFieldSurface(surface, getCheckboxValue(event))}
								/><span>{surface}</span></label
							>
						{/each}
					</div>
					<button
						type="button"
						onclick={saveAttributeField}
						disabled={savingRegistry ||
							!fieldKey.trim() ||
							!fieldDisplayName.trim() ||
							(fieldProtocol === 'oidc' && fieldSurfaces.length === 0)}>Save attribute field</button
					>
				</div>
			</div>
			<div class="registry-grid">
				<div class="registry-card">
					<h2>Groups</h2>
					{#each attributeGroups as group (group.id)}
						<p>
							<strong>{group.groupKey}</strong> / {group.protocol} / {group.groupType} / {group.fieldKeys.join(
								', '
							)}
						</p>
					{:else}
						<p>No attribute groups registered.</p>
					{/each}
				</div>
				<div class="registry-card">
					<h2>Fields</h2>
					{#each attributeFields as field (field.id)}
						<p>
							<strong>{field.fieldKey}</strong> / {field.protocol} / {field.classification} / {field.surfaces.join(
								', '
							)}
						</p>
					{:else}
						<p>No attribute fields registered.</p>
					{/each}
				</div>
			</div>
		</section>
	{/if}

	{#if message}
		<div class="empty-state">{message}</div>
	{/if}
</div>

{#if previewTemplate}
	<div class="modal-backdrop">
		<div
			class="template-preview-modal"
			role="dialog"
			aria-modal="true"
			aria-labelledby="template-preview-title"
		>
			<div class="template-preview-heading">
				<div>
					<p class="eyebrow">Template preview</p>
					<h2 id="template-preview-title">{previewTemplate.displayName}</h2>
				</div>
				<button type="button" onclick={() => (previewTemplate = null)}>Close</button>
			</div>
			<div class="template-preview-table" role="table" aria-label="Template attribute preview">
				<div class="template-preview-row template-preview-header" role="row">
					<span role="columnheader">Name</span>
					<span role="columnheader">Label</span>
					<span role="columnheader">Type</span>
					<span role="columnheader">Required</span>
				</div>
				{#each templatePreviewRows(previewTemplate) as row, index (`${row.name}-${index}`)}
					<div class="template-preview-row" role="row">
						<span role="cell">{row.name}</span>
						<span role="cell">{row.label}</span>
						<span role="cell">{row.type}</span>
						<span role="cell">{row.required ? 'Yes' : 'No'}</span>
					</div>
				{:else}
					<div class="template-preview-empty">No attributes are defined in this template.</div>
				{/each}
			</div>
		</div>
	</div>
{/if}

<style>
	.profile-editor-page {
		display: grid;
		gap: 18px;
	}

	.page-heading,
	.panel-heading,
	.action-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 18px;
	}

	.action-row {
		align-items: center;
		justify-content: flex-start;
	}

	.table-add-action {
		display: flex;
		justify-content: center;
		padding-top: 4px;
	}

	.profile-actions {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 10px;
	}

	.profile-action-row {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
	}

	.back-link {
		color: var(--color-primary);
		font-size: 13px;
		font-weight: 700;
		text-decoration: none;
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

	h2 {
		color: var(--text-primary);
		font-size: 16px;
	}

	.summary,
	.profile-note,
	.action-row span,
	.registry-card p {
		color: var(--text-secondary);
		font-size: 13px;
		line-height: 1.45;
	}

	.eyebrow,
	label span,
	.metrics-grid span,
	.impact-preview span {
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 800;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.panel,
	.empty-state,
	.detail-panel,
	.registry-card,
	.impact-preview,
	.metrics-grid div {
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--bg-card);
	}

	.panel,
	.detail-panel {
		display: grid;
		gap: 14px;
		padding: 16px;
	}

	.empty-state,
	.registry-card,
	.impact-preview,
	.metrics-grid div {
		padding: 14px;
	}

	.profile-tabs,
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
		text-decoration: none;
	}

	button.active {
		color: var(--text-primary);
		border-color: var(--color-primary);
		background: var(--bg-hover);
	}

	.danger-button {
		color: #ff3535;
		border-color: rgba(255, 53, 53, 0.75);
	}

	.danger-button:hover:not(:disabled),
	.danger-button:focus-visible:not(:disabled) {
		color: #ff4f4f;
		border-color: #ff4f4f;
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.registry-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}

	.template-detail strong,
	.impact-preview strong,
	.metrics-grid strong {
		display: block;
		color: var(--text-primary);
	}

	.template-browser {
		display: grid;
		grid-template-columns: minmax(180px, 0.8fr) minmax(220px, 1fr) minmax(260px, 1.1fr);
		gap: 12px;
	}

	.template-pane,
	.template-detail {
		display: grid;
		align-content: start;
		gap: 2px;
		min-height: 180px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--bg-card);
		padding: 6px;
	}

	.template-pane button {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		justify-content: flex-start;
		width: 100%;
		min-height: 28px;
		border-color: transparent;
		border-radius: 4px;
		background: transparent;
		padding: 0 8px;
		text-align: left;
	}

	.template-pane button:hover {
		background: var(--bg-hover);
	}

	.template-pane button.active {
		border-color: transparent;
		background: var(--bg-hover);
	}

	.template-pane button span {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.template-pane button small {
		flex: 0 0 auto;
		color: var(--text-muted);
		font-size: 12px;
	}

	.template-category-icon {
		flex: 0 0 auto;
		width: 16px;
		height: 16px;
		color: var(--text-muted);
	}

	.template-detail {
		gap: 8px;
		padding: 10px;
	}

	.template-detail span {
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 800;
		text-transform: uppercase;
	}

	.template-detail p {
		margin: 0;
		color: var(--text-secondary);
		font-size: 13px;
		line-height: 1.4;
	}

	.template-detail dl {
		display: grid;
		gap: 8px;
		margin: 0;
	}

	.template-detail dl div {
		display: flex;
		justify-content: space-between;
		gap: 12px;
	}

	.template-detail dt,
	.template-detail dd {
		margin: 0;
		color: var(--text-secondary);
		font-size: 13px;
	}

	.template-detail dt {
		font-weight: 800;
	}

	.template-detail-actions {
		display: flex;
		justify-content: space-between;
		gap: 10px;
	}

	.modal-backdrop {
		position: fixed;
		z-index: 1000;
		inset: 0;
		display: grid;
		place-items: center;
		padding: 24px;
		background: rgba(0, 0, 0, 0.58);
	}

	.template-preview-modal {
		display: grid;
		gap: 14px;
		width: min(920px, 100%);
		max-height: min(760px, calc(100vh - 48px));
		overflow: auto;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--bg-card);
		padding: 16px;
		box-shadow: 0 22px 70px rgba(0, 0, 0, 0.35);
	}

	.template-preview-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}

	.template-preview-table {
		display: grid;
		overflow-x: auto;
		border: 1px solid var(--border-color);
		border-radius: 8px;
	}

	.template-preview-row {
		display: grid;
		grid-template-columns: minmax(220px, 1.3fr) minmax(180px, 1fr) 120px 110px;
		gap: 12px;
		min-width: 660px;
		padding: 9px 10px;
		border-bottom: 1px solid var(--border-color);
		color: var(--text-secondary);
		font-size: 13px;
	}

	.template-preview-row:last-child {
		border-bottom: 0;
	}

	.template-preview-header {
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 800;
		text-transform: uppercase;
	}

	.template-preview-empty {
		padding: 14px;
		color: var(--text-secondary);
		font-size: 13px;
	}

	.settings-grid,
	.metrics-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 12px;
	}

	.parser-grid {
		grid-template-columns: minmax(260px, 2fr) repeat(3, minmax(0, 1fr));
	}

	.creation-source-grid {
		display: grid;
		justify-items: start;
		gap: 10px;
	}

	.creation-source-grid label,
	.creation-source-grid select {
		width: auto;
		min-width: 260px;
		max-width: min(520px, 100%);
	}

	label {
		display: grid;
		gap: 6px;
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

	pre {
		overflow: auto;
		margin: 0;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		padding: 12px;
		color: var(--text-secondary);
		background: var(--bg-hover);
	}

	.column-table,
	.claim-table,
	.saml-attribute-table,
	.registry-card {
		display: grid;
		gap: 8px;
		overflow-x: auto;
	}

	.table-toolbar {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		gap: 12px;
		margin: 4px 0;
	}

	.advanced-toggle {
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 800;
		text-transform: uppercase;
	}

	.column-header,
	.column-row,
	.claim-header,
	.claim-row,
	.destination-column-row,
	.saml-attribute-header,
	.saml-attribute-row {
		display: grid;
		gap: 8px;
		align-items: center;
	}

	.column-header,
	.column-row {
		grid-template-columns: 1.2fr 1.2fr 0.85fr 1.15fr 0.75fr 76px 0.9fr 80px 90px;
		min-width: 1180px;
	}

	.column-header.advanced,
	.column-row.advanced {
		grid-template-columns: 1.2fr 1.2fr 0.85fr 1.15fr 0.75fr 76px 0.9fr 80px 1fr 1.3fr 90px;
		min-width: 1480px;
	}

	.claim-header,
	.claim-row {
		grid-template-columns: 1fr 1fr 0.75fr 1.1fr 0.75fr 76px 0.8fr 1.2fr 1fr 90px;
		min-width: 1320px;
	}

	.claim-header.advanced,
	.claim-row.advanced {
		grid-template-columns: 1fr 1fr 0.75fr 1.1fr 0.75fr 76px 0.8fr 1.2fr 1fr 1fr 90px;
		min-width: 1440px;
	}

	.destination-column-row {
		grid-template-columns: 1fr 1fr 0.75fr 1.1fr 0.75fr 76px 0.8fr 80px 90px;
		min-width: 1160px;
	}

	.destination-column-row.advanced {
		grid-template-columns: 1fr 1fr 0.75fr 1.1fr 0.75fr 76px 0.8fr 80px 1fr 90px;
		min-width: 1280px;
	}

	.saml-attribute-header,
	.saml-attribute-row {
		grid-template-columns: 1.25fr 1fr 0.75fr 1.1fr 0.75fr 76px 0.8fr 80px 90px;
		min-width: 1160px;
	}

	.saml-attribute-header.advanced,
	.saml-attribute-row.advanced {
		grid-template-columns: 1.25fr 1fr 1.25fr 0.75fr 1.1fr 0.75fr 76px 0.8fr 80px 1fr 90px;
		min-width: 1440px;
	}

	.column-header,
	.claim-header,
	.saml-attribute-header {
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

	@media (max-width: 1020px) {
		.page-heading,
		.panel-heading {
			display: grid;
		}

		.settings-grid,
		.parser-grid,
		.registry-grid,
		.template-browser,
		.metrics-grid {
			grid-template-columns: 1fr;
		}

		.column-header,
		.claim-header,
		.saml-attribute-header {
			display: none;
		}

		.column-row,
		.claim-row,
		.destination-column-row,
		.saml-attribute-row {
			grid-template-columns: 1fr;
			min-width: 0;
			border: 1px solid var(--border-color);
			border-radius: 8px;
			padding: 10px;
		}
	}
</style>
