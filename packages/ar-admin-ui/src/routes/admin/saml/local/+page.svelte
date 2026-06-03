<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { SvelteURL } from 'svelte/reactivity';
	import { getTenantInfo, type TenantInfo } from '$lib/api/admin-info';
	import { adminSettingsAPI, type CategorySettings } from '$lib/api/admin-settings';
	import {
		adminSAMLAPI,
		type SAMLEntityIdStyle,
		type SAMLInteractiveLoginUrlPolicy,
		type SAMLSigningCertificateSubject,
		type SAMLSigningKeyPolicy,
		type SAMLSettings,
		type SAMLTrustCertificatePreview
	} from '$lib/api/admin-saml';
	import { parseDiscoveryMethods } from '$lib/admin/tenant-discovery-settings';
	import { settingsContext } from '$lib/stores/settings-context.svelte';

	type MetadataRole = 'idp' | 'sp';
	type LoginEntryMode = 'tenant_only' | 'discovery_optional' | 'discovery_required';

	interface PublishedCertificate {
		id: string;
		role: MetadataRole;
		index: number;
		use: string;
		certificate: string;
		preview?: SAMLTrustCertificatePreview;
		error?: string;
	}

	interface MetadataDocument {
		role: MetadataRole;
		label: string;
		url: string;
		entityId: string;
		xml: string;
		certificates: PublishedCertificate[];
		error?: string;
	}

	interface LoginEntryPreviewSettings {
		overrideEnabled: boolean;
		mode: LoginEntryMode;
		discoveryMethods: string[];
		selectionPolicy: string;
		redirectDefaultLoginToDiscovery: boolean;
		requireCommonDiscoveryBeforeLogin: boolean;
		skipDiscoveryIfOnlyOneTenant: boolean;
		redirectTenantDiscoverToCommonEntry: boolean;
	}

	interface LoginRouteStep {
		title: string;
		url: string;
		detail: string;
	}

	let tenantInfo = $state<TenantInfo | null>(null);
	let samlSettings = $state<SAMLSettings | null>(null);
	let metadataDocs = $state<MetadataDocument[]>([]);
	let tenantLoginEntrySettings = $state<LoginEntryPreviewSettings | null>(null);
	let commonLoginEntrySettings = $state<LoginEntryPreviewSettings | null>(null);
	let discoverySettingsError = $state('');
	let loading = $state(true);
	let savingSettings = $state(false);
	let signingAction = $state('');
	let drBundleAction = $state('');
	let error = $state('');
	let actionMessage = $state('');
	let copiedKey = $state('');
	let drBundleFileInput = $state<HTMLInputElement | null>(null);
	let drBundlePassphrase = $state('');
	let drBundlePassphraseConfirm = $state('');
	let draftEntityIdStyle = $state<SAMLEntityIdStyle>('metadata_url');
	let draftInteractiveLoginUrlPolicy = $state<SAMLInteractiveLoginUrlPolicy>('tenant_host');
	let draftCertificateSubject = $state<SAMLSigningCertificateSubject>({
		countryName: '',
		stateOrProvinceName: '',
		localityName: '',
		organizationName: 'Authrim',
		organizationalUnitName: '',
		commonName: 'Authrim SAML Signing'
	});

	const signingRoles: MetadataRole[] = ['idp', 'sp'];

	const hasSAMLSettingsChanges = $derived(
		!!samlSettings &&
			(samlSettings.entityIdStyle !== draftEntityIdStyle ||
				samlSettings.interactiveLoginUrlPolicy !== draftInteractiveLoginUrlPolicy)
	);
	const hasCertificateSubjectChanges = $derived(
		!!samlSettings &&
			JSON.stringify(currentCertificateSubject()) !== JSON.stringify(draftCertificateSubject)
	);
	const effectiveTenantLoginEntrySettings = $derived(
		tenantLoginEntrySettings?.overrideEnabled ? tenantLoginEntrySettings : commonLoginEntrySettings
	);
	const selectedSAMLLoginUrl = $derived(buildSAMLLoginUrl(draftInteractiveLoginUrlPolicy));
	const loginRouteSteps = $derived(buildLoginRouteSteps(draftInteractiveLoginUrlPolicy));
	const canExportDRBundle = $derived(
		!drBundleAction &&
			drBundlePassphrase.length >= 12 &&
			drBundlePassphrase === drBundlePassphraseConfirm
	);
	const canImportDRBundle = $derived(!drBundleAction && drBundlePassphrase.length >= 12);

	onMount(() => {
		void initialize();
	});

	async function initialize() {
		await settingsContext.initialize();
		await load();
	}

	async function load() {
		loading = true;
		error = '';
		actionMessage = '';
		try {
			discoverySettingsError = '';
			const [settingsResult, tenantInfoResult, tenantLoginEntryResult, commonLoginEntryResult] =
				await Promise.all([
					adminSAMLAPI.getSettings(),
					getTenantInfo(),
					adminSettingsAPI.getSettings('login-entry').catch((err) => {
						discoverySettingsError =
							err instanceof Error ? err.message : 'Failed to load tenant discovery settings';
						return null;
					}),
					adminSettingsAPI.getPlatformSettings('login-entry').catch(() => null)
				]);
			samlSettings = settingsResult;
			tenantInfo = tenantInfoResult;
			tenantLoginEntrySettings = normalizeLoginEntrySettings(tenantLoginEntryResult);
			commonLoginEntrySettings =
				normalizeLoginEntrySettings(commonLoginEntryResult) ?? tenantLoginEntrySettings;
			draftEntityIdStyle = settingsResult.entityIdStyle;
			draftInteractiveLoginUrlPolicy = settingsResult.interactiveLoginUrlPolicy;
			draftCertificateSubject = normalizeSubjectForForm(
				settingsResult.localSigning?.certificateSubject ?? settingsResult.certificateSubject
			);
			metadataDocs = tenantInfoResult.components.saml
				? await loadMetadataDocuments(tenantInfoResult)
				: [];
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load SAML entity information';
		} finally {
			loading = false;
		}
	}

	async function loadMetadataDocuments(info: TenantInfo): Promise<MetadataDocument[]> {
		const targets = [
			{ role: 'idp' as const, label: 'Authrim IdP Metadata', url: info.saml.idp_metadata },
			{
				role: 'sp' as const,
				label: 'Authrim SP Metadata',
				url: info.saml.sp_metadata ?? info.saml.metadata
			}
		];
		return await Promise.all(targets.map((target) => loadMetadataDocument(target)));
	}

	async function loadMetadataDocument(target: {
		role: MetadataRole;
		label: string;
		url: string;
	}): Promise<MetadataDocument> {
		try {
			const response = await fetch(target.url, { credentials: 'include' });
			if (!response.ok) {
				throw new Error(`Metadata request failed with ${response.status}`);
			}
			const xml = await response.text();
			const parsed = parseMetadataXml(xml, target.role);
			const certificates = await Promise.all(
				parsed.certificates.map(async (certificate) => {
					try {
						const preview = await adminSAMLAPI.previewTrustCertificate({
							certificate: certificate.certificate
						});
						return { ...certificate, preview };
					} catch (err) {
						return {
							...certificate,
							error: err instanceof Error ? err.message : 'Failed to parse certificate'
						};
					}
				})
			);
			return {
				role: target.role,
				label: target.label,
				url: target.url,
				entityId: parsed.entityId,
				xml,
				certificates
			};
		} catch (err) {
			return {
				role: target.role,
				label: target.label,
				url: target.url,
				entityId: '-',
				xml: '',
				certificates: [],
				error: err instanceof Error ? err.message : 'Failed to load metadata'
			};
		}
	}

	function parseMetadataXml(xml: string, role: MetadataRole) {
		const doc = new DOMParser().parseFromString(xml, 'application/xml');
		const parserError = doc.querySelector('parsererror');
		if (parserError) {
			throw new Error(parserError.textContent || 'Invalid SAML metadata XML');
		}

		const root = doc.documentElement;
		const entityId = root.getAttribute('entityID') || '-';
		const keyDescriptors = Array.from(
			doc.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:metadata', 'KeyDescriptor')
		);
		const certNodes = Array.from(
			doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'X509Certificate')
		);
		const certificates = certNodes.map((node, index) => {
			const keyDescriptor = keyDescriptors.find((descriptor) => descriptor.contains(node));
			const use = keyDescriptor?.getAttribute('use') || 'signing';
			const certificate = normalizePemCertificate(node.textContent || '');
			return {
				id: `${role}-${index}-${use}`,
				role,
				index: index + 1,
				use,
				certificate
			};
		});
		return { entityId, certificates };
	}

	function normalizePemCertificate(value: string) {
		const compact = value
			.replace(/-----BEGIN CERTIFICATE-----/g, '')
			.replace(/-----END CERTIFICATE-----/g, '')
			.replace(/\s+/g, '');
		const lines = compact.match(/.{1,64}/g) ?? [];
		return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
	}

	async function copy(text: string, key: string) {
		try {
			await navigator.clipboard.writeText(text);
			copiedKey = key;
			setTimeout(() => {
				copiedKey = '';
			}, 2000);
		} catch {
			// Clipboard access may be unavailable in embedded previews.
		}
	}

	function downloadText(filename: string, contents: string, type = 'text/plain') {
		const blob = new Blob([contents], { type });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		document.body.appendChild(link);
		link.click();
		link.remove();
		URL.revokeObjectURL(url);
	}

	function roleLabel(role: MetadataRole) {
		return role === 'idp' ? 'IdP' : 'SP';
	}

	function formatDateTime(value: string | number | undefined) {
		if (!value) return '-';
		const date = typeof value === 'number' ? new Date(value) : new Date(value);
		if (Number.isNaN(date.getTime())) return '-';
		return date.toLocaleString();
	}

	function entityIdStyleLabel(style: SAMLEntityIdStyle) {
		return style === 'metadata_url' ? 'Metadata URL' : 'Role URL';
	}

	function interactiveLoginPolicyLabel(policy: SAMLInteractiveLoginUrlPolicy) {
		return policy === 'tenant_host' ? 'Tenant Host' : 'UI Base URL';
	}

	function metadataSigningLabel(settings: SAMLSettings) {
		return settings.metadata.signingEnabled ? 'Signed metadata' : 'Unsigned metadata';
	}

	function metadataSigningBadge(settings: SAMLSettings) {
		return settings.metadata.signingEnabled ? 'badge badge-success' : 'badge badge-neutral';
	}

	function currentCertificateSubject(): SAMLSigningCertificateSubject {
		return normalizeSubjectForForm(
			samlSettings?.localSigning?.certificateSubject ?? samlSettings?.certificateSubject
		);
	}

	function normalizeSubjectForForm(
		subject: Partial<SAMLSigningCertificateSubject> | undefined
	): SAMLSigningCertificateSubject {
		return {
			countryName: subject?.countryName ?? '',
			stateOrProvinceName: subject?.stateOrProvinceName ?? '',
			localityName: subject?.localityName ?? '',
			organizationName: subject?.organizationName || 'Authrim',
			organizationalUnitName: subject?.organizationalUnitName ?? '',
			commonName: subject?.commonName || 'Authrim SAML Signing'
		};
	}

	function localSigningPolicy(role: MetadataRole): SAMLSigningKeyPolicy {
		return role === 'idp'
			? (samlSettings?.localSigning?.idpSigningKeyPolicy ?? {})
			: (samlSettings?.localSigning?.spSigningKeyPolicy ?? {});
	}

	function policySummary(policy: SAMLSigningKeyPolicy) {
		const active = policy.active?.kid ? `active ${policy.active.kid}` : 'default active key';
		const next = policy.next?.kid ? `, next ${policy.next.kid}` : '';
		const backup = policy.backup?.kid ? `, backup ${policy.backup.kid}` : '';
		return `${active}${next}${backup}`;
	}

	function buildEntityIdPreview(role: MetadataRole, style: SAMLEntityIdStyle) {
		if (!samlSettings) return '-';
		const roleUrl = `${samlSettings.generated.issuerUrl}/saml/${role}`;
		return style === 'metadata_url' ? `${roleUrl}/metadata` : roleUrl;
	}

	function normalizeLoginEntrySettings(
		settings: CategorySettings | null
	): LoginEntryPreviewSettings | null {
		if (!settings) return null;
		const values = settings.values;
		const mode = values['login-entry.mode'];
		return {
			overrideEnabled: readBooleanSetting(values, 'login-entry.override_enabled', false),
			mode:
				mode === 'tenant_only' || mode === 'discovery_optional' || mode === 'discovery_required'
					? mode
					: 'discovery_optional',
			discoveryMethods: parseDiscoveryMethods(values['login-entry.discovery_methods']),
			selectionPolicy:
				typeof values['login-entry.selection_policy'] === 'string'
					? values['login-entry.selection_policy']
					: 'select_if_multiple',
			redirectDefaultLoginToDiscovery: readBooleanSetting(
				values,
				'login-entry.redirect_default_login_to_discovery',
				true
			),
			requireCommonDiscoveryBeforeLogin: readBooleanSetting(
				values,
				'login-entry.require_common_discovery_before_login',
				true
			),
			skipDiscoveryIfOnlyOneTenant: readBooleanSetting(
				values,
				'login-entry.skip_discovery_if_only_one_tenant',
				false
			),
			redirectTenantDiscoverToCommonEntry: readBooleanSetting(
				values,
				'login-entry.redirect_tenant_discover_to_common_entry',
				true
			)
		};
	}

	function readBooleanSetting(values: Record<string, unknown>, key: string, fallback: boolean) {
		return typeof values[key] === 'boolean' ? values[key] : fallback;
	}

	function buildSAMLLoginUrl(policy: SAMLInteractiveLoginUrlPolicy) {
		const base =
			policy === 'tenant_host'
				? tenantInfo?.login_ui_url || (tenantInfo?.issuer ? `${tenantInfo.issuer}/login` : null)
				: tenantInfo?.global_login_ui_url ||
					tenantInfo?.login_ui_url ||
					(samlSettings?.generated.issuerUrl ? `${samlSettings.generated.issuerUrl}/login` : null);

		if (!base) return '-';

		try {
			const url = new SvelteURL(base);
			url.pathname = '/login';
			url.searchParams.set('saml_request_id', '{saml_request_id}');
			url.searchParams.set('saml_sp_entity_id', '{sp_entity_id}');
			url.searchParams.set('return_to', 'saml_sso');
			if (policy === 'ui_base_url') {
				url.searchParams.set(
					'tenant_hint',
					tenantInfo?.tenant_id || samlSettings?.tenantId || '{tenant_id}'
				);
			}
			return url.toString();
		} catch {
			return `${base}/login`;
		}
	}

	function discoverUrl() {
		if (tenantInfo?.discover_url) return tenantInfo.discover_url;
		const base = tenantInfo?.global_login_ui_url || tenantInfo?.login_ui_url || tenantInfo?.issuer;
		if (!base) return '-';
		try {
			const url = new SvelteURL(base);
			url.pathname = '/discover';
			url.search = '';
			return url.toString();
		} catch {
			return `${base}/discover`;
		}
	}

	function discoverUrlWithTenantReturn() {
		const commonDiscover = discoverUrl();
		const tenantLogin = buildSAMLLoginUrl('tenant_host');
		if (commonDiscover === '-' || tenantLogin === '-') return commonDiscover;
		try {
			const url = new SvelteURL(commonDiscover);
			url.searchParams.set(
				'expected_tenant_id',
				tenantInfo?.tenant_id || samlSettings?.tenantId || '{tenant_id}'
			);
			url.searchParams.set('return_to', tenantLogin);
			return url.toString();
		} catch {
			return commonDiscover;
		}
	}

	function buildLoginRouteSteps(policy: SAMLInteractiveLoginUrlPolicy): LoginRouteStep[] {
		const tenantLogin = buildSAMLLoginUrl('tenant_host');
		const uiBaseLogin = buildSAMLLoginUrl('ui_base_url');

		if (policy === 'tenant_host') {
			const steps: LoginRouteStep[] = [
				{
					title: 'SAML redirect',
					url: tenantLogin,
					detail: 'The browser is sent to this tenant login URL.'
				}
			];

			if (
				tenantInfo?.discover_url &&
				effectiveTenantLoginEntrySettings?.mode !== 'tenant_only' &&
				effectiveTenantLoginEntrySettings?.requireCommonDiscoveryBeforeLogin
			) {
				steps.push({
					title: 'Common discovery gate',
					url: discoverUrlWithTenantReturn(),
					detail:
						'Because tenant login requires common discovery, the first visible page is tenant discovery. After the tenant is confirmed, it returns to the tenant login page.'
				});
			} else {
				steps.push({
					title: 'First visible page',
					url: tenantLogin,
					detail: 'The login page is shown directly without common tenant discovery.'
				});
			}

			return steps;
		}

		return [
			{
				title: 'SAML redirect',
				url: uiBaseLogin,
				detail: 'The browser is sent to the global Login UI /login URL with tenant_hint.'
			},
			{
				title: 'First visible page',
				url: discoverUrl(),
				detail: discoveryFirstPageDescription(commonLoginEntrySettings)
			},
			{
				title: 'After tenant resolution',
				url: tenantLogin,
				detail:
					'Discovery issues a tenant verification grant and then redirects to the tenant login page.'
			}
		];
	}

	function discoveryFirstPageDescription(settings: LoginEntryPreviewSettings | null) {
		if (!tenantInfo?.discover_url) {
			return 'No common discovery URL is configured, so the Login UI is expected to show the login page directly.';
		}
		if (!settings) {
			return 'Common entry /login redirects to /discover, but discovery settings could not be loaded.';
		}
		if (settings.mode === 'tenant_only') {
			return 'Common entry /login redirects to /discover. Tenant-only mode can auto-return only when discovery receives expected_tenant_id and return_to; this UI Base URL starts from /login, so the discovery page is the first visible page unless single-tenant skip applies.';
		}
		const methods = settings.discoveryMethods;
		if (methods.length === 1 && methods[0] === 'wayf') {
			return 'Common entry /login redirects to a WAYF tenant chooser. Only the tenant dropdown is shown.';
		}
		return `Common entry /login redirects to tenant discovery. Visible methods: ${formatDiscoveryMethods(methods)}.`;
	}

	function formatDiscoveryMethods(methods: string[]) {
		if (methods.length === 0) return 'none configured';
		return methods
			.map((method) => {
				switch (method) {
					case 'email_domain':
						return 'email/domain';
					case 'tenant_code':
						return 'tenant code';
					case 'tenant_slug':
						return 'tenant slug';
					case 'wayf':
						return 'WAYF dropdown';
					default:
						return method;
				}
			})
			.join(', ');
	}

	function fingerprint(value: string | undefined) {
		if (!value) return '-';
		const compact = value.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
		if (!compact || compact.length % 2 !== 0) return value;
		return compact.match(/.{2}/g)?.join(':') ?? value;
	}

	function scopeFromUrl(value: string | undefined) {
		if (!value) return '-';
		try {
			const host = new URL(value).hostname;
			const parts = host.split('.');
			return parts.length > 2 ? parts.slice(1).join('.') : host;
		} catch {
			return '-';
		}
	}

	async function saveSAMLSettings() {
		if (!samlSettings || !hasSAMLSettingsChanges || savingSettings) return;
		savingSettings = true;
		actionMessage = '';
		error = '';
		try {
			samlSettings = await adminSAMLAPI.updateSettings({
				entityIdStyle: draftEntityIdStyle,
				interactiveLoginUrlPolicy: draftInteractiveLoginUrlPolicy
			});
			draftEntityIdStyle = samlSettings.entityIdStyle;
			draftInteractiveLoginUrlPolicy = samlSettings.interactiveLoginUrlPolicy;
			actionMessage = 'SAML settings updated';
			if (tenantInfo?.components.saml) {
				metadataDocs = await loadMetadataDocuments(tenantInfo);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to update SAML settings';
		} finally {
			savingSettings = false;
		}
	}

	async function saveCertificateSubject() {
		if (!samlSettings || !hasCertificateSubjectChanges || savingSettings) return;
		savingSettings = true;
		actionMessage = '';
		error = '';
		try {
			samlSettings = await adminSAMLAPI.updateSettings({
				certificateSubject: draftCertificateSubject
			});
			draftCertificateSubject = currentCertificateSubject();
			actionMessage = 'SAML signing certificate subject saved';
		} catch (err) {
			error =
				err instanceof Error ? err.message : 'Failed to save SAML signing certificate subject';
		} finally {
			savingSettings = false;
		}
	}

	async function runLocalSigningAction(
		role: MetadataRole,
		action: 'recreate_active' | 'publish_next' | 'promote_next' | 'retire_backup'
	) {
		if (signingAction) return;
		signingAction = `${role}:${action}`;
		actionMessage = '';
		error = '';
		try {
			samlSettings = await adminSAMLAPI.updateLocalSigning({
				role,
				action,
				certificateSubject: currentCertificateSubject(),
				keepPreviousAsBackup: true
			});
			draftCertificateSubject = currentCertificateSubject();
			actionMessage = 'SAML signing certificate settings updated';
			if (tenantInfo?.components.saml) {
				metadataDocs = await loadMetadataDocuments(tenantInfo);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to update SAML signing certificate';
		} finally {
			signingAction = '';
		}
	}

	async function exportLocalSigningDRBundle() {
		if (drBundleAction) return;
		drBundleAction = 'export';
		actionMessage = '';
		error = '';
		try {
			const bundle = await adminSAMLAPI.exportLocalSigningDRBundle(drBundlePassphrase);
			const tenant = bundle.tenantId || samlSettings?.tenantId || 'tenant';
			downloadText(
				`authrim-saml-local-signing-dr-bundle-${tenant}.json`,
				JSON.stringify(bundle, null, 2),
				'application/json'
			);
			actionMessage = 'SAML signing DR bundle exported';
			clearDRBundlePassphrase();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to export SAML signing DR bundle';
		} finally {
			drBundleAction = '';
		}
	}

	async function importLocalSigningDRBundle(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file || drBundleAction) return;
		drBundleAction = 'import';
		actionMessage = '';
		error = '';
		try {
			const bundle = JSON.parse(await file.text()) as unknown;
			samlSettings = await adminSAMLAPI.importLocalSigningDRBundle(bundle, drBundlePassphrase);
			draftEntityIdStyle = samlSettings.entityIdStyle;
			draftInteractiveLoginUrlPolicy = samlSettings.interactiveLoginUrlPolicy;
			draftCertificateSubject = normalizeSubjectForForm(
				samlSettings.localSigning?.certificateSubject ?? samlSettings.certificateSubject
			);
			actionMessage = 'SAML signing DR bundle imported';
			if (tenantInfo?.components.saml) {
				metadataDocs = await loadMetadataDocuments(tenantInfo);
			}
			clearDRBundlePassphrase();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to import SAML signing DR bundle';
		} finally {
			drBundleAction = '';
			input.value = '';
		}
	}

	function clearDRBundlePassphrase() {
		drBundlePassphrase = '';
		drBundlePassphraseConfirm = '';
	}
</script>

<svelte:head>
	<title>SAML Entity Info - Admin Dashboard - Authrim</title>
</svelte:head>

{#snippet endpointRow(label: string, value: string, key: string, href?: string)}
	<div class="reference-row">
		<span class="reference-label">{label}</span>
		<div class="reference-value-row">
			{#if href}
				<a {href} target="_blank" rel="noopener noreferrer" class="reference-value">
					{value}
					<i class="i-ph-arrow-square-out"></i>
				</a>
			{:else}
				<span class="reference-value">{value}</span>
			{/if}
			<button
				class="icon-btn"
				class:copied={copiedKey === key}
				onclick={() => copy(value, key)}
				title="Copy"
			>
				<i class={copiedKey === key ? 'i-ph-check' : 'i-ph-copy'}></i>
			</button>
		</div>
	</div>
{/snippet}

{#snippet fieldRow(label: string, value: string, key: string, href?: string)}
	<div class="form-field-row">
		<span class="reference-label">{label}</span>
		<div class="reference-value-row">
			{#if href}
				<a {href} target="_blank" rel="noopener noreferrer" class="reference-value">
					{value}
					<i class="i-ph-arrow-square-out"></i>
				</a>
			{:else}
				<span class="reference-value">{value}</span>
			{/if}
			<button
				class="icon-btn"
				class:copied={copiedKey === key}
				onclick={() => copy(value, key)}
				title="Copy"
			>
				<i class={copiedKey === key ? 'i-ph-check' : 'i-ph-copy'}></i>
			</button>
		</div>
	</div>
{/snippet}

<div class="admin-page">
	<div class="page-header">
		<div>
			<button class="link-button" onclick={() => goto('/admin/saml')}>
				<i class="i-ph-arrow-left"></i>
				SAML
			</button>
			<h1 class="page-title">SAML Entity Info</h1>
			<p class="page-description">
				Local Authrim IdP/SP metadata, endpoint references, entity IDs, and published signing
				certificates.
			</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-secondary" onclick={load} disabled={loading}>
				<i class="i-ph-arrow-clockwise"></i>
				Refresh
			</button>
		</div>
	</div>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}
	{#if actionMessage}
		<div class="alert alert-success">{actionMessage}</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading...</p>
		</div>
	{:else}
		{#if !tenantInfo?.components.saml}
			<div class="panel">
				<div class="panel-header compact-panel-header">
					<div>
						<h2 class="panel-title">SAML Metadata</h2>
						<p class="form-hint">Form-ready URLs and certificates for SAML registration.</p>
					</div>
					<span class="badge badge-neutral">Not deployed</span>
				</div>
				<div class="empty-state compact-empty">SAML worker is not deployed for this tenant.</div>
			</div>
		{/if}

		{#if samlSettings}
			<div class="panel">
				<div class="panel-header compact-panel-header">
					<div>
						<h2 class="panel-title">SAML Signing DR Bundle</h2>
						<p class="form-hint">
							Export and restore local SAML signing keys, certificates, entity ID settings, and
							signing rollover state for this tenant.
						</p>
					</div>
					<div class="metadata-badges">
						<span class="badge badge-warning">Sensitive</span>
					</div>
				</div>
				<div class="entity-warning">
					<i class="i-ph-warning-circle"></i>
					<span>
						This bundle is encrypted with your passphrase, but it contains private signing keys
						after decryption. Keep it offline and import it only when recreating the same
						tenant/domain environment.
					</span>
				</div>
				<div class="dr-bundle-fields">
					<label>
						<span>Passphrase</span>
						<input
							class="form-input"
							type="password"
							autocomplete="new-password"
							bind:value={drBundlePassphrase}
							placeholder="12+ characters"
							disabled={!!drBundleAction}
						/>
					</label>
					<label>
						<span>Confirm passphrase</span>
						<input
							class="form-input"
							type="password"
							autocomplete="new-password"
							bind:value={drBundlePassphraseConfirm}
							placeholder="Required for export"
							disabled={!!drBundleAction}
						/>
					</label>
				</div>
				<div class="form-actions">
					<button
						class="btn btn-secondary btn-sm"
						onclick={exportLocalSigningDRBundle}
						disabled={!canExportDRBundle}
					>
						<i class="i-ph-download-simple"></i>
						{drBundleAction === 'export' ? 'Exporting...' : 'Export DR Bundle'}
					</button>
					<button
						class="btn btn-secondary btn-sm"
						onclick={() => drBundleFileInput?.click()}
						disabled={!canImportDRBundle}
					>
						<i class="i-ph-upload-simple"></i>
						{drBundleAction === 'import' ? 'Importing...' : 'Import DR Bundle'}
					</button>
					<input
						bind:this={drBundleFileInput}
						class="hidden-file-input"
						type="file"
						accept="application/json,.json"
						onchange={importLocalSigningDRBundle}
					/>
				</div>
			</div>
		{/if}

		{#if tenantInfo}
			{#each metadataDocs as doc (doc.role)}
				<div class="panel metadata-panel">
					<div class="panel-header compact-panel-header">
						<div>
							<h2 class="panel-title">{doc.label}</h2>
							<p class="form-hint">
								Endpoint URLs, entityID, metadata XML, and signing certificates for Authrim {roleLabel(
									doc.role
								)}.
							</p>
						</div>
						<div class="metadata-badges">
							<span class="badge badge-info">{roleLabel(doc.role)}</span>
							<button
								class="btn btn-secondary btn-sm"
								onclick={() =>
									downloadText(
										`authrim-saml-${doc.role}-metadata.xml`,
										doc.xml,
										'application/samlmetadata+xml'
									)}
								disabled={!doc.xml}
							>
								<i class="i-ph-download-simple"></i>
								Metadata
							</button>
						</div>
					</div>

					{#if doc.error}
						<div class="alert alert-error">{doc.error}</div>
					{:else}
						<div class="metadata-section">
							<div class="preview-heading">Endpoint References</div>
							<div class="info-row-list">
								{#if doc.role === 'idp'}
									{@render fieldRow('SSO (Single Sign-On)', tenantInfo.saml.sso, 'saml_sso')}
									{@render fieldRow(
										'IdP Metadata URL',
										tenantInfo.saml.idp_metadata,
										'saml_idp_metadata',
										tenantInfo.saml.idp_metadata
									)}
									{@render fieldRow('SLO (Single Logout)', tenantInfo.saml.slo, 'saml_idp_slo')}
								{:else}
									{@render fieldRow(
										'ACS (Assertion Consumer Service)',
										tenantInfo.saml.acs,
										'saml_acs'
									)}
									{@render fieldRow(
										'SP Metadata URL',
										tenantInfo.saml.sp_metadata ?? tenantInfo.saml.metadata,
										'saml_sp_metadata',
										tenantInfo.saml.sp_metadata ?? tenantInfo.saml.metadata
									)}
									{@render fieldRow('SLO (Single Logout)', tenantInfo.saml.slo, 'saml_sp_slo')}
								{/if}
							</div>
						</div>

						<div class="metadata-section">
							<div class="preview-heading">Registration Values</div>
							<div class="info-row-list">
								{@render fieldRow(
									`${roleLabel(doc.role)} entityID`,
									doc.entityId,
									`${doc.role}_metadata_entity`
								)}
								{@render fieldRow('Scope', scopeFromUrl(doc.entityId), `${doc.role}_scope`)}
							</div>
						</div>

						{#if doc.certificates.length === 0}
							<div class="empty-state compact-empty">
								No X.509 certificates are published in this metadata.
							</div>
						{:else}
							<div class="certificate-list">
								{#each doc.certificates as certificate (certificate.id)}
									<section class="certificate-card">
										<div class="certificate-header">
											<div>
												<h3>{roleLabel(certificate.role)} Certificate {certificate.index}</h3>
												<p>{certificate.use}</p>
											</div>
											<div class="certificate-actions">
												<button
													class="btn btn-secondary btn-sm"
													onclick={() => copy(certificate.certificate, `cert_${certificate.id}`)}
												>
													<i
														class={copiedKey === `cert_${certificate.id}`
															? 'i-ph-check'
															: 'i-ph-copy'}
													></i>
													Copy
												</button>
												<button
													class="btn btn-secondary btn-sm"
													onclick={() =>
														downloadText(
															`authrim-saml-${certificate.role}-certificate-${certificate.index}.pem`,
															certificate.certificate,
															'application/x-pem-file'
														)}
												>
													<i class="i-ph-download-simple"></i>
													PEM
												</button>
											</div>
										</div>

										{#if certificate.preview}
											<div class="certificate-info-grid">
												<div>
													<span>Subject</span><strong>{certificate.preview.subject}</strong>
												</div>
												<div><span>Issuer</span><strong>{certificate.preview.issuer}</strong></div>
												<div>
													<span>Valid From</span><strong
														>{formatDateTime(certificate.preview.validFrom)}</strong
													>
												</div>
												<div>
													<span>Valid To</span><strong
														>{formatDateTime(certificate.preview.validTo)}</strong
													>
												</div>
												<div>
													<span>Signature</span><strong
														>{certificate.preview.signatureAlgorithm}</strong
													>
												</div>
												<div>
													<span>Public Key</span>
													<strong>
														{certificate.preview.publicKeyAlgorithm}
														{certificate.preview.publicKeySizeBits
															? ` ${certificate.preview.publicKeySizeBits} bit`
															: ''}
													</strong>
												</div>
											</div>

											<div class="fingerprint-grid">
												{@render endpointRow(
													'SHA-1 fingerprint',
													fingerprint(certificate.preview.fingerprintSha1),
													`${certificate.id}_sha1`
												)}
												{@render endpointRow(
													'SHA-256 fingerprint',
													fingerprint(certificate.preview.fingerprintSha256),
													`${certificate.id}_sha256`
												)}
											</div>

											{#if certificate.preview.warnings.length > 0}
												<div class="certificate-warnings">
													{#each certificate.preview.warnings as warning (warning)}
														<span><i class="i-ph-warning-circle"></i>{warning}</span>
													{/each}
												</div>
											{/if}
										{:else if certificate.error}
											<div class="alert alert-error">{certificate.error}</div>
										{/if}

										<details class="certificate-pem">
											<summary>
												<i class="i-ph-caret-right"></i>
												<span>Certificate PEM</span>
											</summary>
											<div class="field-copy-row">
												<textarea
													class="copy-textarea certificate-textarea"
													readonly
													rows="10"
													value={certificate.certificate}
												></textarea>
												<button
													class="icon-btn"
													class:copied={copiedKey === `cert_pem_${certificate.id}`}
													onclick={() =>
														copy(certificate.certificate, `cert_pem_${certificate.id}`)}
													title="Copy"
												>
													<i
														class={copiedKey === `cert_pem_${certificate.id}`
															? 'i-ph-check'
															: 'i-ph-copy'}
													></i>
												</button>
											</div>
										</details>
									</section>
								{/each}
							</div>
						{/if}
					{/if}
				</div>
			{/each}
		{/if}

		{#if samlSettings}
			<div class="panel">
				<div class="panel-header compact-panel-header">
					<div>
						<h2 class="panel-title">SAML Published Entity IDs</h2>
						<p class="form-hint">
							Tenant-wide SAML defaults used in generated IdP/SP metadata and interactive login
							redirects.
						</p>
					</div>
					<div class="metadata-badges">
						<span class="badge badge-info">{entityIdStyleLabel(samlSettings.entityIdStyle)}</span>
						<span class="badge badge-info">
							Login {interactiveLoginPolicyLabel(samlSettings.interactiveLoginUrlPolicy)}
						</span>
					</div>
				</div>

				<div class="entity-layout">
					<div class="entity-options" role="radiogroup" aria-label="SAML entityID style">
						<label class="entity-option">
							<input
								type="radio"
								name="entityIdStyle"
								checked={draftEntityIdStyle === 'metadata_url'}
								onchange={() => (draftEntityIdStyle = 'metadata_url')}
								disabled={savingSettings}
							/>
							<span>
								<strong>Metadata URL</strong>
								<small>/saml/idp/metadata and /saml/sp/metadata</small>
							</span>
						</label>
						<label class="entity-option">
							<input
								type="radio"
								name="entityIdStyle"
								checked={draftEntityIdStyle === 'role_url'}
								onchange={() => (draftEntityIdStyle = 'role_url')}
								disabled={savingSettings}
							/>
							<span>
								<strong>Role URL</strong>
								<small>/saml/idp and /saml/sp</small>
							</span>
						</label>
					</div>

					<div class="entity-current">
						<div class="entity-preview-group">
							<div class="preview-heading">Current entityIDs</div>
							{@render fieldRow('IdP Entity ID', samlSettings.generated.idpEntityId, 'idp_entity')}
							{@render fieldRow('SP Entity ID', samlSettings.generated.spEntityId, 'sp_entity')}
						</div>
						{#if draftEntityIdStyle !== samlSettings.entityIdStyle}
							<div class="entity-preview-group pending-preview">
								<div class="preview-heading">After save</div>
								{@render fieldRow(
									'IdP Entity ID',
									buildEntityIdPreview('idp', draftEntityIdStyle),
									'idp_entity_next'
								)}
								{@render fieldRow(
									'SP Entity ID',
									buildEntityIdPreview('sp', draftEntityIdStyle),
									'sp_entity_next'
								)}
							</div>
						{/if}
					</div>
				</div>

				<div class="login-policy">
					<div class="section-copy">
						<div class="section-heading">Interactive Login Redirect</div>
						<p class="form-hint">
							Controls where SAML sends users when a flow needs interactive login.
						</p>
					</div>

					<div class="login-policy-layout">
						<div class="login-policy-choice">
							<div class="entity-options" role="radiogroup" aria-label="SAML login redirect policy">
								<label class="entity-option">
									<input
										type="radio"
										name="interactiveLoginUrlPolicy"
										checked={draftInteractiveLoginUrlPolicy === 'tenant_host'}
										onchange={() => (draftInteractiveLoginUrlPolicy = 'tenant_host')}
										disabled={savingSettings}
									/>
									<span>
										<strong>Tenant Host</strong>
										<small>Use this tenant's /login URL. Default for SAML.</small>
									</span>
								</label>
								<label class="entity-option">
									<input
										type="radio"
										name="interactiveLoginUrlPolicy"
										checked={draftInteractiveLoginUrlPolicy === 'ui_base_url'}
										onchange={() => (draftInteractiveLoginUrlPolicy = 'ui_base_url')}
										disabled={savingSettings}
									/>
									<span>
										<strong>UI Base URL</strong>
										<small>Use global UI_URL /login with tenant_hint.</small>
									</span>
								</label>
							</div>
						</div>

						<div class="login-policy-preview">
							<div class="preview-heading">Selected Login URL</div>
							{@render fieldRow('Login URL', selectedSAMLLoginUrl, 'selected_saml_login_url')}

							<div class="route-preview">
								<div class="preview-heading">Displayed Page Flow</div>
								{#if discoverySettingsError}
									<div class="inline-warning">
										<i class="i-ph-warning-circle"></i>
										<span>{discoverySettingsError}</span>
									</div>
								{/if}
								<ol class="route-steps">
									{#each loginRouteSteps as step, index (step.title)}
										<li class="route-step">
											<span class="route-step-index">{index + 1}</span>
											<div>
												<strong>{step.title}</strong>
												<span class="route-step-url">{step.url}</span>
												<small>{step.detail}</small>
											</div>
										</li>
									{/each}
								</ol>
							</div>
						</div>
					</div>
				</div>

				<div class="metadata-summary">
					<div class="metadata-summary-header">
						<div>
							<div class="preview-heading">SAML Metadata Publication</div>
							<p class="form-hint">
								Generated IdP/SP metadata currently publishes validity dates. XML signature is
								opt-in for strict environments.
							</p>
						</div>
						<div class="metadata-badges">
							<span class={metadataSigningBadge(samlSettings)}>
								{metadataSigningLabel(samlSettings)}
							</span>
							<span
								class={samlSettings.metadata.validUntilEnabled
									? 'badge badge-success'
									: 'badge badge-neutral'}
							>
								validUntil {samlSettings.metadata.validUntilEnabled ? 'Enabled' : 'Disabled'}
							</span>
						</div>
					</div>

					<div class="metadata-grid">
						<div>
							<span class="preview-label">IdP validUntil</span>
							<strong>{formatDateTime(samlSettings.metadata.idpValidUntil)}</strong>
						</div>
						<div>
							<span class="preview-label">SP validUntil</span>
							<strong>{formatDateTime(samlSettings.metadata.spValidUntil)}</strong>
						</div>
						<div>
							<span class="preview-label">Validity window</span>
							<strong>{samlSettings.metadata.validityDays} days</strong>
						</div>
						<div>
							<span class="preview-label">cacheDuration</span>
							<strong>{samlSettings.metadata.cacheDuration}</strong>
						</div>
					</div>
				</div>

				<div class="entity-warning">
					<i class="i-ph-warning-circle"></i>
					<span>
						Changing published entityIDs can affect SAML trust. Existing SP/IdP configurations may
						need updated metadata, audience settings, issuer settings, and certificate validation
						review before production use.
					</span>
				</div>

				<div class="form-actions">
					<button
						class="btn btn-primary btn-sm"
						onclick={saveSAMLSettings}
						disabled={savingSettings || !hasSAMLSettingsChanges}
					>
						{savingSettings ? 'Saving...' : 'Save SAML Settings'}
					</button>
				</div>
			</div>

			<div class="panel">
				<div class="panel-header compact-panel-header">
					<div>
						<h2 class="panel-title">Signing Certificate Subject</h2>
						<p class="form-hint">
							Default subject values used when Authrim recreates SAML signing certificates.
						</p>
					</div>
				</div>

				<div class="subject-grid">
					<label>
						<span>C (Country)</span>
						<input
							class="form-input"
							bind:value={draftCertificateSubject.countryName}
							placeholder="JP"
							disabled={savingSettings}
						/>
					</label>
					<label>
						<span>ST (State or Province Name)</span>
						<input
							class="form-input"
							bind:value={draftCertificateSubject.stateOrProvinceName}
							placeholder="Tokyo"
							disabled={savingSettings}
						/>
					</label>
					<label>
						<span>L (Locality Name)</span>
						<input
							class="form-input"
							bind:value={draftCertificateSubject.localityName}
							placeholder="Chiyoda"
							disabled={savingSettings}
						/>
					</label>
					<label>
						<span>O (Organization)</span>
						<input
							class="form-input"
							bind:value={draftCertificateSubject.organizationName}
							placeholder="Authrim"
							disabled={savingSettings}
						/>
					</label>
					<label>
						<span>OU (Organizational Unit)</span>
						<input
							class="form-input"
							bind:value={draftCertificateSubject.organizationalUnitName}
							placeholder="Security"
							disabled={savingSettings}
						/>
					</label>
					<label>
						<span>CN (Common Name)</span>
						<input
							class="form-input"
							bind:value={draftCertificateSubject.commonName}
							placeholder="Authrim SAML Signing"
							disabled={savingSettings}
						/>
					</label>
				</div>

				<div class="entity-warning">
					<i class="i-ph-warning-circle"></i>
					<span>
						Changing these values affects newly generated certificates only. Existing federation
						partners may need updated metadata after a certificate is recreated or rolled over.
					</span>
				</div>

				<div class="form-actions">
					<button
						class="btn btn-primary btn-sm"
						onclick={saveCertificateSubject}
						disabled={savingSettings || !hasCertificateSubjectChanges}
					>
						{savingSettings ? 'Saving...' : 'Save Signing Certificate Subject'}
					</button>
				</div>
			</div>

			<div class="panel">
				<div class="panel-header compact-panel-header">
					<div>
						<h2 class="panel-title">Signing Rollover</h2>
						<p class="form-hint">
							Recreate, publish, promote, or retire SAML signing keys for Authrim IdP/SP metadata.
						</p>
					</div>
				</div>

				<div class="local-signing-grid">
					{#each signingRoles as role (role)}
						{@const policy = localSigningPolicy(role)}
						<section class="local-signing-card">
							<div>
								<div class="preview-heading">{roleLabel(role)} Signing Rollover</div>
								<p class="form-hint">{policySummary(policy)}</p>
							</div>
							<div class="local-signing-actions">
								<button
									class="btn btn-secondary btn-sm"
									onclick={() => runLocalSigningAction(role, 'recreate_active')}
									disabled={!!signingAction}
								>
									Recreate active
								</button>
								<button
									class="btn btn-secondary btn-sm"
									onclick={() => runLocalSigningAction(role, 'publish_next')}
									disabled={!!signingAction}
								>
									Publish next
								</button>
								<button
									class="btn btn-secondary btn-sm"
									onclick={() => runLocalSigningAction(role, 'promote_next')}
									disabled={!!signingAction || !policy.next?.kid}
								>
									Promote next
								</button>
								<button
									class="btn btn-secondary btn-sm"
									onclick={() => runLocalSigningAction(role, 'retire_backup')}
									disabled={!!signingAction || !policy.backup?.kid}
								>
									Retire backup
								</button>
							</div>
						</section>
					{/each}
				</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	.link-button {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin: 0 0 8px;
		padding: 0;
		border: none;
		background: transparent;
		color: var(--primary);
		cursor: pointer;
		font: inherit;
		font-size: 0.875rem;
	}

	.compact-panel-header {
		align-items: flex-start;
	}

	.fingerprint-grid {
		display: grid;
		gap: 10px;
		margin-top: 16px;
	}

	.info-row-list {
		display: flex;
		flex-direction: column;
		margin-top: 10px;
	}

	.fingerprint-grid {
		gap: 2px;
	}

	.reference-row {
		display: grid;
		grid-template-columns: 220px minmax(0, 1fr);
		gap: 12px;
		align-items: center;
		padding: 7px 0;
		border-bottom: 1px solid var(--border-color);
	}

	.reference-row:last-child {
		border-bottom: 0;
	}

	.reference-label,
	.preview-label {
		color: var(--text-secondary);
		font-size: 0.8125rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.reference-value-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.reference-value {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		flex: 1;
		color: var(--text-primary);
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-decoration: none;
	}

	a.reference-value {
		color: var(--primary);
	}

	a.reference-value:hover {
		text-decoration: underline;
	}

	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: 1px solid var(--border-color);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		flex: 0 0 auto;
	}

	.icon-btn:hover {
		background: var(--bg-subtle);
		color: var(--text-primary);
	}

	.icon-btn.copied {
		border-color: var(--success);
		color: var(--success);
	}

	.form-field-row {
		display: grid;
		grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
		column-gap: 36px;
		align-items: center;
		min-width: 0;
		padding: 10px 0;
		border-bottom: 1px solid var(--border-color);
	}

	.form-field-row:last-child {
		border-bottom: 0;
	}

	.field-copy-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto 28px;
		gap: 10px;
		align-items: center;
		min-width: 0;
	}

	.copy-textarea {
		width: 100%;
		min-width: 0;
		padding: 9px 10px;
		border: 1px solid var(--border-color);
		border-radius: var(--radius-sm);
		background: var(--bg-subtle);
		color: var(--text-primary);
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		line-height: 1.45;
	}

	.copy-textarea {
		resize: vertical;
	}

	.copy-textarea:focus {
		outline: 2px solid rgba(59, 130, 246, 0.45);
		outline-offset: 1px;
	}

	.certificate-textarea {
		min-height: 220px;
		white-space: pre;
	}

	.entity-layout {
		display: grid;
		grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
		gap: 20px;
		margin-top: 16px;
		align-items: start;
	}

	.entity-options {
		display: grid;
		gap: 8px;
	}

	.entity-option {
		display: grid;
		grid-template-columns: 18px minmax(0, 1fr);
		gap: 10px;
		align-items: flex-start;
		padding: 10px 12px;
		border: 1px solid var(--border-color);
		border-radius: var(--radius-md);
		background: var(--surface);
		cursor: pointer;
	}

	.entity-option input {
		margin-top: 2px;
	}

	.entity-option strong,
	.entity-option small {
		display: block;
	}

	.entity-option strong {
		color: var(--text-primary);
		font-size: 0.875rem;
	}

	.entity-option small {
		margin-top: 2px;
		color: var(--text-secondary);
		font-size: 0.75rem;
		line-height: 1.35;
	}

	.entity-current {
		display: grid;
		gap: 10px;
		min-width: 0;
	}

	.entity-preview-group,
	.metadata-summary,
	.certificate-card {
		border: 1px solid var(--border-color);
		border-radius: var(--radius-md);
		background: var(--surface);
	}

	.entity-preview-group {
		display: grid;
		gap: 6px;
		padding: 10px 12px;
		min-width: 0;
	}

	.pending-preview {
		border-color: rgba(245, 158, 11, 0.45);
		background: rgba(245, 158, 11, 0.08);
	}

	.login-policy {
		display: grid;
		gap: 14px;
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--border-color);
	}

	.section-copy {
		display: grid;
		gap: 5px;
		min-width: 0;
	}

	.section-copy .form-hint {
		white-space: nowrap;
	}

	.section-heading {
		color: var(--text-primary);
		font-size: 0.9375rem;
		font-weight: 700;
	}

	.login-policy-layout {
		display: grid;
		grid-template-columns: minmax(240px, 340px) minmax(0, 1fr);
		gap: 20px;
		align-items: start;
	}

	.login-policy-choice {
		display: grid;
		gap: 10px;
	}

	.login-policy-preview {
		display: grid;
		gap: 12px;
		min-width: 0;
		padding: 12px;
		border: 1px solid var(--border-color);
		border-radius: var(--radius-md);
		background: var(--surface);
	}

	.route-preview {
		display: grid;
		gap: 10px;
		padding-top: 10px;
		border-top: 1px solid var(--border-color);
	}

	.preview-heading {
		color: var(--text-primary);
		font-size: 0.8125rem;
		font-weight: 700;
	}

	.inline-warning {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		color: var(--warning);
		font-size: 0.8125rem;
		line-height: 1.45;
	}

	.inline-warning i {
		margin-top: 2px;
		flex: 0 0 auto;
	}

	.route-steps {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.route-step {
		display: grid;
		grid-template-columns: 24px minmax(0, 1fr);
		gap: 10px;
		align-items: flex-start;
	}

	.route-step-index {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: 999px;
		background: var(--bg-subtle);
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 700;
	}

	.route-step strong,
	.route-step-url,
	.route-step small {
		display: block;
		min-width: 0;
	}

	.route-step strong {
		color: var(--text-primary);
		font-size: 0.8125rem;
	}

	.route-step-url {
		margin-top: 2px;
		color: var(--primary);
		font-family: var(--font-mono);
		font-size: 0.75rem;
		overflow-wrap: anywhere;
	}

	.route-step small {
		margin-top: 3px;
		color: var(--text-secondary);
		font-size: 0.75rem;
		line-height: 1.4;
	}

	.metadata-summary {
		display: grid;
		gap: 12px;
		margin-top: 14px;
		padding: 12px;
	}

	.metadata-summary-header,
	.metadata-badges,
	.certificate-header,
	.certificate-actions {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}

	.metadata-summary-header,
	.certificate-header {
		justify-content: space-between;
	}

	.metadata-badges,
	.certificate-actions {
		flex-wrap: wrap;
		justify-content: flex-end;
		flex: 0 0 auto;
	}

	.metadata-grid,
	.certificate-info-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 10px;
	}

	.subject-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 10px;
	}

	.subject-grid label {
		display: grid;
		gap: 5px;
		min-width: 0;
	}

	.subject-grid span {
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 700;
	}

	.local-signing-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
		margin-top: 14px;
	}

	.local-signing-card {
		display: grid;
		gap: 12px;
		padding: 12px;
		border: 1px solid var(--border-color);
		border-radius: var(--radius-md);
		background: var(--surface);
	}

	.local-signing-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.certificate-info-grid {
		grid-template-columns: repeat(3, minmax(0, 1fr));
		margin-top: 14px;
	}

	.metadata-grid > div,
	.certificate-info-grid > div {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	.metadata-grid strong,
	.certificate-info-grid strong {
		color: var(--text-primary);
		font-size: 0.8125rem;
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.certificate-info-grid span {
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.entity-warning {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		margin-top: 12px;
		color: var(--text-secondary);
		font-size: 0.8125rem;
		line-height: 1.45;
	}

	.entity-warning i {
		margin-top: 2px;
		color: var(--warning);
		flex: 0 0 auto;
	}

	.form-actions {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
		margin-top: 16px;
	}

	.dr-bundle-fields {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 320px));
		gap: 10px;
		margin-top: 14px;
	}

	.dr-bundle-fields label {
		display: grid;
		gap: 6px;
	}

	.hidden-file-input {
		display: none;
	}

	.metadata-panel {
		margin-top: 16px;
	}

	.metadata-section {
		display: grid;
		gap: 8px;
		margin-top: 16px;
	}

	.certificate-list {
		display: grid;
		gap: 12px;
		margin-top: 16px;
	}

	.certificate-card {
		padding: 14px;
	}

	.certificate-header h3 {
		margin: 0;
		color: var(--text-primary);
		font-size: 1rem;
	}

	.certificate-header p {
		margin: 3px 0 0;
		color: var(--text-secondary);
		font-size: 0.8125rem;
	}

	.certificate-warnings {
		display: grid;
		gap: 6px;
		margin-top: 12px;
		color: var(--warning);
		font-size: 0.8125rem;
	}

	.certificate-warnings span {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.certificate-pem {
		display: grid;
		gap: 8px;
		margin-top: 14px;
	}

	.certificate-pem summary {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		width: fit-content;
		color: var(--text-secondary);
		font-size: 0.8125rem;
		font-weight: 700;
		cursor: pointer;
		user-select: none;
	}

	.certificate-pem summary::-webkit-details-marker {
		display: none;
	}

	.certificate-pem summary i {
		transition: transform 0.16s ease;
	}

	.certificate-pem[open] summary i {
		transform: rotate(90deg);
	}

	.certificate-pem .field-copy-row {
		grid-template-columns: minmax(0, 1fr) 28px;
		margin-top: 8px;
		align-items: start;
	}

	.compact-empty {
		padding: 24px;
	}

	@media (max-width: 900px) {
		.reference-row,
		.form-field-row,
		.entity-layout,
		.login-policy-layout,
		.metadata-grid,
		.subject-grid,
		.local-signing-grid,
		.certificate-info-grid,
		.metadata-summary-header,
		.certificate-header {
			grid-template-columns: 1fr;
			display: grid;
		}

		.metadata-badges,
		.certificate-actions {
			justify-content: flex-start;
		}

		.section-copy .form-hint {
			white-space: normal;
		}
	}
</style>
