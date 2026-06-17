<script lang="ts">
	import { goto } from '$app/navigation';
	import { LL } from '$i18n/i18n-svelte';
	import {
		adminIdentityMappingAPI,
		type PersistentIdentifierAlgorithm,
		type PersistentIdentifierAudienceMode,
		type PersistentIdentifierMode,
		type PersistentIdentifierProtocolScope
	} from '$lib/api/admin-identity-mapping';
	import { AdminPageHeader, AdminPageShell, AdminSection } from '$lib/components/admin';

	let displayName = $state('');
	let profileKey = $state('');
	let description = $state('');
	let mode = $state<PersistentIdentifierMode>('computed');
	let algorithm = $state<PersistentIdentifierAlgorithm>('authrim_sha256_base64url');
	let protocolScope = $state<PersistentIdentifierProtocolScope>('any');
	let audienceMode = $state<PersistentIdentifierAudienceMode>('runtime');
	let usage = $state('oidc_pairwise_sub,saml_edu_person_targeted_id');
	let issuerEntityId = $state('');
	let secretRef = $state('');
	let saving = $state(false);
	let message = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);

	async function saveProfile() {
		saving = true;
		message = null;
		errorMessage = null;
		try {
			await adminIdentityMappingAPI.createPersistentIdentifierProfile({
				displayName,
				profileKey,
				description: description || null,
				mode,
				algorithm,
				protocolScope,
				audienceMode,
				usage: usage
					.split(',')
					.map((item) => item.trim())
					.filter(Boolean),
				issuerEntityId: issuerEntityId || null,
				secretRef: secretRef || null,
				lifecycleState: 'active'
			});
			message = $LL.admin_identity_mapping_persistent_saved();
			await goto('/admin/field-mapping/persistent-identifiers');
		} catch (error) {
			errorMessage =
				error instanceof Error
					? error.message
					: $LL.admin_identity_mapping_persistent_save_failed();
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_identity_mapping_persistent_create_title()}</title>
</svelte:head>

<AdminPageShell width="narrow">
	<AdminPageHeader
		eyebrow={$LL.admin_identity_mapping_title()}
		title={$LL.admin_identity_mapping_persistent_create_title()}
		description={$LL.admin_identity_mapping_persistent_description()}
	/>

	<AdminSection>
		<form
			class="persistent-form"
			onsubmit={(event) => {
				event.preventDefault();
				void saveProfile();
			}}
		>
			<label>
				<span>{$LL.admin_identity_mapping_persistent_display_name()}</span>
				<input bind:value={displayName} required />
			</label>
			<label>
				<span>{$LL.admin_identity_mapping_persistent_profile_key()}</span>
				<input bind:value={profileKey} required />
			</label>
			<label>
				<span>{$LL.admin_identity_mapping_persistent_description_label()}</span>
				<textarea bind:value={description}></textarea>
			</label>
			<div class="form-grid">
				<label>
					<span>{$LL.admin_identity_mapping_persistent_mode()}</span>
					<select bind:value={mode}>
						<option value="computed">computed</option>
						<option value="stored">stored</option>
						<option value="imported">imported</option>
					</select>
				</label>
				<label>
					<span>{$LL.admin_identity_mapping_persistent_algorithm()}</span>
					<select bind:value={algorithm}>
						<option value="authrim_sha256_base64url">authrim_sha256_base64url</option>
						<option value="shibboleth_sha1_base64">shibboleth_sha1_base64</option>
						<option value="stored">stored</option>
						<option value="imported">imported</option>
					</select>
				</label>
				<label>
					<span>{$LL.admin_identity_mapping_persistent_protocol_scope()}</span>
					<select bind:value={protocolScope}>
						<option value="any">any</option>
						<option value="oidc">oidc</option>
						<option value="saml">saml</option>
						<option value="generic">generic</option>
					</select>
				</label>
				<label>
					<span>{$LL.admin_identity_mapping_persistent_audience()}</span>
					<select bind:value={audienceMode}>
						<option value="runtime">runtime</option>
						<option value="saml_sp_entity_id">saml_sp_entity_id</option>
						<option value="oidc_sector_identifier">oidc_sector_identifier</option>
					</select>
				</label>
			</div>
			<label>
				<span>{$LL.admin_identity_mapping_persistent_usage()}</span>
				<input bind:value={usage} />
			</label>
			<label>
				<span>{$LL.admin_identity_mapping_persistent_issuer()}</span>
				<input bind:value={issuerEntityId} />
			</label>
			<label>
				<span>{$LL.admin_identity_mapping_persistent_secret_ref()}</span>
				<input bind:value={secretRef} />
			</label>

			{#if message}<p class="form-message">{message}</p>{/if}
			{#if errorMessage}<p class="form-message error">{errorMessage}</p>{/if}

			<div class="form-actions">
				<a href="/admin/field-mapping/persistent-identifiers">{$LL.admin_identity_mapping_back()}</a
				>
				<button type="submit" disabled={saving}>
					{saving
						? $LL.admin_identity_mapping_persistent_saving()
						: $LL.admin_identity_mapping_persistent_save()}
				</button>
			</div>
		</form>
	</AdminSection>
</AdminPageShell>

<style>
	.persistent-form,
	.form-grid {
		display: grid;
		gap: 14px;
	}

	.form-grid {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	label {
		display: grid;
		gap: 6px;
		color: var(--color-text);
		font-weight: 700;
	}

	label span {
		color: var(--color-text-muted);
		font-size: 0.78rem;
	}

	input,
	select,
	textarea {
		width: 100%;
		border: 1px solid var(--color-border);
		border-radius: var(--input-radius, 8px);
		background: var(--input-bg, var(--color-surface));
		color: var(--color-text);
		padding: 0.72rem 0.85rem;
		font: inherit;
	}

	textarea {
		min-height: 92px;
		resize: vertical;
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		align-items: center;
	}

	.form-actions a,
	button {
		border: 1px solid var(--button-border, var(--color-border));
		border-radius: var(--button-radius, 8px);
		background: var(--button-secondary-bg, var(--color-surface));
		color: var(--button-secondary-color, var(--color-text));
		padding: 0.65rem 0.95rem;
		font: inherit;
		font-weight: 700;
		text-decoration: none;
	}

	button {
		background: var(--button-primary-bg, var(--color-accent));
		border-color: var(--button-primary-border, var(--color-accent));
		color: var(--button-primary-color, #fff);
		cursor: pointer;
	}

	.form-message {
		margin: 0;
		color: var(--color-success);
	}

	.form-message.error {
		color: var(--color-danger);
	}

	@media (max-width: 720px) {
		.form-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
