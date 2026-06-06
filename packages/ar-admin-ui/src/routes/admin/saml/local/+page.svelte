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
		type SAMLSigningKeyReference,
		type SAMLSigningKeyPolicy,
		type SAMLSettings,
		type SAMLTrustCertificatePreview
	} from '$lib/api/admin-saml';
	import { parseDiscoveryMethods } from '$lib/admin/tenant-discovery-settings';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { getLocale, LL } from '$i18n/i18n-svelte';

	type MetadataRole = 'idp' | 'sp';
	type LoginEntryMode = 'tenant_only' | 'discovery_optional' | 'discovery_required';
	type SigningCertificateSlot = 'active' | 'next' | 'backup';
	type LocalSigningAction =
		| 'recreate_active'
		| 'publish_next'
		| 'promote_next'
		| 'retire_backup'
		| 'delete_next';

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

	interface SigningCertificateStatusRow {
		id: string;
		slot: SigningCertificateSlot;
		label: string;
		description: string;
		status: string;
		reference?: SAMLSigningKeyReference;
		publishedCertificate?: PublishedCertificate;
		isSigning: boolean;
		isStored: boolean;
		isPublished: boolean;
		createdAt?: string | number;
		validFrom?: string | number;
		validTo?: string | number;
		maxReferenceUntil?: number;
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
	let error = $state('');
	let actionMessage = $state('');
	let copiedKey = $state('');
	let selectedSigningRows = $state<Record<MetadataRole, string>>({
		idp: 'active',
		sp: 'active'
	});
	let selectedCertificateDetail = $state<{
		role: MetadataRole;
		row: SigningCertificateStatusRow;
		certificate: string;
		preview?: SAMLTrustCertificatePreview;
		error?: string;
		loading: boolean;
	} | null>(null);
	let draftEntityIdStyle = $state<SAMLEntityIdStyle>('metadata_url');
	let draftInteractiveLoginUrlPolicy = $state<SAMLInteractiveLoginUrlPolicy>('tenant_host');
	let draftCertificateRole = $state<MetadataRole>('idp');
	let draftCertificateValidFrom = $state('');
	let draftCertificateValidTo = $state(defaultCertificateValidTo());
	let draftCertificatePublicKeyAlgorithm = $state<'RSA'>('RSA');
	let draftCertificatePublicKeySizeBits = $state<2048 | 3072 | 4096>(3072);
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
	const effectiveTenantLoginEntrySettings = $derived(
		tenantLoginEntrySettings?.overrideEnabled ? tenantLoginEntrySettings : commonLoginEntrySettings
	);
	const selectedSAMLLoginUrl = $derived(buildSAMLLoginUrl(draftInteractiveLoginUrlPolicy));
	const loginRouteSteps = $derived(buildLoginRouteSteps(draftInteractiveLoginUrlPolicy));
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
							err instanceof Error ? err.message : $LL.admin_saml_local_error_load_discovery();
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
			error = err instanceof Error ? err.message : $LL.admin_saml_local_error_load_entity();
		} finally {
			loading = false;
		}
	}

	async function loadMetadataDocuments(info: TenantInfo): Promise<MetadataDocument[]> {
		const targets = [
			{
				role: 'idp' as const,
				label: $LL.admin_saml_local_authrim_idp_metadata(),
				url: info.saml.idp_metadata
			},
			{
				role: 'sp' as const,
				label: $LL.admin_saml_local_authrim_sp_metadata(),
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
			const url = new URL(target.url);
			url.searchParams.set('_authrim_admin_preview', String(Date.now()));
			const response = await fetch(url, {
				cache: 'no-store',
				credentials: 'include'
			});
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
							error:
								err instanceof Error ? err.message : $LL.admin_saml_local_error_parse_certificate()
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
				error: err instanceof Error ? err.message : $LL.admin_saml_local_error_load_metadata()
			};
		}
	}

	function parseMetadataXml(xml: string, role: MetadataRole) {
		const doc = new DOMParser().parseFromString(xml, 'application/xml');
		const parserError = doc.querySelector('parsererror');
		if (parserError) {
			throw new Error(parserError.textContent || $LL.admin_saml_local_error_invalid_metadata());
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
		return date.toLocaleString(getLocale() === 'ja' ? 'ja-JP' : 'en-US');
	}

	function entityIdStyleLabel(style: SAMLEntityIdStyle) {
		return style === 'metadata_url'
			? $LL.admin_saml_local_metadata_url()
			: $LL.admin_saml_local_role_url();
	}

	function interactiveLoginPolicyLabel(policy: SAMLInteractiveLoginUrlPolicy) {
		return policy === 'tenant_host'
			? $LL.admin_saml_local_tenant_host()
			: $LL.admin_saml_local_ui_base_url();
	}

	function metadataSigningLabel(settings: SAMLSettings) {
		return settings.metadata.signingEnabled
			? $LL.admin_saml_local_signed_metadata()
			: $LL.admin_saml_local_unsigned_metadata();
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

	function rolloverCertificateRows(
		role: MetadataRole,
		policy: SAMLSigningKeyPolicy
	): SigningCertificateStatusRow[] {
		const activePublished = metadataCertificateForSlot(role, 'active');
		const nextReferences = nextSigningReferences(policy);
		const backupPublished = publishedCertificateForReference(
			role,
			policy.backup,
			nextReferences.length + 1
		);

		const rows = [
			buildSigningCertificateStatusRow(
				'active',
				'active',
				$LL.admin_saml_local_rollover_active_label(),
				$LL.admin_saml_local_rollover_active_desc(),
				policy.active,
				activePublished,
				true
			),
			...nextReferences.map((reference, index) =>
				buildSigningCertificateStatusRow(
					signingReferenceRowId('next', reference, index),
					'next',
					nextReferences.length > 1
						? `${$LL.admin_saml_local_rollover_next_label()} ${index + 1}`
						: $LL.admin_saml_local_rollover_next_label(),
					$LL.admin_saml_local_rollover_next_desc(),
					reference,
					publishedCertificateForReference(role, reference, index + 1),
					false
				)
			),
			buildSigningCertificateStatusRow(
				'backup',
				'backup',
				$LL.admin_saml_local_rollover_backup_label(),
				$LL.admin_saml_local_rollover_backup_desc(),
				policy.backup,
				backupPublished,
				false
			)
		];
		return rows;
	}

	function buildSigningCertificateStatusRow(
		id: string,
		slot: SigningCertificateSlot,
		label: string,
		description: string,
		reference: SAMLSigningKeyReference | undefined,
		publishedCertificate: PublishedCertificate | undefined,
		isSigning: boolean
	): SigningCertificateStatusRow {
		const isStored = !!reference?.kid || !!reference?.keyRef || !!publishedCertificate;
		const isPublished = !!publishedCertificate;
		const createdAt = certificateCreatedAt(reference, publishedCertificate);
		const maxReferenceUntil =
			isPublished && samlSettings
				? Date.now() + parseMetadataCacheDurationMs(samlSettings.metadata.cacheDuration)
				: undefined;

		return {
			id,
			slot,
			label,
			description,
			status: certificateStatusLabel(slot, isSigning, isStored, isPublished),
			reference,
			publishedCertificate,
			isSigning: isSigning && isStored,
			isStored,
			isPublished,
			createdAt,
			validFrom: publishedCertificate?.preview?.validFrom ?? reference?.validFrom,
			validTo: publishedCertificate?.preview?.validTo ?? reference?.validTo,
			maxReferenceUntil
		};
	}

	function metadataCertificateForSlot(role: MetadataRole, slot: SigningCertificateSlot) {
		const doc = metadataDocs.find((entry) => entry.role === role);
		if (!doc) return undefined;
		const index = slot === 'active' ? 0 : slot === 'next' ? 1 : 2;
		return doc.certificates[index];
	}

	function publishedCertificateForReference(
		role: MetadataRole,
		reference: SAMLSigningKeyReference | undefined,
		fallbackIndex: number
	) {
		const doc = metadataDocs.find((entry) => entry.role === role);
		if (!doc) return undefined;
		if (reference?.certificate) {
			const matched = doc.certificates.find(
				(certificate) => certificate.certificate === reference.certificate
			);
			if (matched) return matched;
		}
		return doc.certificates[fallbackIndex];
	}

	function nextSigningReferences(policy: SAMLSigningKeyPolicy) {
		const references = [policy.next, ...(policy.nextCandidates ?? [])].filter(
			(reference): reference is SAMLSigningKeyReference => !!reference
		);
		const seen = new Set<string>();
		return references.filter((reference) => {
			const key = reference.kid ?? reference.keyRef ?? reference.certificate ?? reference.id;
			if (!key) return true;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}

	function signingReferenceRowId(
		slot: SigningCertificateSlot,
		reference: SAMLSigningKeyReference | undefined,
		index = 0
	) {
		return reference?.kid ?? reference?.keyRef ?? reference?.id ?? `${slot}:${index}`;
	}

	function certificateStatusLabel(
		slot: SigningCertificateSlot,
		isSigning: boolean,
		isStored: boolean,
		_isPublished: boolean
	) {
		if (!isStored) {
			return slot === 'active'
				? $LL.admin_saml_local_rollover_status_default_active()
				: $LL.admin_saml_local_rollover_status_not_configured();
		}
		if (isSigning) return $LL.admin_saml_local_rollover_status_signing();
		return $LL.admin_saml_local_rollover_status_stored_only();
	}

	function certificateCreatedAt(
		reference: SAMLSigningKeyReference | undefined,
		publishedCertificate: PublishedCertificate | undefined
	) {
		return (
			reference?.plannedActivationAt ??
			reference?.metadataPublishFrom ??
			keyCreatedAt(reference?.kid) ??
			publishedCertificate?.preview?.validFrom
		);
	}

	function keyCreatedAt(kid: string | undefined) {
		const match = /^key-(\d{12,})-/.exec(kid ?? '');
		if (!match) return undefined;
		const value = Number(match[1]);
		return Number.isFinite(value) ? value : undefined;
	}

	function parseMetadataCacheDurationMs(value: string | undefined) {
		const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value ?? '');
		if (!match) return 24 * 60 * 60 * 1000;
		const hours = Number(match[1] ?? 0);
		const minutes = Number(match[2] ?? 0);
		const seconds = Number(match[3] ?? 0);
		return ((hours * 60 + minutes) * 60 + seconds) * 1000;
	}

	function defaultCertificateValidTo() {
		const date = new Date();
		date.setUTCFullYear(date.getUTCFullYear() + 10);
		return dateToLocalDateTime(date);
	}

	function dateToLocalDateTime(date: Date) {
		const local = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
		return local.toISOString().slice(0, 16);
	}

	function localDateTimeToIso(value: string) {
		if (!value) return undefined;
		const date = new Date(value);
		return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
	}

	function yesNo(value: boolean) {
		return value ? $LL.admin_saml_local_yes() : $LL.admin_saml_local_no();
	}

	function selectedSigningRowId(role: MetadataRole) {
		return selectedSigningRows[role] ?? 'active';
	}

	function selectSigningRow(role: MetadataRole, row: SigningCertificateStatusRow) {
		selectedSigningRows[role] = row.id;
	}

	function selectedSigningRow(
		role: MetadataRole,
		policy: SAMLSigningKeyPolicy
	): SigningCertificateStatusRow {
		const rows = rolloverCertificateRows(role, policy);
		return rows.find((row) => row.id === selectedSigningRowId(role)) ?? rows[0];
	}

	function selectedSlotCanRun(
		role: MetadataRole,
		policy: SAMLSigningKeyPolicy,
		slot: SigningCertificateSlot
	) {
		const row = selectedSigningRow(role, policy);
		if (signingAction || row.slot !== slot) return false;
		if (slot === 'next') return !!row.reference?.kid || !!row.reference?.keyRef;
		if (slot === 'backup') return !!row.reference?.kid || !!row.reference?.keyRef;
		return true;
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
					title: $LL.admin_saml_local_route_saml_redirect(),
					url: tenantLogin,
					detail: $LL.admin_saml_local_route_tenant_login_detail()
				}
			];

			if (
				tenantInfo?.discover_url &&
				effectiveTenantLoginEntrySettings?.mode !== 'tenant_only' &&
				effectiveTenantLoginEntrySettings?.requireCommonDiscoveryBeforeLogin
			) {
				steps.push({
					title: $LL.admin_saml_local_route_common_discovery_gate(),
					url: discoverUrlWithTenantReturn(),
					detail: $LL.admin_saml_local_route_common_discovery_detail()
				});
			} else {
				steps.push({
					title: $LL.admin_saml_local_route_first_visible_page(),
					url: tenantLogin,
					detail: $LL.admin_saml_local_route_direct_login_detail()
				});
			}

			return steps;
		}

		return [
			{
				title: $LL.admin_saml_local_route_saml_redirect(),
				url: uiBaseLogin,
				detail: $LL.admin_saml_local_route_ui_base_detail()
			},
			{
				title: $LL.admin_saml_local_route_first_visible_page(),
				url: discoverUrl(),
				detail: discoveryFirstPageDescription(commonLoginEntrySettings)
			},
			{
				title: $LL.admin_saml_local_route_after_tenant_resolution(),
				url: tenantLogin,
				detail: $LL.admin_saml_local_route_after_resolution_detail()
			}
		];
	}

	function discoveryFirstPageDescription(settings: LoginEntryPreviewSettings | null) {
		if (!tenantInfo?.discover_url) {
			return $LL.admin_saml_local_discovery_no_url();
		}
		if (!settings) {
			return $LL.admin_saml_local_discovery_load_failed();
		}
		if (settings.mode === 'tenant_only') {
			return $LL.admin_saml_local_discovery_tenant_only();
		}
		const methods = settings.discoveryMethods;
		if (methods.length === 1 && methods[0] === 'wayf') {
			return $LL.admin_saml_local_discovery_wayf();
		}
		return $LL.admin_saml_local_discovery_methods({ methods: formatDiscoveryMethods(methods) });
	}

	function formatDiscoveryMethods(methods: string[]) {
		if (methods.length === 0) return $LL.admin_saml_local_discovery_none_configured();
		return methods
			.map((method) => {
				switch (method) {
					case 'email_domain':
						return $LL.admin_saml_local_discovery_email_domain();
					case 'tenant_code':
						return $LL.admin_saml_local_discovery_tenant_code();
					case 'tenant_slug':
						return $LL.admin_saml_local_discovery_tenant_slug();
					case 'wayf':
						return $LL.admin_saml_local_discovery_wayf_dropdown();
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
			actionMessage = $LL.admin_saml_local_settings_updated();
			if (tenantInfo?.components.saml) {
				metadataDocs = await loadMetadataDocuments(tenantInfo);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_saml_local_error_update_settings();
		} finally {
			savingSettings = false;
		}
	}

	function applyActiveCertificateSubject() {
		const activeSubject = metadataCertificateForSlot(draftCertificateRole, 'active')?.preview
			?.subject;
		const parsed = parseCertificateSubject(activeSubject);
		if (!parsed) return;
		draftCertificateSubject = parsed;
	}

	function parseCertificateSubject(
		subject: string | undefined
	): SAMLSigningCertificateSubject | null {
		if (!subject) return null;
		const values: Partial<SAMLSigningCertificateSubject> = {};
		for (const part of subject.split(',')) {
			const [rawKey, ...rawValueParts] = part.trim().split('=');
			const value = rawValueParts.join('=').trim();
			switch (rawKey?.trim()) {
				case 'C':
					values.countryName = value;
					break;
				case 'ST':
					values.stateOrProvinceName = value;
					break;
				case 'L':
					values.localityName = value;
					break;
				case 'O':
					values.organizationName = value;
					break;
				case 'OU':
					values.organizationalUnitName = value;
					break;
				case 'CN':
					values.commonName = value;
					break;
			}
		}
		return normalizeSubjectForForm(values);
	}

	async function createRolloverCertificate() {
		if (!samlSettings || savingSettings || signingAction) return;
		savingSettings = true;
		try {
			await runLocalSigningAction(draftCertificateRole, 'publish_next');
		} finally {
			savingSettings = false;
		}
	}

	async function runLocalSigningAction(
		role: MetadataRole,
		action: LocalSigningAction,
		row?: SigningCertificateStatusRow
	) {
		if (signingAction) return;
		signingAction = `${role}:${action}`;
		actionMessage = '';
		error = '';
		try {
			samlSettings = await adminSAMLAPI.updateLocalSigning({
				role,
				action,
				certificateSubject: draftCertificateSubject,
				keepPreviousAsBackup: true,
				targetKid: row?.reference?.kid,
				targetKeyRef: row?.reference?.keyRef,
				validFrom: localDateTimeToIso(draftCertificateValidFrom),
				validTo: localDateTimeToIso(draftCertificateValidTo),
				publicKeyAlgorithm: draftCertificatePublicKeyAlgorithm,
				publicKeySizeBits: draftCertificatePublicKeySizeBits
			});
			draftCertificateSubject = currentCertificateSubject();
			actionMessage = $LL.admin_saml_local_certificate_settings_updated();
			if (tenantInfo?.components.saml) {
				metadataDocs = await loadMetadataDocuments(tenantInfo);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_saml_local_error_update_certificate();
		} finally {
			signingAction = '';
		}
	}

	async function openCertificateDetail(role: MetadataRole, row: SigningCertificateStatusRow) {
		const certificate = row.reference?.certificate ?? row.publishedCertificate?.certificate ?? '';
		if (!certificate) {
			selectedCertificateDetail = {
				role,
				row,
				certificate,
				loading: false,
				error: $LL.admin_saml_local_rollover_detail_no_certificate()
			};
			return;
		}

		selectedCertificateDetail = {
			role,
			row,
			certificate,
			preview: row.publishedCertificate?.preview,
			loading: !row.publishedCertificate?.preview
		};

		if (row.publishedCertificate?.preview) return;

		try {
			const preview = await adminSAMLAPI.previewTrustCertificate({ certificate });
			if (selectedCertificateDetail?.role === role && selectedCertificateDetail.row.id === row.id) {
				selectedCertificateDetail = {
					...selectedCertificateDetail,
					preview,
					loading: false
				};
			}
		} catch (err) {
			if (selectedCertificateDetail?.role === role && selectedCertificateDetail.row.id === row.id) {
				selectedCertificateDetail = {
					...selectedCertificateDetail,
					loading: false,
					error: err instanceof Error ? err.message : $LL.admin_saml_local_error_parse_certificate()
				};
			}
		}
	}

	function closeCertificateDetail() {
		selectedCertificateDetail = null;
	}

	function canDeleteSelectedSlot(role: MetadataRole, policy: SAMLSigningKeyPolicy) {
		const row = selectedSigningRow(role, policy);
		if (signingAction || row.slot === 'active') return false;
		return !!row.reference?.kid || !!row.reference?.certificate;
	}

	async function deleteSelectedSigningCertificate(
		role: MetadataRole,
		policy: SAMLSigningKeyPolicy
	) {
		await deleteSigningCertificate(role, selectedSigningRow(role, policy));
	}

	async function deleteSigningCertificate(role: MetadataRole, row: SigningCertificateStatusRow) {
		if (row.slot === 'active' || signingAction) return;
		if (!row.reference?.kid && !row.reference?.certificate) return;
		await runLocalSigningAction(role, row.slot === 'next' ? 'delete_next' : 'retire_backup', row);
		selectedSigningRows[role] = 'active';
	}
</script>

<svelte:head>
	<title>{$LL.admin_saml_local_page_title()}</title>
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
				title={$LL.admin_saml_local_copy()}
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
				title={$LL.admin_saml_local_copy()}
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
				{$LL.admin_saml_local_back()}
			</button>
			<h1 class="page-title">{$LL.admin_saml_local_title()}</h1>
			<p class="page-description">{$LL.admin_saml_local_description()}</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-secondary" onclick={() => goto('/admin/dr-backup')}>
				<i class="i-ph-cloud-arrow-up"></i>
				{$LL.admin_dr_backup_saml_bundle_title()}
			</button>
			<button class="btn btn-secondary" onclick={load} disabled={loading}>
				<i class="i-ph-arrow-clockwise"></i>
				{$LL.admin_saml_refresh()}
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
			<p>{$LL.admin_saml_loading()}</p>
		</div>
	{:else}
		{#if !tenantInfo?.components.saml}
			<div class="panel">
				<div class="panel-header compact-panel-header">
					<div>
						<h2 class="panel-title">{$LL.admin_saml_local_metadata_title()}</h2>
						<p class="form-hint">{$LL.admin_saml_local_metadata_desc()}</p>
					</div>
					<span class="badge badge-neutral">{$LL.admin_saml_local_not_deployed()}</span>
				</div>
				<div class="empty-state compact-empty">{$LL.admin_saml_local_worker_not_deployed()}</div>
			</div>
		{/if}

		{#if tenantInfo}
			{#each metadataDocs as doc (doc.role)}
				<div class="panel metadata-panel">
					<div class="panel-header compact-panel-header">
						<div>
							<h2 class="panel-title">{doc.label}</h2>
							<p class="form-hint">
								{doc.role === 'idp'
									? $LL.admin_saml_local_idp_registration_hint()
									: $LL.admin_saml_local_sp_registration_hint()}
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
								{$LL.admin_saml_local_download_xml()}
							</button>
						</div>
					</div>

					{#if doc.error}
						<div class="alert alert-error">{doc.error}</div>
					{:else}
						<div class="metadata-section">
							<div class="preview-heading">{$LL.admin_saml_local_endpoint_references()}</div>
							<div class="info-row-list">
								{#if doc.role === 'idp'}
									{@render fieldRow($LL.admin_saml_local_sso(), tenantInfo.saml.sso, 'saml_sso')}
									{@render fieldRow(
										$LL.admin_saml_local_idp_metadata_url(),
										tenantInfo.saml.idp_metadata,
										'saml_idp_metadata',
										tenantInfo.saml.idp_metadata
									)}
									{@render fieldRow(
										$LL.admin_saml_local_slo(),
										tenantInfo.saml.slo,
										'saml_idp_slo'
									)}
								{:else}
									{@render fieldRow($LL.admin_saml_local_acs(), tenantInfo.saml.acs, 'saml_acs')}
									{@render fieldRow(
										$LL.admin_saml_local_sp_metadata_url(),
										tenantInfo.saml.sp_metadata ?? tenantInfo.saml.metadata,
										'saml_sp_metadata',
										tenantInfo.saml.sp_metadata ?? tenantInfo.saml.metadata
									)}
									{@render fieldRow($LL.admin_saml_local_slo(), tenantInfo.saml.slo, 'saml_sp_slo')}
								{/if}
							</div>
						</div>

						<div class="metadata-section">
							<div class="preview-heading">{$LL.admin_saml_local_registration_values()}</div>
							<div class="info-row-list">
								{@render fieldRow(
									$LL.admin_saml_local_role_entity_id({ role: roleLabel(doc.role) }),
									doc.entityId,
									`${doc.role}_metadata_entity`
								)}
								{@render fieldRow(
									$LL.admin_saml_local_scope(),
									scopeFromUrl(doc.entityId),
									`${doc.role}_scope`
								)}
							</div>
						</div>

						{#if doc.certificates.length === 0}
							<div class="empty-state compact-empty">
								{$LL.admin_saml_local_no_certificates()}
							</div>
						{:else}
							<div class="certificate-list">
								{#each doc.certificates as certificate (certificate.id)}
									<section class="certificate-card">
										<div class="certificate-header">
											<div>
												<h3>
													{$LL.admin_saml_local_certificate_heading({
														role: roleLabel(certificate.role),
														index: certificate.index
													})}
												</h3>
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
													{$LL.admin_saml_local_copy_pem()}
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
													{$LL.admin_saml_local_download_pem()}
												</button>
											</div>
										</div>

										{#if certificate.preview}
											<div class="certificate-info-grid">
												<div>
													<span>{$LL.admin_saml_local_subject()}</span><strong
														>{certificate.preview.subject}</strong
													>
												</div>
												<div>
													<span>{$LL.admin_saml_local_issuer()}</span><strong
														>{certificate.preview.issuer}</strong
													>
												</div>
												<div>
													<span>{$LL.admin_saml_local_valid_from()}</span><strong
														>{formatDateTime(certificate.preview.validFrom)}</strong
													>
												</div>
												<div>
													<span>{$LL.admin_saml_local_valid_to()}</span><strong
														>{formatDateTime(certificate.preview.validTo)}</strong
													>
												</div>
												<div>
													<span>{$LL.admin_saml_local_signature()}</span><strong
														>{certificate.preview.signatureAlgorithm}</strong
													>
												</div>
												<div>
													<span>{$LL.admin_saml_local_public_key()}</span>
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
													$LL.admin_saml_local_sha1_fingerprint(),
													fingerprint(certificate.preview.fingerprintSha1),
													`${certificate.id}_sha1`
												)}
												{@render endpointRow(
													$LL.admin_saml_local_sha256_fingerprint(),
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
												<span>{$LL.admin_saml_local_certificate_pem()}</span>
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
													title={$LL.admin_saml_local_copy()}
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
						<h2 class="panel-title">{$LL.admin_saml_local_published_entity_ids()}</h2>
						<p class="form-hint">{$LL.admin_saml_local_published_entity_ids_desc()}</p>
					</div>
					<div class="metadata-badges">
						<span class="badge badge-info">{entityIdStyleLabel(samlSettings.entityIdStyle)}</span>
						<span class="badge badge-info">
							{$LL.admin_saml_local_login_policy_badge({
								policy: interactiveLoginPolicyLabel(samlSettings.interactiveLoginUrlPolicy)
							})}
						</span>
					</div>
				</div>

				<div class="entity-layout">
					<div
						class="entity-options"
						role="radiogroup"
						aria-label={$LL.admin_saml_local_entity_id_style_aria()}
					>
						<label class="entity-option">
							<input
								type="radio"
								name="entityIdStyle"
								checked={draftEntityIdStyle === 'metadata_url'}
								onchange={() => (draftEntityIdStyle = 'metadata_url')}
								disabled={savingSettings}
							/>
							<span>
								<strong>{$LL.admin_saml_local_metadata_url()}</strong>
								<small>{$LL.admin_saml_local_metadata_url_desc()}</small>
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
								<strong>{$LL.admin_saml_local_role_url()}</strong>
								<small>{$LL.admin_saml_local_role_url_desc()}</small>
							</span>
						</label>
					</div>

					<div class="entity-current">
						<div class="entity-preview-group">
							<div class="preview-heading">{$LL.admin_saml_local_current_entity_ids()}</div>
							{@render fieldRow(
								$LL.admin_saml_local_idp_entity_id(),
								samlSettings.generated.idpEntityId,
								'idp_entity'
							)}
							{@render fieldRow(
								$LL.admin_saml_local_sp_entity_id(),
								samlSettings.generated.spEntityId,
								'sp_entity'
							)}
						</div>
						{#if draftEntityIdStyle !== samlSettings.entityIdStyle}
							<div class="entity-preview-group pending-preview">
								<div class="preview-heading">{$LL.admin_saml_local_after_save()}</div>
								{@render fieldRow(
									$LL.admin_saml_local_idp_entity_id(),
									buildEntityIdPreview('idp', draftEntityIdStyle),
									'idp_entity_next'
								)}
								{@render fieldRow(
									$LL.admin_saml_local_sp_entity_id(),
									buildEntityIdPreview('sp', draftEntityIdStyle),
									'sp_entity_next'
								)}
							</div>
						{/if}
					</div>
				</div>

				<div class="login-policy">
					<div class="section-copy">
						<div class="section-heading">{$LL.admin_saml_local_interactive_login_redirect()}</div>
						<p class="form-hint">{$LL.admin_saml_local_interactive_login_desc()}</p>
					</div>

					<div class="login-policy-layout">
						<div class="login-policy-choice">
							<div
								class="entity-options"
								role="radiogroup"
								aria-label={$LL.admin_saml_local_login_policy_aria()}
							>
								<label class="entity-option">
									<input
										type="radio"
										name="interactiveLoginUrlPolicy"
										checked={draftInteractiveLoginUrlPolicy === 'tenant_host'}
										onchange={() => (draftInteractiveLoginUrlPolicy = 'tenant_host')}
										disabled={savingSettings}
									/>
									<span>
										<strong>{$LL.admin_saml_local_tenant_host()}</strong>
										<small>{$LL.admin_saml_local_tenant_host_desc()}</small>
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
										<strong>{$LL.admin_saml_local_ui_base_url()}</strong>
										<small>{$LL.admin_saml_local_ui_base_url_desc()}</small>
									</span>
								</label>
							</div>
						</div>

						<div class="login-policy-preview">
							<div class="preview-heading">{$LL.admin_saml_local_selected_login_url()}</div>
							{@render fieldRow(
								$LL.admin_saml_local_login_url(),
								selectedSAMLLoginUrl,
								'selected_saml_login_url'
							)}

							<div class="route-preview">
								<div class="preview-heading">{$LL.admin_saml_local_displayed_page_flow()}</div>
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
							<div class="preview-heading">{$LL.admin_saml_local_metadata_publication()}</div>
							<p class="form-hint">{$LL.admin_saml_local_metadata_publication_desc()}</p>
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
								{samlSettings.metadata.validUntilEnabled
									? $LL.admin_saml_local_valid_until_enabled()
									: $LL.admin_saml_local_valid_until_disabled()}
							</span>
						</div>
					</div>

					<div class="metadata-grid">
						<div>
							<span class="preview-label">{$LL.admin_saml_local_idp_valid_until()}</span>
							<strong>{formatDateTime(samlSettings.metadata.idpValidUntil)}</strong>
						</div>
						<div>
							<span class="preview-label">{$LL.admin_saml_local_sp_valid_until()}</span>
							<strong>{formatDateTime(samlSettings.metadata.spValidUntil)}</strong>
						</div>
						<div>
							<span class="preview-label">{$LL.admin_saml_local_validity_window()}</span>
							<strong
								>{$LL.admin_saml_local_validity_days({
									days: samlSettings.metadata.validityDays
								})}</strong
							>
						</div>
						<div>
							<span class="preview-label">{$LL.admin_saml_local_cache_duration()}</span>
							<strong>{samlSettings.metadata.cacheDuration}</strong>
						</div>
					</div>
				</div>

				<div class="entity-warning">
					<i class="i-ph-warning-circle"></i>
					<span>{$LL.admin_saml_local_entity_warning()}</span>
				</div>

				<div class="form-actions">
					<button
						class="btn btn-primary btn-sm"
						onclick={saveSAMLSettings}
						disabled={savingSettings || !hasSAMLSettingsChanges}
					>
						{savingSettings ? $LL.admin_saml_local_saving() : $LL.admin_saml_local_save_settings()}
					</button>
				</div>
			</div>

			<div class="panel">
				<div class="panel-header compact-panel-header">
					<div>
						<h2 class="panel-title">{$LL.admin_saml_local_signing_rollover()}</h2>
						<p class="form-hint">{$LL.admin_saml_local_signing_rollover_desc()}</p>
						<p class="form-hint">{$LL.admin_saml_local_signing_rollover_role_note()}</p>
					</div>
				</div>

				<div class="local-signing-grid">
					{#each signingRoles as role (role)}
						{@const policy = localSigningPolicy(role)}
						<section class="local-signing-card">
							<div>
								<div class="preview-heading">
									{$LL.admin_saml_local_rollover_saved_certificates({ role: roleLabel(role) })}
								</div>
							</div>
							<div class="rollover-table-wrap">
								<table class="rollover-table">
									<thead>
										<tr>
											<th>{$LL.admin_saml_local_rollover_select_certificate()}</th>
											<th>{$LL.admin_saml_local_rollover_certificate()}</th>
											<th>{$LL.admin_saml_local_rollover_status()}</th>
											<th>{$LL.admin_saml_local_rollover_signing()}</th>
											<th>{$LL.admin_saml_local_rollover_stored()}</th>
											<th>{$LL.admin_saml_local_rollover_published()}</th>
											<th>{$LL.admin_saml_local_rollover_created()}</th>
											<th>{$LL.admin_saml_local_rollover_valid_from()}</th>
											<th>{$LL.admin_saml_local_rollover_valid_to()}</th>
											<th>{$LL.admin_saml_local_rollover_max_reference_until()}</th>
											<th>{$LL.admin_saml_local_rollover_row_actions()}</th>
										</tr>
									</thead>
									<tbody>
										{#each rolloverCertificateRows(role, policy) as row (row.id)}
											<tr>
												<td>
													<input
														type="radio"
														name={`saml-signing-slot-${role}`}
														checked={selectedSigningRowId(role) === row.id}
														aria-label={$LL.admin_saml_local_rollover_select_slot({
															role: roleLabel(role),
															slot: row.label
														})}
														onchange={() => selectSigningRow(role, row)}
													/>
												</td>
												<td>
													<strong>{row.label}</strong>
													<span>{row.description}</span>
													{#if row.reference?.kid}
														<code>{row.reference.kid}</code>
													{/if}
												</td>
												<td>
													<span
														class:status-active={row.isSigning}
														class:status-published={!row.isSigning && row.isPublished}
														class:status-muted={!row.isStored}
														class="rollover-status"
													>
														{row.status}
													</span>
												</td>
												<td>{yesNo(row.isSigning)}</td>
												<td>{yesNo(row.isStored)}</td>
												<td>{yesNo(row.isPublished)}</td>
												<td>{formatDateTime(row.createdAt)}</td>
												<td>{formatDateTime(row.validFrom)}</td>
												<td>{formatDateTime(row.validTo)}</td>
												<td>{formatDateTime(row.maxReferenceUntil)}</td>
												<td>
													<div class="rollover-row-actions">
														<button
															class="btn btn-secondary btn-xs"
															onclick={() => openCertificateDetail(role, row)}
															disabled={!row.reference?.certificate &&
																!row.publishedCertificate?.certificate}
														>
															{$LL.admin_saml_local_rollover_view_certificate()}
														</button>
														<button
															class="btn btn-danger btn-xs"
															onclick={() => {
																selectSigningRow(role, row);
																void deleteSigningCertificate(role, row);
															}}
															disabled={row.slot === 'active' ||
																!!signingAction ||
																(!row.reference?.kid && !row.reference?.certificate)}
															title={row.slot === 'active'
																? $LL.admin_saml_local_rollover_delete_active_disabled()
																: undefined}
														>
															{$LL.admin_saml_local_rollover_delete_certificate()}
														</button>
													</div>
												</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
							<div class="selected-action-label">
								{$LL.admin_saml_local_rollover_selected_actions()}
							</div>
							<div class="local-signing-actions">
								<button
									class="btn btn-secondary btn-sm"
									onclick={() =>
										runLocalSigningAction(role, 'promote_next', selectedSigningRow(role, policy))}
									disabled={!selectedSlotCanRun(role, policy, 'next')}
								>
									{$LL.admin_saml_local_promote_next()}
								</button>
								<button
									class="btn btn-secondary btn-sm"
									onclick={() =>
										runLocalSigningAction(role, 'retire_backup', selectedSigningRow(role, policy))}
									disabled={!selectedSlotCanRun(role, policy, 'backup')}
								>
									{$LL.admin_saml_local_retire_backup()}
								</button>
								<button
									class="btn btn-danger btn-sm"
									onclick={() => deleteSelectedSigningCertificate(role, policy)}
									disabled={!canDeleteSelectedSlot(role, policy)}
									title={selectedSigningRow(role, policy).slot === 'active'
										? $LL.admin_saml_local_rollover_delete_active_disabled()
										: undefined}
								>
									{$LL.admin_saml_local_rollover_delete_certificate()}
								</button>
							</div>
						</section>
					{/each}
				</div>

				<div class="rollover-action-notes">
					<div>
						<strong>{$LL.admin_saml_local_recreate_active()}</strong>
						<span>{$LL.admin_saml_local_rollover_recreate_active_note()}</span>
					</div>
					<div>
						<strong>{$LL.admin_saml_local_publish_next()}</strong>
						<span>{$LL.admin_saml_local_rollover_publish_next_note()}</span>
					</div>
					<div>
						<strong>{$LL.admin_saml_local_promote_next()}</strong>
						<span>{$LL.admin_saml_local_rollover_promote_next_note()}</span>
					</div>
					<div>
						<strong>{$LL.admin_saml_local_retire_backup()}</strong>
						<span>{$LL.admin_saml_local_rollover_retire_backup_note()}</span>
					</div>
				</div>
			</div>

			<div class="panel">
				<div class="panel-header compact-panel-header">
					<div>
						<h2 class="panel-title">{$LL.admin_saml_local_signing_subject()}</h2>
						<p class="form-hint">{$LL.admin_saml_local_signing_subject_desc()}</p>
					</div>
				</div>

				<div class="certificate-create-controls">
					<label>
						<span>{$LL.admin_saml_local_rollover_role()}</span>
						<select
							class="form-input"
							bind:value={draftCertificateRole}
							disabled={savingSettings || !!signingAction}
						>
							<option value="idp">IdP</option>
							<option value="sp">SP</option>
						</select>
					</label>
					<button
						class="btn btn-secondary btn-sm"
						onclick={applyActiveCertificateSubject}
						disabled={!metadataCertificateForSlot(draftCertificateRole, 'active')?.preview}
					>
						{$LL.admin_saml_local_use_current_subject()}
					</button>
				</div>

				<div class="subject-grid">
					<label>
						<span>{$LL.admin_saml_local_country()}</span>
						<input
							class="form-input"
							bind:value={draftCertificateSubject.countryName}
							placeholder="JP"
							disabled={savingSettings}
						/>
					</label>
					<label>
						<span>{$LL.admin_saml_local_state()}</span>
						<input
							class="form-input"
							bind:value={draftCertificateSubject.stateOrProvinceName}
							placeholder="Tokyo"
							disabled={savingSettings}
						/>
					</label>
					<label>
						<span>{$LL.admin_saml_local_locality()}</span>
						<input
							class="form-input"
							bind:value={draftCertificateSubject.localityName}
							placeholder="Chiyoda"
							disabled={savingSettings}
						/>
					</label>
					<label>
						<span>{$LL.admin_saml_local_organization()}</span>
						<input
							class="form-input"
							bind:value={draftCertificateSubject.organizationName}
							placeholder="Authrim"
							disabled={savingSettings}
						/>
					</label>
					<label>
						<span>{$LL.admin_saml_local_org_unit()}</span>
						<input
							class="form-input"
							bind:value={draftCertificateSubject.organizationalUnitName}
							placeholder="Security"
							disabled={savingSettings}
						/>
					</label>
					<label>
						<span>{$LL.admin_saml_local_common_name()}</span>
						<input
							class="form-input"
							bind:value={draftCertificateSubject.commonName}
							placeholder="Authrim SAML Signing"
							disabled={savingSettings}
						/>
					</label>
				</div>

				<div class="subject-grid">
					<label>
						<span>{$LL.admin_saml_local_certificate_valid_from()}</span>
						<input
							class="form-input"
							type="datetime-local"
							bind:value={draftCertificateValidFrom}
							disabled={savingSettings}
						/>
					</label>
					<label>
						<span>{$LL.admin_saml_local_certificate_valid_to()}</span>
						<input
							class="form-input"
							type="datetime-local"
							bind:value={draftCertificateValidTo}
							disabled={savingSettings}
						/>
					</label>
					<label>
						<span>{$LL.admin_saml_local_certificate_public_key_algorithm()}</span>
						<select
							class="form-input"
							bind:value={draftCertificatePublicKeyAlgorithm}
							disabled={savingSettings}
						>
							<option value="RSA">RSA</option>
						</select>
					</label>
					<label>
						<span>{$LL.admin_saml_local_certificate_public_key_bits()}</span>
						<select
							class="form-input"
							bind:value={draftCertificatePublicKeySizeBits}
							disabled={savingSettings}
						>
							<option value={2048}>2048</option>
							<option value={3072}>3072</option>
							<option value={4096}>4096</option>
						</select>
					</label>
				</div>

				<div class="entity-warning">
					<i class="i-ph-warning-circle"></i>
					<span>{$LL.admin_saml_local_subject_warning()}</span>
				</div>

				<div class="form-actions">
					<button
						class="btn btn-primary btn-sm"
						onclick={createRolloverCertificate}
						disabled={savingSettings || !!signingAction}
					>
						{savingSettings
							? $LL.admin_saml_local_saving()
							: $LL.admin_saml_local_create_rollover_certificate()}
					</button>
				</div>
			</div>

			<div class="panel emergency-panel">
				<div class="panel-header compact-panel-header">
					<div>
						<h2 class="panel-title">{$LL.admin_saml_local_emergency_operations()}</h2>
						<p class="form-hint">{$LL.admin_saml_local_emergency_operations_desc()}</p>
					</div>
				</div>
				<div class="local-signing-actions">
					{#each signingRoles as role (role)}
						<button
							class="btn btn-danger btn-sm"
							onclick={() => runLocalSigningAction(role, 'recreate_active')}
							disabled={!!signingAction}
						>
							{$LL.admin_saml_local_recreate_active_for_role({ role: roleLabel(role) })}
						</button>
					{/each}
				</div>
			</div>
		{/if}
	{/if}
</div>

{#if selectedCertificateDetail}
	<div class="modal-backdrop">
		<div
			class="certificate-detail-modal"
			role="dialog"
			aria-modal="true"
			aria-labelledby="certificate-detail-title"
			tabindex="-1"
		>
			<div class="modal-header">
				<div>
					<h2 id="certificate-detail-title">
						{$LL.admin_saml_local_rollover_detail_title({
							role: roleLabel(selectedCertificateDetail.role),
							slot: selectedCertificateDetail.row.label
						})}
					</h2>
					<p>{selectedCertificateDetail.row.status}</p>
				</div>
				<button
					class="icon-btn"
					onclick={closeCertificateDetail}
					aria-label={$LL.dialog_close()}
					title={$LL.dialog_close()}
				>
					<i class="i-ph-x"></i>
				</button>
			</div>

			<div class="modal-body">
				{#if selectedCertificateDetail.loading}
					<div class="alert alert-info">
						{$LL.admin_saml_local_rollover_detail_loading()}
					</div>
				{:else if selectedCertificateDetail.error}
					<div class="alert alert-error">{selectedCertificateDetail.error}</div>
				{/if}

				{#if selectedCertificateDetail.preview}
					<div class="certificate-info-grid modal-certificate-grid">
						<div>
							<span>{$LL.admin_saml_local_subject()}</span>
							<strong>{selectedCertificateDetail.preview.subject}</strong>
						</div>
						<div>
							<span>{$LL.admin_saml_local_issuer()}</span>
							<strong>{selectedCertificateDetail.preview.issuer}</strong>
						</div>
						<div>
							<span>{$LL.admin_saml_local_valid_from()}</span>
							<strong>{formatDateTime(selectedCertificateDetail.preview.validFrom)}</strong>
						</div>
						<div>
							<span>{$LL.admin_saml_local_valid_to()}</span>
							<strong>{formatDateTime(selectedCertificateDetail.preview.validTo)}</strong>
						</div>
						<div>
							<span>{$LL.admin_saml_local_signature()}</span>
							<strong>{selectedCertificateDetail.preview.signatureAlgorithm}</strong>
						</div>
						<div>
							<span>{$LL.admin_saml_local_public_key()}</span>
							<strong>
								{selectedCertificateDetail.preview.publicKeyAlgorithm}
								{selectedCertificateDetail.preview.publicKeySizeBits
									? ` ${selectedCertificateDetail.preview.publicKeySizeBits} bit`
									: ''}
							</strong>
						</div>
					</div>

					<div class="fingerprint-grid">
						{@render fieldRow(
							$LL.admin_saml_local_sha1_fingerprint(),
							fingerprint(selectedCertificateDetail.preview.fingerprintSha1),
							`${selectedCertificateDetail.role}_${selectedCertificateDetail.row.slot}_sha1`
						)}
						{@render fieldRow(
							$LL.admin_saml_local_sha256_fingerprint(),
							fingerprint(selectedCertificateDetail.preview.fingerprintSha256),
							`${selectedCertificateDetail.role}_${selectedCertificateDetail.row.slot}_sha256`
						)}
					</div>

					{#if selectedCertificateDetail.preview.warnings.length > 0}
						<div class="certificate-warnings">
							{#each selectedCertificateDetail.preview.warnings as warning (warning)}
								<span><i class="i-ph-warning-circle"></i>{warning}</span>
							{/each}
						</div>
					{/if}
				{/if}

				{#if selectedCertificateDetail.certificate}
					<details class="certificate-pem">
						<summary>
							<i class="i-ph-caret-right"></i>
							<span>{$LL.admin_saml_local_certificate_pem()}</span>
						</summary>
						<div class="field-copy-row">
							<textarea
								class="copy-textarea certificate-textarea"
								readonly
								value={selectedCertificateDetail.certificate}
							></textarea>
							<button
								class="icon-btn"
								class:copied={copiedKey ===
									`detail_cert_pem_${selectedCertificateDetail.role}_${selectedCertificateDetail.row.slot}`}
								onclick={() =>
									copy(
										selectedCertificateDetail?.certificate ?? '',
										`detail_cert_pem_${selectedCertificateDetail?.role}_${selectedCertificateDetail?.row.slot}`
									)}
								title={$LL.admin_saml_local_copy()}
							>
								<i
									class={copiedKey ===
									`detail_cert_pem_${selectedCertificateDetail.role}_${selectedCertificateDetail.row.slot}`
										? 'i-ph-check'
										: 'i-ph-copy'}
								></i>
							</button>
						</div>
					</details>
				{/if}
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={closeCertificateDetail}>
					{$LL.dialog_close()}
				</button>
			</div>
		</div>
	</div>
{/if}

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

	.certificate-create-controls {
		display: flex;
		align-items: end;
		gap: 10px;
		margin-bottom: 14px;
	}

	.certificate-create-controls label {
		display: grid;
		gap: 5px;
		min-width: 140px;
	}

	.certificate-create-controls span {
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 700;
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
		grid-template-columns: 1fr;
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

	.emergency-panel {
		border-color: rgba(239, 68, 68, 0.3);
	}

	.rollover-table-wrap {
		width: 100%;
		overflow-x: auto;
	}

	.rollover-table {
		width: 100%;
		min-width: 1240px;
		border-collapse: collapse;
		font-size: 0.8125rem;
	}

	.rollover-table th,
	.rollover-table td {
		padding: 9px 10px;
		border-bottom: 1px solid var(--border-color);
		text-align: left;
		vertical-align: top;
		white-space: nowrap;
	}

	.rollover-table th {
		color: var(--text-secondary);
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.rollover-table th:first-child,
	.rollover-table td:first-child {
		width: 54px;
		text-align: center;
	}

	.rollover-table td:nth-child(2) {
		white-space: normal;
		min-width: 260px;
	}

	.rollover-table td:nth-child(2) strong,
	.rollover-table td:nth-child(2) span,
	.rollover-table td:nth-child(2) code {
		display: block;
	}

	.rollover-table td:nth-child(2) span {
		margin-top: 2px;
		color: var(--text-secondary);
		font-size: 0.75rem;
		line-height: 1.35;
	}

	.rollover-table td:nth-child(2) code {
		margin-top: 4px;
		color: var(--text-secondary);
		font-size: 0.7rem;
		overflow-wrap: anywhere;
	}

	.selected-action-label {
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.rollover-row-actions {
		display: flex;
		gap: 6px;
		justify-content: flex-end;
	}

	.btn-xs {
		padding: 4px 8px;
		font-size: 0.75rem;
		line-height: 1.2;
	}

	.rollover-status {
		display: inline-flex;
		align-items: center;
		width: max-content;
		padding: 3px 8px;
		border-radius: 999px;
		background: var(--bg-subtle);
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 700;
	}

	.rollover-status.status-active {
		background: rgba(34, 197, 94, 0.14);
		color: var(--success);
	}

	.rollover-status.status-published {
		background: rgba(59, 130, 246, 0.14);
		color: var(--primary);
	}

	.rollover-status.status-muted {
		opacity: 0.72;
	}

	.rollover-action-notes {
		display: grid;
		gap: 8px;
		margin-top: 14px;
		padding: 12px;
		border: 1px solid var(--border-color);
		border-radius: var(--radius-md);
		background: var(--surface);
	}

	.rollover-action-notes div {
		display: grid;
		grid-template-columns: 160px minmax(0, 1fr);
		gap: 12px;
		align-items: baseline;
	}

	.rollover-action-notes strong {
		color: var(--text-primary);
		font-size: 0.8125rem;
	}

	.rollover-action-notes span {
		color: var(--text-secondary);
		font-size: 0.8125rem;
		line-height: 1.45;
	}

	.modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 1000;
		display: grid;
		place-items: center;
		padding: 24px;
		background: rgba(0, 0, 0, 0.5);
	}

	.certificate-detail-modal {
		display: grid;
		grid-template-rows: auto minmax(0, 1fr) auto;
		width: min(920px, 100%);
		max-height: min(860px, calc(100vh - 48px));
		border: 1px solid var(--border-color);
		border-radius: var(--radius-lg);
		background: var(--surface);
		box-shadow: var(--shadow-lg);
		overflow: hidden;
	}

	.modal-header,
	.modal-footer {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		padding: 16px;
		border-bottom: 1px solid var(--border-color);
	}

	.modal-header h2 {
		margin: 0;
		color: var(--text-primary);
		font-size: 1.125rem;
	}

	.modal-header p {
		margin: 4px 0 0;
		color: var(--text-secondary);
		font-size: 0.8125rem;
	}

	.modal-body {
		min-height: 0;
		overflow: auto;
		padding: 16px;
	}

	.modal-footer {
		justify-content: flex-end;
		border-top: 1px solid var(--border-color);
		border-bottom: 0;
	}

	.modal-certificate-grid {
		margin-top: 0;
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
		.certificate-header,
		.rollover-action-notes div {
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
