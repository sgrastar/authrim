<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import {
		adminConsentStatementsAPI,
		type ConsentStatement,
		type ConsentStatementLocalization,
		type ConsentStatementVersion,
		type TenantConsentRequirement
	} from '$lib/api/admin-consent-statements';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		MonacoTextEditor
	} from '$lib/components/admin';
	import { ToggleSwitch } from '$lib/components';
	import { getLocale, LL } from '$i18n/i18n-svelte';

	type Mode = 'new' | 'edit';
	type StatementTemplateId =
		| 'terms-of-service'
		| 'privacy-policy'
		| 'user-data-release-consent'
		| 'saml-attribute-release'
		| 'saml-attribute-release-confirmation';
	type CollectionMode = 'required' | 'optional' | 'display' | 'hidden';
	type BindingType =
		| 'subject'
		| 'identity_schema'
		| 'destination_field_mapping_set'
		| 'user_decision';

	let { mode, statementId = '' }: { mode: Mode; statementId?: string } = $props();

	let loading = $state(true);
	let error = $state('');
	let successMessage = $state('');
	let currentStatementId = $state('');
	let statement = $state<ConsentStatement | null>(null);
	let versions = $state<ConsentStatementVersion[]>([]);
	let localizations = $state<ConsentStatementLocalization[]>([]);
	let requirement = $state<TenantConsentRequirement | null>(null);
	let selectedVersionId = $state<string | null>(null);
	let showActivateConfirm = $state(false);
	let activatingVersionId = $state<string | null>(null);
	let editingLanguage = $state<string | null>(null);
	let recordRetentionMode = $state<'indefinite' | 'specified'>('indefinite');
	let reconsentIntervalEnabled = $state(false);
	let collectionMode = $state<CollectionMode>('required');
	let bindingDraft = $state<{ binding_type: BindingType; binding_value?: string }>({
		binding_type: 'subject'
	});
	const samlAttributeReleaseConfirmationCategory = 'saml_attribute_release_confirmation';

	let statementFormData = $state({
		slug: '',
		category: 'custom',
		legal_basis: 'consent',
		processing_purpose: '',
		display_order: 0,
		is_active: true,
		record_retention_days: null as number | null,
		withdrawal_allowed: true,
		withdrawal_impact: '',
		reconsent_on_version_change: true,
		reconsent_interval_days: null as number | null
	});

	let versionFormData = $state({
		version: defaultVersion(),
		content_type: 'url',
		effective_at: currentDateTimeInputValue(),
		effective_until: '',
		effective_until_open_ended: true
	});

	let requirementFormData = $state({
		is_required: 1,
		min_version: '',
		enforcement: 'block',
		show_deletion_link: 0,
		deletion_url: '',
		conditional_rules_json: '',
		display_order: 0
	});

	let localizationFormData = $state({
		language: 'ja',
		title: '',
		description: '',
		processing_purpose: '',
		withdrawal_impact: '',
		document_url: '',
		inline_content: ''
	});

	const selectedVersion = $derived(
		versions.find((version) => version.id === selectedVersionId) || null
	);
	const pageTitle = $derived($LL.admin_consent_statements_detail_title());

	const CATEGORIES = [
		'terms_of_service',
		'privacy_policy',
		samlAttributeReleaseConfirmationCategory,
		'custom'
	];
	const RECORD_RETENTION_PRESETS = [365, 1095, 1825, 2555, 3650];
	const RECONSENT_INTERVAL_PRESETS = [365, 180, 730, 1095];

	onMount(() => {
		if (mode === 'edit') {
			currentStatementId = statementId;
			loadDetail();
		} else {
			applyTemplateFromQuery();
			loading = false;
		}
	});

	$effect(() => {
		if (mode === 'edit' && statementId && statementId !== currentStatementId) {
			currentStatementId = statementId;
		}
	});

	async function loadDetail() {
		loading = true;
		error = '';
		try {
			if (!currentStatementId) {
				throw new Error($LL.admin_consent_statements_error_load());
			}
			const [statementResult, versionResult, requirementResult] = await Promise.all([
				adminConsentStatementsAPI.getStatement(currentStatementId),
				adminConsentStatementsAPI.listVersions(currentStatementId),
				adminConsentStatementsAPI.listRequirements()
			]);
			statement = statementResult.statement;
			versions = (versionResult.versions || []).sort((a, b) => b.created_at - a.created_at);
			requirement =
				(requirementResult.requirements || []).find(
					(req) => req.statement_id === currentStatementId
				) || null;
			populateStatementForm(statement);
			populateRequirementForm(requirement);
			const initialVersion = versions.find((version) => version.is_current) || versions[0] || null;
			if (initialVersion) {
				await selectVersion(initialVersion.id);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_statements_error_load();
		} finally {
			loading = false;
		}
	}

	function populateStatementForm(value: ConsentStatement) {
		statementFormData = {
			slug: value.slug,
			category: normalizeCategory(value.category),
			legal_basis: value.legal_basis,
			processing_purpose: value.processing_purpose || '',
			display_order: value.display_order,
			is_active: value.is_active !== 0,
			record_retention_days: value.record_retention_days ?? null,
			withdrawal_allowed: value.withdrawal_allowed !== 0 && value.withdrawal_allowed !== false,
			withdrawal_impact: value.withdrawal_impact || '',
			reconsent_on_version_change:
				value.reconsent_on_version_change !== 0 && value.reconsent_on_version_change !== false,
			reconsent_interval_days: value.reconsent_interval_days ?? null
		};
		recordRetentionMode =
			value.record_retention_days !== null && value.record_retention_days !== undefined
				? 'specified'
				: 'indefinite';
		reconsentIntervalEnabled =
			value.reconsent_interval_days !== null && value.reconsent_interval_days !== undefined;
	}

	function populateVersionForm(value: ConsentStatementVersion | null) {
		versionFormData = value
			? {
					version: value.version,
					content_type: value.content_type,
					effective_at: toDateTimeInputValue(value.effective_at),
					effective_until: value.effective_until ? toDateTimeInputValue(value.effective_until) : '',
					effective_until_open_ended: !value.effective_until
				}
			: {
					version: defaultVersion(),
					content_type: 'url',
					effective_at: currentDateTimeInputValue(),
					effective_until: '',
					effective_until_open_ended: true
				};
	}

	function populateRequirementForm(value: TenantConsentRequirement | null) {
		collectionMode = value ? (value.is_required ? 'required' : 'optional') : 'hidden';
		requirementFormData = value
			? {
					is_required: value.is_required,
					min_version: value.min_version || '',
					enforcement: value.enforcement,
					show_deletion_link: value.show_deletion_link,
					deletion_url: value.deletion_url || '',
					conditional_rules_json: value.conditional_rules_json || '',
					display_order: value.display_order
				}
			: {
					is_required: 1,
					min_version: '',
					enforcement: 'block',
					show_deletion_link: 0,
					deletion_url: '',
					conditional_rules_json: '',
					display_order: statementFormData.display_order
				};
	}

	async function selectVersion(versionId: string) {
		selectedVersionId = versionId;
		const version = versions.find((item) => item.id === versionId) || null;
		populateVersionForm(version);
		localizations = [];
		editingLanguage = null;
		resetLocalizationForm();
		if (!version) return;
		try {
			if (!currentStatementId) return;
			const result = await adminConsentStatementsAPI.listLocalizations(
				currentStatementId,
				version.id
			);
			localizations = result.localizations || [];
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_localizations_error_load();
		}
	}

	function startNewVersion() {
		selectedVersionId = null;
		populateVersionForm(null);
		localizations = [];
		editingLanguage = null;
		resetLocalizationForm();
		successMessage = $LL.admin_consent_versions_new_draft_ready();
	}

	async function saveSettings() {
		error = '';
		try {
			let savedStatementId = currentStatementId;
			const recordRetentionDays =
				recordRetentionMode === 'specified'
					? statementFormData.record_retention_days || RECORD_RETENTION_PRESETS[1]
					: null;
			const reconsentIntervalDays = reconsentIntervalEnabled
				? statementFormData.reconsent_interval_days || RECONSENT_INTERVAL_PRESETS[0]
				: null;
			if (mode === 'new') {
				const created = await adminConsentStatementsAPI.createStatement({
					slug: statementFormData.slug,
					category: statementFormData.category,
					legal_basis: statementFormData.legal_basis,
					processing_purpose: statementFormData.processing_purpose,
					display_order: statementFormData.display_order,
					record_retention_days: recordRetentionDays,
					withdrawal_allowed: statementFormData.withdrawal_allowed,
					withdrawal_impact: statementFormData.withdrawal_impact,
					reconsent_on_version_change: statementFormData.reconsent_on_version_change,
					reconsent_interval_days: reconsentIntervalDays
				});
				statement = created.statement;
				savedStatementId = created.statement.id;
				currentStatementId = savedStatementId;
			} else {
				if (!savedStatementId) {
					throw new Error($LL.admin_consent_statements_error_save());
				}
				const updated = await adminConsentStatementsAPI.updateStatement(savedStatementId, {
					slug: statementFormData.slug,
					category: statementFormData.category,
					legal_basis: statementFormData.legal_basis,
					processing_purpose: statementFormData.processing_purpose,
					display_order: statementFormData.display_order,
					is_active: statementFormData.is_active ? 1 : 0,
					record_retention_days: recordRetentionDays,
					withdrawal_allowed: statementFormData.withdrawal_allowed,
					withdrawal_impact: statementFormData.withdrawal_impact,
					reconsent_on_version_change: statementFormData.reconsent_on_version_change,
					reconsent_interval_days: reconsentIntervalDays
				});
				statement = updated.statement;
			}

			await saveVersionSettings(savedStatementId);
			await saveRequirementSettings(savedStatementId);
			if (mode === 'new' && shouldSaveInitialLocalization()) {
				await saveInitialLocalization(savedStatementId);
			}

			successMessage = $LL.admin_consent_statements_updated_success();
			if (mode === 'new') {
				goto(`/admin/consent-statements/${encodeURIComponent(savedStatementId)}`);
			} else {
				await loadDetail();
			}
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_statements_error_save();
		}
	}

	async function saveVersionSettings(currentStatementId: string) {
		const effectiveAt = new Date(versionFormData.effective_at).getTime();
		const effectiveUntil = versionFormData.effective_until_open_ended
			? null
			: new Date(versionFormData.effective_until).getTime();
		if (!Number.isFinite(effectiveAt)) {
			throw new Error($LL.admin_consent_versions_effective_start_required());
		}
		if (effectiveUntil !== null && !Number.isFinite(effectiveUntil)) {
			throw new Error($LL.admin_consent_versions_effective_end_required());
		}
		if (selectedVersionId) {
			await adminConsentStatementsAPI.updateVersion(currentStatementId, selectedVersionId, {
				version: versionFormData.version,
				content_type: versionFormData.content_type,
				effective_at: effectiveAt,
				effective_until: effectiveUntil
			});
			return;
		}
		const created = await adminConsentStatementsAPI.createVersion(currentStatementId, {
			version: versionFormData.version,
			content_type: versionFormData.content_type,
			effective_at: effectiveAt,
			effective_until: effectiveUntil
		});
		selectedVersionId = created.version.id;
	}

	function shouldSaveInitialLocalization(): boolean {
		return Boolean(
			selectedVersionId &&
			localizationFormData.language &&
			localizationFormData.title.trim() &&
			localizationFormData.description.trim()
		);
	}

	async function saveInitialLocalization(currentStatementId: string) {
		if (!selectedVersionId) return;
		await adminConsentStatementsAPI.upsertLocalization(
			currentStatementId,
			selectedVersionId,
			localizationFormData.language,
			{
				title: localizationFormData.title,
				description: localizationFormData.description,
				processing_purpose: localizationFormData.processing_purpose || undefined,
				withdrawal_impact: localizationFormData.withdrawal_impact || undefined,
				document_url: localizationFormData.document_url || undefined,
				inline_content: localizationFormData.inline_content || undefined
			}
		);
	}

	async function saveRequirementSettings(currentStatementId: string) {
		if (collectionMode === 'hidden') {
			return;
		}
		await adminConsentStatementsAPI.upsertRequirement(currentStatementId, {
			is_required: requirementFormData.is_required,
			min_version: requirementFormData.min_version || undefined,
			enforcement: requirementFormData.enforcement,
			show_deletion_link: requirementFormData.show_deletion_link,
			deletion_url: requirementFormData.deletion_url || undefined,
			conditional_rules_json: requirementFormData.conditional_rules_json || undefined,
			display_order: requirementFormData.display_order
		});
	}

	async function saveLocalization() {
		if (!currentStatementId || !selectedVersionId) {
			error = $LL.admin_consent_localizations_save_settings_first();
			return;
		}
		error = '';
		try {
			await adminConsentStatementsAPI.upsertLocalization(
				currentStatementId,
				selectedVersionId,
				localizationFormData.language,
				{
					title: localizationFormData.title,
					description: localizationFormData.description,
					processing_purpose: localizationFormData.processing_purpose || undefined,
					withdrawal_impact: localizationFormData.withdrawal_impact || undefined,
					document_url: localizationFormData.document_url || undefined,
					inline_content: localizationFormData.inline_content || undefined
				}
			);
			successMessage = editingLanguage
				? $LL.admin_consent_localizations_updated_success()
				: $LL.admin_consent_localizations_created_success();
			editingLanguage = null;
			resetLocalizationForm();
			await selectVersion(selectedVersionId);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_localizations_error_save();
		}
	}

	function editLocalization(localization: ConsentStatementLocalization) {
		editingLanguage = localization.language;
		localizationFormData = {
			language: localization.language,
			title: localization.title,
			description: localization.description,
			processing_purpose: localization.processing_purpose || '',
			withdrawal_impact: localization.withdrawal_impact || '',
			document_url: localization.document_url || '',
			inline_content: localization.inline_content || ''
		};
	}

	async function deleteLocalization(language: string) {
		if (!currentStatementId || !selectedVersionId) return;
		if (!confirm($LL.admin_consent_localizations_delete_confirm({ language }))) return;
		try {
			await adminConsentStatementsAPI.deleteLocalization(
				currentStatementId,
				selectedVersionId,
				language
			);
			successMessage = $LL.admin_consent_localizations_deleted_success();
			await selectVersion(selectedVersionId);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_localizations_error_delete();
		}
	}

	function resetLocalizationForm() {
		localizationFormData = {
			language: 'ja',
			title: '',
			description: '',
			processing_purpose: '',
			withdrawal_impact: '',
			document_url: '',
			inline_content: ''
		};
	}

	async function confirmActivate(versionId: string) {
		if (!currentStatementId) return;
		error = '';
		try {
			const result = await adminConsentStatementsAPI.listLocalizations(
				currentStatementId,
				versionId
			);
			if ((result.localizations || []).length === 0) {
				await selectVersion(versionId);
				error = $LL.admin_consent_versions_activation_requires_content();
				return;
			}
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_localizations_error_load();
			return;
		}
		activatingVersionId = versionId;
		showActivateConfirm = true;
	}

	async function activateVersion() {
		if (!currentStatementId || !activatingVersionId) return;
		try {
			await adminConsentStatementsAPI.activateVersion(currentStatementId, activatingVersionId);
			showActivateConfirm = false;
			activatingVersionId = null;
			successMessage = $LL.admin_consent_versions_activated_success();
			await loadDetail();
		} catch (err) {
			error =
				err instanceof Error && err.message
					? err.message
					: $LL.admin_consent_versions_error_activate();
		}
	}

	async function deleteVersion(versionId: string) {
		if (!currentStatementId) return;
		if (!confirm($LL.admin_consent_versions_delete_confirm())) return;
		try {
			await adminConsentStatementsAPI.deleteVersion(currentStatementId, versionId);
			successMessage = $LL.admin_consent_versions_deleted_success();
			if (selectedVersionId === versionId) selectedVersionId = null;
			await loadDetail();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_versions_error_delete();
		}
	}

	async function deleteStatement() {
		if (!statement) return;
		if (!confirm($LL.admin_consent_statements_deactivate_confirm())) return;
		try {
			await adminConsentStatementsAPI.deleteStatement(statement.id);
			goto('/admin/consent-statements');
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_consent_statements_error_delete();
		}
	}

	function closeOnBackdropKeydown(event: KeyboardEvent, close: () => void) {
		if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			close();
		}
	}

	function formatDate(ts: number): string {
		if (!ts) return '-';
		return new Date(ts).toLocaleDateString();
	}

	function formatUtcDateTimeInput(value: string): string {
		const timestamp = value ? new Date(value).getTime() : NaN;
		if (!Number.isFinite(timestamp)) return '-';
		return new Date(timestamp).toISOString().replace('T', ' ').slice(0, 16);
	}

	function toDateTimeInputValue(ts: number): string {
		if (!ts) return currentDateTimeInputValue();
		const date = new Date(ts);
		const offsetMs = date.getTimezoneOffset() * 60 * 1000;
		return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
	}

	function todayInputValue(): string {
		return new Date().toISOString().slice(0, 10);
	}

	function currentDateTimeInputValue(): string {
		return toDateTimeInputValue(Date.now());
	}

	function defaultVersion(): string {
		return todayInputValue().replaceAll('-', '');
	}

	function applyTemplateFromQuery() {
		const template = $page.url.searchParams.get('template');
		if (isStatementTemplateId(template)) {
			applyStatementTemplate(template);
			applyCollectionMode(
				normalizeCollectionMode($page.url.searchParams.get('collection'), template)
			);
			applyBindingFromQuery(template);
		}
	}

	function applyBindingFromQuery(template: StatementTemplateId) {
		const bindingType = normalizeBindingType($page.url.searchParams.get('binding_type'), template);
		bindingDraft = {
			binding_type: bindingType,
			binding_value: $page.url.searchParams.get('binding_value') ?? undefined
		};
	}

	function applyStatementTemplate(template: StatementTemplateId) {
		const ja = getLocale() === 'ja';
		const templateDefaults = getStatementTemplateDefaults(template, ja);

		statementFormData = {
			slug: templateDefaults.slug,
			category: templateDefaults.category,
			legal_basis: 'consent',
			processing_purpose: templateDefaults.processingPurpose,
			display_order: 0,
			is_active: true,
			record_retention_days: null,
			withdrawal_allowed: templateDefaults.withdrawalAllowed,
			withdrawal_impact: '',
			reconsent_on_version_change: true,
			reconsent_interval_days: null
		};
		recordRetentionMode = 'indefinite';
		reconsentIntervalEnabled = false;
		versionFormData = {
			...versionFormData,
			content_type: 'inline'
		};
		requirementFormData = {
			...requirementFormData,
			display_order: 0
		};
		localizationFormData = {
			language: ja ? 'ja' : 'en',
			title: templateDefaults.title,
			description: templateDefaults.description,
			processing_purpose: templateDefaults.processingPurpose,
			withdrawal_impact: '',
			document_url: '',
			inline_content: templateDefaults.inlineContent
		};
	}

	function isStatementTemplateId(value: string | null): value is StatementTemplateId {
		return (
			value === 'terms-of-service' ||
			value === 'privacy-policy' ||
			value === 'user-data-release-consent' ||
			value === 'saml-attribute-release' ||
			value === 'saml-attribute-release-confirmation'
		);
	}

	function normalizeCollectionMode(
		value: string | null,
		template: StatementTemplateId
	): CollectionMode {
		if (value === 'required' || value === 'optional' || value === 'display' || value === 'hidden') {
			return value;
		}
		return template === 'saml-attribute-release-confirmation' ? 'display' : 'required';
	}

	function applyCollectionMode(mode: CollectionMode) {
		collectionMode = mode;
		switch (mode) {
			case 'required':
				requirementFormData = {
					...requirementFormData,
					is_required: 1,
					enforcement: 'block'
				};
				return;
			case 'optional':
			case 'display':
			case 'hidden':
				requirementFormData = {
					...requirementFormData,
					is_required: 0,
					enforcement: 'allow_continue'
				};
				return;
		}
	}

	function normalizeBindingType(value: string | null, template: StatementTemplateId): BindingType {
		if (
			value === 'subject' ||
			value === 'identity_schema' ||
			value === 'destination_field_mapping_set' ||
			value === 'user_decision'
		) {
			return value;
		}
		switch (template) {
			case 'user-data-release-consent':
			case 'saml-attribute-release':
				return 'destination_field_mapping_set';
			case 'saml-attribute-release-confirmation':
				return 'user_decision';
			case 'terms-of-service':
			case 'privacy-policy':
			default:
				return 'subject';
		}
	}

	function getStatementTemplateDefaults(template: StatementTemplateId, ja: boolean) {
		const defaults: Record<
			StatementTemplateId,
			{
				slug: string;
				category: string;
				processingPurpose: string;
				title: string;
				description: string;
				inlineContent: string;
				withdrawalAllowed: boolean;
			}
		> = {
			'terms-of-service': {
				slug: 'terms_of_service',
				category: 'terms_of_service',
				processingPurpose: ja ? 'サービス利用条件への同意' : 'Agreement to service terms',
				title: ja ? '利用規約への同意' : 'Terms of Service',
				description: ja
					? 'サービスを利用するには利用規約への同意が必要です。'
					: 'You must agree to the Terms of Service to continue.',
				inlineContent: ja
					? '利用規約を読み、その内容に同意します。'
					: 'I have read and agree to the Terms of Service.',
				withdrawalAllowed: false
			},
			'privacy-policy': {
				slug: 'privacy_policy',
				category: 'privacy_policy',
				processingPurpose: ja ? '個人情報の取り扱いへの同意' : 'Consent to privacy practices',
				title: ja ? 'プライバシーポリシーへの同意' : 'Privacy Policy',
				description: ja
					? '個人情報の取り扱い方針を確認してください。'
					: 'Review how personal data is handled.',
				inlineContent: ja
					? 'プライバシーポリシーを読み、その内容に同意します。'
					: 'I have read and agree to the Privacy Policy.',
				withdrawalAllowed: false
			},
			'user-data-release-consent': {
				slug: 'user_data_release',
				category: 'custom',
				processingPurpose: ja ? 'ユーザーデータの送信同意' : 'User data release consent',
				title: ja ? 'ユーザーデータ送信への同意' : 'User Data Release Consent',
				description: ja
					? 'このサービスにユーザーデータを送信することへの同意を取得します。'
					: 'Collect consent to release user data to this service.',
				inlineContent: ja
					? [
							'このサービスに必要なユーザーデータを送信します。',
							'',
							'送信先: {clientName}',
							'送信される情報: {claims}',
							'',
							'送信内容を確認してください。'
						].join('\n')
					: [
							'Authrim will release the required user data to this service.',
							'',
							'Destination: {clientName}',
							'Released data: {claims}',
							'',
							'Review the information before continuing.'
						].join('\n'),
				withdrawalAllowed: true
			},
			'saml-attribute-release': {
				slug: 'saml_attribute_release',
				category: 'custom',
				processingPurpose: ja ? 'SAML SPへの属性送信同意' : 'SAML SP attribute release consent',
				title: ja ? 'SAML属性送信への同意' : 'SAML Attribute Release Consent',
				description: ja
					? 'SAML SPに属性情報を送信することへの同意を取得します。'
					: 'Collect consent to release attributes to a SAML SP.',
				inlineContent: ja
					? [
							'このサービスに以下の属性情報を送信します。',
							'',
							'サービス名: {spName}',
							'送信先: {entityId}',
							'送信属性: {attributes}',
							'',
							'送信内容を確認してください。'
						].join('\n')
					: [
							'Authrim will release the following attributes to this service.',
							'',
							'Service: {spName}',
							'Destination: {entityId}',
							'Attributes: {attributes}',
							'',
							'Review the information before continuing.'
						].join('\n'),
				withdrawalAllowed: true
			},
			'saml-attribute-release-confirmation': {
				slug: 'saml_attribute_release_uapprove',
				category: samlAttributeReleaseConfirmationCategory,
				processingPurpose: ja
					? 'SAML SPへの属性送信確認'
					: 'SAML SP attribute release confirmation',
				title: ja ? 'SPへの属性提供に対する同意' : 'Consent for releasing attributes to the SP',
				description: ja
					? 'このサービスに属性情報を送信する方法を選択してください。'
					: 'Choose how Authrim should release attributes to this service.',
				inlineContent: ja
					? [
							'このサービスに表示中の属性情報を送信します。',
							'',
							'サービス名: {spName}',
							'送信先: {entityId}',
							'',
							'選択肢:',
							'- 今回だけ情報を送信することに同意する（次回ログイン時に再度同意確認を行う）',
							'- 今後も情報を自動的にこのサービスに送信することに同意する（次回ログイン以降、同意確認は行わない）',
							''
						].join('\n')
					: [
							'Authrim will release the displayed attributes to this service.',
							'',
							'Service: {spName}',
							'Destination: {entityId}',
							'',
							'Choices:',
							'- Agree to release the information this time only. You will be asked again at the next login.',
							'- Agree to automatically release the information to this service in the future.',
							''
						].join('\n'),
				withdrawalAllowed: false
			}
		};
		return defaults[template];
	}

	function localText(key: string): string {
		const ja = getLocale() === 'ja';
		const labels: Record<string, { ja: string; en: string }> = {
			samlCategory: { ja: 'SAML属性送信確認', en: 'SAML attribute release confirmation' },
			displayOnly: { ja: '表示のみ', en: 'Display only' },
			hidden: { ja: '表示なし', en: 'Hidden' },
			bindingTitle: { ja: '紐づけ対象', en: 'Binding target' },
			bindingDescription: {
				ja: 'この同意文をどの対象に紐付けるかの初期指定です。',
				en: 'Initial binding target for this consent statement.'
			},
			bindingType: { ja: '対象種別', en: 'Target type' },
			bindingSubject: { ja: '本人', en: 'Subject' }
		};
		return ja ? labels[key]?.ja || key : labels[key]?.en || key;
	}

	function getCategoryLabel(category: string): string {
		switch (normalizeCategory(category)) {
			case 'terms_of_service':
				return $LL.admin_consent_category_terms_of_service();
			case 'privacy_policy':
				return $LL.admin_consent_category_privacy_policy();
			case samlAttributeReleaseConfirmationCategory:
				return localText('samlCategory');
			default:
				return $LL.admin_consent_category_custom();
		}
	}

	function normalizeCategory(category: string): string {
		return category === 'terms_of_service' ||
			category === 'privacy_policy' ||
			category === samlAttributeReleaseConfirmationCategory
			? category
			: 'custom';
	}

	function getVersionStatusLabel(status: string): string {
		switch (status) {
			case 'active':
				return $LL.admin_consent_versions_status_active();
			case 'archived':
				return $LL.admin_consent_versions_status_archived();
			default:
				return $LL.admin_consent_versions_status_draft();
		}
	}

	function getReconsentIntervalPresetLabel(days: number): string {
		switch (days) {
			case 180:
				return $LL.admin_consent_statements_reconsent_interval_preset_180();
			case 365:
				return $LL.admin_consent_statements_reconsent_interval_preset_365();
			case 730:
				return $LL.admin_consent_statements_reconsent_interval_preset_730();
			case 1095:
				return $LL.admin_consent_statements_reconsent_interval_preset_1095();
			default:
				return $LL.admin_consent_statements_reconsent_interval_preset({ days });
		}
	}

	function getRecordRetentionPresetLabel(days: number): string {
		switch (days) {
			case 365:
				return $LL.admin_consent_statements_record_retention_preset_365();
			case 1095:
				return $LL.admin_consent_statements_record_retention_preset_1095();
			case 1825:
				return $LL.admin_consent_statements_record_retention_preset_1825();
			case 2555:
				return $LL.admin_consent_statements_record_retention_preset_2555();
			case 3650:
				return $LL.admin_consent_statements_record_retention_preset_3650();
			default:
				return $LL.admin_consent_statements_record_retention_preset({ days });
		}
	}
