<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { ToggleSwitch } from '$lib/components';
	import { onMount } from 'svelte';
	import {
		adminSAMLAPI,
		type AttributeReleaseConsentMode,
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
	import { getLocale, LL } from '$i18n/i18n-svelte';

	const providerId = $derived($page.params.id);
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

	let provider = $state<SAMLProvider | null>(null);
	let fieldMappingSets = $state<IdentityMappingFieldMappingSetSummary[]>([]);
	let loading = $state(true);
	let saving = $state(false);
	let busyAction = $state('');
	let error = $state('');
	let message = $state('');

	let name = $state('');
	let description = $state('');
	let enabled = $state(true);
	let metadataUrl = $state('');
	let providerName = $state('Authrim');
	let logoUrl = $state('');
	let iconName = $state('');
	let entityId = $state('');
	let ssoUrl = $state('');
	let acsUrl = $state('');
	let sloUrl = $state('');
	let certificate = $state('');
	let nameIdFormat = $state('');
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
	let attributeReleaseConsentSetting = $state<'disabled' | AttributeReleaseConsentMode>('disabled');
	let identityMappingFieldMappingSetId = $state('');
	let attributeMappingJson = $state('{}');
	let certificatePreview = $state<SAMLTrustCertificatePreview | null>(null);
	let certificatePreviewError = $state('');
	let loadingCertificatePreview = $state(false);
	const activeFieldMappingSets = $derived(
		fieldMappingSets.filter((fieldMappingSet) => fieldMappingSet.lifecycleState === 'active')
	);
	const selectedInactiveFieldMappingSet = $derived(
		identityMappingFieldMappingSetId &&
			!activeFieldMappingSets.some(
				(fieldMappingSet) => fieldMappingSet.id === identityMappingFieldMappingSetId
			)
			? (fieldMappingSets.find(
					(fieldMappingSet) => fieldMappingSet.id === identityMappingFieldMappingSetId
				) ?? null)
			: null
	);

	onMount(() => {
		void loadPage();
	});

	async function loadPage() {
		if (!providerId) return;
		loading = true;
		error = '';
		try {
			const [loadedProvider, fieldMappingResult] = await Promise.all([
				adminSAMLAPI.getProvider(providerId),
				adminIdentityMappingAPI.listFieldMappingSets()
			]);
			provider = loadedProvider;
			fieldMappingSets = fieldMappingResult.fieldMappingSets;
			populateForm(loadedProvider);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_saml_detail_error_load();
		} finally {
			loading = false;
		}
	}

	function populateForm(data: SAMLProvider) {
		name = data.name;
		description = data.config.description || '';
		enabled = data.enabled;
		metadataUrl = data.config.metadataUrl || '';
		providerName = data.config.providerName || 'Authrim';
		logoUrl = data.config.logoUrl || '';
		iconName = data.config.iconName || '';
		entityId = data.config.entityId || '';
		ssoUrl = data.config.ssoUrl || '';
		acsUrl = data.config.acsUrl || '';
		sloUrl = data.config.sloUrl || '';
		certificate = data.config.certificate || '';
		nameIdFormat =
			data.config.nameIdFormat || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
		allowPost = data.config.allowedBindings?.includes('post') ?? true;
		allowRedirect = data.config.allowedBindings?.includes('redirect') ?? true;
		signAssertions = data.config.signAssertions ?? true;
		signResponses = data.config.signResponses ?? true;
		authnRequestSignaturePolicy = data.config.authnRequestSignaturePolicy || 'optional';
		logoutRequestSignaturePolicy = data.config.logoutRequestSignaturePolicy || 'required';
		authnContextPolicyMode = data.config.authnContextPolicy?.mode || 'observe';
		jitEmailLinkingPolicy = data.config.jitEmailLinkingPolicy || 'email_linking';
		allowSyntheticEmailFallback = data.config.allowSyntheticEmailFallback === true;
		allowedAuthnContextClassRefs = (
			data.config.authnContextPolicy?.allowedClassRefs?.length
				? data.config.authnContextPolicy.allowedClassRefs
				: ['urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport']
		).join('\n');
		authnContextClassRefMode = data.config.authnContextClassRefMode || 'legacy_static';
		defaultAuthnContextClassRef =
			data.config.defaultAuthnContextClassRef ||
			'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport';
		passkeyAuthnContextClassRef =
			data.config.passkeyAuthnContextClassRef || 'urn:authrim:acr:phishing-resistant';
		attributeReleaseConsentSetting = data.config.attributeReleaseConsent?.enabled
			? data.config.attributeReleaseConsent.mode
			: 'disabled';
		identityMappingFieldMappingSetId = data.config.identityMapping?.fieldMappingSetId || '';
		attributeMappingJson = JSON.stringify(data.config.attributeMapping || {}, null, 2);
		certificatePreview = null;
		certificatePreviewError = '';
	}

	function providerTypeLabel(type: SAMLProvider['providerType']) {
		return type === 'saml_sp'
			? $LL.admin_saml_detail_service_provider()
			: $LL.admin_saml_detail_identity_provider();
	}

	function selectedNameIdFormatInfo() {
		switch (nameIdFormat) {
			case 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress':
				return {
					description: $LL.admin_saml_detail_nameid_email(),
					sample: 'alice@example.edu'
				};
			case 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent':
				return {
					description: $LL.admin_saml_detail_nameid_persistent(),
					sample: 'a7f62c2b-2f5f-4df8-9d1d-8c7e7b1c6c2a'
				};
			case 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient':
				return {
					description: $LL.admin_saml_detail_nameid_transient(),
					sample: '_9f23b7f2d3d0476a8b98'
				};
			case 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified':
				return {
					description: $LL.admin_saml_detail_nameid_unspecified(),
					sample: 'alice'
				};
			case 'urn:mace:shibboleth:1.0:nameIdentifier':
				return {
					description: $LL.admin_saml_detail_nameid_shibboleth(),
					sample: 'alice@example.edu'
				};
			default:
				return {
					description: $LL.admin_saml_detail_nameid_custom(),
					sample: nameIdFormat || '-'
				};
		}
	}

	function formatCertificateDate(value: string) {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value || '-';
		return date.toLocaleString(getLocale() === 'ja' ? 'ja-JP' : 'en-US');
	}

	function providerCertificateMessage() {
		const validation = provider?.config.certificateValidation;
		if (!validation) return '';
		if (validation.allExpired) {
			return $LL.admin_saml_detail_all_expired();
		}
		if (validation.hasExpired) {
			return $LL.admin_saml_detail_some_expired();
		}
		if (validation.hasWeakSignature) {
			return $LL.admin_saml_detail_weak_signature();
		}
		return '';
	}

	function providerCertificateMessageClass() {
		const validation = provider?.config.certificateValidation;
		return validation?.allExpired || validation?.hasExpired
			? 'alert alert-error'
			: 'alert alert-warning';
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

	function buildConfig(): SAMLProviderConfig {
		const config: SAMLProviderConfig = {
			description: description.trim(),
			logoUrl: logoUrl.trim() || undefined,
			iconName: iconName || undefined,
			entityId: entityId.trim(),
			metadataUrl: metadataUrl.trim(),
			sloUrl: sloUrl.trim(),
			certificate: certificate.trim(),
			nameIdFormat,
			attributeMapping: parseMapping(),
			allowedBindings: selectedBindings()
		};

		if (provider?.providerType === 'saml_idp') {
			return {
				...config,
				providerName: providerName.trim() || undefined,
				ssoUrl: ssoUrl.trim(),
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
			signAssertions,
			signResponses,
			authnRequestSignaturePolicy,
			logoutRequestSignaturePolicy,
			authnContextClassRefMode,
			defaultAuthnContextClassRef: defaultAuthnContextClassRef.trim() || undefined,
			passkeyAuthnContextClassRef: passkeyAuthnContextClassRef.trim() || undefined,
			attributeReleaseConsent:
				attributeReleaseConsentSetting === 'disabled'
					? {
							enabled: false,
							mode: 'once'
						}
					: {
							enabled: true,
							mode: attributeReleaseConsentSetting
						},
			identityMapping: identityMappingFieldMappingSetId
				? {
						...(provider?.config.identityMapping ?? {}),
						fieldMappingSetId: identityMappingFieldMappingSetId,
						destinationNamespace:
							provider?.config.identityMapping?.destinationNamespace ?? 'saml.attribute'
					}
				: undefined
		};
	}

	function validate() {
		if (!name.trim()) return $LL.admin_saml_detail_name_required_error();
		if (!isValidLoginLogoUrl(logoUrl)) return $LL.admin_saml_detail_logo_invalid();
		if (!entityId.trim()) return $LL.admin_saml_detail_entity_required();
		if (!allowPost && !allowRedirect) return $LL.admin_saml_detail_at_least_one_binding();
		if (provider?.providerType === 'saml_idp' && (!ssoUrl.trim() || !certificate.trim())) {
			return $LL.admin_saml_detail_idp_required();
		}
		if (provider?.providerType === 'saml_sp' && !acsUrl.trim()) {
			return $LL.admin_saml_detail_sp_required();
		}
		if (provider?.providerType === 'saml_sp' && !identityMappingFieldMappingSetId) {
			return $LL.admin_saml_detail_identity_mapping_required_error();
		}
		parseMapping();
		return '';
	}

	function isValidLoginLogoUrl(value: string): boolean {
		if (!value.trim()) return true;
		try {
			return new URL(value.trim()).protocol === 'https:';
		} catch {
			return false;
		}
	}

	async function handleSave() {
		if (!providerId) return;
		const validationError = validate();
		if (validationError) {
			error = validationError;
			return;
		}

		saving = true;
		error = '';
		message = '';
		try {
			const updated = await adminSAMLAPI.updateProvider(providerId, {
				name: name.trim(),
				enabled,
				config: buildConfig()
			});
			provider = updated;
			populateForm(updated);
			message = $LL.admin_saml_detail_provider_updated();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_saml_detail_error_update();
		} finally {
			saving = false;
		}
	}

	async function previewCertificate() {
		if (!certificate.trim()) {
			certificatePreviewError = $LL.admin_saml_detail_certificate_required();
			return;
		}
		loadingCertificatePreview = true;
		certificatePreviewError = '';
		certificatePreview = null;
		try {
			certificatePreview = await adminSAMLAPI.previewTrustCertificate({
				certificate: certificate.trim()
			});
			certificate = certificatePreview.certificate;
		} catch (err) {
			certificatePreviewError =
				err instanceof Error ? err.message : $LL.admin_saml_detail_error_validate_certificate();
		} finally {
			loadingCertificatePreview = false;
		}
	}

	async function promoteNext() {
		if (!providerId || !provider) return;
		busyAction = 'promote';
		error = '';
		message = '';
		try {
			const result = await adminSAMLAPI.promoteSigningNext(providerId);
			provider = { ...provider, config: result.config };
			populateForm(provider);
			message = $LL.admin_saml_detail_next_promoted();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_saml_detail_error_promote_next();
		} finally {
			busyAction = '';
		}
	}

	async function retireBackup() {
		if (!providerId || !provider) return;
		busyAction = 'retire';
		error = '';
		message = '';
		try {
			const result = await adminSAMLAPI.retireSigningBackup(providerId);
			provider = { ...provider, config: result.config };
			populateForm(provider);
			message = $LL.admin_saml_detail_backup_retired();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_saml_detail_error_retire_backup();
		} finally {
			busyAction = '';
		}
	}

	async function deleteProvider() {
		if (!providerId || !provider) return;
		if (!window.confirm($LL.admin_saml_detail_delete_confirm({ name: provider.name }))) return;
		busyAction = 'delete';
		error = '';
		try {
			await adminSAMLAPI.deleteProvider(providerId);
			await goto('/admin/saml');
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_saml_detail_error_delete();
		} finally {
			busyAction = '';
		}
	}
</script>

<svelte:head>
	<title
		>{provider ? provider.name : $LL.admin_saml_detail_page_title_fallback()} - Admin Dashboard - Authrim</title
	>
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

	{#if loading}
		<div class="loading-state">{$LL.admin_saml_detail_loading()}</div>
	{:else if provider}
		<div class="page-header">
			<div>
				<h1 class="page-title">{provider.name}</h1>
				<p class="page-description">{providerTypeLabel(provider.providerType)}</p>
			</div>
			<div class="page-actions">
				<button class="btn btn-danger" onclick={deleteProvider} disabled={busyAction === 'delete'}>
					{$LL.admin_saml_detail_delete()}
				</button>
			</div>
		</div>

		<form
			onsubmit={(event) => {
				event.preventDefault();
				void handleSave();
			}}
		>
			{#if error}
				<div class="alert alert-error">{error}</div>
			{/if}

			{#if message}
				<div class="alert alert-success">{message}</div>
			{/if}

			{#if providerCertificateMessage()}
				<div class={providerCertificateMessageClass()}>{providerCertificateMessage()}</div>
			{/if}

			<div class="panel">
				<ToggleSwitch
					bind:checked={enabled}
					label={$LL.admin_saml_detail_provider_status()}
					description={$LL.admin_saml_detail_provider_status_desc()}
				/>
			</div>

			<div class="panel">
				<h2 class="panel-title">{$LL.admin_saml_detail_basic_information()}</h2>

				<div class="form-grid">
					<div class="form-group">
						<label for="name" class="form-label">{$LL.admin_saml_detail_name_required()}</label>
						<input id="name" type="text" bind:value={name} class="form-input" required />
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
						<div class="inline-help">
							<p>{selectedNameIdFormatInfo().description}</p>
							<code
								>{$LL.admin_saml_detail_example({
									sample: selectedNameIdFormatInfo().sample
								})}</code
							>
						</div>
					</div>

					<div class="form-group form-group-full">
						<label for="description" class="form-label">{$LL.admin_saml_detail_description()}</label
						>
						<textarea
							id="description"
							bind:value={description}
							class="form-input form-textarea"
							rows="3"
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
				<h2 class="panel-title">{$LL.admin_saml_detail_saml_configuration()}</h2>

				<div class="form-grid">
					<div class="form-group form-group-full">
						<label for="entityId" class="form-label">{$LL.admin_saml_entity_id()} *</label>
						<input id="entityId" type="text" bind:value={entityId} class="form-input" />
					</div>

					{#if provider.providerType === 'saml_idp'}
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
						<label for="metadataUrl" class="form-label">{$LL.admin_saml_local_metadata_url()}</label
						>
						<input id="metadataUrl" type="url" bind:value={metadataUrl} class="form-input" />
						<p class="form-hint">
							{$LL.admin_saml_detail_metadata_source_hint()}
						</p>
					</div>

					<div class="form-group form-group-full">
						<label for="certificate" class="form-label">
							{provider.providerType === 'saml_idp'
								? $LL.admin_saml_detail_signing_certificate_required()
								: $LL.admin_saml_detail_sp_certificate()}
						</label>
						<textarea
							id="certificate"
							bind:value={certificate}
							oninput={() => {
								certificatePreview = null;
								certificatePreviewError = '';
							}}
							class="form-input form-textarea monospace"
							rows="8"
						></textarea>
						<p class="form-hint">
							{$LL.admin_saml_detail_certificate_hint()}
						</p>
						<div class="certificate-actions">
							<button
								type="button"
								class="btn btn-secondary btn-sm"
								onclick={previewCertificate}
								disabled={loadingCertificatePreview || !certificate.trim()}
							>
								{loadingCertificatePreview
									? $LL.admin_saml_detail_checking()
									: $LL.admin_saml_detail_validate_certificate()}
							</button>
						</div>
						{#if certificatePreviewError}
							<p class="form-error">{certificatePreviewError}</p>
						{/if}
						{#if certificatePreview}
							{@render certificatePreviewCard(certificatePreview)}
						{/if}
					</div>

					<div class="form-group form-group-full">
						<label for="attributeMapping" class="form-label"
							>{$LL.admin_saml_detail_attribute_mapping_json()}</label
						>
						<textarea
							id="attributeMapping"
							bind:value={attributeMappingJson}
							class="form-input form-textarea monospace"
							rows="6"
						></textarea>
					</div>
				</div>

				<div class="binding-section">
					<h3 class="section-subtitle">{$LL.admin_saml_detail_allowed_bindings()}</h3>
					<p class="form-hint">
						{$LL.admin_saml_detail_allowed_bindings_hint()}
					</p>
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
			</div>

			{#if provider.providerType === 'saml_idp'}
				<div class="panel">
					<h2 class="panel-title">{$LL.admin_saml_detail_sp_login_policy()}</h2>

					<div class="form-grid">
						<div class="form-group">
							<label for="providerName" class="form-label"
								>{$LL.admin_saml_detail_sp_display_name()}</label
							>
							<input id="providerName" type="text" bind:value={providerName} class="form-input" />
						</div>

						<div class="form-group">
							<label for="jitEmailLinkingPolicy" class="form-label"
								>{$LL.admin_saml_detail_jit_linking_policy()}</label
							>
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
							<label for="authnContextPolicyMode" class="form-label"
								>{$LL.admin_saml_detail_authn_context_policy()}</label
							>
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

			{#if provider.providerType === 'saml_sp'}
				<div class="panel">
					<h2 class="panel-title">{$LL.admin_saml_detail_sp_policy()}</h2>

					<div class="form-grid">
						<div class="form-group">
							<label for="identityMappingFieldMapping" class="form-label"
								>{$LL.admin_saml_detail_identity_mapping_policy()}</label
							>
							<select
								id="identityMappingFieldMapping"
								bind:value={identityMappingFieldMappingSetId}
								class="form-select"
							>
								<option value="">{$LL.admin_saml_detail_identity_mapping_policy_default()}</option>
								{#if selectedInactiveFieldMappingSet}
									<option value={selectedInactiveFieldMappingSet.id} disabled>
										{selectedInactiveFieldMappingSet.displayName}
										({$LL.admin_saml_detail_field_mapping_inactive()})
									</option>
								{/if}
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
							<label for="attributeReleaseConsent" class="form-label"
								>{$LL.admin_saml_detail_attribute_release_consent()}</label
							>
							<select
								id="attributeReleaseConsent"
								bind:value={attributeReleaseConsentSetting}
								class="form-select"
							>
								<option value="disabled"
									>{$LL.admin_saml_detail_attribute_release_consent_disabled()}</option
								>
								<option value="once"
									>{$LL.admin_saml_detail_attribute_release_consent_once()}</option
								>
								<option value="every_time"
									>{$LL.admin_saml_detail_attribute_release_consent_every_time()}</option
								>
								<option value="until_attributes_change"
									>{$LL.admin_saml_detail_attribute_release_consent_until_attributes_change()}</option
								>
							</select>
							<p class="field-hint">
								{$LL.admin_saml_detail_attribute_release_consent_hint()}
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
							<label for="authnContextClassRefMode" class="form-label"
								>{$LL.admin_saml_detail_authn_context_mode()}</label
							>
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
		</form>

		<div class="panel">
			<div class="panel-header">
				<div>
					<h2 class="panel-title">{$LL.admin_saml_local_signing_rollover()}</h2>
					<p class="form-hint">
						{$LL.admin_saml_detail_rollover_desc()}
					</p>
				</div>
				<div class="key-state">
					<span class:enabled={Boolean(provider.config.signingKeyPolicy?.active)}>active</span>
					<span class:enabled={Boolean(provider.config.signingKeyPolicy?.next)}>next</span>
					<span class:enabled={Boolean(provider.config.signingKeyPolicy?.backup)}>backup</span>
				</div>
			</div>

			<div class="panel-actions">
				<button
					class="btn btn-secondary"
					onclick={promoteNext}
					disabled={!provider.config.signingKeyPolicy?.next || busyAction === 'promote'}
				>
					{busyAction === 'promote'
						? $LL.admin_saml_detail_promoting()
						: $LL.admin_saml_detail_promote_next()}
				</button>
				<button
					class="btn btn-secondary"
					onclick={retireBackup}
					disabled={!provider.config.signingKeyPolicy?.backup || busyAction === 'retire'}
				>
					{busyAction === 'retire'
						? $LL.admin_saml_detail_retiring()
						: $LL.admin_saml_detail_retire_backup()}
				</button>
			</div>
		</div>

		<div class="form-actions page-bottom-actions">
			<button class="btn btn-primary" type="button" onclick={handleSave} disabled={saving}>
				{saving ? $LL.admin_saml_local_saving() : $LL.admin_saml_detail_save_changes()}
			</button>
		</div>
	{:else}
		<div class="alert alert-error">{error || $LL.admin_saml_detail_not_found()}</div>
	{/if}
</div>

<style>
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

	.inline-help {
		display: grid;
		gap: 4px;
		margin-top: 8px;
		padding: 10px 12px;
		border: 1px solid var(--color-border, #d8dde6);
		border-radius: 8px;
		background: var(--color-surface-subtle, #f8fafc);
	}

	.inline-help p {
		margin: 0;
		color: var(--color-text-muted, #657083);
		font-size: 0.8125rem;
		line-height: 1.45;
	}

	.inline-help code {
		color: var(--color-text, #111827);
		font-family: var(--font-mono);
		font-size: 0.75rem;
		overflow-wrap: anywhere;
	}

	.field-hint {
		margin: 4px 0 0;
		color: var(--text-muted, #9ca3af);
		font-size: 0.6875rem;
		line-height: 1.45;
	}

	.binding-section {
		margin-top: 16px;
	}

	.section-subtitle {
		margin: 0 0 4px;
		color: var(--color-text, #111827);
		font-size: 0.875rem;
		font-weight: 700;
	}

	.compact-checkboxes {
		padding-top: 10px;
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

	.panel-actions {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
		flex-wrap: wrap;
	}

	.page-bottom-actions {
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--color-border, #d8dde6);
		justify-content: flex-end;
	}

	.key-state {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.key-state span {
		border-radius: var(--radius-full);
		padding: 2px 10px;
		background: var(--bg-subtle);
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 500;
		opacity: 0.55;
	}

	.key-state span.enabled {
		background: var(--success-light);
		color: var(--success);
		opacity: 1;
	}
</style>
