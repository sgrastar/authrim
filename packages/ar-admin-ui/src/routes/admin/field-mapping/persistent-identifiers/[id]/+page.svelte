<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import {
		adminIdentityMappingAPI,
		type PersistentIdentifierProfileRequest,
		type PersistentIdentifierProfileSummary,
		type PersistentIdentifierPreviewResult
	} from '$lib/api/admin-identity-mapping';

	const profileId = $derived($page.params.id ?? '');

	let loading = $state(true);
	let saving = $state(false);
	let previewing = $state(false);
	let errorMessage = $state('');
	let successMessage = $state('');
	let profile = $state<PersistentIdentifierProfileSummary | null>(null);
	let previewResult = $state<PersistentIdentifierPreviewResult | null>(null);
	let previewSubject = $state('user-12345');
	let previewAudience = $state('https://sp.example.edu/shibboleth-sp');
	let previewIssuer = $state('https://idp.example.edu/idp/shibboleth');
	let usageText = $state('');
	let draft = $state<PersistentIdentifierProfileRequest>({
		displayName: '',
		profileKey: '',
		mode: 'computed',
		algorithm: 'authrim_sha256_base64url',
		protocolScope: 'any',
		usage: [],
		audienceMode: 'runtime',
		lifecycleState: 'active'
	});

	onMount(() => {
		void loadProfile();
	});

	async function loadProfile() {
		loading = true;
		errorMessage = '';
		try {
			const response = await adminIdentityMappingAPI.getPersistentIdentifierProfile(profileId);
			profile = response.result;
			draft = {
				displayName: response.result.displayName,
				profileKey: response.result.profileKey,
				description: response.result.description,
				mode: response.result.mode,
				algorithm: response.result.algorithm,
				protocolScope: response.result.protocolScope,
				usage: response.result.usage,
				sourceRef: response.result.sourceRef,
				secretRef: response.result.secretRef,
				issuerEntityId: response.result.issuerEntityId,
				audienceMode: response.result.audienceMode,
				format: response.result.format,
				lifecycleState: response.result.lifecycleState
			};
			usageText = response.result.usage.join(', ');
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to load profile';
		} finally {
			loading = false;
		}
	}

	async function saveProfile() {
		saving = true;
		errorMessage = '';
		successMessage = '';
		try {
			const response = await adminIdentityMappingAPI.updatePersistentIdentifierProfile(profileId, {
				...draft,
				usage: parseUsage(usageText)
			});
			profile = response.result;
			successMessage = 'Persistent Identifier Profileを保存しました。';
			usageText = response.result.usage.join(', ');
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to save profile';
		} finally {
			saving = false;
		}
	}

	async function deleteProfile() {
		saving = true;
		errorMessage = '';
		successMessage = '';
		try {
			await adminIdentityMappingAPI.deletePersistentIdentifierProfile(profileId);
			await goto('/admin/field-mapping/persistent-identifiers');
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to delete profile';
		} finally {
			saving = false;
		}
	}

	async function previewProfile() {
		previewing = true;
		errorMessage = '';
		previewResult = null;
		try {
			const response = await adminIdentityMappingAPI.previewPersistentIdentifier({
				profileId,
				subject: previewSubject,
				audience: previewAudience,
				issuerEntityId: previewIssuer
			});
			previewResult = response.result;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to preview identifier';
		} finally {
			previewing = false;
		}
	}

	function parseUsage(value: string): string[] {
		return Array.from(
			new Set(
				value
					.split(',')
					.map((item) => item.trim())
					.filter(Boolean)
			)
		);
	}
</script>

<svelte:head>
	<title>Persistent ID Profile - Field Mapping</title>
</svelte:head>

