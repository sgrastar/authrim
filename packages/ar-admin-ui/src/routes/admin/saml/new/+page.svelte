<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { ToggleSwitch } from '$lib/components';
	import {
		adminSAMLAPI,
		type CreateSAMLProviderRequest,
		type SAMLAttributePreset,
		type SAMLFederationTrustProfile,
		type SAMLMetadataAggregatePreviewResponse,
		type SAMLMetadataBatchStatus,
		type SAMLMetadataEntitySummary,
		type SAMLMetadataKeywordFacet,
		type SAMLProvider,
		type SAMLProviderConfig,
		type SAMLTrustCertificatePreview
	} from '$lib/api/admin-saml';
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

	let presets = $state<SAMLAttributePreset[]>([]);
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
	let samlProfile = $state('baseline');
	let authnRequestSignaturePolicy = $state<'required' | 'optional' | 'disabled'>('optional');
	let authnContextPolicyMode = $state<'observe' | 'require_any'>('observe');
	let allowedAuthnContextClassRefs = $state(
		'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport'
	);
	let authnContextClassRefMode = $state<'legacy_static' | 'session'>('legacy_static');
	let defaultAuthnContextClassRef = $state(
		'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport'
	);
	let passkeyAuthnContextClassRef = $state('urn:authrim:acr:phishing-resistant');
	let attributePresetId = $state('basic.v1');
	let attributeMappingJson = $state('{\n\t"email": "email",\n\t"name": "name"\n}');
	let loadingPresets = $state(false);
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
		void loadPresets();
	});

	async function loadPresets() {
		loadingPresets = true;
		try {
			const result = await adminSAMLAPI.listAttributePresets();
			presets = result.presets;
		} catch {
			presets = [];
		} finally {
			loadingPresets = false;
		}
	}

	async function loadFederationTrustProfileForEdit(id: string) {
		loadingFederationProfile = true;
		error = '';
		try {
			const result = await adminSAMLAPI.listFederationTrustProfiles();
			const profile = result.profiles.find((item) => item.id === id);
			if (!profile) {
				error = 'Federation trust profile was not found';
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
			error = err instanceof Error ? err.message : 'Failed to load federation trust profile';
		} finally {
			loadingFederationProfile = false;
		}
	}

	function parseMapping(): Record<string, string> {
		if (!attributeMappingJson.trim()) return {};
		const parsed = JSON.parse(attributeMappingJson) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('Attribute mapping must be a JSON object');
		}
		return parsed as Record<string, string>;
	}

	function selectedBindings() {
		const bindings: string[] = [];
		if (allowPost) bindings.push('post');
		if (allowRedirect) bindings.push('redirect');
		return bindings;
	}

	function selectedPresetConfig(): SAMLProviderConfig {
		if (providerType !== 'saml_sp' || !attributePresetId) return {};
		const preset = presets.find((item) => item.id === attributePresetId);
		return {
			attributePresetId,
			attributePresetVersion: preset?.version,
			attributeReleasePolicy: preset?.attributeReleasePolicy
		};
	}

	function buildManualConfig(): SAMLProviderConfig {
		const config: SAMLProviderConfig = {
			description: description.trim() || undefined,
			logoUrl: logoUrl.trim() || undefined,
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
			samlProfile,
			authnRequestSignaturePolicy,
			authnContextClassRefMode,
			defaultAuthnContextClassRef: defaultAuthnContextClassRef.trim() || undefined,
			passkeyAuthnContextClassRef: passkeyAuthnContextClassRef.trim() || undefined,
			...selectedPresetConfig()
		};
	}

	function buildMetadataConfig(): SAMLProviderConfig {
		const config: SAMLProviderConfig = {
			description: description.trim() || undefined,
			logoUrl: logoUrl.trim() || undefined,
			...selectedPresetConfig()
		};
		if (providerType !== 'saml_sp') {
			return {
				...config,
				providerName: providerName.trim() || undefined,
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
			authnContextClassRefMode,
			defaultAuthnContextClassRef: defaultAuthnContextClassRef.trim() || undefined,
			passkeyAuthnContextClassRef: passkeyAuthnContextClassRef.trim() || undefined
		};
	}

	function applyPreviewConfig(config: SAMLProviderConfig) {
		providerName = config.providerName || providerName;
		logoUrl = config.logoUrl || '';
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
		samlProfile = config.samlProfile || samlProfile;
		authnRequestSignaturePolicy = config.authnRequestSignaturePolicy || 'optional';
		authnContextPolicyMode = config.authnContextPolicy?.mode || 'observe';
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
		attributePresetId =
			config.attributePresetId || (providerType === 'saml_sp' ? attributePresetId : '');
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
		return type === 'saml_sp' ? 'Service Provider' : 'Identity Provider';
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
					? 'This is IdP metadata. Keep Identity Provider selected for external SAML login, or import the target SP metadata before choosing Service Provider.'
					: 'This is SP metadata. Keep Service Provider selected for Authrim-issued assertions, or import the external IdP metadata before choosing Identity Provider.';
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
		metadataImportMessage =
			'Federation mode creates a trust profile for signed aggregate metadata, not a single IdP/SP provider.';
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
				metadataImportError = 'Metadata URL is required';
			}
			return;
		}

		if (!isImportableMetadataUrl(metadataUrl.trim())) {
			metadataImportError = 'Metadata URL must be a valid HTTP or HTTPS URL';
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
				metadataUrl: metadataUrl.trim(),
				samlProfile,
				attributePresetId: attributePresetId || undefined
			});
			await applyMetadataPreview(preview, {
				source: 'url',
				sourceUrl: metadataUrl.trim()
			});
			lastImportedMetadataUrl = metadataUrl.trim();
		} catch (err) {
			metadataImported = false;
			metadataImportedProviderType = '';
			metadataImportError = err instanceof Error ? err.message : 'Failed to import SAML metadata';
		} finally {
			importingMetadata = false;
		}
	}

	async function importMetadataFromXml() {
		if (!metadataXml.trim()) {
			metadataImportError = 'Metadata XML is required';
			return;
		}

		importingMetadata = true;
		metadataImportError = '';
		metadataImportMessage = '';
		metadataImportTone = 'success';
		error = '';

		try {
			const preview = await adminSAMLAPI.previewMetadata({
				metadataXml: metadataXml.trim(),
				samlProfile,
				attributePresetId: attributePresetId || undefined
			});
			await applyMetadataPreview(preview, { source: 'xml' });
		} catch (err) {
			metadataImported = false;
			metadataImportedProviderType = '';
			metadataImportError = err instanceof Error ? err.message : 'Failed to import SAML metadata XML';
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
				federationProfileName = federationProfileName || buildFederationProfileName(options.sourceUrl);
				federationProfileUrlPattern = federationProfileUrlPattern || options.sourceUrl;
			} else {
				federationProfileName = federationProfileName || 'SAML federation';
			}
			metadataImportTone = preview.verification.status === 'verified' ? 'success' : 'warning';
			metadataImportMessage = `Aggregate metadata loaded from ${options.source.toUpperCase()}: ${preview.entityCount} entities, signature ${preview.verification.status}.`;
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
				? 'SP metadata imported. Authrim will act as IdP for this provider.'
				: 'IdP metadata imported. Authrim will act as SP for this provider.';
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
			error = 'Federation profile name is required';
			return;
		}
		const metadataUrlPatterns = parseFederationProfileUrlPatterns();
		if (metadataUrlPatterns.length === 0) {
			error = 'Metadata URL pattern is required';
			return;
		}
		const certificates = parseFederationProfileCertificates();
		if (certificates.length === 0) {
			error = 'Signing certificate PEM is required for a federation trust profile';
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
				? 'Federation trust profile updated. Returning to SAML settings...'
				: 'Federation trust profile saved. Returning to SAML settings...';
			setTimeout(() => {
				void goto('/admin/saml');
			}, 1000);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create federation trust profile';
		} finally {
			saving = false;
		}
	}

	async function previewFederationCertificate(source: 'url' | 'pem', options: { quiet?: boolean } = {}) {
		const certificateUrl = federationProfileCertificateUrl.trim();
		const certificate = federationProfileCertificate.trim();
		if (source === 'url' && !certificateUrl) {
			if (!options.quiet) {
				federationCertificateError = 'Certificate URL is required';
			}
			return;
		}
		if (source === 'pem' && !certificate) {
			if (!options.quiet) {
				federationCertificateError = 'Certificate PEM is required';
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
					err instanceof Error ? err.message : 'Failed to preview federation trust certificate';
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
			if (federationProfileCertificate.trim() && !federationProfileCertificate.trim().startsWith('https://')) {
				void previewFederationCertificate('pem', { quiet: true });
			}
		}, 350);
	}

	async function previewProviderCertificate(options: { quiet?: boolean } = {}) {
		if (!certificate.trim()) {
			if (!options.quiet) {
				providerCertificateError = 'Certificate PEM is required';
			}
			return;
		}

		loadingProviderCertificate = true;
		providerCertificateError = '';
		try {
			const preview = await adminSAMLAPI.previewTrustCertificate({ certificate: certificate.trim() });
			providerCertificatePreview = preview;
			certificate = preview.certificate;
		} catch (err) {
			providerCertificatePreview = null;
			if (!options.quiet) {
				providerCertificateError =
					err instanceof Error ? err.message : 'Failed to preview SAML certificate';
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
		return date.toLocaleString();
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
				samlProfile,
				attributePresetId: attributePresetId || undefined,
				enabled
			});
			if (aggregateBatchPolling) clearInterval(aggregateBatchPolling);
			aggregateBatchPolling = setInterval(() => {
				void pollAggregateBatch();
			}, 1000);
			await pollAggregateBatch();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to start aggregate metadata import';
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
			if (!federationProfileName.trim()) return 'Federation profile name is required';
			if (!federationProfileUrlPattern.trim()) return 'Metadata URL pattern is required';
			if (!federationProfileCertificate.trim()) {
				return 'Signing certificate PEM is required for a federation trust profile';
			}
			return '';
		}
		if (!name.trim()) return 'Name is required';
		if (!isValidLoginLogoUrl(logoUrl)) return 'Login UI logo URL must be a valid HTTPS URL';
		if (setupMode === 'metadata_url' && !metadataUrl.trim()) return 'Metadata URL is required';
		if (setupMode === 'metadata_xml' && !metadataXml.trim()) return 'Metadata XML is required';
		if (setupMode === 'manual') {
			if (!entityId.trim()) return 'Entity ID is required';
			if (!allowPost && !allowRedirect) return 'At least one binding is required';
			if (providerType === 'saml_idp' && (!ssoUrl.trim() || !certificate.trim())) {
				return 'SSO URL and certificate are required for a SAML IdP';
			}
			if (providerType === 'saml_sp' && !acsUrl.trim()) {
				return 'ACS URL is required for a SAML SP';
			}
			parseMapping();
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
				if (providerType === 'saml_sp') {
					request.samlProfile = samlProfile;
					request.attributePresetId = attributePresetId || undefined;
				}
			}

			const provider = await adminSAMLAPI.createProvider(request);
			saving = false;
			providerSavedMessage = `${provider.name} created. Returning to SAML settings...`;
			setTimeout(() => {
				void goto('/admin/saml');
			}, 1000);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create SAML provider';
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
		{isEditingFederationProfile ? 'Edit Federation Trust Profile' : 'New SAML Provider/Federation'}
		- Admin Dashboard - Authrim
	</title>
