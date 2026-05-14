<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { ToggleSwitch } from '$lib/components';
	import {
		adminSAMLAPI,
		type CreateSAMLProviderRequest,
		type SAMLAttributePreset,
		type SAMLProvider,
		type SAMLProviderConfig
	} from '$lib/api/admin-saml';
	import { onMount } from 'svelte';

	type SetupMode = 'metadata_url' | 'metadata_xml' | 'manual';

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
		}
	];

	let presets = $state<SAMLAttributePreset[]>([]);
	let providerType = $state<SAMLProvider['providerType']>('saml_idp');
	let setupMode = $state<SetupMode>('manual');
	let name = $state('');
	let description = $state('');
	let enabled = $state(true);
	let metadataUrl = $state('');
	let metadataXml = $state('');
	let providerName = $state('Authrim');
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
	let metadataImportMessage = $state('');
	let metadataImportError = $state('');
	let lastImportedMetadataUrl = $state('');
	let saving = $state(false);
	let error = $state('');
	let metadataImportTimer: ReturnType<typeof setTimeout> | undefined;

	onMount(() => {
		const requestedType = $page.url.searchParams.get('type');
		providerType = requestedType === 'sp' ? 'saml_sp' : 'saml_idp';
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
		error = '';

		try {
			const preview = await adminSAMLAPI.previewMetadata({
				metadataUrl: metadataUrl.trim(),
				samlProfile,
				attributePresetId: attributePresetId || undefined
			});
			providerType = preview.providerType;
			setupMode = 'manual';
			applyPreviewConfig(preview.config);
			metadataImported = true;
			lastImportedMetadataUrl = metadataUrl.trim();
			metadataImportMessage =
				preview.providerType === 'saml_sp'
					? 'SP metadata imported. Authrim will act as IdP for this provider.'
					: 'IdP metadata imported. Authrim will act as SP for this provider.';
		} catch (err) {
			metadataImported = false;
			metadataImportError = err instanceof Error ? err.message : 'Failed to import SAML metadata';
		} finally {
			importingMetadata = false;
		}
	}

	function handleMetadataUrlInput() {
		metadataImported = false;
		lastImportedMetadataUrl = '';
		metadataImportMessage = '';
		metadataImportError = '';
	}

	function validate() {
		if (!name.trim()) return 'Name is required';
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
		const validationError = validate();
		if (validationError) {
			error = validationError;
			return;
		}

		saving = true;
		error = '';

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
			await goto(`/admin/saml/${provider.id}`);
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
	<title>New SAML Provider - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<a href="/admin/saml" class="back-link">← Back to SAML</a>

	<h1 class="page-title">Add SAML Provider</h1>

	<form
		onsubmit={(event) => {
			event.preventDefault();
			void handleSubmit();
		}}
	>
		{#if error}
			<div class="alert alert-error">{error}</div>
		{/if}

		<div class="panel">
			<h2 class="panel-title">SAML Configuration</h2>
			<p class="form-hint panel-hint">
				Import metadata first to detect whether the counterparty is an IdP or SP and fill the form.
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
					{importingMetadata ? 'Importing...' : 'Import Metadata'}
				</button>
			</div>

			{#if metadataImportError}
				<p class="form-error">{metadataImportError}</p>
			{:else if metadataImportMessage}
				<p class="form-success">{metadataImportMessage}</p>
			{:else}
				<p class="form-hint">
					SP metadata will select Service Provider. IdP metadata will select Identity Provider.
				</p>
			{/if}
		</div>

		<div class="panel">
			<h2 class="panel-title">Choose Provider Type</h2>
			<p class="form-hint panel-hint">
				Choose IdP when Authrim accepts SAML login, or SP when Authrim issues SAML assertions.
			</p>

			<div class="template-grid saml-choice-grid">
				<button
					type="button"
					class="template-card"
					class:template-card-selected={providerType === 'saml_idp'}
					onclick={() => (providerType = 'saml_idp')}
				>
					<div class="i-ph-identification-card h-5 w-5 template-icon"></div>
					<div class="template-name">Identity Provider</div>
					<div class="template-desc">External login</div>
				</button>

				<button
					type="button"
					class="template-card"
					class:template-card-selected={providerType === 'saml_sp'}
					onclick={() => (providerType = 'saml_sp')}
				>
					<div class="i-ph-app-window h-5 w-5 template-icon"></div>
					<div class="template-name">Service Provider</div>
					<div class="template-desc">Authrim as IdP</div>
				</button>
			</div>
		</div>

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
						{#each nameIdFormats as format}
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
			</div>
		</div>

		<div class="panel">
			<ToggleSwitch
				bind:checked={enabled}
				label="Provider Status"
				description="Enable or disable this SAML provider."
			/>
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
						class="form-input form-textarea monospace"
						rows="12"
					></textarea>
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
							class="form-input form-textarea monospace"
							rows="8"
							placeholder="-----BEGIN CERTIFICATE-----"
						></textarea>
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
							{#each presets as preset}
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
						<label for="defaultAuthnContextClassRef" class="form-label">Default AuthnContext</label>
						<input
							id="defaultAuthnContextClassRef"
							type="text"
							bind:value={defaultAuthnContextClassRef}
							class="form-input"
						/>
					</div>

					<div class="form-group">
						<label for="passkeyAuthnContextClassRef" class="form-label">Passkey AuthnContext</label>
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

		<div class="form-actions">
			<button type="button" class="btn btn-secondary" onclick={navigateBack}>Cancel</button>
			<button type="submit" class="btn btn-primary" disabled={saving}>
				{saving ? 'Creating...' : 'Create Provider'}
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
		min-height: 44px;
		white-space: nowrap;
	}

	.form-success {
		margin: 8px 0 0;
		color: var(--color-success, #22c55e);
		font-size: 0.875rem;
	}

	.saml-choice-grid {
		grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
	}

	.form-textarea {
		min-height: auto;
		resize: vertical;
		line-height: 1.45;
	}

	.monospace {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
	}

	.compact-checkboxes {
		padding-top: 4px;
	}

	@media (max-width: 720px) {
		.metadata-import-row {
			grid-template-columns: 1fr;
		}

		.metadata-import-button {
			width: 100%;
		}
	}
</style>
