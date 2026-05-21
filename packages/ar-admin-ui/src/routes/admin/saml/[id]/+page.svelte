<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { ToggleSwitch } from '$lib/components';
	import { onMount } from 'svelte';
	import {
		adminSAMLAPI,
		type SAMLAttributePreset,
		type SAMLProvider,
		type SAMLProviderConfig
	} from '$lib/api/admin-saml';

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
	let importMode = $state<'url' | 'xml'>('url');
	let importMetadataUrl = $state('');
	let importMetadataXml = $state('');

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
		importMetadataUrl = data.config.metadataUrl || '';
		providerName = data.config.providerName || 'Authrim';
		logoUrl = data.config.logoUrl || '';
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
	}

	function providerTypeLabel(type: SAMLProvider['providerType']) {
		return type === 'saml_sp' ? 'Service Provider' : 'Identity Provider';
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

	async function importMetadata() {
		if (!providerId) return;
		if (importMode === 'url' && !importMetadataUrl.trim()) {
			error = 'Metadata URL is required';
			return;
		}
		if (importMode === 'xml' && !importMetadataXml.trim()) {
			error = 'Metadata XML is required';
			return;
		}

		busyAction = 'import';
		error = '';
		message = '';
		try {
			const result = await adminSAMLAPI.importMetadata(providerId, {
				metadataUrl: importMode === 'url' ? importMetadataUrl.trim() : undefined,
				metadataXml: importMode === 'xml' ? importMetadataXml.trim() : undefined,
				samlProfile: provider?.providerType === 'saml_sp' ? samlProfile : undefined,
				attributePresetId:
					provider?.providerType === 'saml_sp' ? attributePresetId || undefined : undefined
			});
			if (provider) {
				provider = { ...provider, config: result.config };
				populateForm(provider);
			}
			message = 'Metadata imported';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to import metadata';
		} finally {
			busyAction = '';
		}
	}

	async function refreshMetadata() {
		if (!providerId || !provider) return;
		busyAction = 'refresh';
		error = '';
		message = '';
		try {
			const result = await adminSAMLAPI.refreshMetadata(providerId);
			provider = { ...provider, config: result.config };
			populateForm(provider);
			message = result.expired
				? 'Metadata refreshed; current metadata is expired'
				: `Metadata refreshed; ${result.changed ? 'changes detected' : 'no changes'}`;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to refresh metadata';
		} finally {
			busyAction = '';
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
						<p class="form-hint">Used by Refresh URL when metadata is published remotely.</p>
					</div>

					<div class="form-group form-group-full">
						<label for="certificate" class="form-label">
							{provider.providerType === 'saml_idp' ? 'Signing Certificate *' : 'SP Certificate'}
						</label>
						<textarea
							id="certificate"
							bind:value={certificate}
							class="form-input form-textarea monospace"
							rows="8"
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

			<div class="form-actions">
				<button class="btn btn-primary" type="submit" disabled={saving}>
					{saving ? 'Saving...' : 'Save Changes'}
				</button>
			</div>
		</form>

		<div class="panel">
			<h2 class="panel-title">Metadata Import</h2>
			<p class="form-hint panel-hint">
				Import updated metadata from the counterparty. This overwrites endpoint and certificate
				fields discovered from metadata.
			</p>

			<div class="template-grid metadata-choice-grid">
				<button
					type="button"
					class="template-card"
					class:template-card-selected={importMode === 'url'}
					onclick={() => (importMode = 'url')}
				>
					<div class="i-ph-link h-5 w-5 template-icon"></div>
					<div class="template-name">URL</div>
					<div class="template-desc">Fetch metadata</div>
				</button>
				<button
					type="button"
					class="template-card"
					class:template-card-selected={importMode === 'xml'}
					onclick={() => (importMode = 'xml')}
				>
					<div class="i-ph-file-code h-5 w-5 template-icon"></div>
					<div class="template-name">XML</div>
					<div class="template-desc">Paste metadata</div>
				</button>
			</div>

			{#if importMode === 'url'}
				<div class="form-group metadata-input">
					<label for="importMetadataUrl" class="form-label">Metadata URL</label>
					<input
						id="importMetadataUrl"
						type="url"
						bind:value={importMetadataUrl}
						class="form-input"
					/>
				</div>
			{:else}
				<div class="form-group metadata-input">
					<label for="importMetadataXml" class="form-label">Metadata XML</label>
					<textarea
						id="importMetadataXml"
						bind:value={importMetadataXml}
						class="form-input form-textarea monospace"
						rows="10"
					></textarea>
				</div>
			{/if}

			<div class="panel-actions">
				<button
					class="btn btn-secondary"
					onclick={importMetadata}
					disabled={busyAction === 'import'}
				>
					{busyAction === 'import' ? 'Importing...' : 'Import Metadata'}
				</button>
				<button
					class="btn btn-secondary"
					onclick={refreshMetadata}
					disabled={!provider.config.metadataUrl || busyAction === 'refresh'}
				>
					{busyAction === 'refresh' ? 'Refreshing...' : 'Refresh URL'}
				</button>
			</div>
		</div>

		<div class="panel">
			<div class="panel-header">
				<h2 class="panel-title">Signing Rollover</h2>
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
	{:else}
		<div class="alert alert-error">{error || 'SAML provider not found'}</div>
	{/if}
</div>

<style>
	.panel-hint {
		margin-bottom: 16px;
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

	.metadata-choice-grid {
		grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
		margin-bottom: 16px;
	}

	.metadata-input {
		margin-top: 16px;
	}

	.panel-actions {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
		flex-wrap: wrap;
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