</svelte:head>

{#snippet certificatePreviewCard(preview: SAMLTrustCertificatePreview)}
	<div class="certificate-preview">
		<div class="certificate-preview-header">
			<strong>Valid X.509 certificate</strong>
			<span class="badge badge-info">{preview.publicKeyAlgorithm}</span>
		</div>
		<div class="certificate-preview-grid">
			<span>Subject</span>
			<code>{preview.subject}</code>
			<span>Issuer</span>
			<code>{preview.issuer}</code>
			<span>Valid From</span>
			<code>{formatCertificateDate(preview.validFrom)}</code>
			<span>Valid To</span>
			<code>{formatCertificateDate(preview.validTo)}</code>
			<span>Signature</span>
			<code>{preview.signatureAlgorithm}</code>
			{#if preview.publicKeySizeBits}
				<span>Key Size</span>
				<code>{preview.publicKeySizeBits} bits</code>
			{/if}
			<span>SHA-1</span>
			<code>{preview.fingerprintSha1}</code>
			<span>SHA-256</span>
			<code>{preview.fingerprintSha256}</code>
		</div>
		{#if preview.warnings.length > 0}
			<div class="certificate-warnings">
				{#each preview.warnings as warning}
					<div><i class="i-ph-warning-circle"></i>{warning}</div>
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

<div class="admin-page">
	<a href="/admin/saml" class="back-link">← Back to SAML</a>

	<h1 class="page-title">
		{isEditingFederationProfile ? 'Edit Federation Trust Profile' : 'Add SAML Provider/Federation'}
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
				<p>Loading federation trust profile...</p>
			</div>
		{/if}

		{#if !aggregatePreview}
			<div class="panel">
				{#if setupTarget === 'federation'}
					<ToggleSwitch
						bind:checked={enabled}
						label="Trust Profile Status"
						description="Enable or disable this trust profile for aggregate metadata verification."
					/>
				{:else}
					<ToggleSwitch
						bind:checked={enabled}
						label="Provider Status"
						description="Enable or disable this SAML provider."
					/>
				{/if}
			</div>
		{/if}

		{#if !isEditingFederationProfile}
		<div class="panel">
			<h2 class="panel-title">SAML Configuration</h2>
			<p class="form-hint panel-hint">
				Enter a metadata URL to automatically detect a single IdP/SP provider or a federation
				aggregate containing multiple entities.
			</p>

			<div class="metadata-import-row">
				<div class="form-group metadata-import-input">
					<label for="metadataUrl" class="form-label">Metadata URL</label>
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
						Importing Metadata...
					{:else}
						Import Metadata
					{/if}
				</button>
			</div>

			{#if importingMetadata}
				<p class="form-hint loading-hint">
					<i class="i-ph-circle-notch loading-spinner"></i>
					Reading metadata, detecting single entity or federation aggregate, and preparing import
					options.
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
					Single SP metadata selects Service Provider. Single IdP metadata selects Identity
					Provider. Aggregate metadata opens federation import options.
				</p>
			{/if}
		</div>
		{/if}

		{#if aggregatePreview}
			<div class="panel">
				<h2 class="panel-title">Federation Aggregate Detected</h2>
				<p
					class:form-success={aggregatePreview.verification.status === 'verified'}
					class:form-warning={aggregatePreview.verification.status !== 'verified'}
				>
					Signature {aggregatePreview.verification.status}
					{#if aggregatePreview.verification.trustProfileName}
						via {aggregatePreview.verification.trustProfileName}
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
						<div class="template-name">Create Providers</div>
						<div class="template-desc">Select entities from this aggregate</div>
					</button>
					<button
						type="button"
						class="template-card"
						class:template-card-selected={aggregateImportMode === 'trust_profile'}
						onclick={() => (aggregateImportMode = 'trust_profile')}
					>
						<div class="i-ph-shield-check h-5 w-5 template-icon"></div>
						<div class="template-name">Federation Trust Profile</div>
						<div class="template-desc">Register trust anchor for this aggregate</div>
					</button>
				</div>

				{#if aggregateImportMode === 'trust_profile'}
					<div class="federation-profile-form">
						<div class="form-grid">
							<div class="form-group">
								<label for="federationProfileName" class="form-label">Profile Name *</label>
								<input
									id="federationProfileName"
									bind:value={federationProfileName}
									class="form-input"
									placeholder="Example Research Federation"
								/>
							</div>
							<div class="form-group">
								<label for="federationProfilePolicy" class="form-label">Policy</label>
								<select
									id="federationProfilePolicy"
									bind:value={federationProfilePolicy}
									class="form-select"
								>
									<option value="strict">Strict</option>
									<option value="warn">Warn</option>
									<option value="disabled">Disabled</option>
								</select>
							</div>
							<div class="form-group form-group-full">
								<label for="federationProfileUrlPattern" class="form-label">
									Metadata URL Pattern *
								</label>
								<input
									id="federationProfileUrlPattern"
									bind:value={federationProfileUrlPattern}
									class="form-input"
								/>
								<p class="form-hint">
									Use the exact aggregate URL for a narrow trust profile, or a controlled wildcard
									such as https://metadata.example.org/*.
								</p>
							</div>
							<div class="form-group form-group-full">
								<label for="federationProfileCertificate" class="form-label">
									Federation Signing Certificate *
								</label>
								<div class="metadata-import-row certificate-url-row">
									<div class="form-group metadata-import-input">
										<label for="federationProfileCertificateUrl" class="form-label">
											Certificate URL
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
										{loadingFederationCertificate ? 'Checking...' : 'Load Certificate'}
									</button>
								</div>
								<textarea
									id="federationProfileCertificate"
									bind:value={federationProfileCertificate}
									oninput={handleFederationCertificateInput}
									class="form-input form-textarea monospace"
									rows="8"
									placeholder="Paste PEM, base64 DER, or enter a certificate URL above"
								></textarea>
								<p class="form-hint">
									Accepts X.509 certificates in DER or PEM form. Common URL/file extensions are
									.cer, .crt, and .pem, but Authrim validates the certificate content rather than
									the extension.
								</p>
								<div class="certificate-actions">
									<button
										type="button"
										class="btn btn-secondary btn-sm"
										onclick={() => previewFederationCertificate('pem')}
										disabled={loadingFederationCertificate || !federationProfileCertificate.trim()}
									>
										Validate Certificate
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
								Federation trust profile created: {federationProfileCreated.name}
							</p>
						{/if}
					</div>
				{:else}

				<div class="metadata-import-row">
					<div class="form-group metadata-import-input">
						<label for="aggregateSearch" class="form-label">Search entities</label>
						<input
							id="aggregateSearch"
							type="search"
							bind:value={aggregateEntityQuery}
							class="form-input"
							placeholder="entityID, display name, endpoint"
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
						Search
					</button>
				</div>

				{#if aggregateKeywordFacets.length > 0}
					<div class="aggregate-filter-row">
						<div class="form-group aggregate-filter-category">
							<label for="aggregateKeywordCategory" class="form-label">Keyword category</label>
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
								aria-label={`${activeAggregateKeywordFacet.label} filters`}
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
					Showing {aggregateEntities.length} of {aggregateEntityTotal}. Selected {selectedAggregateEntityIds.length}.
					{#if loadingAggregateEntities}
						Loading more...
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
								{loadingAggregateEntities ? 'Loading...' : 'Load more'}
							</button>
						</div>
					{/if}
				</div>

				{#if aggregateBatch}
					<div class="batch-progress">
						<div>
							Processed {aggregateBatch.processed} / {aggregateBatch.total}
							· Succeeded {aggregateBatch.succeeded}
							· Failed {aggregateBatch.failed}
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
				<h2 class="panel-title">Choose Provider Type</h2>
				<p class="form-hint panel-hint">
					Choose IdP or SP for a single SAML counterparty, or Federation for aggregate metadata
					trust anchors.
				</p>

				<div class="template-grid saml-choice-grid">
					<button
						type="button"
						class="template-card"
						class:template-card-selected={setupTarget === 'saml_idp'}
						onclick={() => chooseProviderType('saml_idp')}
					>
						<div class="i-ph-identification-card h-5 w-5 template-icon"></div>
						<div class="template-name">Identity Provider</div>
						<div class="template-desc">External login</div>
					</button>

					<button
						type="button"
						class="template-card"
						class:template-card-selected={setupTarget === 'saml_sp'}
						onclick={() => chooseProviderType('saml_sp')}
					>
						<div class="i-ph-app-window h-5 w-5 template-icon"></div>
						<div class="template-name">Service Provider</div>
						<div class="template-desc">Authrim as IdP</div>
					</button>

					<button
						type="button"
						class="template-card"
						class:template-card-selected={setupTarget === 'federation'}
						onclick={chooseFederation}
					>
						<div class="i-ph-shield-check h-5 w-5 template-icon"></div>
						<div class="template-name">Federation</div>
						<div class="template-desc">Aggregate metadata trust</div>
					</button>
				</div>

				{#if metadataImported && metadataImportedProviderType}
					<p class="form-hint selected-metadata-role">
						Imported metadata role: {providerTypeLabel(metadataImportedProviderType)}.
					</p>
				{/if}
			</div>
			{/if}

			{#if setupTarget === 'federation'}
				<div class="panel">
					<h2 class="panel-title">Federation Trust Profile</h2>
					<p class="form-hint panel-hint">
						Register a trust anchor for signed aggregate metadata. This does not create a single
						SAML IdP/SP provider by itself.
					</p>

					<div class="form-grid">
						<div class="form-group">
							<label for="manualFederationProfileName" class="form-label">Profile Name *</label>
							<input
								id="manualFederationProfileName"
								bind:value={federationProfileName}
								class="form-input"
								placeholder="Example Research Federation"
							/>
						</div>
						<div class="form-group">
							<label for="manualFederationProfilePolicy" class="form-label">Policy</label>
							<select
								id="manualFederationProfilePolicy"
								bind:value={federationProfilePolicy}
								class="form-select"
							>
								<option value="strict">Strict</option>
								<option value="warn">Warn</option>
								<option value="disabled">Disabled</option>
							</select>
						</div>
						<div class="form-group form-group-full">
							<label for="manualFederationDescription" class="form-label">Description</label>
							<textarea
								id="manualFederationDescription"
								bind:value={description}
								class="form-input form-textarea"
								rows="3"
								placeholder="Operational note, owner, federation source, or rollout status"
							></textarea>
						</div>
						<div class="form-group form-group-full">
							<label for="manualFederationProfileUrlPattern" class="form-label">
								Metadata URL Pattern *
							</label>
							<textarea
								id="manualFederationProfileUrlPattern"
								bind:value={federationProfileUrlPattern}
								class="form-input form-textarea monospace"
								rows="3"
								placeholder="https://metadata.example.org/*"
							></textarea>
							<p class="form-hint">
								Use one pattern per line. Prefer the exact aggregate URL for narrow trust, or a
								controlled wildcard for a known metadata host.
							</p>
						</div>
						<div class="form-group form-group-full">
							<label for="manualFederationProfileCertificate" class="form-label">
								Federation Signing Certificate *
							</label>
							<div class="metadata-import-row certificate-url-row">
								<div class="form-group metadata-import-input">
									<label for="manualFederationProfileCertificateUrl" class="form-label">
										Certificate URL
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
									{loadingFederationCertificate ? 'Checking...' : 'Load Certificate'}
								</button>
							</div>
							<textarea
								id="manualFederationProfileCertificate"
								bind:value={federationProfileCertificate}
								oninput={handleFederationCertificateInput}
								class="form-input form-textarea monospace"
								rows="10"
								placeholder="Paste PEM, base64 DER, or enter a certificate URL above"
							></textarea>
							<p class="form-hint">
								Accepts X.509 certificates in DER or PEM form. Common URL/file extensions are
								.cer, .crt, and .pem. This is similar to Shibboleth metadata signature validation
								configuration.
							</p>
							<div class="certificate-actions">
								<button
									type="button"
									class="btn btn-secondary btn-sm"
									onclick={() => previewFederationCertificate('pem')}
									disabled={loadingFederationCertificate || !federationProfileCertificate.trim()}
								>
									Validate Certificate
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
				<h2 class="panel-title">Basic Information</h2>

				<div class="form-grid">
					<div class="form-group">
						<label for="name" class="form-label">Name *</label>
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
						<label for="nameIdFormat" class="form-label">NameID Format</label>
						<select id="nameIdFormat" bind:value={nameIdFormat} class="form-select">
							{#each nameIdFormats as format (format.value)}
								<option value={format.value}>{format.label}</option>
							{/each}
						</select>
					</div>

					<div class="form-group form-group-full">
						<label for="description" class="form-label">Description</label>
						<textarea
							id="description"
							bind:value={description}
							class="form-input form-textarea"
							rows="3"
							placeholder="Operational note, owner, rollout status, or test purpose"
						></textarea>
					</div>

					<div class="form-group form-group-full">
						<label for="logoUrl" class="form-label">Login UI Logo URL</label>
						<div class="logo-url-field">
							<input
								id="logoUrl"
								type="url"
								bind:value={logoUrl}
								class="form-input"
								placeholder="https://example.com/logo.png"
							/>
							{#if logoUrl}
								<div class="logo-url-preview" aria-label="Logo preview">
									<img src={logoUrl} alt="" loading="lazy" />
								</div>
							{/if}
						</div>
						<p class="form-hint">
							Optional. Used as the provider logo on Login UI buttons. HTTPS only; the image is
							fitted into a square.
						</p>
					</div>
				</div>
			</div>

			<div class="panel">
				<h2 class="panel-title">Configuration Method</h2>
				<p class="form-hint panel-hint">
					Metadata import is preferred. Use manual fields only when the counterparty cannot publish
					metadata.
				</p>

				<div class="template-grid saml-choice-grid">
					<button
						type="button"
						class="template-card"
						class:template-card-selected={setupMode === 'metadata_url'}
						onclick={() => (setupMode = 'metadata_url')}
					>
						<div class="i-ph-link h-5 w-5 template-icon"></div>
						<div class="template-name">Metadata URL</div>
						<div class="template-desc">Auto fetch</div>
					</button>

					<button
						type="button"
						class="template-card"
						class:template-card-selected={setupMode === 'metadata_xml'}
						onclick={() => (setupMode = 'metadata_xml')}
					>
						<div class="i-ph-file-code h-5 w-5 template-icon"></div>
						<div class="template-name">Metadata XML</div>
						<div class="template-desc">Paste XML</div>
					</button>

					<button
						type="button"
						class="template-card"
						class:template-card-selected={setupMode === 'manual'}
						onclick={() => (setupMode = 'manual')}
					>
						<div class="i-ph-sliders h-5 w-5 template-icon"></div>
						<div class="template-name">Manual</div>
						<div class="template-desc">Direct input</div>
					</button>
				</div>
			</div>

			<div class="panel">
				<h2 class="panel-title">SAML Configuration</h2>

				{#if setupMode === 'metadata_url'}
					<div class="form-group">
						<label for="metadataUrlMode" class="form-label">Metadata URL *</label>
						<input
							id="metadataUrlMode"
							type="url"
							bind:value={metadataUrl}
							class="form-input"
							placeholder="https://example.com/saml/metadata"
						/>
						<p class="form-hint">
							HTTPS URLs are fetched by the backend and stored with metadata change tracking.
						</p>
					</div>
				{:else if setupMode === 'metadata_xml'}
					<div class="form-group">
						<label for="metadataXml" class="form-label">Metadata XML *</label>
						<textarea
							id="metadataXml"
							bind:value={metadataXml}
							oninput={handleMetadataXmlInput}
							class="form-input form-textarea monospace"
							rows="12"
						></textarea>
						<p class="form-hint">
							Paste SAML metadata XML, then import it to detect the role and populate the provider
							fields.
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
									Importing Metadata...
								{:else}
									Import Metadata
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
							<label for="entityId" class="form-label">Entity ID *</label>
							<input id="entityId" type="text" bind:value={entityId} class="form-input" />
						</div>

						{#if providerType === 'saml_idp'}
							<div class="form-group">
								<label for="ssoUrl" class="form-label">SSO URL *</label>
								<input id="ssoUrl" type="url" bind:value={ssoUrl} class="form-input" />
							</div>
						{:else}
							<div class="form-group">
								<label for="acsUrl" class="form-label">ACS URL *</label>
								<input id="acsUrl" type="url" bind:value={acsUrl} class="form-input" />
							</div>
						{/if}

						<div class="form-group">
							<label for="sloUrl" class="form-label">SLO URL</label>
							<input id="sloUrl" type="url" bind:value={sloUrl} class="form-input" />
						</div>

						<div class="form-group form-group-full">
							<label for="certificate" class="form-label">
								{providerType === 'saml_idp' ? 'Signing Certificate *' : 'SP Certificate'}
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
								Validate the X.509 certificate before saving when entering metadata manually.
							</p>
							<div class="certificate-actions">
								<button
									type="button"
									class="btn btn-secondary btn-sm"
									onclick={() => previewProviderCertificate()}
									disabled={loadingProviderCertificate || !certificate.trim()}
								>
									{loadingProviderCertificate ? 'Checking...' : 'Validate Certificate'}
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
							<label for="attributeMapping" class="form-label">Attribute Mapping JSON</label>
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
					<h2 class="panel-title">SP Login Policy</h2>

					<div class="form-grid">
						<div class="form-group">
							<label for="providerName" class="form-label">SP Display Name</label>
							<input
								id="providerName"
								type="text"
								bind:value={providerName}
								class="form-input"
								placeholder="Authrim"
							/>
						</div>

						<div class="form-group">
							<label for="authnContextPolicyMode" class="form-label">AuthnContext Policy</label>
							<select
								id="authnContextPolicyMode"
								bind:value={authnContextPolicyMode}
								class="form-select"
							>
								<option value="observe">Observe</option>
								<option value="require_any">Require allowed value</option>
							</select>
						</div>

						<div class="form-group form-group-full">
							<label for="allowedAuthnContextClassRefs" class="form-label">
								Allowed AuthnContextClassRef
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
					<h2 class="panel-title">SP Policy</h2>

					<div class="form-grid">
						<div class="form-group">
							<label for="samlProfile" class="form-label">Profile</label>
							<select id="samlProfile" bind:value={samlProfile} class="form-select">
								<option value="baseline">Baseline</option>
								<option value="strict">Strict</option>
								<option value="academic_publisher">Academic Publisher</option>
								<option value="legacy">Legacy</option>
							</select>
						</div>

						<div class="form-group">
							<label for="attributePreset" class="form-label">Attribute Preset</label>
							<select
								id="attributePreset"
								bind:value={attributePresetId}
								class="form-select"
								disabled={loadingPresets}
							>
								<option value="">None</option>
								{#each presets as preset (preset.id)}
									<option value={preset.id}>{preset.label}</option>
								{/each}
							</select>
						</div>

						<div class="form-group">
							<label for="authnRequestSignaturePolicy" class="form-label">
								AuthnRequest Signature
							</label>
							<select
								id="authnRequestSignaturePolicy"
								bind:value={authnRequestSignaturePolicy}
								class="form-select"
							>
								<option value="optional">Optional</option>
								<option value="required">Required</option>
								<option value="disabled">Disabled</option>
							</select>
						</div>

						<div class="form-group">
							<label for="authnContextClassRefMode" class="form-label">AuthnContext Mode</label>
							<select
								id="authnContextClassRefMode"
								bind:value={authnContextClassRefMode}
								class="form-select"
							>
								<option value="session">Session aware</option>
								<option value="legacy_static">Legacy static</option>
							</select>
						</div>

						<div class="form-group">
							<label for="defaultAuthnContextClassRef" class="form-label"
								>Default AuthnContext</label
							>
							<input
								id="defaultAuthnContextClassRef"
								type="text"
								bind:value={defaultAuthnContextClassRef}
								class="form-input"
							/>
						</div>

						<div class="form-group">
							<label for="passkeyAuthnContextClassRef" class="form-label"
								>Passkey AuthnContext</label
							>
							<input
								id="passkeyAuthnContextClassRef"
								type="text"
								bind:value={passkeyAuthnContextClassRef}
								class="form-input"
							/>
						</div>
					</div>

					<div class="behavior-settings-list">
						<ToggleSwitch
							bind:checked={signAssertions}
							label="Sign Assertions"
							description="Sign SAML Assertions sent to this service provider."
						/>
						<ToggleSwitch
							bind:checked={signResponses}
							label="Sign Responses"
							description="Sign SAML Responses sent to this service provider."
						/>
					</div>
				</div>
			{/if}
			{/if}
		{/if}

		{#if (providerCertificatePreview?.warnings.length ?? 0) > 0 ||
			(federationCertificatePreview?.warnings.length ?? 0) > 0}
			<div class="save-warning-panel">
				<div class="save-warning-title">
					<i class="i-ph-warning-circle"></i>
					<span>Certificate security warnings</span>
				</div>
				<ul>
					{#each providerCertificatePreview?.warnings ?? [] as warning}
						<li>{warning}</li>
					{/each}
					{#each federationCertificatePreview?.warnings ?? [] as warning}
						<li>{warning}</li>
					{/each}
				</ul>
			</div>
		{/if}

		<div class="form-actions">
			<button type="button" class="btn btn-secondary" onclick={navigateBack}>Cancel</button>
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
						{saving ? 'Saving...' : 'Save Trust Profile'}
					{:else}
						{saving ? 'Starting...' : 'Create Selected Providers'}
					{/if}
				{:else if setupTarget === 'federation'}
					{saving
						? 'Saving...'
						: isEditingFederationProfile
							? 'Update Trust Profile'
							: 'Create Trust Profile'}
				{:else}
					{saving ? 'Creating...' : 'Create Provider'}
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
