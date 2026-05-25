<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { ToggleSwitch } from '$lib/components';
	import { onMount } from 'svelte';
	import {
		adminSAMLAPI,
		type SAMLAttributePreset,
		type SAMLProvider,
		type SAMLProviderConfig,
		type SAMLTrustCertificatePreview
	} from '$lib/api/admin-saml';
	import LoginProviderIconPicker from '$lib/components/admin/LoginProviderIconPicker.svelte';

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
	let presets = $state<SAMLAttributePreset[]>([]);
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
	let samlProfile = $state('baseline');
	let authnRequestSignaturePolicy = $state<'required' | 'optional' | 'disabled'>('optional');
	let logoutRequestSignaturePolicy = $state<'required' | 'optional' | 'disabled'>('required');
	let authnContextPolicyMode = $state<'observe' | 'require_any'>('observe');
	let allowedAuthnContextClassRefs = $state(
		'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport'
	);
	let authnContextClassRefMode = $state<'legacy_static' | 'session'>('legacy_static');
	let defaultAuthnContextClassRef = $state(
		'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport'
	);
	let passkeyAuthnContextClassRef = $state('urn:authrim:acr:phishing-resistant');
	let attributePresetId = $state('');
	let attributeMappingJson = $state('{}');
	let certificatePreview = $state<SAMLTrustCertificatePreview | null>(null);
	let certificatePreviewError = $state('');
	let loadingCertificatePreview = $state(false);

	onMount(() => {
		void loadPage();
	});

	async function loadPage() {
		if (!providerId) return;
		loading = true;
		error = '';
		try {
			const [loadedProvider, presetResult] = await Promise.all([
				adminSAMLAPI.getProvider(providerId),
				adminSAMLAPI.listAttributePresets()
			]);
			provider = loadedProvider;
			presets = presetResult.presets;
			populateForm(loadedProvider);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load SAML provider';
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
		samlProfile = data.config.samlProfile || 'baseline';
		authnRequestSignaturePolicy = data.config.authnRequestSignaturePolicy || 'optional';
		logoutRequestSignaturePolicy = data.config.logoutRequestSignaturePolicy || 'required';
		authnContextPolicyMode = data.config.authnContextPolicy?.mode || 'observe';
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
		attributePresetId = data.config.attributePresetId || '';
		attributeMappingJson = JSON.stringify(data.config.attributeMapping || {}, null, 2);
		certificatePreview = null;
		certificatePreviewError = '';
	}

	function providerTypeLabel(type: SAMLProvider['providerType']) {
		return type === 'saml_sp' ? 'Service Provider' : 'Identity Provider';
	}

	function selectedNameIdFormatInfo() {
		switch (nameIdFormat) {
			case 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress':
				return {
					description: 'Uses the user email address as the NameID value.',
					sample: 'alice@example.edu'
				};
			case 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent':
				return {
					description: 'Uses a stable opaque identifier for the subject and SP relationship.',
					sample: 'a7f62c2b-2f5f-4df8-9d1d-8c7e7b1c6c2a'
				};
			case 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient':
				return {
					description: 'Uses a short-lived opaque identifier for this SAML transaction/session.',
					sample: '_9f23b7f2d3d0476a8b98'
				};
			case 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified':
				return {
					description: 'Leaves the semantic meaning to the bilateral SP/IdP agreement.',
					sample: 'alice'
				};
			case 'urn:mace:shibboleth:1.0:nameIdentifier':
				return {
					description:
						'Legacy Shibboleth 1.x NameIdentifier format, kept only for older Shibboleth-era systems.',
					sample: 'alice@example.edu'
				};
			default:
				return {
					description: 'Custom or externally supplied NameID format.',
					sample: nameIdFormat || '-'
				};
		}
	}

	function formatCertificateDate(value: string) {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value || '-';
		return date.toLocaleString();
	}

	function providerCertificateMessage() {
		const validation = provider?.config.certificateValidation;
		if (!validation) return '';
		if (validation.allExpired) {
			return 'All configured signing certificates are expired. This provider is disabled until a valid certificate is configured.';
		}
		if (validation.hasExpired) {
			return 'One or more configured signing certificates are expired. Check rollover state and remove retired certificates when safe.';
		}
		if (validation.hasWeakSignature) {
			return 'One or more configured signing certificates use a weak signature algorithm. Keep SHA-1 only for an explicit legacy compatibility exception.';
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
		if (provider?.providerType !== 'saml_sp' || !attributePresetId) return {};
		const preset = presets.find((item) => item.id === attributePresetId);
		return {
			attributePresetId,
			attributePresetVersion: preset?.version,
			attributeReleasePolicy: preset?.attributeReleasePolicy
		};
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
				samlProfile,
				authnRequestSignaturePolicy,
				logoutRequestSignaturePolicy,
				authnContextClassRefMode,
			defaultAuthnContextClassRef: defaultAuthnContextClassRef.trim() || undefined,
			passkeyAuthnContextClassRef: passkeyAuthnContextClassRef.trim() || undefined,
			...selectedPresetConfig()
		};
	}

	function validate() {
		if (!name.trim()) return 'Name is required';
		if (!isValidLoginLogoUrl(logoUrl)) return 'Login UI logo URL must be a valid HTTPS URL';
		if (!entityId.trim()) return 'Entity ID is required';
		if (!allowPost && !allowRedirect) return 'At least one binding is required';
		if (provider?.providerType === 'saml_idp' && (!ssoUrl.trim() || !certificate.trim())) {
			return 'SSO URL and certificate are required for a SAML IdP';
		}
		if (provider?.providerType === 'saml_sp' && !acsUrl.trim()) {
			return 'ACS URL is required for a SAML SP';
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
			message = 'Provider updated';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to update provider';
		} finally {
			saving = false;
		}
	}

	async function previewCertificate() {
		if (!certificate.trim()) {
			certificatePreviewError = 'Certificate is required';
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
				err instanceof Error ? err.message : 'Failed to validate certificate';
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
			message = 'Next certificate promoted';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to promote next certificate';
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
			message = 'Backup certificate retired';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to retire backup certificate';
		} finally {
			busyAction = '';
		}
	}

	async function deleteProvider() {
		if (!providerId || !provider) return;
		if (!window.confirm(`Delete ${provider.name}?`)) return;
		busyAction = 'delete';
		error = '';
		try {
			await adminSAMLAPI.deleteProvider(providerId);
			await goto('/admin/saml');
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to delete provider';
		} finally {
			busyAction = '';
		}
	}
</script>

<svelte:head>
	<title>{provider ? provider.name : 'SAML Provider'} - Admin Dashboard - Authrim</title>
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
					{#each preview.warnings as warning (warning)}
					<div><i class="i-ph-warning-circle"></i>{warning}</div>
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

<div class="admin-page">
	<a href="/admin/saml" class="back-link">← Back to SAML</a>

	{#if loading}
		<div class="loading-state">Loading SAML provider...</div>
	{:else if provider}
		<div class="page-header">
			<div>
				<h1 class="page-title">{provider.name}</h1>
				<p class="page-description">{providerTypeLabel(provider.providerType)}</p>
			</div>
			<div class="page-actions">
				<button class="btn btn-danger" onclick={deleteProvider} disabled={busyAction === 'delete'}>
					Delete
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
					label="Provider Status"
					description="Enable or disable this SAML provider."
				/>
			</div>

			<div class="panel">
				<h2 class="panel-title">Basic Information</h2>

				<div class="form-grid">
					<div class="form-group">
						<label for="name" class="form-label">Name *</label>
						<input id="name" type="text" bind:value={name} class="form-input" required />
					</div>

					<div class="form-group">
						<label for="nameIdFormat" class="form-label">NameID Format</label>
						<select id="nameIdFormat" bind:value={nameIdFormat} class="form-select">
							{#each nameIdFormats as format (format.value)}
								<option value={format.value}>{format.label}</option>
							{/each}
						</select>
						<div class="inline-help">
							<p>{selectedNameIdFormatInfo().description}</p>
							<code>Example: {selectedNameIdFormatInfo().sample}</code>
						</div>
					</div>

					<div class="form-group form-group-full">
						<label for="description" class="form-label">Description</label>
						<textarea
							id="description"
							bind:value={description}
							class="form-input form-textarea"
							rows="3"
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

					<div class="form-group form-group-full">
						<LoginProviderIconPicker
							bind:value={iconName}
							defaultIcon="buildings"
							defaultLabel="Default SAML icon"
							description="Used when Login UI Logo URL is empty."
						/>
					</div>
				</div>
			</div>

			<div class="panel">
				<h2 class="panel-title">SAML Configuration</h2>

				<div class="form-grid">
					<div class="form-group form-group-full">
						<label for="entityId" class="form-label">Entity ID *</label>
						<input id="entityId" type="text" bind:value={entityId} class="form-input" />
					</div>

					{#if provider.providerType === 'saml_idp'}
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
						<label for="metadataUrl" class="form-label">Metadata URL</label>
						<input id="metadataUrl" type="url" bind:value={metadataUrl} class="form-input" />
						<p class="form-hint">
							Stored metadata source URL. Aggregate or multi-entity metadata should be handled from
							Add Provider/Federation.
						</p>
					</div>

					<div class="form-group form-group-full">
						<label for="certificate" class="form-label">
							{provider.providerType === 'saml_idp' ? 'Signing Certificate *' : 'SP Certificate'}
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
							Accepts X.509 certificates in PEM or base64 DER form. Metadata import usually fills
							this automatically.
						</p>
						<div class="certificate-actions">
							<button
								type="button"
								class="btn btn-secondary btn-sm"
								onclick={previewCertificate}
								disabled={loadingCertificatePreview || !certificate.trim()}
							>
								{loadingCertificatePreview ? 'Checking...' : 'Validate Certificate'}
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
						<label for="attributeMapping" class="form-label">Attribute Mapping JSON</label>
						<textarea
							id="attributeMapping"
							bind:value={attributeMappingJson}
							class="form-input form-textarea monospace"
							rows="6"
						></textarea>
					</div>
				</div>

				<div class="binding-section">
					<h3 class="section-subtitle">Allowed SAML Bindings</h3>
					<p class="form-hint">
						Controls which SAML protocol bindings this provider may use for SSO/SLO messages.
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
					<h2 class="panel-title">SP Login Policy</h2>

					<div class="form-grid">
						<div class="form-group">
							<label for="providerName" class="form-label">SP Display Name</label>
							<input id="providerName" type="text" bind:value={providerName} class="form-input" />
						</div>

							<div class="form-group">
								<label for="logoutRequestSignaturePolicy" class="form-label">
									IdP LogoutRequest Signature
								</label>
								<select
									id="logoutRequestSignaturePolicy"
									bind:value={logoutRequestSignaturePolicy}
									class="form-select"
								>
									<option value="required">Required</option>
									<option value="optional">Optional</option>
									<option value="disabled">Disabled</option>
								</select>
								<p class="field-hint">
									Required by default. Use Optional or Disabled only for explicit legacy IdP
									compatibility.
								</p>
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

			{#if provider.providerType === 'saml_sp'}
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
							<select id="attributePreset" bind:value={attributePresetId} class="form-select">
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
								<label for="spLogoutRequestSignaturePolicy" class="form-label">
									LogoutRequest Signature
								</label>
								<select
									id="spLogoutRequestSignaturePolicy"
									bind:value={logoutRequestSignaturePolicy}
									class="form-select"
								>
									<option value="required">Required</option>
									<option value="optional">Optional</option>
									<option value="disabled">Disabled</option>
								</select>
								<p class="field-hint">
									Required by default. Relax only for an explicit legacy SP exception.
								</p>
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
							<label for="defaultAuthnContextClassRef" class="form-label">
								Default AuthnContext
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
								Passkey AuthnContext
							</label>
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
		</form>

		<div class="panel">
			<div class="panel-header">
				<div>
					<h2 class="panel-title">Signing Rollover</h2>
					<p class="form-hint">
						Manage staged signing certificates. Publish next/backup certificates in metadata, then
						promote next after counterparties have refreshed trust.
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
					{busyAction === 'promote' ? 'Promoting...' : 'Promote Next'}
				</button>
				<button
					class="btn btn-secondary"
					onclick={retireBackup}
					disabled={!provider.config.signingKeyPolicy?.backup || busyAction === 'retire'}
				>
					{busyAction === 'retire' ? 'Retiring...' : 'Retire Backup'}
				</button>
			</div>
		</div>

		<div class="form-actions page-bottom-actions">
			<button class="btn btn-primary" type="button" onclick={handleSave} disabled={saving}>
				{saving ? 'Saving...' : 'Save Changes'}
			</button>
		</div>
	{:else}
		<div class="alert alert-error">{error || 'SAML provider not found'}</div>
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
