<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { getLocale, LL } from '$i18n/i18n-svelte';
	import { ToggleSwitch } from '$lib/components';
	import {
		adminSAMLAPI,
		type CreateSAMLProviderRequest,
		type SAMLFederationTrustProfile,
		type SAMLMetadataAggregatePreviewResponse,
		type SAMLMetadataBatchStatus,
		type SAMLMetadataEntitySummary,
		type SAMLMetadataKeywordFacet,
		type SAMLJitEmailLinkingPolicy,
		type SAMLProvider,
		type SAMLProviderConfig,
		type SAMLTrustCertificatePreview
	} from '$lib/api/admin-saml';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingFieldMappingSetSummary
	} from '$lib/api/admin-identity-mapping';
	import LoginProviderIconPicker from '$lib/components/admin/LoginProviderIconPicker.svelte';
	import { onMount } from 'svelte';

	type SetupMode = 'metadata_url' | 'metadata_xml' | 'manual';
	type AggregateImportMode = 'selected_entities' | 'trust_profile';
	type SetupTarget = SAMLProvider['providerType'] | 'federation';

	const nameIdFormats = [
		{
			value: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
			label: 'Email address'
		},
		{
			value: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
			label: 'Persistent'
		},
		{
			value: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
			label: 'Transient'
		},
		{
			value: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
			label: 'Unspecified'
		},
		{
			value: 'urn:mace:shibboleth:1.0:nameIdentifier',
			label: 'Shibboleth 1.x'
		}
	];

	let fieldMappingSets = $state<IdentityMappingFieldMappingSetSummary[]>([]);
	let setupTarget = $state<SetupTarget>('saml_idp');
	let providerType = $state<SAMLProvider['providerType']>('saml_idp');
	let setupMode = $state<SetupMode>('manual');
	let name = $state('');
	let description = $state('');
	let enabled = $state(true);
	let metadataUrl = $state('');
	let metadataXml = $state('');
	let providerName = $state('Authrim');
	let logoUrl = $state('');
	let iconName = $state('');
	let entityId = $state('');
	let ssoUrl = $state('');
	let acsUrl = $state('');
	let sloUrl = $state('');
	let certificate = $state('');
	let nameIdFormat = $state(nameIdFormats[0].value);
	let allowPost = $state(true);
	let allowRedirect = $state(true);
	let signAssertions = $state(true);
	let signResponses = $state(true);
	let authnRequestSignaturePolicy = $state<'required' | 'optional' | 'disabled'>('optional');
	let logoutRequestSignaturePolicy = $state<'required' | 'optional' | 'disabled'>('required');
	let authnContextPolicyMode = $state<'observe' | 'require_any'>('observe');
	let jitEmailLinkingPolicy = $state<SAMLJitEmailLinkingPolicy>('email_linking');
	let allowSyntheticEmailFallback = $state(false);
	let allowedAuthnContextClassRefs = $state(
		'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport'
	);
	let authnContextClassRefMode = $state<'legacy_static' | 'session'>('legacy_static');
	let defaultAuthnContextClassRef = $state(
		'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport'
	);
	let passkeyAuthnContextClassRef = $state('urn:authrim:acr:phishing-resistant');
	let identityMappingFieldMappingSetId = $state('');
	let attributeMappingJson = $state('{\n\t"email": "email",\n\t"name": "name"\n}');
	let importingMetadata = $state(false);
	let metadataImported = $state(false);
	let metadataImportedProviderType = $state<SAMLProvider['providerType'] | ''>('');
	let metadataImportMessage = $state('');
	let metadataImportTone = $state<'success' | 'warning'>('success');
	let metadataImportError = $state('');
	let lastImportedMetadataUrl = $state('');
	let aggregatePreview = $state<SAMLMetadataAggregatePreviewResponse | null>(null);
	let aggregateEntities = $state<SAMLMetadataEntitySummary[]>([]);
	let aggregateEntityTotal = $state(0);
	let aggregateEntityQuery = $state('');
	let aggregateKeywordFacets = $state<SAMLMetadataKeywordFacet[]>([]);
	let aggregateKeywordCategory = $state('');
	let selectedAggregateKeywords = $state<string[]>([]);
	let loadingAggregateEntities = $state(false);
	let aggregateEntitiesOffset = $state(0);
	let aggregateHasMoreEntities = $state(false);
	let selectedAggregateEntityIds = $state<string[]>([]);
	let aggregateBatch = $state<SAMLMetadataBatchStatus | null>(null);
	let aggregateBatchPolling: ReturnType<typeof setInterval> | undefined;
	let aggregateImportMode = $state<AggregateImportMode>('selected_entities');
	let federationProfileName = $state('');
	let federationProfileUrlPattern = $state('');
	let federationProfileCertificateUrl = $state('');
	let federationProfileCertificate = $state('');
	let federationProfilePolicy = $state<'strict' | 'warn' | 'disabled'>('strict');
	let federationProfileCreated = $state<SAMLFederationTrustProfile | null>(null);
	let federationProfileSavedMessage = $state('');
	let providerSavedMessage = $state('');
	let providerCertificatePreview = $state<SAMLTrustCertificatePreview | null>(null);
	let providerCertificateError = $state('');
	let loadingProviderCertificate = $state(false);
	let federationCertificatePreview = $state<SAMLTrustCertificatePreview | null>(null);
	let federationCertificateError = $state('');
	let loadingFederationCertificate = $state(false);
	let editingFederationProfileId = $state('');
	let loadingFederationProfile = $state(false);
	let activeAggregateKeywordFacet = $derived(
		aggregateKeywordFacets.find((facet) => facet.category === aggregateKeywordCategory) ?? null
	);
	let isEditingFederationProfile = $derived(Boolean(editingFederationProfileId));
	let saving = $state(false);
	let error = $state('');
	let metadataImportTimer: ReturnType<typeof setTimeout> | undefined;
	let providerCertificatePreviewTimer: ReturnType<typeof setTimeout> | undefined;
	let federationCertificatePreviewTimer: ReturnType<typeof setTimeout> | undefined;
	const activeFieldMappingSets = $derived(
		fieldMappingSets.filter((fieldMappingSet) => fieldMappingSet.lifecycleState === 'active')
	);

	onMount(() => {
		const trustProfileId = $page.url.searchParams.get('trustProfileId');
		const requestedType = $page.url.searchParams.get('type');
		if (trustProfileId) {
			editingFederationProfileId = trustProfileId;
			setupTarget = 'federation';
			void loadFederationTrustProfileForEdit(trustProfileId);
		} else {
			providerType = requestedType === 'sp' ? 'saml_sp' : 'saml_idp';
			setupTarget = providerType;
		}
		void loadFieldMappingSets();
	});

	async function loadFieldMappingSets() {
		try {
			const result = await adminIdentityMappingAPI.listFieldMappingSets();
			fieldMappingSets = result.fieldMappingSets;
		} catch {
			fieldMappingSets = [];
		}
	}

	async function loadFederationTrustProfileForEdit(id: string) {
		loadingFederationProfile = true;
		error = '';
		try {
			const result = await adminSAMLAPI.listFederationTrustProfiles();
			const profile = result.profiles.find((item) => item.id === id);
			if (!profile) {
				error = $LL.admin_saml_new_federation_not_found();
				return;
			}
			federationProfileName = profile.name;
			description = profile.description ?? '';
			enabled = profile.enabled;
			federationProfilePolicy = profile.policy ?? 'strict';
			federationProfileUrlPattern = profile.metadataUrlPatterns.join('\n');
			federationProfileCertificate = profile.certificates
				.map((certificate) => certificate.certificate.trim())
				.filter(Boolean)
				.join('\n\n');
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_saml_new_error_load_federation();
		} finally {
			loadingFederationProfile = false;
		}
	}

	function parseMapping(): Record<string, string> {
		if (!attributeMappingJson.trim()) return {};
		const parsed = JSON.parse(attributeMappingJson) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error($LL.admin_saml_detail_mapping_object_error());
		}
		return parsed as Record<string, string>;
	}

	function selectedBindings() {
		const bindings: string[] = [];
		if (allowPost) bindings.push('post');
		if (allowRedirect) bindings.push('redirect');
		return bindings;
	}

	function buildManualConfig(): SAMLProviderConfig {
		const config: SAMLProviderConfig = {
			description: description.trim() || undefined,
			logoUrl: logoUrl.trim() || undefined,
			iconName: iconName || undefined,
			entityId: entityId.trim(),
			sloUrl: sloUrl.trim() || undefined,
			nameIdFormat,
			attributeMapping: parseMapping(),
			allowedBindings: selectedBindings()
		};

		if (providerType === 'saml_idp') {
			return {
				...config,
				providerName: providerName.trim() || undefined,
				ssoUrl: ssoUrl.trim(),
				certificate: certificate.trim(),
				logoutRequestSignaturePolicy,
				jitEmailLinkingPolicy,
				allowSyntheticEmailFallback,
				authnContextPolicy: {
					mode: authnContextPolicyMode,
					allowedClassRefs: allowedAuthnContextClassRefs
						.split('\n')
						.map((value) => value.trim())
						.filter(Boolean)
				}
			};
		}

		return {
			...config,
			acsUrl: acsUrl.trim(),
			certificate: certificate.trim() || undefined,
			signAssertions,
			signResponses,
			authnRequestSignaturePolicy,
			logoutRequestSignaturePolicy,
			authnContextClassRefMode,
			defaultAuthnContextClassRef: defaultAuthnContextClassRef.trim() || undefined,
			passkeyAuthnContextClassRef: passkeyAuthnContextClassRef.trim() || undefined,
			identityMapping: {
				fieldMappingSetId: identityMappingFieldMappingSetId,
				destinationNamespace: 'saml.attribute'
			}
		};
	}

	function buildMetadataConfig(): SAMLProviderConfig {
		const config: SAMLProviderConfig = {
			description: description.trim() || undefined,
			logoUrl: logoUrl.trim() || undefined,
			iconName: iconName || undefined
		};
		if (providerType !== 'saml_sp') {
			return {
				...config,
				providerName: providerName.trim() || undefined,
				logoutRequestSignaturePolicy,
				jitEmailLinkingPolicy,
				allowSyntheticEmailFallback,
				authnContextPolicy: {
					mode: authnContextPolicyMode,
					allowedClassRefs: allowedAuthnContextClassRefs
						.split('\n')
						.map((value) => value.trim())
						.filter(Boolean)
				}
			};
		}
		return {
			...config,
			authnRequestSignaturePolicy,
			logoutRequestSignaturePolicy,
			authnContextClassRefMode,
			defaultAuthnContextClassRef: defaultAuthnContextClassRef.trim() || undefined,
			passkeyAuthnContextClassRef: passkeyAuthnContextClassRef.trim() || undefined,
			identityMapping: {
				fieldMappingSetId: identityMappingFieldMappingSetId,
				destinationNamespace: 'saml.attribute'
			}
		};
	}

	function applyPreviewConfig(config: SAMLProviderConfig) {
		providerName = config.providerName || providerName;
		logoUrl = config.logoUrl || '';
		iconName = config.iconName || iconName;
		entityId = config.entityId || '';
		ssoUrl = config.ssoUrl || '';
		acsUrl = config.acsUrl || '';
		sloUrl = config.sloUrl || '';
		certificate = config.certificate || '';
		nameIdFormat = config.nameIdFormat || nameIdFormats[0].value;
		allowPost = config.allowedBindings?.includes('post') ?? true;
		allowRedirect = config.allowedBindings?.includes('redirect') ?? true;
		signAssertions = config.signAssertions ?? true;
		signResponses = config.signResponses ?? true;
		authnRequestSignaturePolicy = config.authnRequestSignaturePolicy || 'optional';
		logoutRequestSignaturePolicy = config.logoutRequestSignaturePolicy || 'required';
		authnContextPolicyMode = config.authnContextPolicy?.mode || 'observe';
		jitEmailLinkingPolicy = config.jitEmailLinkingPolicy || jitEmailLinkingPolicy;
		allowSyntheticEmailFallback =
			config.allowSyntheticEmailFallback === undefined
				? allowSyntheticEmailFallback
				: config.allowSyntheticEmailFallback === true;
		allowedAuthnContextClassRefs = (
			config.authnContextPolicy?.allowedClassRefs?.length
				? config.authnContextPolicy.allowedClassRefs
				: ['urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport']
		).join('\n');
		authnContextClassRefMode = config.authnContextClassRefMode || 'legacy_static';
		defaultAuthnContextClassRef =
			config.defaultAuthnContextClassRef ||
			'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport';
		passkeyAuthnContextClassRef =
			config.passkeyAuthnContextClassRef || 'urn:authrim:acr:phishing-resistant';
		attributeMappingJson = JSON.stringify(config.attributeMapping || {}, null, 2);
		if (!name.trim() && config.entityId) {
			name = config.entityId;
		}
	}

	function isImportableMetadataUrl(value: string): boolean {
		try {
			const parsed = new URL(value);
			return parsed.protocol === 'https:' || parsed.protocol === 'http:';
		} catch {
			return false;
		}
	}

	function providerTypeLabel(type: SAMLProvider['providerType']) {
		return type === 'saml_sp'
			? $LL.admin_saml_detail_service_provider()
			: $LL.admin_saml_detail_identity_provider();
	}

	function isValidLoginLogoUrl(value: string): boolean {
		if (!value.trim()) return true;
		try {
			return new URL(value.trim()).protocol === 'https:';
		} catch {
			return false;
		}
	}

	function chooseProviderType(nextProviderType: SAMLProvider['providerType']) {
		if (
			metadataImported &&
			metadataImportedProviderType &&
			nextProviderType !== metadataImportedProviderType
		) {
			metadataImportError = '';
			metadataImportTone = 'warning';
			metadataImportMessage =
				metadataImportedProviderType === 'saml_idp'
					? $LL.admin_saml_new_metadata_idp_warning()
					: $LL.admin_saml_new_metadata_sp_warning();
			return;
		}

		providerType = nextProviderType;
		setupTarget = nextProviderType;
	}

	function chooseFederation() {
		setupTarget = 'federation';
		if (metadataUrl.trim() && !federationProfileUrlPattern.trim()) {
			federationProfileUrlPattern = metadataUrl.trim();
		}
		if (metadataUrl.trim() && !federationProfileName.trim()) {
			federationProfileName = buildFederationProfileName(metadataUrl.trim());
		}
		metadataImportError = '';
		metadataImportTone = 'warning';
		metadataImportMessage = $LL.admin_saml_new_federation_mode_message();
	}

	function scheduleMetadataImport() {
		if (metadataImportTimer) clearTimeout(metadataImportTimer);
		metadataImportTimer = setTimeout(() => {
			if (isImportableMetadataUrl(metadataUrl.trim())) {
				void importMetadataFromUrl({ showRequiredError: false });
			}
		}, 250);
	}

	async function importMetadataFromUrl(options: { showRequiredError?: boolean } = {}) {
		if (!metadataUrl.trim()) {
			if (options.showRequiredError ?? true) {
				metadataImportError = $LL.admin_saml_new_metadata_url_error();
			}
			return;
		}

		if (!isImportableMetadataUrl(metadataUrl.trim())) {
			metadataImportError = $LL.admin_saml_new_metadata_url_invalid();
			return;
		}

		if (metadataImported && lastImportedMetadataUrl === metadataUrl.trim()) {
			return;
		}

		importingMetadata = true;
		metadataImportError = '';
		metadataImportMessage = '';
		metadataImportTone = 'success';
		error = '';

		try {
			const preview = await adminSAMLAPI.previewMetadata({
				metadataUrl: metadataUrl.trim()
			});
			await applyMetadataPreview(preview, {
				source: 'url',
				sourceUrl: metadataUrl.trim()
			});
			lastImportedMetadataUrl = metadataUrl.trim();
		} catch (err) {
			metadataImported = false;
			metadataImportedProviderType = '';
			metadataImportError =
				err instanceof Error ? err.message : $LL.admin_saml_new_metadata_import_failed();
		} finally {
			importingMetadata = false;
		}
	}

	async function importMetadataFromXml() {
		if (!metadataXml.trim()) {
			metadataImportError = $LL.admin_saml_new_metadata_xml_error();
			return;
		}

		importingMetadata = true;
		metadataImportError = '';
		metadataImportMessage = '';
		metadataImportTone = 'success';
		error = '';

		try {
			const preview = await adminSAMLAPI.previewMetadata({
				metadataXml: metadataXml.trim()
			});
			await applyMetadataPreview(preview, { source: 'xml' });
		} catch (err) {
			metadataImported = false;
			metadataImportedProviderType = '';
			metadataImportError =
				err instanceof Error ? err.message : $LL.admin_saml_new_metadata_xml_import_failed();
		} finally {
			importingMetadata = false;
		}
	}

	async function applyMetadataPreview(
		preview: Awaited<ReturnType<typeof adminSAMLAPI.previewMetadata>>,
		options: { source: 'url' | 'xml'; sourceUrl?: string }
	) {
		if (preview.kind === 'aggregate') {
			aggregatePreview = preview;
			aggregateImportMode = 'selected_entities';
			metadataImported = false;
			metadataImportedProviderType = '';
			if (options.sourceUrl) {
				federationProfileName =
					federationProfileName || buildFederationProfileName(options.sourceUrl);
				federationProfileUrlPattern = federationProfileUrlPattern || options.sourceUrl;
			} else {
				federationProfileName = federationProfileName || 'SAML federation';
			}
			metadataImportTone = preview.verification.status === 'verified' ? 'success' : 'warning';
			metadataImportMessage = $LL.admin_saml_new_aggregate_loaded({
				source: options.source.toUpperCase(),
				count: preview.entityCount,
				status: preview.verification.status
			});
			await loadAggregateEntities(0);
			return;
		}

		providerType = preview.providerType;
		setupTarget = preview.providerType;
		setupMode = 'manual';
		applyPreviewConfig(preview.config);
		await previewProviderCertificate({ quiet: true });
		metadataImported = true;
		metadataImportedProviderType = preview.providerType;
		metadataImportTone = 'success';
		metadataImportMessage =
			preview.providerType === 'saml_sp'
				? $LL.admin_saml_new_sp_imported()
				: $LL.admin_saml_new_idp_imported();
	}

	function resetMetadataImportState() {
		metadataImported = false;
		metadataImportedProviderType = '';
		aggregatePreview = null;
		aggregateEntities = [];
		aggregateEntityTotal = 0;
		aggregateKeywordFacets = [];
		aggregateKeywordCategory = '';
		selectedAggregateKeywords = [];
		loadingAggregateEntities = false;
		aggregateEntitiesOffset = 0;
		aggregateHasMoreEntities = false;
		selectedAggregateEntityIds = [];
		aggregateBatch = null;
		aggregateImportMode = 'selected_entities';
		federationProfileName = '';
		federationProfileUrlPattern = '';
		federationProfileCertificateUrl = '';
		federationProfileCertificate = '';
		federationProfilePolicy = 'strict';
		federationProfileCreated = null;
		federationProfileSavedMessage = '';
		providerSavedMessage = '';
		providerCertificatePreview = null;
		providerCertificateError = '';
		loadingProviderCertificate = false;
		if (providerCertificatePreviewTimer) clearTimeout(providerCertificatePreviewTimer);
		federationCertificatePreview = null;
		federationCertificateError = '';
		if (federationCertificatePreviewTimer) clearTimeout(federationCertificatePreviewTimer);
		lastImportedMetadataUrl = '';
		metadataImportMessage = '';
		metadataImportTone = 'success';
		metadataImportError = '';
	}

	function handleMetadataUrlInput() {
		resetMetadataImportState();
	}

	function handleMetadataXmlInput() {
		resetMetadataImportState();
	}

	async function loadAggregateEntities(offset = 0) {
		if (!aggregatePreview || loadingAggregateEntities) return;
		loadingAggregateEntities = true;
		try {
			const result = await adminSAMLAPI.listAggregatePreviewEntities(aggregatePreview.previewId, {
				query: aggregateEntityQuery,
				keywords: selectedAggregateKeywords,
				offset,
				limit: 50
			});
			aggregateEntities =
				offset === 0 ? result.entities : [...aggregateEntities, ...result.entities];
			aggregateEntityTotal = result.total;
			aggregateEntitiesOffset = result.offset + result.entities.length;
			aggregateHasMoreEntities = aggregateEntitiesOffset < result.total;
			aggregateKeywordFacets = result.keywordFacets ?? [];
			if (!aggregateKeywordCategory && aggregateKeywordFacets.length > 0) {
				aggregateKeywordCategory = aggregateKeywordFacets[0].category;
			}
		} finally {
			loadingAggregateEntities = false;
		}
	}

	function buildFederationProfileName(url: string) {
		try {
			const parsed = new URL(url);
			return `${parsed.hostname} federation`;
		} catch {
			return 'SAML federation';
		}
	}

	function parseFederationProfileUrlPatterns() {
		return federationProfileUrlPattern
			.split(/\r?\n/)
			.map((value) => value.trim())
			.filter(Boolean);
	}

	function parseFederationProfileCertificates() {
		const certificateInput = federationProfileCertificate.trim();
		if (!certificateInput) return [];
		const pemBlocks = Array.from(
			certificateInput.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)
		).map((match) => match[0].trim());
		const certificates =
			pemBlocks.length > 0
				? pemBlocks
				: certificateInput
						.split(/\n{2,}/)
						.map((value) => value.trim())
						.filter(Boolean);
		return certificates.map((certificate, index) => ({
			name: certificates.length > 1 ? `Certificate ${index + 1}` : undefined,
			certificate
		}));
	}

	async function createFederationTrustProfile() {
		if (!federationProfileName.trim()) {
			error = $LL.admin_saml_new_federation_name_error();
			return;
		}
		const metadataUrlPatterns = parseFederationProfileUrlPatterns();
		if (metadataUrlPatterns.length === 0) {
			error = $LL.admin_saml_new_metadata_pattern_error();
			return;
		}
		const certificates = parseFederationProfileCertificates();
		if (certificates.length === 0) {
			error = $LL.admin_saml_new_federation_certificate_error();
			return;
		}

		saving = true;
		error = '';
		federationProfileSavedMessage = '';
		try {
			const request = {
				name: federationProfileName.trim(),
				description: aggregatePreview
					? `Created from aggregate metadata preview ${aggregatePreview.previewId}`
					: description.trim() || undefined,
				metadataUrlPatterns,
				certificates,
				policy: federationProfilePolicy,
				enabled
			};
			federationProfileCreated =
				isEditingFederationProfile && !aggregatePreview
					? await adminSAMLAPI.updateFederationTrustProfile(editingFederationProfileId, request)
					: await adminSAMLAPI.createFederationTrustProfile(request);
			saving = false;
			federationProfileSavedMessage = isEditingFederationProfile
				? $LL.admin_saml_new_federation_updated_returning()
				: $LL.admin_saml_new_federation_saved_returning();
			setTimeout(() => {
				void goto('/admin/saml');
			}, 1000);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_saml_new_error_create_federation();
		} finally {
			saving = false;
		}
	}

	async function previewFederationCertificate(
		source: 'url' | 'pem',
		options: { quiet?: boolean } = {}
	) {
		const certificateUrl = federationProfileCertificateUrl.trim();
		const certificate = federationProfileCertificate.trim();
		if (source === 'url' && !certificateUrl) {
			if (!options.quiet) {
				federationCertificateError = $LL.admin_saml_new_certificate_url_error();
			}
			return;
		}
		if (source === 'pem' && !certificate) {
			if (!options.quiet) {
				federationCertificateError = $LL.admin_saml_new_certificate_pem_error();
			}
			return;
		}

		loadingFederationCertificate = true;
		federationCertificateError = '';
		try {
			const preview = await adminSAMLAPI.previewTrustCertificate(
				source === 'url' ? { certificateUrl } : { certificate }
			);
			federationCertificatePreview = preview;
			federationProfileCertificate = preview.certificate;
		} catch (err) {
			federationCertificatePreview = null;
			if (!options.quiet) {
				federationCertificateError =
					err instanceof Error
						? err.message
						: $LL.admin_saml_new_error_preview_federation_certificate();
			}
		} finally {
			loadingFederationCertificate = false;
		}
	}

	function handleFederationCertificateInput() {
		federationCertificatePreview = null;
		federationCertificateError = '';
		const value = federationProfileCertificate.trim();
		if (value.startsWith('https://')) {
			federationProfileCertificateUrl = value;
		}
		if (federationCertificatePreviewTimer) clearTimeout(federationCertificatePreviewTimer);
		federationCertificatePreviewTimer = setTimeout(() => {
			if (
				federationProfileCertificate.trim() &&
				!federationProfileCertificate.trim().startsWith('https://')
			) {
				void previewFederationCertificate('pem', { quiet: true });
			}
		}, 350);
	}

	async function previewProviderCertificate(options: { quiet?: boolean } = {}) {
		if (!certificate.trim()) {
			if (!options.quiet) {
				providerCertificateError = $LL.admin_saml_new_certificate_pem_error();
			}
			return;
		}

		loadingProviderCertificate = true;
		providerCertificateError = '';
		try {
			const preview = await adminSAMLAPI.previewTrustCertificate({
				certificate: certificate.trim()
			});
			providerCertificatePreview = preview;
			certificate = preview.certificate;
		} catch (err) {
			providerCertificatePreview = null;
			if (!options.quiet) {
				providerCertificateError =
					err instanceof Error
						? err.message
						: $LL.admin_saml_new_error_preview_provider_certificate();
			}
		} finally {
			loadingProviderCertificate = false;
		}
	}

	function handleProviderCertificateInput() {
		providerCertificatePreview = null;
		providerCertificateError = '';
		if (providerCertificatePreviewTimer) clearTimeout(providerCertificatePreviewTimer);
		providerCertificatePreviewTimer = setTimeout(() => {
			void previewProviderCertificate({ quiet: true });
		}, 350);
	}

	function formatCertificateDate(value: string) {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value || '-';
		return date.toLocaleString(getLocale() === 'ja' ? 'ja-JP' : 'en-US');
	}

	function handleAggregateSearch() {
		selectedAggregateEntityIds = [];
		void loadAggregateEntities(0);
	}

	function toggleAggregateKeyword(keyword: string) {
		selectedAggregateEntityIds = [];
		selectedAggregateKeywords = selectedAggregateKeywords.includes(keyword)
			? selectedAggregateKeywords.filter((item) => item !== keyword)
			: [...selectedAggregateKeywords, keyword];
		void loadAggregateEntities(0);
	}

	function handleAggregateCategoryChange(event: Event) {
		aggregateKeywordCategory = (event.currentTarget as HTMLSelectElement).value;
	}

	function handleAggregateEntityScroll(event: Event) {
		const list = event.currentTarget as HTMLElement;
		const remaining = list.scrollHeight - list.scrollTop - list.clientHeight;
		if (remaining < 80 && aggregateHasMoreEntities && !loadingAggregateEntities) {
			void loadAggregateEntities(aggregateEntitiesOffset);
		}
	}

	function toggleAggregateEntity(entityId: string) {
		selectedAggregateEntityIds = selectedAggregateEntityIds.includes(entityId)
			? selectedAggregateEntityIds.filter((id) => id !== entityId)
			: [...selectedAggregateEntityIds, entityId];
	}

	async function startAggregateBatchCreate() {
		if (!aggregatePreview || selectedAggregateEntityIds.length === 0) return;
		saving = true;
		error = '';
		try {
			aggregateBatch = await adminSAMLAPI.startAggregateBatchCreate(aggregatePreview.previewId, {
				entityIds: selectedAggregateEntityIds,
				enabled
			});
			if (aggregateBatchPolling) clearInterval(aggregateBatchPolling);
			aggregateBatchPolling = setInterval(() => {
				void pollAggregateBatch();
			}, 1000);
			await pollAggregateBatch();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_saml_new_error_start_aggregate();
		} finally {
			saving = false;
		}
	}

	async function pollAggregateBatch() {
		if (!aggregateBatch) return;
		aggregateBatch = await adminSAMLAPI.getAggregateBatchStatus(aggregateBatch.batchId);
		if (aggregateBatch.status === 'completed' || aggregateBatch.status === 'failed') {
			if (aggregateBatchPolling) clearInterval(aggregateBatchPolling);
			aggregateBatchPolling = undefined;
		}
	}

	function validate() {
		if (aggregatePreview) return '';
		if (setupTarget === 'federation') {
			if (!federationProfileName.trim()) return $LL.admin_saml_new_federation_name_error();
			if (!federationProfileUrlPattern.trim()) return $LL.admin_saml_new_metadata_pattern_error();
			if (!federationProfileCertificate.trim()) {
				return $LL.admin_saml_new_federation_certificate_error();
			}
			return '';
		}
		if (!name.trim()) return $LL.admin_saml_detail_name_required_error();
		if (!isValidLoginLogoUrl(logoUrl)) return $LL.admin_saml_detail_logo_invalid();
		if (setupMode === 'metadata_url' && !metadataUrl.trim())
			return $LL.admin_saml_new_metadata_url_error();
		if (setupMode === 'metadata_xml' && !metadataXml.trim())
			return $LL.admin_saml_new_metadata_xml_error();
		if (setupMode === 'manual') {
			if (!entityId.trim()) return $LL.admin_saml_detail_entity_required();
			if (!allowPost && !allowRedirect) return $LL.admin_saml_detail_at_least_one_binding();
			if (providerType === 'saml_idp' && (!ssoUrl.trim() || !certificate.trim())) {
				return $LL.admin_saml_detail_idp_required();
			}
			if (providerType === 'saml_sp' && !acsUrl.trim()) {
				return $LL.admin_saml_detail_sp_required();
			}
			if (providerType === 'saml_sp' && !identityMappingFieldMappingSetId) {
				return $LL.admin_saml_detail_identity_mapping_required_error();
			}
			parseMapping();
		}
		if (setupMode !== 'manual' && providerType === 'saml_sp' && !identityMappingFieldMappingSetId) {
			return $LL.admin_saml_detail_identity_mapping_required_error();
		}
		return '';
	}

	async function handleSubmit() {
		if (aggregatePreview) {
			if (aggregateImportMode === 'trust_profile') {
				await createFederationTrustProfile();
			} else {
				await startAggregateBatchCreate();
			}
			return;
		}
		const validationError = validate();
		if (validationError) {
			error = validationError;
			return;
		}

		if (setupTarget === 'federation') {
			await createFederationTrustProfile();
			return;
		}

		saving = true;
		error = '';
		providerSavedMessage = '';

		try {
			const request: CreateSAMLProviderRequest = {
				name: name.trim(),
				providerType,
				enabled
			};

			if (setupMode === 'manual') {
				request.config = buildManualConfig();
				if (metadataImported && metadataUrl.trim()) {
					request.metadataUrl = metadataUrl.trim();
				}
			} else {
				request.config = buildMetadataConfig();
				if (setupMode === 'metadata_url') request.metadataUrl = metadataUrl.trim();
				if (setupMode === 'metadata_xml') request.metadataXml = metadataXml.trim();
			}

			const provider = await adminSAMLAPI.createProvider(request);
			saving = false;
			providerSavedMessage = $LL.admin_saml_new_provider_created_returning({ name: provider.name });
			setTimeout(() => {
				void goto('/admin/saml');
			}, 1000);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_saml_new_error_create_provider();
		} finally {
			saving = false;
		}
	}

	function navigateBack() {
		goto('/admin/saml');
	}
