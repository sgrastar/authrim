<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingExternalSchemaSummary,
		type IdentityMappingProtocolSchemaSummary,
		type IdentityMappingTemplateSummary
	} from '$lib/api/admin-identity-mapping';
	import {
		createDestinationConsentSettingsDraft,
		summarizeDestinationConsentSettings,
		type DestinationConsentSettingsDraft
	} from '$lib/admin/identity-mapping-profile-settings';

	type ProfileKind = 'inbound' | 'outbound' | 'template';

	interface ProfileItem {
		id: string;
		kind: ProfileKind;
		protocol: string;
		displayName: string;
		versionLabel: string;
		lifecycleState: string;
		source: string;
	}

	let profiles = $state<ProfileItem[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let activeKind = $state<ProfileKind | 'all'>('all');
	let selectedProfileId = $state<string | null>(null);
	let consentDrafts = $state<Record<string, DestinationConsentSettingsDraft>>({});
	const profileKinds: Array<ProfileKind | 'all'> = ['all', 'inbound', 'outbound', 'template'];

	onMount(() => {
		void loadProfiles();
	});

	async function loadProfiles() {
		loading = true;
		errorMessage = null;
		try {
			const [protocolSchemas, externalSchemas, templates] = await Promise.all([
				adminIdentityMappingAPI.listProtocolSchemas(),
				adminIdentityMappingAPI.listExternalSchemas(),
				adminIdentityMappingAPI.listTemplates()
			]);
			const loadedProfiles = [
				...protocolSchemas.protocolSchemas.map(protocolSchemaToProfile),
				...externalSchemas.externalSchemas.map(externalSchemaToProfile),
				...templates.templates.map(templateToProfile)
			];
			profiles = loadedProfiles;
			const firstOutbound = loadedProfiles.find((profile) => profile.kind === 'outbound');
			if (!selectedProfileId && firstOutbound) {
				selectConsentProfile(firstOutbound);
			}
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to load mapping profiles';
		} finally {
			loading = false;
		}
	}

	const visibleProfiles = $derived(
		activeKind === 'all' ? profiles : profiles.filter((profile) => profile.kind === activeKind)
	);
	const selectedProfile = $derived(
		profiles.find((profile) => profile.id === selectedProfileId) ?? null
	);
	const selectedConsentDraft = $derived(
		selectedProfileId ? (consentDrafts[selectedProfileId] ?? null) : null
	);
	const inboundCount = $derived(profiles.filter((profile) => profile.kind === 'inbound').length);
	const outboundCount = $derived(profiles.filter((profile) => profile.kind === 'outbound').length);

	function selectConsentProfile(profile: ProfileItem) {
		if (profile.kind !== 'outbound') return;
		const existingDraft = consentDrafts[profile.id];
		selectedProfileId = profile.id;
		if (!existingDraft) {
			consentDrafts = {
				...consentDrafts,
				[profile.id]: createDestinationConsentSettingsDraft(profile.id)
			};
		}
	}

	function updateSelectedConsentDraft(patch: Partial<DestinationConsentSettingsDraft>) {
		if (!selectedProfileId || !selectedConsentDraft) return;
		consentDrafts = {
			...consentDrafts,
			[selectedProfileId]: {
				...selectedConsentDraft,
				...patch
			}
		};
	}

	function getInputValue(event: Event): string {
		return event.currentTarget instanceof HTMLInputElement ||
			event.currentTarget instanceof HTMLSelectElement
			? event.currentTarget.value
			: '';
	}

	function protocolSchemaToProfile(schema: IdentityMappingProtocolSchemaSummary): ProfileItem {
		return {
			id: schema.id,
			kind: ['saml', 'oidc'].includes(schema.protocol.toLowerCase()) ? 'outbound' : 'inbound',
			protocol: schema.protocol,
			displayName: schema.displayName ?? schema.schemaKey,
			versionLabel: schema.versionLabel ?? schema.schemaVersion ?? 'current',
			lifecycleState: schema.lifecycleState,
			source: schema.schemaKey
		};
	}

	function externalSchemaToProfile(schema: IdentityMappingExternalSchemaSummary): ProfileItem {
		return {
			id: schema.id,
			kind: 'inbound',
			protocol: schema.sourceType,
			displayName: schema.displayName ?? schema.schemaKey,
			versionLabel: schema.versionLabel ?? `imported:${schema.importedAt ?? 'current'}`,
			lifecycleState: schema.lifecycleState,
			source: schema.sourceKey ?? schema.sourceId ?? schema.schemaKey
		};
	}

	function templateToProfile(template: IdentityMappingTemplateSummary): ProfileItem {
		return {
			id: template.id,
			kind: 'template',
			protocol: template.protocol,
			displayName: template.displayName,
			versionLabel: template.templateKey,
			lifecycleState: template.lifecycleState,
			source: template.templateKey
		};
	}
</script>

<svelte:head>
	<title>Source & Destination Profiles - Authrim Admin</title>
</svelte:head>

<div class="profiles-page">
	<div class="page-heading">
		<div>
			<a class="back-link" href="/admin/identity-mapping">Back to Identity Mapping</a>
			<p class="eyebrow">Identity Mapping</p>
			<h1>Source &amp; Destination Profiles</h1>
			<p class="summary">
				Prepare inbound adapters and outbound destinations before selecting them in the Flow Editor.
				SAML, OIDC, SCIM, CSV, and future sources share this registration surface.
			</p>
		</div>
		<div class="status-panel">
			<div>
				<span>Inbound</span>
				<strong>{inboundCount}</strong>
			</div>
			<div>
				<span>Outbound</span>
				<strong>{outboundCount}</strong>
			</div>
		</div>
	</div>

	<section class="profiles-panel">
		<div class="panel-heading">
			<div class="filter-bar" aria-label="Profile filters">
				{#each profileKinds as kind (kind)}
					<button
						type="button"
						class:active={activeKind === kind}
						onclick={() => (activeKind = kind)}
					>
						{kind}
					</button>
				{/each}
			</div>
			<button type="button" onclick={loadProfiles} disabled={loading}>Refresh</button>
		</div>

		{#if loading}
			<div class="empty-state">Loading source and destination profiles.</div>
		{:else if errorMessage}
			<div class="empty-state">{errorMessage}</div>
		{:else if visibleProfiles.length === 0}
			<div class="empty-state">No profiles match this filter.</div>
		{:else}
			<div class="profile-grid">
				{#each visibleProfiles as profile (profile.id)}
					<article class:selected={profile.id === selectedProfileId}>
						<div class="profile-heading">
							<span>{profile.kind}</span>
							<strong>{profile.lifecycleState}</strong>
						</div>
						<h2>{profile.displayName}</h2>
						<p>{profile.protocol} / {profile.source}</p>
						<small>{profile.versionLabel}</small>
						{#if profile.kind === 'outbound'}
							<button type="button" onclick={() => selectConsentProfile(profile)}>
								Configure release consent
							</button>
						{/if}
					</article>
				{/each}
			</div>
		{/if}
	</section>

	{#if selectedProfile && selectedConsentDraft}
		<section
			id="destination-consent"
			class="consent-panel"
			aria-label="Destination attribute release consent settings"
		>
			<div>
				<p class="eyebrow">Destination Consent Settings</p>
				<h2>{selectedProfile.displayName}</h2>
				<p class="summary">
					Set tenant defaults and client overrides for attribute release consent. Flow Editor
					previews use the same legal basis, challenge mode, and policy version fields without
					showing raw attribute values.
				</p>
			</div>

			<div class="settings-grid">
				<label>
					<span>Scope</span>
					<select
						value={selectedConsentDraft.scope}
						onchange={(event) =>
							updateSelectedConsentDraft({
								scope: getInputValue(event) as DestinationConsentSettingsDraft['scope']
							})}
					>
						<option value="tenant_default">Tenant default</option>
						<option value="client_override">Client override</option>
					</select>
				</label>

				<label>
					<span>Client override ID</span>
					<input
						value={selectedConsentDraft.clientId}
						placeholder="client id for override"
						disabled={selectedConsentDraft.scope === 'tenant_default'}
						oninput={(event) => updateSelectedConsentDraft({ clientId: getInputValue(event) })}
					/>
				</label>

				<label>
					<span>Consent mode</span>
					<select
						value={selectedConsentDraft.consentMode}
						onchange={(event) =>
							updateSelectedConsentDraft({
								consentMode: getInputValue(event) as DestinationConsentSettingsDraft['consentMode']
							})}
					>
						<option value="once">Once</option>
						<option value="every_time">Every time</option>
						<option value="until_attributes_change">Until attributes change</option>
					</select>
				</label>

				<label>
					<span>Legal basis</span>
					<select
						value={selectedConsentDraft.legalBasis}
						onchange={(event) =>
							updateSelectedConsentDraft({
								legalBasis: getInputValue(event) as DestinationConsentSettingsDraft['legalBasis']
							})}
					>
						<option value="consent">Consent</option>
						<option value="legal_obligation">Legal obligation</option>
						<option value="contract">Contract</option>
						<option value="legitimate_interest">Legitimate interest</option>
					</select>
				</label>

				<label>
					<span>Purpose</span>
					<input
						value={selectedConsentDraft.purpose}
						oninput={(event) => updateSelectedConsentDraft({ purpose: getInputValue(event) })}
					/>
				</label>

				<label>
					<span>Attribute set policy version</span>
					<input
						value={selectedConsentDraft.attributeSetPolicyVersion}
						oninput={(event) =>
							updateSelectedConsentDraft({ attributeSetPolicyVersion: getInputValue(event) })}
					/>
				</label>

				<label>
					<span>Terms version</span>
					<input
						value={selectedConsentDraft.termsVersion}
						oninput={(event) => updateSelectedConsentDraft({ termsVersion: getInputValue(event) })}
					/>
				</label>

				<label>
					<span>Privacy Policy version</span>
					<input
						value={selectedConsentDraft.privacyPolicyVersion}
						oninput={(event) =>
							updateSelectedConsentDraft({ privacyPolicyVersion: getInputValue(event) })}
					/>
				</label>

				<label>
					<span>Challenge handling</span>
					<select
						value={selectedConsentDraft.challengeExperience}
						onchange={(event) =>
							updateSelectedConsentDraft({
								challengeExperience: getInputValue(
									event
								) as DestinationConsentSettingsDraft['challengeExperience']
							})}
					>
						<option value="login_flow">Login flow challenge</option>
						<option value="step_up_required">Step-up required</option>
					</select>
				</label>

				<label class="checkbox-row">
					<input
						type="checkbox"
						checked={selectedConsentDraft.regulatedPurposeGuard}
						onchange={(event) =>
							updateSelectedConsentDraft({
								regulatedPurposeGuard:
									event.currentTarget instanceof HTMLInputElement
										? event.currentTarget.checked
										: true
							})}
					/>
					<span>Require purpose guard for regulated attributes</span>
				</label>
			</div>

			<div class="consent-preview">
				<span>Preview</span>
				<strong>{summarizeDestinationConsentSettings(selectedConsentDraft)}</strong>
				<small>Raw attribute values remain {selectedConsentDraft.rawValueDisplay}.</small>
			</div>
		</section>
	{/if}
</div>

<style>
	.profiles-page {
		display: grid;
		gap: 18px;
	}

	.page-heading,
	.panel-heading,
	.profile-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 18px;
	}

	.back-link {
		display: inline-flex;
		margin-bottom: 12px;
		color: var(--color-primary);
		font-size: 13px;
		font-weight: 700;
		text-decoration: none;
	}

	.eyebrow,
	.status-panel span,
	.profile-heading span,
	.profile-grid small {
		margin: 0;
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 800;
		letter-spacing: 0.04em;
		text-transform: uppercase;
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

	h2,
	.status-panel strong,
	.profile-heading strong {
		color: var(--text-primary);
	}

	h2 {
		font-size: 16px;
		line-height: 1.35;
	}

	.summary,
	.profile-grid p {
		color: var(--text-secondary);
		font-size: 13px;
		line-height: 1.45;
	}

	.summary {
		max-width: 780px;
		margin-top: 8px;
		font-size: 14px;
	}

	.status-panel,
	.profiles-panel,
	.consent-panel,
	.empty-state,
	.profile-grid article {
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--bg-card);
	}

	.status-panel {
		min-width: 260px;
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
		padding: 14px;
	}

	.status-panel strong {
		display: block;
		margin-top: 4px;
		font-size: 22px;
	}

	.profiles-panel {
		display: grid;
		gap: 14px;
		padding: 16px;
	}

	.consent-panel {
		display: grid;
		gap: 18px;
		padding: 16px;
	}

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
		text-transform: capitalize;
	}

	button.active {
		color: var(--text-primary);
		border-color: var(--color-primary);
		background: var(--bg-hover);
	}

	button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.empty-state {
		padding: 18px;
		color: var(--text-secondary);
	}

	.profile-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 12px;
	}

	.profile-grid article {
		display: grid;
		gap: 8px;
		padding: 14px;
	}

	.profile-grid article.selected {
		border-color: var(--color-primary);
		background: var(--bg-hover);
	}

	.settings-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 14px;
	}

	label {
		display: grid;
		gap: 6px;
		color: var(--text-secondary);
		font-size: 13px;
		font-weight: 700;
	}

	label span {
		color: var(--text-muted);
		font-size: 12px;
		text-transform: uppercase;
	}

	input,
	select {
		width: 100%;
		min-height: 38px;
		padding: 0 10px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		color: var(--text-primary);
		background: var(--bg-card);
	}

	input:disabled {
		color: var(--text-muted);
		background: var(--bg-muted);
	}

	.checkbox-row {
		grid-template-columns: auto 1fr;
		align-items: center;
	}

	.checkbox-row input {
		width: 18px;
		min-height: 18px;
	}

	.consent-preview {
		display: grid;
		gap: 6px;
		padding: 14px;
		border: 1px solid var(--border-color);
		border-radius: 8px;
		background: var(--bg-muted);
	}

	.consent-preview span,
	.consent-preview small {
		color: var(--text-muted);
		font-size: 12px;
		font-weight: 800;
		text-transform: uppercase;
	}

	.consent-preview strong {
		color: var(--text-primary);
		line-height: 1.45;
	}

	.profile-heading strong {
		padding: 3px 8px;
		border-radius: 999px;
		background: var(--bg-muted);
		font-size: 12px;
	}

	@media (max-width: 1100px) {
		.profile-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (max-width: 780px) {
		.page-heading,
		.panel-heading,
		.status-panel,
		.profile-grid {
			display: grid;
			grid-template-columns: 1fr;
		}

		.status-panel {
			min-width: 0;
		}
	}
</style>
