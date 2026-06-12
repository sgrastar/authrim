<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		adminIdentityMappingAPI,
		type PersistentIdentifierProfileRequest
	} from '$lib/api/admin-identity-mapping';

	let saving = $state(false);
	let errorMessage = $state('');
	let draft = $state<PersistentIdentifierProfileRequest>({
		displayName: 'Default persistent identifier profile',
		profileKey: 'default_persistent_identifier',
		mode: 'computed',
		algorithm: 'authrim_sha256_base64url',
		protocolScope: 'any',
		usage: ['saml_edu_person_targeted_id', 'oidc_pairwise_sub'],
		audienceMode: 'runtime',
		lifecycleState: 'active'
	});
	let usageText = $state('saml_edu_person_targeted_id, oidc_pairwise_sub');

	async function createProfile() {
		saving = true;
		errorMessage = '';
		try {
			const response = await adminIdentityMappingAPI.createPersistentIdentifierProfile({
				...draft,
				usage: parseUsage(usageText)
			});
			await goto(`/admin/field-mapping/persistent-identifiers/${response.result.id}`);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to create profile';
		} finally {
			saving = false;
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
	<title>Create Persistent ID Profile - Field Mapping</title>
</svelte:head>

<div class="persistent-page">
	<div class="page-heading">
		<div>
			<a class="back-link" href="/admin/field-mapping/persistent-identifiers">Persistent IDsに戻る</a>
			<p class="eyebrow">PERSISTENT IDENTIFIER PROFILE</p>
			<h1>新しいProfileを作成</h1>
		</div>
		<button type="button" onclick={createProfile} disabled={saving}>
			{saving ? '保存中...' : '作成'}
		</button>
	</div>

	{#if errorMessage}
		<p class="message error">{errorMessage}</p>
	{/if}

	<section class="panel">
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
</div>

<style>
	.persistent-page {
		padding: 2rem;
		color: var(--text-primary);
	}

	.page-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
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

	h1 {
		margin: 0;
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

	label span {
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
		border: 1px solid var(--accent-primary);
		border-radius: 8px;
		background: var(--accent-primary);
		color: var(--text-primary);
		padding: 0.7rem 1rem;
		font-weight: 800;
		cursor: pointer;
	}
</style>