</script>

<svelte:head>
	<title>{pageTitle} - {$LL.admin_consent_statements_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={pageTitle}
		description={mode === 'new'
			? $LL.admin_consent_statements_new_description()
			: $LL.admin_consent_statements_detail_description()}
	>
		{#snippet actions()}
			<a href="/admin/consent-statements" class="btn btn-secondary">
				{$LL.admin_consent_statements_back_to_list()}
			</a>
		{/snippet}
	</AdminPageHeader>

	{#if error}
		<div class="alert alert-error alert-stacked">{error}</div>
	{/if}
	{#if successMessage}
		<div class="alert alert-success alert-stacked">{successMessage}</div>
	{/if}

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner" aria-hidden="true"></i>
			<p>{$LL.admin_consent_statements_loading()}</p>
		</div>
	{:else}
		<div class="detail-stack">
			<AdminSection>
				<div class="statement-identity">
					<input
						id="stmt-slug"
						type="text"
						class="input statement-identity__input"
						aria-label={$LL.admin_consent_statements_name()}
						bind:value={statementFormData.slug}
						placeholder={$LL.admin_consent_statements_placeholder_title()}
					/>
					<div class="statement-category">
						<div class="field-label">{$LL.admin_consent_statements_category()}</div>
						<div
							class="radio-group"
							role="radiogroup"
							aria-label={$LL.admin_consent_statements_category()}
						>
							{#each CATEGORIES as category (category)}
								<label class="radio-card">
									<input
										type="radio"
										name="statement-category"
										value={category}
										bind:group={statementFormData.category}
									/>
									<span>{getCategoryLabel(category)}</span>
								</label>
							{/each}
						</div>
					</div>
					<div class="statement-consent-collection">
						<div class="field-label">{$LL.admin_consent_requirements_collection_mode()}</div>
						<div
							class="radio-group"
							role="radiogroup"
							aria-label={$LL.admin_consent_requirements_collection_mode()}
						>
							<label class="radio-card">
								<input
									type="radio"
									name="requirement-required"
									value="required"
									checked={collectionMode === 'required'}
									onchange={() => applyCollectionMode('required')}
								/>
								<span>{$LL.admin_consent_requirements_collection_required()}</span>
							</label>
							<label class="radio-card">
								<input
									type="radio"
									name="requirement-required"
									value="optional"
									checked={collectionMode === 'optional'}
									onchange={() => applyCollectionMode('optional')}
								/>
								<span>{$LL.admin_consent_requirements_collection_optional()}</span>
							</label>
							<label class="radio-card">
								<input
									type="radio"
									name="requirement-required"
									value="display"
									checked={collectionMode === 'display'}
									onchange={() => applyCollectionMode('display')}
								/>
								<span>{localText('displayOnly')}</span>
							</label>
							<label class="radio-card">
								<input
									type="radio"
									name="requirement-required"
									value="hidden"
									checked={collectionMode === 'hidden'}
									onchange={() => applyCollectionMode('hidden')}
								/>
								<span>{localText('hidden')}</span>
							</label>
						</div>
					</div>
				</div>
			</AdminSection>

			{#if mode === 'new' && $page.url.searchParams.has('template')}
				<AdminSection>
					<div class="section-header">
						<div>
							<h2>{localText('bindingTitle')}</h2>
							<p>{localText('bindingDescription')}</p>
						</div>
					</div>
					<div class="binding-editor">
						<div class="form-group">
							<label for="binding-type">{localText('bindingType')}</label>
							<select id="binding-type" class="input" bind:value={bindingDraft.binding_type}>
								<option value="subject">{localText('bindingSubject')}</option>
								<option value="identity_schema">Identity Schema</option>
								<option value="destination_field_mapping_set">
									Destination Field Mapping Sets
								</option>
								<option value="user_decision">User Decision</option>
							</select>
						</div>
					</div>
				</AdminSection>
			{/if}

			<AdminSection>
				<div class="section-header">
					<div>
						<h2>{$LL.admin_consent_statements_versions_section()}</h2>
						<p>{$LL.admin_consent_statements_versions_section_description()}</p>
					</div>
					{#if mode === 'edit'}
						<button class="btn btn-secondary" onclick={startNewVersion}>
							{$LL.admin_consent_versions_new()}
						</button>
					{/if}
				</div>

				<AdminDataTable width="wide">
					<thead>
						<tr>
							<th>{$LL.admin_consent_versions_version()}</th>
							<th>{$LL.admin_consent_versions_content_type()}</th>
							<th>{$LL.admin_consent_statements_status()}</th>
							<th>{$LL.admin_consent_versions_effective_start()}</th>
							<th>{$LL.admin_consent_versions_effective_end()}</th>
							<th>{$LL.admin_consent_versions_hash()}</th>
							<th class="optional-column">{$LL.admin_consent_statements_actions()}</th>
						</tr>
					</thead>
					<tbody>
						{#each versions as version (version.id)}
							<tr
								class:selected-row={selectedVersionId === version.id}
								data-clickable="true"
								onclick={() => selectVersion(version.id)}
							>
								<td>
									<code class="admin-code">{version.version}</code>
									{#if version.is_current}
										<span class="status-badge" data-state="active">
											{$LL.admin_consent_versions_current()}
										</span>
									{/if}
								</td>
								<td>
									{version.content_type === 'inline'
										? $LL.admin_consent_content_type_inline()
										: $LL.admin_consent_content_type_url()}
								</td>
								<td>
									<span class="status-badge" data-status={version.status}>
										{getVersionStatusLabel(version.status)}
									</span>
								</td>
								<td>{formatDate(version.effective_at)}</td>
								<td>
									{version.effective_until
										? formatDate(version.effective_until)
										: $LL.admin_consent_versions_effective_end_open()}
								</td>
								<td>{version.content_hash ? `${version.content_hash.slice(0, 8)}...` : '-'}</td>
								<td class="optional-column">
									<div class="inline-actions">
										{#if version.status === 'draft'}
											<button
												class="btn btn-ghost btn-sm"
												onclick={(event) => {
													event.stopPropagation();
													confirmActivate(version.id);
												}}
											>
												{$LL.admin_consent_versions_activate()}
											</button>
											{#if mode === 'edit'}
												<button
													class="btn btn-ghost btn-sm danger"
													onclick={(event) => {
														event.stopPropagation();
														deleteStatement();
													}}
												>
													{$LL.admin_consent_statements_deactivate_action()}
												</button>
											{/if}
											<button
												class="btn btn-ghost btn-sm danger"
												onclick={(event) => {
													event.stopPropagation();
													deleteVersion(version.id);
												}}
											>
												{$LL.admin_consent_statements_delete_action()}
											</button>
										{/if}
									</div>
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="7" class="empty-cell">
									{$LL.admin_consent_versions_empty()}
								</td>
							</tr>
						{/each}
					</tbody>
				</AdminDataTable>
			</AdminSection>

			<AdminSection>
				<div class="section-header">
					<div>
						<h2>{$LL.admin_consent_statements_settings_section()}</h2>
						<p>
							{selectedVersion
								? $LL.admin_consent_statements_selected_version_settings({
										version: selectedVersion.version
									})
								: $LL.admin_consent_statements_new_version_settings()}
						</p>
					</div>
				</div>

				<div class="form-grid">
					<div class="version-row full">
						<div class="form-group">
							<label for="ver-version">{$LL.admin_consent_versions_version()}</label>
							<input
								id="ver-version"
								type="text"
								class="input"
								bind:value={versionFormData.version}
								placeholder="YYYYMMDD"
								maxlength="8"
								pattern="\d{8}"
							/>
						</div>
						<div class="form-group">
							<label for="ver-effective">{$LL.admin_consent_versions_effective_start()}</label>
							<input
								id="ver-effective"
								type="datetime-local"
								class="input"
								bind:value={versionFormData.effective_at}
							/>
							<div class="utc-hint">
								UTC: {formatUtcDateTimeInput(versionFormData.effective_at)}
							</div>
						</div>
						<div class="form-group">
							<label for="ver-effective-until">
								{$LL.admin_consent_versions_effective_end()}
							</label>
							<input
								id="ver-effective-until"
								type="datetime-local"
								class="input"
								bind:value={versionFormData.effective_until}
								disabled={versionFormData.effective_until_open_ended}
							/>
							<div class="utc-hint">
								UTC:
								{versionFormData.effective_until_open_ended
									? '-'
									: formatUtcDateTimeInput(versionFormData.effective_until)}
							</div>
						</div>
						<label class="check-row datetime-open-ended">
							<input type="checkbox" bind:checked={versionFormData.effective_until_open_ended} />
							<span>{$LL.admin_consent_versions_effective_end_open()}</span>
						</label>
					</div>
					<div class="form-group full">
						<div class="field-label">{$LL.admin_consent_statements_record_retention_days()}</div>
						<div
							class="radio-group"
							role="radiogroup"
							aria-label={$LL.admin_consent_statements_record_retention_days()}
						>
							<label class="radio-card">
								<input
									type="radio"
									name="record-retention-mode"
									value="indefinite"
									bind:group={recordRetentionMode}
								/>
								<span>{$LL.admin_consent_statements_record_retention_indefinite()}</span>
							</label>
							<label class="radio-card">
								<input
									type="radio"
									name="record-retention-mode"
									value="specified"
									bind:group={recordRetentionMode}
									onchange={() => {
										if (!statementFormData.record_retention_days) {
											statementFormData.record_retention_days = RECORD_RETENTION_PRESETS[1];
										}
									}}
								/>
								<span>{$LL.admin_consent_statements_record_retention_specified()}</span>
							</label>
						</div>
						{#if recordRetentionMode === 'specified'}
							<div class="preset-row">
								{#each RECORD_RETENTION_PRESETS as days (days)}
									<button
										type="button"
										class="preset-button"
										class:selected-preset={statementFormData.record_retention_days === days}
										onclick={() => (statementFormData.record_retention_days = days)}
									>
										{getRecordRetentionPresetLabel(days)}
									</button>
								{/each}
							</div>
							<div class="form-group interval-input">
								<label for="stmt-retention-days">
									{$LL.admin_consent_statements_record_retention_days()}
								</label>
								<input
									id="stmt-retention-days"
									type="number"
									min="1"
									class="input"
									bind:value={statementFormData.record_retention_days}
								/>
							</div>
						{/if}
					</div>
					<div class="form-group full">
						<ToggleSwitch
							id="stmt-reconsent-enabled"
							bind:checked={reconsentIntervalEnabled}
							label={$LL.admin_consent_statements_reconsent_interval_enabled()}
							description={$LL.admin_consent_statements_reconsent_interval_description()}
							onchange={(checked) => {
								if (checked && !statementFormData.reconsent_interval_days) {
									statementFormData.reconsent_interval_days = RECONSENT_INTERVAL_PRESETS[0];
								}
							}}
						/>
						{#if reconsentIntervalEnabled}
							<div class="preset-row">
								{#each RECONSENT_INTERVAL_PRESETS as days (days)}
									<button
										type="button"
										class="preset-button"
										class:selected-preset={statementFormData.reconsent_interval_days === days}
										onclick={() => (statementFormData.reconsent_interval_days = days)}
									>
										{getReconsentIntervalPresetLabel(days)}
									</button>
								{/each}
							</div>
							<div class="form-group interval-input">
								<label for="stmt-reconsent-days">
									{$LL.admin_consent_statements_reconsent_interval_days()}
								</label>
								<input
									id="stmt-reconsent-days"
									type="number"
									min="1"
									class="input"
									bind:value={statementFormData.reconsent_interval_days}
								/>
							</div>
						{/if}
					</div>
					<label class="check-row">
						<input type="checkbox" bind:checked={statementFormData.reconsent_on_version_change} />
						<span>{$LL.admin_consent_statements_reconsent_on_version_change()}</span>
					</label>
					<label class="check-row">
						<input type="checkbox" bind:checked={statementFormData.withdrawal_allowed} />
						<span>{$LL.admin_consent_statements_withdrawal_allowed()}</span>
					</label>
				</div>

				<div class="plain-subsection">
					<h3>{$LL.admin_consent_requirements_advanced_title()}</h3>
					<div class="form-grid">
						<div class="form-group">
							<label for="req-enforcement">{$LL.admin_consent_requirements_enforcement()}</label>
							<select
								id="req-enforcement"
								class="input"
								bind:value={requirementFormData.enforcement}
							>
								<option value="block">
									{$LL.admin_consent_requirements_enforcement_block()}
								</option>
								<option value="allow_continue">
									{$LL.admin_consent_requirements_enforcement_allow_continue()}
								</option>
							</select>
						</div>
						<div class="form-group">
							<label for="req-min-version">
								{$LL.admin_consent_requirements_min_version_yyyymmdd()}
							</label>
							<input
								id="req-min-version"
								type="text"
								class="input"
								bind:value={requirementFormData.min_version}
								placeholder="YYYYMMDD"
								maxlength="8"
							/>
						</div>
						<div class="form-group full">
							<ToggleSwitch
								checked={requirementFormData.show_deletion_link === 1}
								label={$LL.admin_consent_requirements_deletion_link()}
								description={$LL.admin_consent_requirements_deletion_link_description()}
								onchange={(checked) => {
									requirementFormData.show_deletion_link = checked ? 1 : 0;
								}}
							/>
						</div>
						{#if requirementFormData.show_deletion_link}
							<div class="form-group">
								<label for="req-deletion-url">
									{$LL.admin_consent_requirements_deletion_url()}
								</label>
								<input
									id="req-deletion-url"
									type="url"
									class="input"
									bind:value={requirementFormData.deletion_url}
									placeholder="https://example.com/delete-account"
								/>
							</div>
						{/if}
						<div class="form-group full">
							<label for="req-rules">{$LL.admin_consent_requirements_rules()}</label>
							<textarea
								id="req-rules"
								class="input"
								bind:value={requirementFormData.conditional_rules_json}
								rows="3"
								placeholder={'[{"claim": "address.country", "op": "in", "value": ["DE"], "result": "required"}]'}
							></textarea>
						</div>
					</div>
				</div>

				<div class="form-actions">
					<button class="btn btn-primary" onclick={saveSettings}>
						{mode === 'new'
							? $LL.admin_consent_statements_create()
							: $LL.admin_consent_statements_save_settings()}
					</button>
				</div>
			</AdminSection>

			<AdminSection>
				<div class="section-header">
					<div>
						<h2>{$LL.admin_consent_statements_content_section()}</h2>
						<p>
							{selectedVersion
								? $LL.admin_consent_statements_content_section_description({
										version: selectedVersion.version
									})
								: $LL.admin_consent_localizations_save_settings_first()}
						</p>
					</div>
				</div>

				<div class="content-type-control">
					<label for="ver-content-type">{$LL.admin_consent_versions_content_type()}</label>
					<select id="ver-content-type" class="input" bind:value={versionFormData.content_type}>
						<option value="url">{$LL.admin_consent_content_type_url()}</option>
						<option value="inline">{$LL.admin_consent_content_type_inline()}</option>
					</select>
				</div>

				<div class="form-card">
					<h3>
						{editingLanguage
							? $LL.admin_consent_localizations_edit({ language: editingLanguage })
							: $LL.admin_consent_localizations_new()}
					</h3>
					<div class="form-grid">
						<div class="form-group">
							<label for="loc-language">{$LL.admin_consent_localizations_language()}</label>
							<input
								id="loc-language"
								type="text"
								class="input"
								bind:value={localizationFormData.language}
								placeholder="ja"
								disabled={!!editingLanguage}
							/>
						</div>
						<div class="form-group">
							<label for="loc-title">{$LL.admin_consent_localizations_title()}</label>
							<input
								id="loc-title"
								type="text"
								class="input"
								bind:value={localizationFormData.title}
								placeholder={$LL.admin_consent_localizations_placeholder_title()}
								disabled={!selectedVersionId}
							/>
						</div>
						<div class="form-group full">
							<label for="loc-description">{$LL.admin_consent_localizations_description()}</label>
							<textarea
								id="loc-description"
								class="input"
								bind:value={localizationFormData.description}
								rows="2"
								placeholder={$LL.admin_consent_localizations_placeholder_description()}
								disabled={!selectedVersionId}
							></textarea>
						</div>
						<div class="form-group full">
							<label for="loc-purpose">{$LL.admin_consent_statements_purpose()}</label>
							<textarea
								id="loc-purpose"
								class="input"
								bind:value={localizationFormData.processing_purpose}
								rows="2"
								placeholder={$LL.admin_consent_localizations_placeholder_purpose()}
								disabled={!selectedVersionId}
							></textarea>
						</div>
						<div class="form-group full">
							<label for="loc-withdrawal-impact">
								{$LL.admin_consent_statements_withdrawal_impact()}
							</label>
							<textarea
								id="loc-withdrawal-impact"
								class="input"
								bind:value={localizationFormData.withdrawal_impact}
								rows="2"
								placeholder={$LL.admin_consent_localizations_placeholder_withdrawal_impact()}
								disabled={!selectedVersionId}
							></textarea>
						</div>
						<div class="form-group">
							<label for="loc-url">{$LL.admin_consent_localizations_url()}</label>
							<input
								id="loc-url"
								type="url"
								class="input"
								bind:value={localizationFormData.document_url}
								placeholder="https://example.com/policy.html"
								disabled={!selectedVersionId}
							/>
						</div>
						<div class="form-group full">
							<label for="loc-inline">{$LL.admin_consent_localizations_inline()}</label>
							<MonacoTextEditor
								bind:value={localizationFormData.inline_content}
								language="authrim-consent-html"
								ariaLabel={$LL.admin_consent_localizations_inline()}
								placeholder={$LL.admin_consent_localizations_placeholder_inline()}
								disabled={!selectedVersionId}
								minHeight={188}
							/>
						</div>
					</div>
					<div class="form-actions">
						{#if editingLanguage}
							<button
								class="btn btn-secondary"
								onclick={() => {
									editingLanguage = null;
									resetLocalizationForm();
								}}
							>
								{$LL.admin_consent_statements_cancel()}
							</button>
						{/if}
						<button
							class="btn btn-primary"
							onclick={saveLocalization}
							disabled={!selectedVersionId}
						>
							{editingLanguage
								? $LL.admin_consent_statements_update()
								: $LL.admin_consent_localizations_add()}
						</button>
					</div>
				</div>

				<AdminDataTable width="wide">
					<thead>
						<tr>
							<th>{$LL.admin_consent_localizations_language()}</th>
							<th>{$LL.admin_consent_localizations_title()}</th>
							<th>{$LL.admin_consent_localizations_description()}</th>
							<th>{$LL.admin_consent_localizations_url()}</th>
							<th>{$LL.admin_consent_statements_actions()}</th>
						</tr>
					</thead>
					<tbody>
						{#each localizations as localization (localization.id)}
							<tr>
								<td><code class="admin-code">{localization.language}</code></td>
								<td>{localization.title}</td>
								<td class="truncate-cell">{localization.description}</td>
								<td>
									{#if localization.document_url}
										<a href={localization.document_url} target="_blank" rel="noopener noreferrer">
											{$LL.admin_consent_localizations_link()}
										</a>
									{:else}
										-
									{/if}
								</td>
								<td>
									<div class="inline-actions">
										<button
											class="btn btn-ghost btn-sm"
											onclick={() => editLocalization(localization)}
										>
											{$LL.admin_consent_statements_edit_action()}
										</button>
										<button
											class="btn btn-ghost btn-sm danger"
											onclick={() => deleteLocalization(localization.language)}
										>
											{$LL.admin_consent_statements_delete_action()}
										</button>
									</div>
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="5" class="empty-cell">
									{$LL.admin_consent_localizations_empty()}
								</td>
							</tr>
						{/each}
					</tbody>
				</AdminDataTable>
			</AdminSection>
		</div>
	{/if}

	{#if showActivateConfirm}
		<div
			class="modal-overlay"
			role="button"
			tabindex="0"
			aria-label={$LL.admin_consent_versions_dialog_close()}
			onclick={(event) => {
				if (event.target === event.currentTarget) showActivateConfirm = false;
			}}
			onkeydown={(event) => closeOnBackdropKeydown(event, () => (showActivateConfirm = false))}
		>
			<div class="modal" role="dialog" aria-modal="true">
				<h3>{$LL.admin_consent_versions_dialog_title()}</h3>
				<p>{$LL.admin_consent_versions_activate_confirm()}</p>
				<div class="form-actions">
					<button class="btn btn-secondary" onclick={() => (showActivateConfirm = false)}>
						{$LL.admin_consent_statements_cancel()}
					</button>
					<button class="btn btn-primary" onclick={activateVersion}>
						{$LL.admin_consent_versions_activate()}
					</button>
				</div>
			</div>
		</div>
	{/if}
</AdminPageShell>

<style>
	.detail-stack {
		display: grid;
		gap: 18px;
	}

	.statement-identity {
		max-width: 720px;
	}

	.statement-identity__input {
		font-size: 1rem;
		font-weight: 600;
	}

	.statement-category,
	.statement-consent-collection {
		margin-top: 18px;
		display: grid;
		gap: 8px;
	}

	.section-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 16px;
	}

	.section-header h2,
	.form-card h3 {
		margin: 0;
		color: var(--color-text);
		font-size: 1rem;
		font-weight: 700;
	}

	.section-header p {
		margin: 4px 0 0;
		color: var(--color-text-muted);
		font-size: 0.86rem;
		line-height: 1.5;
	}

	.form-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 14px;
	}

	.binding-editor {
		display: grid;
		grid-template-columns: minmax(220px, 0.8fr) minmax(280px, 1.2fr);
		gap: 14px;
	}

	.form-group {
		display: grid;
		gap: 5px;
	}

	.form-group.full {
		grid-column: 1 / -1;
	}

	.form-group label,
	.field-label {
		color: var(--color-text-muted);
		font-size: 0.75rem;
		font-weight: 600;
	}

	.radio-group {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}

	.radio-card {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 38px;
		padding: 8px 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font-size: 0.875rem;
		font-weight: 600;
		cursor: pointer;
	}

	.radio-card:has(input:checked) {
		border-color: var(--color-accent);
		background: var(--color-accent-muted);
		color: var(--color-accent);
	}

	.version-row {
		display: grid;
		grid-template-columns: minmax(180px, 1.2fr) minmax(220px, 1fr) minmax(220px, 1fr) auto;
		align-items: start;
		gap: 14px;
	}

	.utc-hint {
		color: var(--color-text-muted);
		font-size: 0.74rem;
		line-height: 1.35;
	}

	.datetime-open-ended {
		margin-top: 20px;
		white-space: nowrap;
	}

	.input {
		width: 100%;
		height: var(--control-height, 38px);
		min-height: var(--control-height, 38px);
		padding: var(--control-padding, 8px 12px);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font-size: 0.875rem;
	}

	.preset-row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 8px;
	}

	.preset-button {
		min-height: 32px;
		padding: 5px 10px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
	}

	.preset-button.selected-preset {
		border-color: var(--color-accent);
		background: var(--color-accent-muted);
		color: var(--color-accent);
	}

	.interval-input {
		max-width: 220px;
		margin-top: 10px;
	}

	.input:focus {
		outline: none;
		border-color: var(--color-accent);
		box-shadow: 0 0 0 2px var(--color-accent-muted);
	}

	textarea.input {
		height: auto;
		resize: vertical;
	}

	.check-row {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 38px;
		color: var(--color-text);
		font-size: 0.88rem;
	}

	.form-card {
		margin-top: 18px;
		padding: 16px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface-muted);
	}

	.plain-subsection {
		margin-top: 20px;
	}

	.plain-subsection h3 {
		margin: 0 0 12px;
		color: var(--color-text);
		font-size: 0.95rem;
		font-weight: 700;
	}

	.form-card h3 {
		margin-bottom: 12px;
	}

	.content-type-control {
		display: grid;
		gap: 6px;
		max-width: 360px;
		margin: 0 0 16px;
	}

	.content-type-control label {
		color: var(--color-text-muted);
		font-size: 0.75rem;
		font-weight: 600;
	}

	.form-actions,
	.inline-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		justify-content: flex-end;
	}

	.form-actions {
		margin-top: 16px;
	}

	.inline-actions {
		justify-content: flex-start;
	}

	.alert-stacked {
		margin-bottom: 14px;
	}

	.selected-row {
		background: var(--color-accent-muted) !important;
	}

	.status-badge {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		margin-left: 6px;
		padding: 2px 8px;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		color: var(--color-text-muted);
		font-size: 0.75rem;
		font-weight: 700;
	}

	.status-badge[data-state='active'],
	.status-badge[data-status='active'] {
		color: var(--color-success);
		border-color: color-mix(in srgb, var(--color-success) 45%, var(--color-border));
		background: color-mix(in srgb, var(--color-success) 8%, transparent);
	}

	.empty-cell {
		padding: 24px;
		color: var(--color-text-muted);
		text-align: center;
	}

	.admin-code {
		font-family: var(--font-mono);
	}

	.truncate-cell {
		max-width: 280px;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.danger {
		color: var(--color-danger);
	}

	.modal-overlay {
		position: fixed;
		inset: 0;
		z-index: 1000;
		display: grid;
		place-items: center;
		background: rgb(0 0 0 / 50%);
	}

	.modal {
		width: min(420px, calc(100vw - 32px));
		padding: 22px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
		box-shadow: var(--card-shadow);
	}

	.modal h3 {
		margin: 0 0 10px;
		font-size: 1rem;
	}

	.modal p {
		margin: 0;
		color: var(--color-text-muted);
		line-height: 1.55;
	}

	@media (max-width: 760px) {
		.section-header,
		.form-actions {
			display: grid;
			justify-content: stretch;
		}

		.form-grid {
			grid-template-columns: 1fr;
		}

		.binding-editor {
			grid-template-columns: 1fr;
		}

		.version-row {
			grid-template-columns: 1fr;
		}

		.datetime-open-ended {
			margin-top: 0;
		}

		.optional-column {
			display: none;
		}
	}
</style>