<div class="persistent-page">
	<div class="page-heading">
		<div>
			<a class="back-link" href="/admin/field-mapping/persistent-identifiers">Persistent IDsに戻る</a>
			<p class="eyebrow">PERSISTENT IDENTIFIER PROFILE</p>
			<h1>{profile?.displayName ?? 'Profile detail'}</h1>
		</div>
		<div class="heading-actions">
			<button type="button" onclick={loadProfile} disabled={loading}>更新</button>
			<button type="button" class="danger" onclick={deleteProfile} disabled={saving || loading}>
				削除
			</button>
			<button type="button" class="primary" onclick={saveProfile} disabled={saving || loading}>
				{saving ? '保存中...' : '保存'}
			</button>
		</div>
	</div>

	{#if errorMessage}
		<p class="message error">{errorMessage}</p>
	{/if}
	{#if successMessage}
		<p class="message success">{successMessage}</p>
	{/if}

	{#if loading}
		<section class="panel">Loading...</section>
	{:else}
		<div class="layout">
			<section class="panel">
				<div class="panel-heading">
					<div>
						<p class="eyebrow">SETTINGS</p>
						<h2>Profile settings</h2>
					</div>
					<span class="state">{draft.lifecycleState}</span>
				</div>
				<div class="form-grid">
					<label>
						<span>Display name</span>
						<input bind:value={draft.displayName} />
					</label>
					<label>
						<span>Profile key</span>
						<input bind:value={draft.profileKey} />
					</label>
					<label>
						<span>Protocol scope</span>
						<select bind:value={draft.protocolScope}>
							<option value="any">any</option>
							<option value="saml">saml</option>
							<option value="oidc">oidc</option>
							<option value="generic">generic</option>
						</select>
					</label>
					<label>
						<span>Algorithm</span>
						<select bind:value={draft.algorithm}>
							<option value="authrim_sha256_base64url">authrim_sha256_base64url</option>
							<option value="shibboleth_sha1_base64">shibboleth_sha1_base64</option>
						</select>
					</label>
					<label>
						<span>Audience mode</span>
						<select bind:value={draft.audienceMode}>
							<option value="runtime">runtime</option>
							<option value="saml_sp_entity_id">saml_sp_entity_id</option>
							<option value="oidc_sector_identifier">oidc_sector_identifier</option>
						</select>
					</label>
					<label>
						<span>Lifecycle state</span>
						<select bind:value={draft.lifecycleState}>
							<option value="active">active</option>
							<option value="draft">draft</option>
							<option value="disabled">disabled</option>
						</select>
					</label>
					<label>
						<span>Secret ref</span>
						<input bind:value={draft.secretRef} />
					</label>
					<label>
						<span>Issuer entityID</span>
						<input bind:value={draft.issuerEntityId} />
					</label>
					<label class="wide">
						<span>Usage</span>
						<input bind:value={usageText} />
					</label>
					<label class="wide">
						<span>Description</span>
						<textarea bind:value={draft.description}></textarea>
					</label>
				</div>
			</section>

			<section class="panel">
				<div class="panel-heading">
					<div>
						<p class="eyebrow">PREVIEW</p>
						<h2>Identifier preview</h2>
					</div>
				</div>
				<div class="form-grid">
					<label>
						<span>Subject</span>
						<input bind:value={previewSubject} />
					</label>
					<label>
						<span>Audience / SP entityID / sector</span>
						<input bind:value={previewAudience} />
					</label>
					<label class="wide">
						<span>Issuer / IdP entityID</span>
						<input bind:value={previewIssuer} />
					</label>
				</div>
				<div class="preview-actions">
					<button type="button" onclick={previewProfile} disabled={previewing}>
						{previewing ? 'Previewing...' : 'Preview'}
					</button>
				</div>
				{#if previewResult}
					<div class="preview-output">
						<div>
							<span>Opaque identifier</span>
							<code>{previewResult.opaque}</code>
						</div>
						<div>
							<span>SAML AttributeValue</span>
							<code>{previewResult.samlAttributeValue ?? 'Issuer entityID is not configured'}</code>
						</div>
						<div>
							<span>OIDC pairwise sub</span>
							<code>{previewResult.oidcPairwiseSub}</code>
						</div>
					</div>
				{/if}
			</section>
		</div>
	{/if}
</div>

<style>
	.persistent-page {
		padding: 2rem;
		color: var(--text-primary);
	}

	.page-heading,
	.panel-heading,
	.heading-actions {
		display: flex;
		gap: 1rem;
		align-items: flex-start;
		justify-content: space-between;
	}

	.heading-actions {
		align-items: center;
	}

	.page-heading {
		margin-bottom: 1.5rem;
	}

	.back-link {
		color: inherit;
		text-decoration: none;
	}

	.eyebrow {
		margin: 0 0 0.35rem;
		color: var(--text-muted);
		font-size: 0.72rem;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}

	h1,
	h2 {
		margin: 0;
	}

	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1.25fr) minmax(22rem, 0.75fr);
		gap: 1rem;
	}

	.panel,
	.message {
		border: 1px solid var(--border-muted);
		border-radius: 8px;
		background: var(--surface-panel);
		padding: 1rem;
	}

	.message.error {
		border-color: var(--color-danger);
		color: var(--color-danger);
	}

	.message.success {
		border-color: var(--color-success);
		color: var(--color-success);
	}

	.form-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
	}

	label {
		display: grid;
		gap: 0.35rem;
	}

	label.wide {
		grid-column: 1 / -1;
	}

	label span,
	.preview-output span {
		color: var(--text-muted);
		font-size: 0.75rem;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	input,
	select,
	textarea {
		width: 100%;
		border: 1px solid var(--border-muted);
		border-radius: 8px;
		background: var(--surface-subtle);
		color: var(--text-primary);
		padding: 0.7rem;
	}

	textarea {
		min-height: 6rem;
	}

	button {
		border: 1px solid var(--border-muted);
		border-radius: 8px;
		background: var(--surface-subtle);
		color: var(--text-primary);
		padding: 0.7rem 1rem;
		font-weight: 800;
		cursor: pointer;
	}

	button.primary {
		border-color: var(--accent-primary);
		background: var(--accent-primary);
	}

	button.danger {
		border-color: var(--color-danger);
		color: var(--color-danger);
	}

	.state {
		border-radius: 999px;
		background: var(--surface-subtle);
		color: var(--text-secondary);
		padding: 0.25rem 0.6rem;
		font-size: 0.8rem;
		font-weight: 800;
	}

	.preview-actions,
	.preview-output {
		margin-top: 1rem;
	}

	.preview-output {
		display: grid;
		gap: 0.75rem;
	}

	.preview-output div {
		display: grid;
		gap: 0.35rem;
	}

	code {
		overflow-wrap: anywhere;
		border-radius: 8px;
		background: var(--surface-subtle);
		padding: 0.7rem;
	}

	@media (max-width: 920px) {
		.layout,
		.form-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