</script>

<svelte:head>
	<title>
		{isEditingFederationProfile
			? $LL.admin_saml_new_edit_page_title()
			: $LL.admin_saml_new_page_title()}
	</title>
</svelte:head>

{#snippet certificatePreviewCard(preview: SAMLTrustCertificatePreview)}
	<div class="certificate-preview">
		<div class="certificate-preview-header">
			<strong>{$LL.admin_saml_detail_certificate_valid()}</strong>
			<span class="badge badge-info">{preview.publicKeyAlgorithm}</span>
		</div>
		<div class="certificate-preview-grid">
			<span>{$LL.admin_saml_local_subject()}</span>
			<code>{preview.subject}</code>
			<span>{$LL.admin_saml_local_issuer()}</span>
			<code>{preview.issuer}</code>
			<span>{$LL.admin_saml_local_valid_from()}</span>
			<code>{formatCertificateDate(preview.validFrom)}</code>
			<span>{$LL.admin_saml_local_valid_to()}</span>
			<code>{formatCertificateDate(preview.validTo)}</code>
			<span>{$LL.admin_saml_local_signature()}</span>
			<code>{preview.signatureAlgorithm}</code>
			{#if preview.publicKeySizeBits}
				<span>{$LL.admin_saml_detail_key_size()}</span>
				<code>{$LL.admin_saml_detail_bits({ bits: preview.publicKeySizeBits })}</code>
			{/if}
			<span>SHA-1</span>
			<code>{preview.fingerprintSha1}</code>
			<span>SHA-256</span>
			<code>{preview.fingerprintSha256}</code>
		</div>
		{#if preview.warnings.length > 0}
			<div class="certificate-warnings">
				{#each preview.warnings as warning (warning)}
					<div><i class="i-ph-warning-circle"></i>{warning}</div>
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

<div class="admin-page">
	<a href="/admin/saml" class="back-link">← {$LL.admin_saml_detail_back()}</a>

	<h1 class="page-title">
		{isEditingFederationProfile ? $LL.admin_saml_new_edit_title() : $LL.admin_saml_new_title()}
	</h1>

	<form
		onsubmit={(event) => {
			event.preventDefault();
			void handleSubmit();
		}}
	>
		{#if error}
			<div class="alert alert-error">{error}</div>
		{/if}
		{#if federationProfileSavedMessage}
			<div class="alert alert-success">{federationProfileSavedMessage}</div>
		{/if}
		{#if providerSavedMessage}
			<div class="alert alert-success">{providerSavedMessage}</div>
		{/if}

		{#if loadingFederationProfile}
			<div class="loading-state">
				<i class="i-ph-circle-notch loading-spinner"></i>
				<p>{$LL.admin_saml_new_loading_federation()}</p>
			</div>
		{/if}

		{#if !aggregatePreview}
			<div class="panel">
				{#if setupTarget === 'federation'}
					<ToggleSwitch
						bind:checked={enabled}
						label={$LL.admin_saml_new_trust_profile_status()}
						description={$LL.admin_saml_new_trust_profile_status_desc()}
					/>
				{:else}
					<ToggleSwitch
						bind:checked={enabled}
						label={$LL.admin_saml_detail_provider_status()}
						description={$LL.admin_saml_detail_provider_status_desc()}
					/>
				{/if}
			</div>
		{/if}

		{#if !isEditingFederationProfile}
			<div class="panel">
				<h2 class="panel-title">{$LL.admin_saml_detail_saml_configuration()}</h2>
				<p class="form-hint panel-hint">
					{$LL.admin_saml_new_config_intro()}
				</p>

				<div class="metadata-import-row">
					<div class="form-group metadata-import-input">
						<label for="metadataUrl" class="form-label">{$LL.admin_saml_local_metadata_url()}</label
						>
						<input
							id="metadataUrl"
							type="url"
							bind:value={metadataUrl}
							oninput={handleMetadataUrlInput}
							onchange={scheduleMetadataImport}
							onpaste={scheduleMetadataImport}
							class="form-input"
							placeholder="https://example.com/saml/metadata"
						/>
					</div>
					<button
						type="button"
						class="btn btn-secondary metadata-import-button"
						onclick={() => importMetadataFromUrl()}
						disabled={importingMetadata}
					>
						{#if importingMetadata}
							<i class="i-ph-circle-notch loading-spinner"></i>
							{$LL.admin_saml_new_importing_metadata()}
						{:else}
							{$LL.admin_saml_new_import_metadata()}
						{/if}
					</button>
				</div>

				{#if importingMetadata}
					<p class="form-hint loading-hint">
						<i class="i-ph-circle-notch loading-spinner"></i>
						{$LL.admin_saml_new_metadata_loading_hint()}
					</p>
				{:else if metadataImportError}
					<p class="form-error">{metadataImportError}</p>
				{:else if metadataImportMessage}
					<p
						class:form-success={metadataImportTone === 'success'}
						class:form-warning={metadataImportTone === 'warning'}
					>
						{metadataImportMessage}
					</p>
				{:else}
					<p class="form-hint">
						{$LL.admin_saml_new_metadata_import_hint()}
					</p>
				{/if}
			</div>
		{/if}

		{#if aggregatePreview}
			<div class="panel">
				<h2 class="panel-title">{$LL.admin_saml_new_aggregate_detected()}</h2>
				<p
					class:form-success={aggregatePreview.verification.status === 'verified'}
					class:form-warning={aggregatePreview.verification.status !== 'verified'}
				>
					{$LL.admin_saml_new_signature_status({ status: aggregatePreview.verification.status })}
					{#if aggregatePreview.verification.trustProfileName}
						{$LL.admin_saml_new_signature_via({
							profile: aggregatePreview.verification.trustProfileName
						})}
					{/if}
				</p>

				<div class="template-grid aggregate-mode-grid">
					<button
						type="button"
						class="template-card"
						class:template-card-selected={aggregateImportMode === 'selected_entities'}
						onclick={() => (aggregateImportMode = 'selected_entities')}
					>
						<div class="i-ph-list-checks h-5 w-5 template-icon"></div>
						<div class="template-name">{$LL.admin_saml_new_create_providers()}</div>
						<div class="template-desc">{$LL.admin_saml_new_create_providers_desc()}</div>
					</button>
					<button
						type="button"
						class="template-card"
						class:template-card-selected={aggregateImportMode === 'trust_profile'}
						onclick={() => (aggregateImportMode = 'trust_profile')}
					>
						<div class="i-ph-shield-check h-5 w-5 template-icon"></div>
						<div class="template-name">{$LL.admin_saml_new_federation_trust_profile()}</div>
						<div class="template-desc">{$LL.admin_saml_new_federation_trust_profile_desc()}</div>
					</button>
				</div>

				{#if aggregateImportMode === 'trust_profile'}
					<div class="federation-profile-form">
						<div class="form-grid">
							<div class="form-group">
								<label for="federationProfileName" class="form-label">
									{$LL.admin_saml_new_profile_name_required()}
								</label>
								<input
									id="federationProfileName"
									bind:value={federationProfileName}
									class="form-input"
									placeholder={$LL.admin_saml_new_profile_name_placeholder()}
								/>
							</div>
							<div class="form-group">
								<label for="federationProfilePolicy" class="form-label"
									>{$LL.admin_saml_policy()}</label
								>
								<select
									id="federationProfilePolicy"
									bind:value={federationProfilePolicy}
									class="form-select"
								>
									<option value="strict">Strict</option>
									<option value="warn">Warn</option>
									<option value="disabled">{$LL.admin_saml_detail_disabled()}</option>
								</select>
							</div>
							<div class="form-group form-group-full">
								<label for="federationProfileUrlPattern" class="form-label">
									{$LL.admin_saml_new_metadata_url_pattern_required()}
								</label>
								<input
									id="federationProfileUrlPattern"
									bind:value={federationProfileUrlPattern}
									class="form-input"
								/>
								<p class="form-hint">
									{$LL.admin_saml_new_exact_pattern_hint()}
								</p>
							</div>
							<div class="form-group form-group-full">
								<label for="federationProfileCertificate" class="form-label">
									{$LL.admin_saml_new_federation_certificate_required()}
								</label>
								<div class="metadata-import-row certificate-url-row">
									<div class="form-group metadata-import-input">
										<label for="federationProfileCertificateUrl" class="form-label">
											{$LL.admin_saml_new_certificate_url()}
										</label>
										<input
											id="federationProfileCertificateUrl"
											type="url"
											bind:value={federationProfileCertificateUrl}
											class="form-input"
											placeholder="https://metadata.example.edu/federation-signer-2026.cer"
										/>
									</div>
									<button
										type="button"
										class="btn btn-secondary metadata-import-button"
										onclick={() => previewFederationCertificate('url')}
										disabled={loadingFederationCertificate}
									>
										{loadingFederationCertificate
											? $LL.admin_saml_detail_checking()
											: $LL.admin_saml_new_load_certificate()}
									</button>
								</div>
								<textarea
									id="federationProfileCertificate"
									bind:value={federationProfileCertificate}
									oninput={handleFederationCertificateInput}
									class="form-input form-textarea monospace"
									rows="8"
									placeholder={$LL.admin_saml_new_certificate_input_placeholder()}
								></textarea>
								<p class="form-hint">
									{$LL.admin_saml_new_federation_certificate_hint()}
								</p>
								<div class="certificate-actions">
									<button
										type="button"
										class="btn btn-secondary btn-sm"
										onclick={() => previewFederationCertificate('pem')}
										disabled={loadingFederationCertificate || !federationProfileCertificate.trim()}
									>
										{$LL.admin_saml_detail_validate_certificate()}
									</button>
								</div>
								{#if federationCertificateError}
									<p class="form-error">{federationCertificateError}</p>
								{/if}
								{#if federationCertificatePreview}
									{@render certificatePreviewCard(federationCertificatePreview)}
								{/if}
							</div>
						</div>
						{#if federationProfileCreated}
							<p class="form-success">
								{$LL.admin_saml_new_federation_created({ name: federationProfileCreated.name })}
							</p>
						{/if}
					</div>
				{:else}
					<div class="metadata-import-row">
						<div class="form-group metadata-import-input">
							<label for="aggregateSearch" class="form-label">
								{$LL.admin_saml_new_search_entities()}
							</label>
							<input
								id="aggregateSearch"
								type="search"
								bind:value={aggregateEntityQuery}
								class="form-input"
								placeholder={$LL.admin_saml_new_search_placeholder()}
								onkeydown={(event) => {
									if (event.key === 'Enter') {
										event.preventDefault();
										handleAggregateSearch();
									}
								}}
							/>
						</div>
						<button
							type="button"
							class="btn btn-secondary metadata-import-button"
							onclick={handleAggregateSearch}
						>
							{$LL.admin_saml_new_search()}
						</button>
					</div>

					{#if aggregateKeywordFacets.length > 0}
						<div class="aggregate-filter-row">
							<div class="form-group aggregate-filter-category">
								<label for="aggregateKeywordCategory" class="form-label">
									{$LL.admin_saml_new_keyword_category()}
								</label>
								<select
									id="aggregateKeywordCategory"
									class="form-select"
									value={aggregateKeywordCategory}
									onchange={handleAggregateCategoryChange}
								>
									{#each aggregateKeywordFacets as facet (facet.category)}
										<option value={facet.category}>{facet.label}</option>
									{/each}
								</select>
							</div>
							{#if activeAggregateKeywordFacet}
								<div
									class="aggregate-keyword-options"
									aria-label={$LL.admin_saml_new_filters_aria({
										label: activeAggregateKeywordFacet.label
									})}
								>
									{#each activeAggregateKeywordFacet.values as value (value.keyword)}
										<label class="aggregate-keyword-option">
											<input
												type="checkbox"
												checked={selectedAggregateKeywords.includes(value.keyword)}
												onchange={() => toggleAggregateKeyword(value.keyword)}
											/>
											<span>{value.label}</span>
											<small>{value.count}</small>
										</label>
									{/each}
								</div>
							{/if}
						</div>
					{/if}

					<p class="form-hint">
						{$LL.admin_saml_new_aggregate_showing({
							shown: aggregateEntities.length,
							total: aggregateEntityTotal,
							selected: selectedAggregateEntityIds.length
						})}
						{#if loadingAggregateEntities}
							{$LL.admin_saml_new_loading_more()}
						{/if}
					</p>

					<div class="aggregate-entity-list" onscroll={handleAggregateEntityScroll}>
						{#each aggregateEntities as entity (entity.entityId)}
							<label class="aggregate-entity-row">
								<input
									type="checkbox"
									checked={selectedAggregateEntityIds.includes(entity.entityId)}
									onchange={() => toggleAggregateEntity(entity.entityId)}
									class="checkbox"
								/>
								{#if entity.logoUrl}
									<img class="aggregate-entity-logo" src={entity.logoUrl} alt="" loading="lazy" />
								{:else}
									<div
										class="aggregate-entity-logo aggregate-entity-logo--empty"
										aria-hidden="true"
									></div>
								{/if}
								<span>
									<strong>{entity.displayName || entity.entityId}</strong>
									<small>{entity.role} · {entity.entityId}</small>
									{#if entity.acsUrl || entity.ssoUrl}
										<small>{entity.acsUrl || entity.ssoUrl}</small>
									{/if}
									{#if entity.keywords?.length}
										<small class="aggregate-entity-keywords">{entity.keywords.join(', ')}</small>
									{/if}
								</span>
							</label>
						{/each}
						{#if aggregateHasMoreEntities}
							<div class="aggregate-load-more">
								<button
									type="button"
									class="btn btn-secondary"
									disabled={loadingAggregateEntities}
									onclick={() => loadAggregateEntities(aggregateEntitiesOffset)}
								>
									{loadingAggregateEntities ? $LL.common_loading() : $LL.admin_saml_new_load_more()}
								</button>
							</div>
						{/if}
					</div>

					{#if aggregateBatch}
						<div class="batch-progress">
							<div>
								{$LL.admin_saml_new_batch_progress({
									processed: aggregateBatch.processed,
									total: aggregateBatch.total,
									succeeded: aggregateBatch.succeeded,
									failed: aggregateBatch.failed
								})}
							</div>
							<progress value={aggregateBatch.processed} max={aggregateBatch.total}></progress>
						</div>
					{/if}
				{/if}
			</div>
		{/if}

		{#if !aggregatePreview}
			{#if !isEditingFederationProfile}
				<div class="panel">
					<h2 class="panel-title">{$LL.admin_saml_new_choose_provider_type()}</h2>
					<p class="form-hint panel-hint">
						{$LL.admin_saml_new_choose_provider_type_hint()}
					</p>

					<div class="template-grid saml-choice-grid">
						<button
							type="button"
							class="template-card"
							class:template-card-selected={setupTarget === 'saml_idp'}
							onclick={() => chooseProviderType('saml_idp')}
						>
							<div class="i-ph-identification-card h-5 w-5 template-icon"></div>
							<div class="template-name">{$LL.admin_saml_detail_identity_provider()}</div>
							<div class="template-desc">{$LL.admin_saml_new_external_login()}</div>
						</button>

						<button
							type="button"
							class="template-card"
							class:template-card-selected={setupTarget === 'saml_sp'}
							onclick={() => chooseProviderType('saml_sp')}
						>
							<div class="i-ph-app-window h-5 w-5 template-icon"></div>
							<div class="template-name">{$LL.admin_saml_detail_service_provider()}</div>
							<div class="template-desc">{$LL.admin_saml_new_authrim_as_idp()}</div>
						</button>

						<button
							type="button"
							class="template-card"
							class:template-card-selected={setupTarget === 'federation'}
							onclick={chooseFederation}
						>
							<div class="i-ph-shield-check h-5 w-5 template-icon"></div>
							<div class="template-name">{$LL.admin_saml_new_federation()}</div>
							<div class="template-desc">{$LL.admin_saml_new_aggregate_metadata_trust()}</div>
						</button>
					</div>

					{#if metadataImported && metadataImportedProviderType}
						<p class="form-hint selected-metadata-role">
							{$LL.admin_saml_new_imported_metadata_role({
								role: providerTypeLabel(metadataImportedProviderType)
							})}
						</p>
					{/if}
				</div>
			{/if}

			{#if setupTarget === 'federation'}
				<div class="panel">
					<h2 class="panel-title">{$LL.admin_saml_new_federation_trust_profile()}</h2>
					<p class="form-hint panel-hint">
						{$LL.admin_saml_new_federation_profile_hint()}
					</p>

					<div class="form-grid">
						<div class="form-group">
							<label for="manualFederationProfileName" class="form-label">
								{$LL.admin_saml_new_profile_name_required()}
							</label>
							<input
								id="manualFederationProfileName"
								bind:value={federationProfileName}
								class="form-input"
								placeholder={$LL.admin_saml_new_profile_name_placeholder()}
							/>
						</div>
						<div class="form-group">
							<label for="manualFederationProfilePolicy" class="form-label">
								{$LL.admin_saml_policy()}
							</label>
							<select
								id="manualFederationProfilePolicy"
								bind:value={federationProfilePolicy}
								class="form-select"
							>
								<option value="strict">Strict</option>
								<option value="warn">Warn</option>
								<option value="disabled">{$LL.admin_saml_detail_disabled()}</option>
							</select>
						</div>
						<div class="form-group form-group-full">
							<label for="manualFederationDescription" class="form-label">
								{$LL.admin_saml_detail_description()}
							</label>
							<textarea
								id="manualFederationDescription"
								bind:value={description}
								class="form-input form-textarea"
								rows="3"
								placeholder={$LL.admin_saml_new_federation_description_placeholder()}
							></textarea>
						</div>
						<div class="form-group form-group-full">
							<label for="manualFederationProfileUrlPattern" class="form-label">
								{$LL.admin_saml_new_metadata_url_pattern_required()}
							</label>
							<textarea
								id="manualFederationProfileUrlPattern"
								bind:value={federationProfileUrlPattern}
								class="form-input form-textarea monospace"
								rows="3"
								placeholder="https://metadata.example.org/*"
							></textarea>
							<p class="form-hint">
								{$LL.admin_saml_new_line_pattern_hint()}
							</p>
						</div>
						<div class="form-group form-group-full">
							<label for="manualFederationProfileCertificate" class="form-label">
								{$LL.admin_saml_new_federation_certificate_required()}
							</label>
							<div class="metadata-import-row certificate-url-row">
								<div class="form-group metadata-import-input">
									<label for="manualFederationProfileCertificateUrl" class="form-label">
										{$LL.admin_saml_new_certificate_url()}
									</label>
									<input
										id="manualFederationProfileCertificateUrl"
										type="url"
										bind:value={federationProfileCertificateUrl}
										class="form-input"
										placeholder="https://metadata.example.edu/federation-signer-2026.cer"
									/>
								</div>
								<button
									type="button"
									class="btn btn-secondary metadata-import-button"
									onclick={() => previewFederationCertificate('url')}
									disabled={loadingFederationCertificate}
								>
									{loadingFederationCertificate
										? $LL.admin_saml_detail_checking()
										: $LL.admin_saml_new_load_certificate()}
								</button>
							</div>
							<textarea
								id="manualFederationProfileCertificate"
								bind:value={federationProfileCertificate}
								oninput={handleFederationCertificateInput}
								class="form-input form-textarea monospace"
								rows="10"
								placeholder={$LL.admin_saml_new_certificate_input_placeholder()}
							></textarea>
							<p class="form-hint">
								{$LL.admin_saml_new_federation_certificate_hint_shibboleth()}
							</p>
							<div class="certificate-actions">
								<button
									type="button"
									class="btn btn-secondary btn-sm"
									onclick={() => previewFederationCertificate('pem')}
									disabled={loadingFederationCertificate || !federationProfileCertificate.trim()}
								>
									{$LL.admin_saml_detail_validate_certificate()}
								</button>
							</div>
							{#if federationCertificateError}
								<p class="form-error">{federationCertificateError}</p>
							{/if}
							{#if federationCertificatePreview}
								{@render certificatePreviewCard(federationCertificatePreview)}
							{/if}
						</div>
					</div>
				</div>
			{:else}
				<div class="panel">
					<h2 class="panel-title">{$LL.admin_saml_detail_basic_information()}</h2>

					<div class="form-grid">
						<div class="form-group">
							<label for="name" class="form-label">{$LL.admin_saml_detail_name_required()}</label>
							<input
								id="name"
								type="text"
								bind:value={name}
								required
								placeholder={providerType === 'saml_idp' ? 'e.g., MockSAML' : 'e.g., Salesforce SP'}
								class="form-input"
							/>
						</div>

						<div class="form-group">
							<label for="nameIdFormat" class="form-label"
								>{$LL.admin_saml_detail_nameid_format()}</label
							>
							<select id="nameIdFormat" bind:value={nameIdFormat} class="form-select">
								{#each nameIdFormats as format (format.value)}
									<option value={format.value}>{format.label}</option>
								{/each}
							</select>
						</div>

						<div class="form-group form-group-full">
							<label for="description" class="form-label"
								>{$LL.admin_saml_detail_description()}</label
							>
							<textarea
								id="description"
								bind:value={description}
								class="form-input form-textarea"
								rows="3"
								placeholder={$LL.admin_saml_new_description_placeholder()}
							></textarea>
						</div>

						<div class="form-group form-group-full">
							<label for="logoUrl" class="form-label">{$LL.admin_saml_detail_logo_url()}</label>
							<div class="logo-url-field">
								<input
									id="logoUrl"
									type="url"
									bind:value={logoUrl}
									class="form-input"
									placeholder="https://example.com/logo.png"
								/>
								{#if logoUrl}
									<div class="logo-url-preview" aria-label={$LL.admin_saml_detail_logo_preview()}>
										<img src={logoUrl} alt="" loading="lazy" />
									</div>
								{/if}
							</div>
							<p class="form-hint">
								{$LL.admin_saml_detail_logo_hint()}
							</p>
						</div>

						<div class="form-group form-group-full">
							<LoginProviderIconPicker
								bind:value={iconName}
								defaultIcon="buildings"
								defaultLabel={$LL.admin_saml_detail_default_icon()}
								description={$LL.admin_saml_detail_default_icon_desc()}
							/>
						</div>
					</div>
				</div>

				<div class="panel">
					<h2 class="panel-title">{$LL.admin_saml_new_configuration_method()}</h2>
					<p class="form-hint panel-hint">
						{$LL.admin_saml_new_configuration_method_hint()}
					</p>

					<div class="template-grid saml-choice-grid">
						<button
							type="button"
							class="template-card"
							class:template-card-selected={setupMode === 'metadata_url'}
							onclick={() => (setupMode = 'metadata_url')}
						>
							<div class="i-ph-link h-5 w-5 template-icon"></div>
							<div class="template-name">{$LL.admin_saml_local_metadata_url()}</div>
							<div class="template-desc">{$LL.admin_saml_new_auto_fetch()}</div>
						</button>

						<button
							type="button"
							class="template-card"
							class:template-card-selected={setupMode === 'metadata_xml'}
							onclick={() => (setupMode = 'metadata_xml')}
						>
							<div class="i-ph-file-code h-5 w-5 template-icon"></div>
							<div class="template-name">{$LL.admin_saml_new_metadata_xml()}</div>
							<div class="template-desc">{$LL.admin_saml_new_paste_xml()}</div>
						</button>

						<button
							type="button"
							class="template-card"
							class:template-card-selected={setupMode === 'manual'}
							onclick={() => (setupMode = 'manual')}
						>
							<div class="i-ph-sliders h-5 w-5 template-icon"></div>
							<div class="template-name">{$LL.admin_saml_new_manual()}</div>
							<div class="template-desc">{$LL.admin_saml_new_direct_input()}</div>
						</button>
					</div>
				</div>

				<div class="panel">
					<h2 class="panel-title">{$LL.admin_saml_detail_saml_configuration()}</h2>

					{#if setupMode === 'metadata_url'}
						<div class="form-group">
							<label for="metadataUrlMode" class="form-label">
								{$LL.admin_saml_new_metadata_url_required()}
							</label>
							<input
								id="metadataUrlMode"
								type="url"
								bind:value={metadataUrl}
								class="form-input"
								placeholder="https://example.com/saml/metadata"
							/>
							<p class="form-hint">
								{$LL.admin_saml_new_metadata_url_backend_hint()}
							</p>
						</div>
					{:else if setupMode === 'metadata_xml'}
						<div class="form-group">
							<label for="metadataXml" class="form-label">
								{$LL.admin_saml_new_metadata_xml_required()}
							</label>
							<textarea
								id="metadataXml"
								bind:value={metadataXml}
								oninput={handleMetadataXmlInput}
								class="form-input form-textarea monospace"
								rows="12"
							></textarea>
							<p class="form-hint">
								{$LL.admin_saml_new_metadata_xml_hint()}
							</p>
							<div class="form-actions compact-actions">
								<button
									type="button"
									class="btn btn-secondary btn-sm"
									onclick={importMetadataFromXml}
									disabled={importingMetadata || !metadataXml.trim()}
								>
									{#if importingMetadata}
										<i class="i-ph-circle-notch loading-spinner"></i>
										{$LL.admin_saml_new_importing_metadata()}
									{:else}
										{$LL.admin_saml_new_import_metadata()}
									{/if}
								</button>
							</div>
							{#if metadataImportError}
								<p class="form-error">{metadataImportError}</p>
							{:else if metadataImportMessage}
								<p
									class:form-success={metadataImportTone === 'success'}
									class:form-warning={metadataImportTone === 'warning'}
								>
									{metadataImportMessage}
								</p>
							{/if}
						</div>
					{:else}
						<div class="form-grid">
							<div class="form-group form-group-full">
								<label for="entityId" class="form-label">{$LL.admin_saml_entity_id()} *</label>
								<input id="entityId" type="text" bind:value={entityId} class="form-input" />
							</div>

							{#if providerType === 'saml_idp'}
								<div class="form-group">
									<label for="ssoUrl" class="form-label">{$LL.admin_saml_sso_url_required()}</label>
									<input id="ssoUrl" type="url" bind:value={ssoUrl} class="form-input" />
								</div>
							{:else}
								<div class="form-group">
									<label for="acsUrl" class="form-label">{$LL.admin_saml_acs_url_required()}</label>
									<input id="acsUrl" type="url" bind:value={acsUrl} class="form-input" />
								</div>
							{/if}

							<div class="form-group">
								<label for="sloUrl" class="form-label">{$LL.admin_saml_slo_url()}</label>
								<input id="sloUrl" type="url" bind:value={sloUrl} class="form-input" />
							</div>

							<div class="form-group form-group-full">
								<label for="certificate" class="form-label">
									{providerType === 'saml_idp'
										? $LL.admin_saml_detail_signing_certificate_required()
										: $LL.admin_saml_detail_sp_certificate()}
								</label>
								<textarea
									id="certificate"
									bind:value={certificate}
									oninput={handleProviderCertificateInput}
									class="form-input form-textarea monospace"
									rows="8"
									placeholder="-----BEGIN CERTIFICATE-----"
								></textarea>
								<p class="form-hint">
									{$LL.admin_saml_new_manual_certificate_hint()}
								</p>
								<div class="certificate-actions">
									<button
										type="button"
										class="btn btn-secondary btn-sm"
										onclick={() => previewProviderCertificate()}
										disabled={loadingProviderCertificate || !certificate.trim()}
									>
										{loadingProviderCertificate
											? $LL.admin_saml_detail_checking()
											: $LL.admin_saml_detail_validate_certificate()}
									</button>
								</div>
								{#if providerCertificateError}
									<p class="form-error">{providerCertificateError}</p>
								{/if}
								{#if providerCertificatePreview}
									{@render certificatePreviewCard(providerCertificatePreview)}
								{/if}
							</div>

							<div class="form-group form-group-full">
								<label for="attributeMapping" class="form-label">
									{$LL.admin_saml_detail_attribute_mapping_json()}
								</label>
								<textarea
									id="attributeMapping"
									bind:value={attributeMappingJson}
									class="form-input form-textarea monospace"
									rows="6"
								></textarea>
							</div>
						</div>

						<div class="form-checkbox-group compact-checkboxes">
							<label class="form-checkbox-label">
								<input type="checkbox" bind:checked={allowPost} class="checkbox" />
								HTTP-POST
							</label>
							<label class="form-checkbox-label">
								<input type="checkbox" bind:checked={allowRedirect} class="checkbox" />
								HTTP-Redirect
							</label>
						</div>
					{/if}
				</div>

				{#if providerType === 'saml_idp'}
					<div class="panel">
						<h2 class="panel-title">{$LL.admin_saml_detail_sp_login_policy()}</h2>

						<div class="form-grid">
							<div class="form-group">
								<label for="providerName" class="form-label">
									{$LL.admin_saml_detail_sp_display_name()}
								</label>
								<input
									id="providerName"
									type="text"
									bind:value={providerName}
									class="form-input"
									placeholder="Authrim"
								/>
							</div>

							<div class="form-group">
								<label for="jitEmailLinkingPolicy" class="form-label">
									{$LL.admin_saml_detail_jit_linking_policy()}
								</label>
								<select
									id="jitEmailLinkingPolicy"
									bind:value={jitEmailLinkingPolicy}
									class="form-select"
								>
									<option value="email_linking"
										>{$LL.admin_saml_detail_jit_existing_or_create()}</option
									>
									<option value="jit_create_only">{$LL.admin_saml_detail_jit_create_only()}</option>
									<option value="disabled">{$LL.admin_saml_detail_jit_existing_only()}</option>
								</select>
								<p class="field-hint">
									{$LL.admin_saml_detail_jit_hint()}
								</p>
							</div>

							<div class="form-group form-group-full">
								<label class="form-checkbox-label">
									<input
										type="checkbox"
										bind:checked={allowSyntheticEmailFallback}
										class="checkbox"
									/>
									{$LL.admin_saml_detail_synthetic_email()}
								</label>
								<p class="field-hint">
									{$LL.admin_saml_detail_synthetic_email_hint()}
								</p>
							</div>

							<div class="form-group">
								<label for="logoutRequestSignaturePolicy" class="form-label">
									{$LL.admin_saml_detail_idp_logout_signature()}
								</label>
								<select
									id="logoutRequestSignaturePolicy"
									bind:value={logoutRequestSignaturePolicy}
									class="form-select"
								>
									<option value="required">{$LL.admin_saml_detail_required()}</option>
									<option value="optional">{$LL.admin_saml_detail_optional()}</option>
									<option value="disabled">{$LL.admin_saml_detail_disabled()}</option>
								</select>
								<p class="field-hint">
									{$LL.admin_saml_detail_signature_required_hint()}
								</p>
							</div>

							<div class="form-group">
								<label for="authnContextPolicyMode" class="form-label">
									{$LL.admin_saml_detail_authn_context_policy()}
								</label>
								<select
									id="authnContextPolicyMode"
									bind:value={authnContextPolicyMode}
									class="form-select"
								>
									<option value="observe">{$LL.admin_saml_detail_observe()}</option>
									<option value="require_any">{$LL.admin_saml_detail_require_allowed()}</option>
								</select>
							</div>

							<div class="form-group form-group-full">
								<label for="allowedAuthnContextClassRefs" class="form-label">
									{$LL.admin_saml_detail_allowed_authn_context()}
								</label>
								<textarea
									id="allowedAuthnContextClassRefs"
									bind:value={allowedAuthnContextClassRefs}
									class="form-input form-textarea monospace"
									rows="3"
								></textarea>
							</div>
						</div>
					</div>
				{/if}

				{#if providerType === 'saml_sp'}
					<div class="panel">
						<h2 class="panel-title">{$LL.admin_saml_detail_sp_policy()}</h2>

						<div class="form-grid">
							<div class="form-group">
								<label for="identityMappingFieldMapping" class="form-label">
									{$LL.admin_saml_detail_identity_mapping_policy()}
								</label>
								<select
									id="identityMappingFieldMapping"
									bind:value={identityMappingFieldMappingSetId}
									class="form-select"
								>
									<option value="">{$LL.admin_saml_detail_identity_mapping_policy_default()}</option>
									{#each activeFieldMappingSets as fieldMappingSet (fieldMappingSet.id)}
										<option value={fieldMappingSet.id}>
											{fieldMappingSet.displayName}
										</option>
									{/each}
								</select>
								<p class="field-hint">
									{$LL.admin_saml_detail_identity_mapping_policy_hint()}
								</p>
							</div>

							<div class="form-group">
								<label for="authnRequestSignaturePolicy" class="form-label">
									{$LL.admin_saml_detail_authn_request_signature()}
								</label>
								<select
									id="authnRequestSignaturePolicy"
									bind:value={authnRequestSignaturePolicy}
									class="form-select"
								>
									<option value="optional">{$LL.admin_saml_detail_optional()}</option>
									<option value="required">{$LL.admin_saml_detail_required()}</option>
									<option value="disabled">{$LL.admin_saml_detail_disabled()}</option>
								</select>
								<p class="field-hint">
									{$LL.admin_saml_detail_authn_request_signature_hint()}
								</p>
							</div>

							<div class="form-group">
								<label for="spLogoutRequestSignaturePolicy" class="form-label">
									{$LL.admin_saml_detail_logout_request_signature()}
								</label>
								<select
									id="spLogoutRequestSignaturePolicy"
									bind:value={logoutRequestSignaturePolicy}
									class="form-select"
								>
									<option value="required">{$LL.admin_saml_detail_required()}</option>
									<option value="optional">{$LL.admin_saml_detail_optional()}</option>
									<option value="disabled">{$LL.admin_saml_detail_disabled()}</option>
								</select>
								<p class="field-hint">
									{$LL.admin_saml_detail_sp_signature_hint()}
								</p>
							</div>

							<div class="form-group">
								<label for="authnContextClassRefMode" class="form-label">
									{$LL.admin_saml_detail_authn_context_mode()}
								</label>
								<select
									id="authnContextClassRefMode"
									bind:value={authnContextClassRefMode}
									class="form-select"
								>
									<option value="session">{$LL.admin_saml_detail_session_aware()}</option>
									<option value="legacy_static">{$LL.admin_saml_detail_legacy_static()}</option>
								</select>
								<p class="field-hint">
									{$LL.admin_saml_detail_authn_context_mode_hint()}
								</p>
							</div>

							<div class="form-group">
								<label for="defaultAuthnContextClassRef" class="form-label">
									{$LL.admin_saml_detail_default_authn_context()}
								</label>
								<input
									id="defaultAuthnContextClassRef"
									type="text"
									bind:value={defaultAuthnContextClassRef}
									class="form-input"
								/>
							</div>

							<div class="form-group">
								<label for="passkeyAuthnContextClassRef" class="form-label">
									{$LL.admin_saml_detail_passkey_authn_context()}
								</label>
								<input
									id="passkeyAuthnContextClassRef"
									type="text"
									bind:value={passkeyAuthnContextClassRef}
									class="form-input"
								/>
								<p class="field-hint">
									{$LL.admin_saml_detail_passkey_authn_context_hint()}
								</p>
							</div>
						</div>

						<div class="behavior-settings-list">
							<ToggleSwitch
								bind:checked={signAssertions}
								label={$LL.admin_saml_detail_sign_assertions()}
								description={$LL.admin_saml_detail_sign_assertions_desc()}
							/>
							<ToggleSwitch
								bind:checked={signResponses}
								label={$LL.admin_saml_detail_sign_responses()}
								description={$LL.admin_saml_detail_sign_responses_desc()}
							/>
						</div>
					</div>
				{/if}
			{/if}
		{/if}

		{#if (providerCertificatePreview?.warnings.length ?? 0) > 0 || (federationCertificatePreview?.warnings.length ?? 0) > 0}
			<div class="save-warning-panel">
				<div class="save-warning-title">
					<i class="i-ph-warning-circle"></i>
					<span>{$LL.admin_saml_new_certificate_security_warnings()}</span>
				</div>
				<ul>
					{#each providerCertificatePreview?.warnings ?? [] as warning (warning)}
						<li>{warning}</li>
					{/each}
					{#each federationCertificatePreview?.warnings ?? [] as warning (warning)}
						<li>{warning}</li>
					{/each}
				</ul>
			</div>
		{/if}

		<div class="form-actions">
			<button type="button" class="btn btn-secondary" onclick={navigateBack}>
				{$LL.admin_saml_new_cancel()}
			</button>
			<button
				type="submit"
				class="btn btn-primary"
				disabled={saving ||
					Boolean(federationProfileSavedMessage) ||
					Boolean(providerSavedMessage) ||
					(Boolean(aggregatePreview) &&
						aggregateImportMode === 'selected_entities' &&
						selectedAggregateEntityIds.length === 0)}
			>
				{#if aggregatePreview}
					{#if aggregateImportMode === 'trust_profile'}
						{saving ? $LL.admin_saml_local_saving() : $LL.admin_saml_new_save_trust_profile()}
					{:else}
						{saving
							? $LL.admin_saml_new_starting()
							: $LL.admin_saml_new_create_selected_providers()}
					{/if}
				{:else if setupTarget === 'federation'}
					{saving
						? $LL.admin_saml_local_saving()
						: isEditingFederationProfile
							? $LL.admin_saml_new_update_trust_profile()
							: $LL.admin_saml_new_create_trust_profile()}
				{:else}
					{saving ? $LL.admin_saml_new_creating() : $LL.admin_saml_new_create_provider()}
				{/if}
			</button>
		</div>
	</form>
</div>

<style>
	.panel-hint {
		margin-bottom: 16px;
	}

	.metadata-import-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 12px;
		align-items: end;
	}

	.metadata-import-input {
		margin-bottom: 0;
	}

	.metadata-import-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		min-height: 44px;
		white-space: nowrap;
	}

	.loading-hint {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		margin-top: 10px;
	}

	.certificate-url-row {
		margin-bottom: 10px;
	}

	.certificate-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 8px;
	}

	.field-hint {
		margin: 4px 0 0;
		color: var(--text-muted, #9ca3af);
		font-size: 0.6875rem;
		line-height: 1.45;
	}

	.certificate-preview {
		display: grid;
		gap: 10px;
		margin-top: 12px;
		padding: 12px;
		border: 1px solid var(--color-border, #d8dde6);
		border-radius: 8px;
		background: var(--color-surface-subtle, #f8fafc);
	}

	.certificate-preview-header {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
		justify-content: space-between;
	}

	.certificate-preview-grid {
		display: grid;
		grid-template-columns: 140px minmax(0, 1fr);
		gap: 6px 12px;
	}

	.certificate-preview-grid span {
		color: var(--color-text-muted, #657083);
		font-size: 0.8125rem;
		font-weight: 600;
	}

	.certificate-preview-grid code {
		color: var(--color-text, #111827);
		font-family: var(--font-mono);
		font-size: 0.75rem;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	.certificate-warnings {
		display: grid;
		gap: 6px;
		color: var(--color-danger, #dc2626);
		font-size: 0.8125rem;
	}

	.save-warning-panel {
		display: grid;
		gap: 8px;
		margin-top: 16px;
		padding: 12px;
		border: 1px solid rgba(220, 38, 38, 0.35);
		border-radius: 8px;
		background: rgba(220, 38, 38, 0.08);
		color: var(--color-danger, #dc2626);
		font-size: 0.875rem;
	}

	.save-warning-title {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-weight: 700;
	}

	.save-warning-panel ul {
		margin: 0;
		padding-left: 20px;
	}

	.form-success {
		margin: 8px 0 0;
		color: var(--color-success, #22c55e);
		font-size: 0.875rem;
	}

	.form-warning {
		margin: 8px 0 0;
		color: var(--color-warning, #b08800);
		font-size: 0.875rem;
	}

	.selected-metadata-role {
		margin-top: 10px;
	}

	.saml-choice-grid {
		grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
	}

	.aggregate-mode-grid {
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		margin-top: 16px;
		margin-bottom: 16px;
	}

	.federation-profile-form {
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--border-color);
	}

	.form-textarea {
		min-height: auto;
		resize: vertical;
		line-height: 1.45;
	}

	.logo-url-field {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.logo-url-field .form-input {
		flex: 1;
	}

	.logo-url-preview {
		display: grid;
		width: 40px;
		height: 40px;
		flex: 0 0 40px;
		place-items: center;
		border: 1px solid var(--color-border, #d8dde6);
		border-radius: 8px;
		background: var(--color-surface-subtle, #f8fafc);
	}

	.logo-url-preview img {
		max-width: 28px;
		max-height: 28px;
		object-fit: contain;
	}

	.monospace {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
	}

	.compact-checkboxes {
		padding-top: 4px;
	}

	.aggregate-entity-list {
		display: grid;
		gap: 8px;
		max-height: 420px;
		overflow: auto;
		border: 1px solid var(--color-border, #d8dde6);
		border-radius: 8px;
		padding: 8px;
	}

	.aggregate-filter-row {
		display: grid;
		grid-template-columns: minmax(180px, 240px) minmax(0, 1fr);
		gap: 12px;
		align-items: end;
		margin-top: 12px;
	}

	.aggregate-filter-category {
		margin-bottom: 0;
	}

	.aggregate-keyword-options {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		max-height: 96px;
		overflow: auto;
		padding: 2px 0;
	}

	.aggregate-keyword-option {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 32px;
		padding: 5px 8px;
		border: 1px solid var(--color-border, #d8dde6);
		border-radius: 999px;
		background: var(--color-surface, #fff);
		font-size: 0.8125rem;
		white-space: nowrap;
	}

	.aggregate-keyword-option small {
		color: var(--color-text-muted, #657083);
		font-size: 0.75rem;
	}

	.aggregate-entity-row {
		display: grid;
		grid-template-columns: auto auto minmax(0, 1fr);
		gap: 10px;
		align-items: start;
		padding: 8px;
		border-radius: 6px;
	}

	.aggregate-entity-logo {
		width: 32px;
		height: 32px;
		border: 1px solid var(--color-border, #d8dde6);
		border-radius: 6px;
		background: var(--color-surface, #fff);
		object-fit: contain;
	}

	.aggregate-entity-logo--empty {
		visibility: hidden;
	}

	.aggregate-entity-row:hover {
		background: var(--color-surface-muted, #f6f7f9);
	}

	.aggregate-entity-row span {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.aggregate-entity-row small {
		color: var(--color-text-muted, #657083);
		overflow-wrap: anywhere;
	}

	.aggregate-entity-keywords {
		font-size: 0.75rem;
	}

	.aggregate-load-more {
		display: flex;
		justify-content: center;
		padding: 8px 0 2px;
	}

	.batch-progress {
		display: grid;
		gap: 8px;
		margin-top: 12px;
		font-size: 0.875rem;
	}

	.batch-progress progress {
		width: 100%;
		height: 10px;
	}

	@media (max-width: 720px) {
		.metadata-import-row {
			grid-template-columns: 1fr;
		}

		.aggregate-filter-row {
			grid-template-columns: 1fr;
			align-items: stretch;
		}

		.metadata-import-button {
			width: 100%;
		}

		.certificate-preview-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
