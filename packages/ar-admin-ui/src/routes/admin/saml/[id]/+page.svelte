<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { ToggleSwitch } from '$lib/components';
	import { onMount } from 'svelte';
	import {
		adminSAMLAPI,
		type AttributeReleaseConsentMode,
		type SAMLAttributeReleaseConfirmationValueDisplay,
		type SAMLJitEmailLinkingPolicy,
		type SAMLProvider,
		type SAMLProviderConfig,
		type SAMLTrustCertificatePreview
	} from '$lib/api/admin-saml';
	import {
		adminConsentStatementsAPI,
		type ConsentStatement
	} from '$lib/api/admin-consent-statements';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingFieldMappingSetSummary
	} from '$lib/api/admin-identity-mapping';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection
	} from '$lib/components/admin';
	import ConsentPolicyTargetSettings from '$lib/components/admin/ConsentPolicyTargetSettings.svelte';
	import FlowAssignmentSettings from '$lib/components/admin/FlowAssignmentSettings.svelte';
	import LoginProviderIconPicker from '$lib/components/admin/LoginProviderIconPicker.svelte';
	import { getLocale, LL } from '$i18n/i18n-svelte';

	const providerId = $derived($page.params.id);
	const samlAttributeReleaseConfirmationCategory = 'saml_attribute_release_confirmation';
	type AttributeReleaseConfirmationMode =
		| 'disabled'
		| 'uapprove_once'
		| 'uapprove_until_attributes_change'
		| 'every_time';
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
	let samlProfile = $state('baseline');
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
	let attributeReleaseConfirmationMode = $state<AttributeReleaseConfirmationMode>('disabled');
	let attributeReleaseValueDisplay =
		$state<SAMLAttributeReleaseConfirmationValueDisplay>('masked_values');
	let attributeReleaseTemplateStatementId = $state('');
	let attributeReleaseButtonLabel = $state('');
	let identityMappingFieldMappingSetId = $state('');
	let certificatePreview = $state<SAMLTrustCertificatePreview | null>(null);
	let certificatePreviewError = $state('');
	let loadingCertificatePreview = $state(false);
	let consentStatements = $state<ConsentStatement[]>([]);

	const attributeReleaseTemplateStatements = $derived(
		consentStatements.filter(
			(statement) => statement.category === samlAttributeReleaseConfirmationCategory
		)
	);
	const selectedAttributeReleaseTemplate = $derived(
		attributeReleaseTemplateStatements.find(
			(statement) => statement.id === attributeReleaseTemplateStatementId
		) || null
	);

	onMount(() => {
		void loadPage();
	});

	async function loadPage() {
		if (!providerId) return;
		loading = true;
		error = '';
		try {
			const [loadedProvider, fieldMappingResult, statementResult] = await Promise.all([
				adminSAMLAPI.getProvider(providerId),
				adminIdentityMappingAPI.listFieldMappingSets(),
				adminConsentStatementsAPI.listStatements()
			]);
			provider = loadedProvider;
			fieldMappingSets = fieldMappingResult.fieldMappingSets;
			consentStatements = statementResult.statements || [];
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
		samlProfile = data.config.samlProfile || 'baseline';
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
		attributeReleaseConfirmationMode = toAttributeReleaseConfirmationMode(data.config);
		attributeReleaseValueDisplay =
			data.config.attributeReleaseConfirmation?.valueDisplay || 'masked_values';
		attributeReleaseTemplateStatementId =
			data.config.attributeReleaseConfirmation?.templateStatementId || '';
		attributeReleaseButtonLabel = data.config.attributeReleaseConfirmation?.buttonLabel || '';
		identityMappingFieldMappingSetId = data.config.identityMapping?.fieldMappingSetId || '';
		certificatePreview = null;
		certificatePreviewError = '';
	}

	function providerTypeLabel(type: SAMLProvider['providerType']) {
		return type === 'saml_sp'
			? $LL.admin_saml_detail_service_provider()
			: $LL.admin_saml_detail_identity_provider();
	}

	function samlProfileHint() {
		switch (samlProfile) {
			case 'strict':
				return $LL.admin_saml_detail_profile_hint_strict();
			case 'academic_publisher':
				return $LL.admin_saml_detail_profile_hint_academic_publisher();
			case 'legacy':
				return $LL.admin_saml_detail_profile_hint_legacy();
			default:
				return $LL.admin_saml_detail_profile_hint_baseline();
		}
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

	function tAttributeRelease(key: string): string {
		const ja = getLocale() === 'ja';
		const labels: Record<string, { ja: string; en: string }> = {
			title: {
				ja: '属性送信確認',
				en: 'Attribute release confirmation'
			},
			description: {
				ja: 'uApprove互換の確認画面として、SPに送信する属性をユーザーに提示します。',
				en: 'Show a uApprove-compatible confirmation before releasing attributes to this SP.'
			},
			displayMode: { ja: '表示モード', en: 'Display mode' },
			disabled: { ja: '表示しない', en: 'Do not show' },
			uapproveOnce: {
				ja: 'uApprove互換: 初回のみ確認',
				en: 'uApprove compatible: first time only'
			},
			uapproveChanged: {
				ja: 'uApprove互換: 属性が変わったら再確認',
				en: 'uApprove compatible: ask again when attributes change'
			},
			everyTime: { ja: '毎回確認', en: 'Ask every SSO' },
			valueDisplay: { ja: '属性値表示', en: 'Attribute value display' },
			names: { ja: '属性名のみ', en: 'Attribute names only' },
			maskedValues: { ja: '値をマスクして表示', en: 'Show masked values' },
			fullValues: { ja: '属性値を表示', en: 'Show values' },
			template: { ja: '通知文テンプレート', en: 'Notice template' },
			noTemplate: { ja: 'テンプレートを指定しない', en: 'No template' },
			buttonLabel: { ja: 'ユーザー画面のボタン文言', en: 'User-facing button label' },
			buttonPlaceholder: { ja: '同意して続行', en: 'Accept and continue' },
			preview: { ja: 'ユーザー表示プレビュー', en: 'User-facing display preview' },
			previewCaption: {
				ja: 'この枠は保存される設定値ではなく、ユーザーに表示される確認画面の見え方です。',
				en: 'This preview shows what users will see. It is not a saved configuration summary.'
			},
			previewTitle: {
				ja: 'このサービスに以下の情報を送信します。',
				en: 'The following information will be released to this service.'
			},
			service: { ja: 'サービス', en: 'Service' },
			entityId: { ja: '送信先', en: 'Destination' },
			attribute: { ja: '属性', en: 'Attribute' },
			value: { ja: '値', en: 'Value' },
			remember: {
				ja: 'このサービスへの属性送信を次回から表示しない',
				en: 'Do not show this again for this service'
			},
			rememberChanged: {
				ja: '送信される属性が変更された場合は再度表示されます。',
				en: 'It will be shown again if released attributes change.'
			},
			noAttributes: {
				ja: '送信属性の詳細はField Mapping Setの設定ページで確認してください。',
				en: 'Use the Field Mapping Set settings page to review the released attributes.'
			},
			enabled: { ja: '有効', en: 'Enabled' }
		};
		return ja ? labels[key]?.ja || key : labels[key]?.en || key;
	}

	function toAttributeReleaseConfirmationMode(
		config: SAMLProviderConfig
	): AttributeReleaseConfirmationMode {
		if (!config.attributeReleaseConsent?.enabled) return 'disabled';
		if (config.attributeReleaseConsent.mode === 'every_time') return 'every_time';
		if (config.attributeReleaseConsent.mode === 'once') return 'uapprove_once';
		return 'uapprove_until_attributes_change';
	}

	function attributeReleaseConsentMode(): AttributeReleaseConsentMode {
		if (attributeReleaseConfirmationMode === 'every_time') return 'every_time';
		if (attributeReleaseConfirmationMode === 'uapprove_once') return 'once';
		return 'until_attributes_change';
	}

	function attributeReleaseConfirmationEnabled(): boolean {
		return attributeReleaseConfirmationMode !== 'disabled';
	}

	function attributeReleaseButtonText(): string {
		return attributeReleaseButtonLabel.trim() || tAttributeRelease('buttonPlaceholder');
	}

	function releasePreviewAttributes(): Array<{ name: string; value: string }> {
		return [];
	}

	function displayPreviewValue(value: string): string {
		if (attributeReleaseValueDisplay === 'names') return '-';
		if (attributeReleaseValueDisplay === 'full_values') return value;
		if (!value) return '';
		if (value.length <= 4) return '••••';
		return `${value.slice(0, 2)}••••${value.slice(-2)}`;
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
			attributeMapping: {},
			allowedBindings: selectedBindings()
		};

		if (provider?.providerType === 'saml_idp') {
			return {
				...config,
				identityMapping: identityMappingFieldMappingSetId
					? {
							...(provider?.config.identityMapping ?? {}),
							fieldMappingSetId: identityMappingFieldMappingSetId,
							destinationNamespace: provider?.config.identityMapping?.destinationNamespace
						}
					: undefined,
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
			samlProfile,
			authnRequestSignaturePolicy,
			logoutRequestSignaturePolicy,
			authnContextClassRefMode,
			defaultAuthnContextClassRef: defaultAuthnContextClassRef.trim() || undefined,
			passkeyAuthnContextClassRef: passkeyAuthnContextClassRef.trim() || undefined,
			attributeReleaseConsent: !attributeReleaseConfirmationEnabled()
				? {
						enabled: false,
						mode: 'once'
					}
				: {
						enabled: true,
						mode: attributeReleaseConsentMode()
					},
			attributeReleaseConfirmation: attributeReleaseConfirmationEnabled()
				? {
						compatibilityMode:
							attributeReleaseConfirmationMode === 'every_time' ? 'custom' : 'uapprove',
						valueDisplay: attributeReleaseValueDisplay,
						templateStatementId: attributeReleaseTemplateStatementId || undefined,
						buttonLabel: attributeReleaseButtonLabel.trim() || undefined
					}
				: undefined,
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
		if (!identityMappingFieldMappingSetId) {
			return getLocale() === 'ja'
				? 'Field Mapping Setを選択してください。'
				: 'Select a Field Mapping Set.';
		}
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

{#snippet pageActions()}
	<a href="/admin/saml" class="btn btn-secondary">{$LL.admin_saml_detail_back()}</a>
	{#if provider}
		<button class="btn btn-danger" onclick={deleteProvider} disabled={busyAction === 'delete'}>
			{$LL.admin_saml_detail_delete()}
		</button>
	{/if}
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={provider?.name ?? $LL.admin_saml_detail_loading()}
		description={provider ? providerTypeLabel(provider.providerType) : undefined}
		actions={pageActions}
	/>

	{#if loading}
		<div class="loading-state">{$LL.admin_saml_detail_loading()}</div>
	{:else if provider}
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

			<AdminSection>
				<ToggleSwitch
					bind:checked={enabled}
					label={$LL.admin_saml_detail_provider_status()}
					description={$LL.admin_saml_detail_provider_status_desc()}
				/>
			</AdminSection>

			<AdminSection title={$LL.admin_saml_detail_basic_information()}>
				<div class="form-grid">
					<div class="admin-field">
						<label for="name" class="admin-field__label"
							>{$LL.admin_saml_detail_name_required()}</label
						>
						<input id="name" type="text" bind:value={name} class="admin-input" required />
					</div>

					<div class="admin-field">
						<label for="nameIdFormat" class="admin-field__label"
							>{$LL.admin_saml_detail_nameid_format()}</label
						>
						<select id="nameIdFormat" bind:value={nameIdFormat} class="admin-select">
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

					<div class="admin-field admin-field--full">
						<label for="description" class="admin-field__label"
							>{$LL.admin_saml_detail_description()}</label
						>
						<textarea
							id="description"
							bind:value={description}
							class="admin-input form-textarea"
							rows="3"
						></textarea>
					</div>

					<div class="admin-field admin-field--full">
						<label for="logoUrl" class="admin-field__label"
							>{$LL.admin_saml_detail_logo_url()}</label
						>
						<div class="logo-url-field">
							<input
								id="logoUrl"
								type="url"
								bind:value={logoUrl}
								class="admin-input"
								placeholder="https://example.com/logo.png"
							/>
							{#if logoUrl}
								<div class="logo-url-preview" aria-label={$LL.admin_saml_detail_logo_preview()}>
									<img src={logoUrl} alt="" loading="lazy" />
								</div>
							{/if}
						</div>
						<p class="field-hint">
							{$LL.admin_saml_detail_logo_hint()}
						</p>
					</div>

					<div class="admin-field admin-field--full">
						<LoginProviderIconPicker
							bind:value={iconName}
							defaultIcon="buildings"
							defaultLabel={$LL.admin_saml_detail_default_icon()}
							description={$LL.admin_saml_detail_default_icon_desc()}
						/>
					</div>
				</div>
			</AdminSection>

			<AdminSection title={$LL.admin_saml_detail_saml_configuration()}>
				<div class="form-grid">
					<div class="admin-field admin-field--full">
						<label for="entityId" class="admin-field__label">{$LL.admin_saml_entity_id()} *</label>
						<input id="entityId" type="text" bind:value={entityId} class="admin-input" />
					</div>

					{#if provider.providerType === 'saml_idp'}
						<div class="admin-field">
							<label for="ssoUrl" class="admin-field__label"
								>{$LL.admin_saml_sso_url_required()}</label
							>
							<input id="ssoUrl" type="url" bind:value={ssoUrl} class="admin-input" />
						</div>
					{:else}
						<div class="admin-field">
							<label for="acsUrl" class="admin-field__label"
								>{$LL.admin_saml_acs_url_required()}</label
							>
							<input id="acsUrl" type="url" bind:value={acsUrl} class="admin-input" />
						</div>
					{/if}

					<div class="admin-field">
						<label for="sloUrl" class="admin-field__label">{$LL.admin_saml_slo_url()}</label>
						<input id="sloUrl" type="url" bind:value={sloUrl} class="admin-input" />
					</div>

					<div class="admin-field admin-field--full">
						<label for="metadataUrl" class="admin-field__label"
							>{$LL.admin_saml_local_metadata_url()}</label
						>
						<input id="metadataUrl" type="url" bind:value={metadataUrl} class="admin-input" />
						<p class="field-hint">
							{$LL.admin_saml_detail_metadata_source_hint()}
						</p>
					</div>

					<div class="admin-field admin-field--full">
						<label for="certificate" class="admin-field__label">
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
							class="admin-input form-textarea monospace"
							rows="8"
						></textarea>
						<p class="field-hint">
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
				</div>

				<div class="binding-section">
					<h3 class="section-subtitle">{$LL.admin_saml_detail_allowed_bindings()}</h3>
					<p class="field-hint">
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
			</AdminSection>

			{#if provider.providerType === 'saml_idp'}
				<AdminSection title={$LL.admin_saml_detail_sp_login_policy()}>
					<div class="form-grid">
						<div class="admin-field">
							<label for="providerName" class="admin-field__label"
								>{$LL.admin_saml_detail_sp_display_name()}</label
							>
							<input id="providerName" type="text" bind:value={providerName} class="admin-input" />
						</div>

						<div class="admin-field">
							<label for="jitEmailLinkingPolicy" class="admin-field__label"
								>{$LL.admin_saml_detail_jit_linking_policy()}</label
							>
							<select
								id="jitEmailLinkingPolicy"
								bind:value={jitEmailLinkingPolicy}
								class="admin-select"
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

						<div class="admin-field">
							<label for="identityMappingFieldMappingInbound" class="admin-field__label"
								>{$LL.admin_saml_detail_identity_mapping_policy()}</label
							>
							<select
								id="identityMappingFieldMappingInbound"
								bind:value={identityMappingFieldMappingSetId}
								class="admin-select"
							>
								<option value="">{$LL.admin_saml_detail_identity_mapping_policy_default()}</option>
								{#each fieldMappingSets as fieldMappingSet (fieldMappingSet.id)}
									<option value={fieldMappingSet.id}>
										{fieldMappingSet.displayName} ({fieldMappingSet.lifecycleState})
									</option>
								{/each}
							</select>
							<p class="field-hint">
								{$LL.admin_saml_detail_identity_mapping_policy_hint()}
								<a class="field-hint-link" href="/admin/field-mapping/field-mapping-sets">
									{$LL.admin_saml_detail_identity_mapping_policy_link()}
								</a>
							</p>
						</div>

						<div class="admin-field admin-field--full">
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

						<div class="admin-field">
							<label for="logoutRequestSignaturePolicy" class="admin-field__label">
								{$LL.admin_saml_detail_idp_logout_signature()}
							</label>
							<select
								id="logoutRequestSignaturePolicy"
								bind:value={logoutRequestSignaturePolicy}
								class="admin-select"
							>
								<option value="required">{$LL.admin_saml_detail_required()}</option>
								<option value="optional">{$LL.admin_saml_detail_optional()}</option>
								<option value="disabled">{$LL.admin_saml_detail_disabled()}</option>
							</select>
							<p class="field-hint">
								{$LL.admin_saml_detail_signature_required_hint()}
							</p>
						</div>

						<div class="admin-field">
							<label for="authnContextPolicyMode" class="admin-field__label"
								>{$LL.admin_saml_detail_authn_context_policy()}</label
							>
							<select
								id="authnContextPolicyMode"
								bind:value={authnContextPolicyMode}
								class="admin-select"
							>
								<option value="observe">{$LL.admin_saml_detail_observe()}</option>
								<option value="require_any">{$LL.admin_saml_detail_require_allowed()}</option>
							</select>
							<p class="field-hint">
								{$LL.admin_saml_detail_authn_context_policy_hint()}
							</p>
						</div>

						<div class="admin-field admin-field--full">
							<label for="allowedAuthnContextClassRefs" class="admin-field__label">
								{$LL.admin_saml_detail_allowed_authn_context()}
							</label>
							<textarea
								id="allowedAuthnContextClassRefs"
								bind:value={allowedAuthnContextClassRefs}
								class="admin-input form-textarea monospace"
								rows="3"
							></textarea>
							<p class="field-hint">
								{$LL.admin_saml_detail_allowed_authn_context_hint()}
							</p>
						</div>
					</div>
				</AdminSection>
			{/if}

			{#if provider.providerType === 'saml_sp'}
				<AdminSection title={$LL.admin_saml_detail_sp_policy()}>
					<div class="form-grid">
						<div class="admin-field">
							<label for="samlProfile" class="admin-field__label"
								>{$LL.admin_saml_detail_profile()}</label
							>
							<select id="samlProfile" bind:value={samlProfile} class="admin-select">
								<option value="baseline">Baseline</option>
								<option value="strict">Strict</option>
								<option value="academic_publisher">Academic Publisher</option>
								<option value="legacy">Legacy</option>
							</select>
							<p class="field-hint">{samlProfileHint()}</p>
						</div>

						<div class="admin-field">
							<label for="identityMappingFieldMapping" class="admin-field__label"
								>{$LL.admin_saml_detail_identity_mapping_policy()}</label
							>
							<select
								id="identityMappingFieldMapping"
								bind:value={identityMappingFieldMappingSetId}
								class="admin-select"
							>
								<option value="">{$LL.admin_saml_detail_identity_mapping_policy_default()}</option>
								{#each fieldMappingSets as fieldMappingSet (fieldMappingSet.id)}
									<option value={fieldMappingSet.id}>
										{fieldMappingSet.displayName} ({fieldMappingSet.lifecycleState})
									</option>
								{/each}
							</select>
							<p class="field-hint">
								{$LL.admin_saml_detail_identity_mapping_policy_hint()}
								<a class="field-hint-link" href="/admin/field-mapping/field-mapping-sets">
									{$LL.admin_saml_detail_identity_mapping_policy_link()}
								</a>
							</p>
						</div>

						<div class="admin-field admin-field--full attribute-release-confirmation">
							<div class="attribute-release-confirmation__header">
								<div>
									<h3>{tAttributeRelease('title')}</h3>
									<p>{tAttributeRelease('description')}</p>
								</div>
								<span
									class="status-badge"
									data-state={attributeReleaseConfirmationEnabled() ? 'active' : 'inactive'}
								>
									{attributeReleaseConfirmationEnabled()
										? tAttributeRelease('enabled')
										: $LL.admin_saml_detail_disabled()}
								</span>
							</div>

							<div class="form-grid compact-release-grid">
								<div class="admin-field">
									<label for="attributeReleaseConfirmationMode" class="admin-field__label"
										>{tAttributeRelease('displayMode')}</label
									>
									<select
										id="attributeReleaseConfirmationMode"
										bind:value={attributeReleaseConfirmationMode}
										class="admin-select"
									>
										<option value="disabled">{tAttributeRelease('disabled')}</option>
										<option value="uapprove_once">{tAttributeRelease('uapproveOnce')}</option>
										<option value="uapprove_until_attributes_change"
											>{tAttributeRelease('uapproveChanged')}</option
										>
										<option value="every_time">{tAttributeRelease('everyTime')}</option>
									</select>
								</div>

								<div class="admin-field">
									<label for="attributeReleaseValueDisplay" class="admin-field__label"
										>{tAttributeRelease('valueDisplay')}</label
									>
									<select
										id="attributeReleaseValueDisplay"
										bind:value={attributeReleaseValueDisplay}
										class="admin-select"
										disabled={!attributeReleaseConfirmationEnabled()}
									>
										<option value="names">{tAttributeRelease('names')}</option>
										<option value="masked_values">{tAttributeRelease('maskedValues')}</option>
										<option value="full_values">{tAttributeRelease('fullValues')}</option>
									</select>
								</div>

								<div class="admin-field">
									<label for="attributeReleaseTemplate" class="admin-field__label"
										>{tAttributeRelease('template')}</label
									>
									<select
										id="attributeReleaseTemplate"
										bind:value={attributeReleaseTemplateStatementId}
										class="admin-select"
										disabled={!attributeReleaseConfirmationEnabled()}
									>
										<option value="">{tAttributeRelease('noTemplate')}</option>
										{#each attributeReleaseTemplateStatements as statement (statement.id)}
											<option value={statement.id}>{statement.slug}</option>
										{/each}
									</select>
								</div>

								<div class="admin-field">
									<label for="attributeReleaseButtonLabel" class="admin-field__label"
										>{tAttributeRelease('buttonLabel')}</label
									>
									<input
										id="attributeReleaseButtonLabel"
										type="text"
										class="admin-input"
										bind:value={attributeReleaseButtonLabel}
										placeholder={tAttributeRelease('buttonPlaceholder')}
										disabled={!attributeReleaseConfirmationEnabled()}
									/>
								</div>
							</div>

							{#if attributeReleaseConfirmationEnabled()}
								<div class="attribute-release-preview" aria-label={tAttributeRelease('preview')}>
									<div class="attribute-release-preview__copy">
										<div>
											<p class="attribute-release-preview__eyebrow">
												{tAttributeRelease('preview')}
											</p>
											<p class="attribute-release-preview__caption">
												{tAttributeRelease('previewCaption')}
											</p>
										</div>
										<p>{tAttributeRelease('previewTitle')}</p>
										<dl>
											<div>
												<dt>{tAttributeRelease('service')}</dt>
												<dd>{provider.name}</dd>
											</div>
											<div>
												<dt>{tAttributeRelease('entityId')}</dt>
												<dd>{entityId || '-'}</dd>
											</div>
											{#if selectedAttributeReleaseTemplate}
												<div>
													<dt>{tAttributeRelease('template')}</dt>
													<dd>{selectedAttributeReleaseTemplate.slug}</dd>
												</div>
											{/if}
										</dl>
									</div>

									{#if releasePreviewAttributes().length > 0}
										<AdminDataTable compact>
											<thead>
												<tr>
													<th>{tAttributeRelease('attribute')}</th>
													<th>{tAttributeRelease('value')}</th>
												</tr>
											</thead>
											<tbody>
												{#each releasePreviewAttributes() as attribute, index (`${attribute.name}-${index}`)}
													<tr>
														<td>{attribute.name}</td>
														<td>{displayPreviewValue(attribute.value)}</td>
													</tr>
												{/each}
											</tbody>
										</AdminDataTable>
									{:else}
										<p class="field-hint">{tAttributeRelease('noAttributes')}</p>
									{/if}

									<label class="preview-check">
										<input
											type="checkbox"
											checked={attributeReleaseConfirmationMode !== 'every_time'}
											disabled
										/>
										<span>
											{tAttributeRelease('remember')}
											<small>{tAttributeRelease('rememberChanged')}</small>
										</span>
									</label>

									<div class="attribute-release-preview__actions">
										<button type="button" class="btn btn-primary" disabled>
											{attributeReleaseButtonText()}
										</button>
										<button type="button" class="btn btn-secondary" disabled>
											{$LL.admin_consent_statements_cancel()}
										</button>
									</div>
								</div>
							{/if}
						</div>

						<div class="admin-field">
							<span class="admin-field__label">
								{$LL.admin_saml_detail_authn_request_signature()}
							</span>
							<div
								id="authnRequestSignaturePolicy"
								class="radio-card-group"
								role="radiogroup"
								aria-label={$LL.admin_saml_detail_authn_request_signature()}
							>
								<label class="radio-card">
									<input type="radio" bind:group={authnRequestSignaturePolicy} value="optional" />
									<span>{$LL.admin_saml_detail_optional()}</span>
								</label>
								<label class="radio-card">
									<input type="radio" bind:group={authnRequestSignaturePolicy} value="required" />
									<span>{$LL.admin_saml_detail_required()}</span>
								</label>
								<label class="radio-card">
									<input type="radio" bind:group={authnRequestSignaturePolicy} value="disabled" />
									<span>{$LL.admin_saml_detail_disabled()}</span>
								</label>
							</div>
							<p class="field-hint">
								{$LL.admin_saml_detail_authn_request_signature_hint()}
							</p>
						</div>

						<div class="admin-field">
							<span class="admin-field__label">
								{$LL.admin_saml_detail_logout_request_signature()}
							</span>
							<div
								id="spLogoutRequestSignaturePolicy"
								class="radio-card-group"
								role="radiogroup"
								aria-label={$LL.admin_saml_detail_logout_request_signature()}
							>
								<label class="radio-card">
									<input type="radio" bind:group={logoutRequestSignaturePolicy} value="required" />
									<span>{$LL.admin_saml_detail_required()}</span>
								</label>
								<label class="radio-card">
									<input type="radio" bind:group={logoutRequestSignaturePolicy} value="optional" />
									<span>{$LL.admin_saml_detail_optional()}</span>
								</label>
								<label class="radio-card">
									<input type="radio" bind:group={logoutRequestSignaturePolicy} value="disabled" />
									<span>{$LL.admin_saml_detail_disabled()}</span>
								</label>
							</div>
							<p class="field-hint">
								{$LL.admin_saml_detail_sp_signature_hint()}
							</p>
						</div>

						<div class="admin-field">
							<span class="admin-field__label">
								{$LL.admin_saml_detail_authn_context_mode()}
							</span>
							<div
								id="authnContextClassRefMode"
								class="radio-card-group"
								role="radiogroup"
								aria-label={$LL.admin_saml_detail_authn_context_mode()}
							>
								<label class="radio-card">
									<input type="radio" bind:group={authnContextClassRefMode} value="session" />
									<span>{$LL.admin_saml_detail_session_aware()}</span>
								</label>
								<label class="radio-card">
									<input type="radio" bind:group={authnContextClassRefMode} value="legacy_static" />
									<span>{$LL.admin_saml_detail_legacy_static()}</span>
								</label>
							</div>
							<p class="field-hint">
								{$LL.admin_saml_detail_authn_context_mode_hint()}
							</p>
						</div>

						<div class="admin-field">
							<label for="defaultAuthnContextClassRef" class="admin-field__label">
								{$LL.admin_saml_detail_default_authn_context()}
							</label>
							<input
								id="defaultAuthnContextClassRef"
								type="text"
								bind:value={defaultAuthnContextClassRef}
								class="admin-input"
							/>
							<p class="field-hint">
								{$LL.admin_saml_detail_default_authn_context_hint()}
							</p>
						</div>

						<div class="admin-field">
							<label for="passkeyAuthnContextClassRef" class="admin-field__label">
								{$LL.admin_saml_detail_passkey_authn_context()}
							</label>
							<input
								id="passkeyAuthnContextClassRef"
								type="text"
								bind:value={passkeyAuthnContextClassRef}
								class="admin-input"
							/>
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

					<FlowAssignmentSettings targetType="saml_sp" targetId={providerId ?? ''} />

					<ConsentPolicyTargetSettings
						targetType="saml_sp"
						targetId={entityId}
						title="SAML SP consent policy"
					/>
				</AdminSection>
			{/if}
		</form>

		<AdminSection
			title={$LL.admin_saml_local_signing_rollover()}
			description={$LL.admin_saml_detail_rollover_desc()}
		>
			<div class="key-state">
				<span class:enabled={Boolean(provider.config.signingKeyPolicy?.active)}>active</span>
				<span class:enabled={Boolean(provider.config.signingKeyPolicy?.next)}>next</span>
				<span class:enabled={Boolean(provider.config.signingKeyPolicy?.backup)}>backup</span>
			</div>

			<div class="section-actions">
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
		</AdminSection>

		<div class="form-actions page-bottom-actions">
			<button class="btn btn-primary" type="button" onclick={handleSave} disabled={saving}>
				{saving ? $LL.admin_saml_local_saving() : $LL.admin_saml_detail_save_changes()}
			</button>
		</div>
	{:else}
		<div class="alert alert-error">{error || $LL.admin_saml_detail_not_found()}</div>
	{/if}
</AdminPageShell>

<style>
	form {
		display: grid;
		gap: 18px;
	}

	.form-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 16px;
	}

	.admin-field {
		display: grid;
		gap: 6px;
	}

	.admin-field--full {
		grid-column: 1 / -1;
	}

	.admin-field__label {
		color: var(--color-text);
		font-size: 0.84rem;
		font-weight: 700;
	}

	.admin-input,
	.admin-select {
		width: 100%;
		min-height: var(--control-height, 40px);
		padding: var(--control-padding, 8px 12px);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
		outline: none;
	}

	.admin-input:focus,
	.admin-select:focus {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.field-hint {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.78rem;
		line-height: 1.5;
	}

	.field-hint-link {
		display: inline-flex;
		margin-left: 8px;
		color: var(--color-accent);
		font-weight: 700;
		text-decoration: none;
	}

	.field-hint-link:hover {
		text-decoration: underline;
	}

	.form-error {
		margin: 4px 0 0;
		color: var(--color-danger);
		font-size: 0.78rem;
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

	.logo-url-field .admin-input {
		flex: 1;
	}

	.logo-url-preview {
		display: grid;
		width: 40px;
		height: 40px;
		flex: 0 0 40px;
		place-items: center;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface-subtle);
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
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface-subtle);
	}

	.inline-help p {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.8125rem;
		line-height: 1.45;
	}

	.inline-help code {
		color: var(--color-text);
		font-family: var(--font-mono);
		font-size: 0.75rem;
		overflow-wrap: anywhere;
	}

	.binding-section {
		margin-top: 16px;
	}

	.attribute-release-confirmation {
		display: grid;
		gap: 16px;
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface-subtle);
	}

	.attribute-release-confirmation__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}

	.attribute-release-confirmation__header h3 {
		margin: 0 0 4px;
		color: var(--color-text);
		font-size: 0.95rem;
	}

	.attribute-release-confirmation__header p {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.8125rem;
		line-height: 1.45;
	}

	.compact-release-grid {
		gap: 12px;
	}

	.radio-card-group {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
		gap: 8px;
	}

	.radio-card {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 38px;
		padding: 8px 10px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface);
		color: var(--color-text);
		font-size: 0.8125rem;
		font-weight: 700;
		cursor: pointer;
	}

	.radio-card:hover {
		border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
	}

	.radio-card:has(input:checked) {
		border-color: var(--color-accent);
		background: var(--color-accent-muted);
	}

	.radio-card input {
		flex: 0 0 auto;
		margin: 0;
	}

	.status-badge {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		padding: 2px 8px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-full);
		color: var(--color-text-muted);
		font-size: 0.75rem;
		font-weight: 700;
		white-space: nowrap;
	}

	.status-badge[data-state='active'] {
		color: var(--color-success);
		border-color: color-mix(in srgb, var(--color-success) 45%, var(--color-border));
		background: color-mix(in srgb, var(--color-success) 8%, transparent);
	}

	.attribute-release-preview {
		display: grid;
		gap: 12px;
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface);
	}

	.attribute-release-preview__copy {
		display: grid;
		gap: 10px;
	}

	.attribute-release-preview__copy p {
		margin: 0;
		color: var(--color-text);
		font-size: 0.9rem;
		font-weight: 700;
	}

	.attribute-release-preview__copy .attribute-release-preview__eyebrow {
		margin: 0 0 3px;
		color: var(--color-accent);
		font-size: 0.75rem;
		font-weight: 800;
		text-transform: uppercase;
	}

	.attribute-release-preview__copy .attribute-release-preview__caption {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.8125rem;
		font-weight: 400;
		line-height: 1.45;
	}

	.attribute-release-preview dl {
		display: grid;
		gap: 6px;
		margin: 0;
	}

	.attribute-release-preview dl div {
		display: grid;
		grid-template-columns: 110px minmax(0, 1fr);
		gap: 8px;
	}

	.attribute-release-preview dt {
		color: var(--color-text-muted);
		font-size: 0.8125rem;
		font-weight: 700;
	}

	.attribute-release-preview dd {
		margin: 0;
		color: var(--color-text);
		font-size: 0.8125rem;
		overflow-wrap: anywhere;
	}

	.preview-check {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		color: var(--color-text);
		font-size: 0.8125rem;
	}

	.preview-check small {
		display: block;
		margin-top: 2px;
		color: var(--color-text-muted);
		line-height: 1.4;
	}

	.attribute-release-preview__actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
	}

	.section-subtitle {
		margin: 0 0 4px;
		color: var(--color-text);
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
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface-subtle);
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
		color: var(--color-text-muted);
		font-size: 0.8125rem;
		font-weight: 600;
	}

	.certificate-preview-grid code {
		color: var(--color-text);
		font-family: var(--font-mono);
		font-size: 0.75rem;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	.certificate-warnings {
		display: grid;
		gap: 6px;
		color: var(--color-danger);
		font-size: 0.8125rem;
	}

	.behavior-settings-list {
		display: grid;
		gap: 14px;
		margin-top: 16px;
	}

	.form-actions,
	.section-actions {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
		flex-wrap: wrap;
	}

	.page-bottom-actions {
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--color-border);
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
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
		font-size: 0.75rem;
		font-weight: 500;
		opacity: 0.55;
	}

	.key-state span.enabled {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
		opacity: 1;
	}

	@media (max-width: 720px) {
		.form-grid {
			grid-template-columns: 1fr;
		}

		.admin-field--full {
			grid-column: auto;
		}

		.form-actions,
		.section-actions {
			align-items: stretch;
			flex-direction: column;
		}
	}
</style>
