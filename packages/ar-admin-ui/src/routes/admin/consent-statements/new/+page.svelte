<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { getLocale, LL } from '$i18n/i18n-svelte';
	import {
		adminConsentStatementsAPI,
		type ConsentStatement,
		type ConsentStatementLocalization,
		type ConsentStatementVersion,
		type TenantConsentRequirement
	} from '$lib/api/admin-consent-statements';
	import {
		adminIdentityMappingAPI,
		type IdentityMappingFieldMappingSetSummary
	} from '$lib/api/admin-identity-mapping';
	import { ToggleSwitch } from '$lib/components';
	import { AdminPageShell, MonacoTextEditor, SanitizedHtmlPreview } from '$lib/components/admin';
	import { onMount } from 'svelte';

	type TemplateId =
		| 'terms-of-service'
		| 'privacy-policy'
		| 'user-data-release-consent'
		| 'saml-attribute-release'
		| 'saml-attribute-release-confirmation'
		| 'custom';
	type CollectionMode = 'required' | 'optional' | 'display' | 'hidden';
	type BindingType =
		| 'subject'
		| 'identity_schema'
		| 'destination_field_mapping_set'
		| 'user_decision';
	type ContentMode = 'display_only' | 'checkbox' | 'radio';
	type ContentLanguageCode =
		| 'en'
		| 'ja'
		| 'zh-CN'
		| 'zh-TW'
		| 'es'
		| 'pt'
		| 'fr'
		| 'de'
		| 'ko'
		| 'ru'
		| 'id'
		| 'ar'
		| 'it'
		| 'th'
		| 'vi';
	type ContentLink = {
		id: string;
		href: string;
		labels: Record<ContentLanguageCode, string>;
	};
	type ContentOptionValueMode = 'boolean' | 'value';
	type AttributeValueDisplay = 'names' | 'masked_values' | 'full_values';
	type ContentOption = {
		id: string;
		valueMode: ContentOptionValueMode;
		value: string;
		labels: Record<ContentLanguageCode, string>;
		descriptions: Record<ContentLanguageCode, string>;
	};

	const languageOptions: Array<{ code: ContentLanguageCode; label: string }> = [
		{ code: 'en', label: 'English (en)' },
		{ code: 'ja', label: 'Japanese (ja)' },
		{ code: 'zh-CN', label: 'Chinese PRC (zh-CN)' },
		{ code: 'zh-TW', label: 'Chinese Taiwan (zh-TW)' },
		{ code: 'es', label: 'Spanish (es)' },
		{ code: 'pt', label: 'Portuguese (pt)' },
		{ code: 'fr', label: 'French (fr)' },
		{ code: 'de', label: 'German (de)' },
		{ code: 'ko', label: 'Korean (ko)' },
		{ code: 'ru', label: 'Russian (ru)' },
		{ code: 'id', label: 'Indonesian (id)' },
		{ code: 'ar', label: 'Arabic (ar)' },
		{ code: 'it', label: 'Italian (it)' },
		{ code: 'th', label: 'Thai (th)' },
		{ code: 'vi', label: 'Vietnamese (vi)' }
	];

	const templates: Array<{
		id: TemplateId;
		icon: string;
		defaultCollectionMode: CollectionMode;
		defaultBindingType: BindingType;
	}> = [
		{
			id: 'terms-of-service',
			icon: 'i-ph-file-text',
			defaultCollectionMode: 'required',
			defaultBindingType: 'subject'
		},
		{
			id: 'privacy-policy',
			icon: 'i-ph-shield-check',
			defaultCollectionMode: 'required',
			defaultBindingType: 'subject'
		},
		{
			id: 'user-data-release-consent',
			icon: 'i-ph-identification-card',
			defaultCollectionMode: 'required',
			defaultBindingType: 'destination_field_mapping_set'
		},
		{
			id: 'saml-attribute-release',
			icon: 'i-ph-share-network',
			defaultCollectionMode: 'required',
			defaultBindingType: 'destination_field_mapping_set'
		},
		{
			id: 'saml-attribute-release-confirmation',
			icon: 'i-ph-list-checks',
			defaultCollectionMode: 'display',
			defaultBindingType: 'user_decision'
		},
		{
			id: 'custom',
			icon: 'i-ph-pencil-simple-line',
			defaultCollectionMode: 'required',
			defaultBindingType: 'subject'
		}
	];

	const modeOptions: CollectionMode[] = ['required', 'optional', 'display', 'hidden'];
	const contentModeOptions: ContentMode[] = ['display_only', 'checkbox', 'radio'];
	const initialContentLinks: ContentLink[] = [];
	const initialContentOptions: ContentOption[] = [];

	let selectedTemplateId = $state<TemplateId | ''>('');
	let collectionMode = $state<CollectionMode>('display');
	let bindingType = $state<BindingType>('user_decision');
	let selectedFieldMappingSetId = $state('');
	let fieldMappingSets = $state<IdentityMappingFieldMappingSetSummary[]>([]);
	let fieldMappingSetsLoaded = $state(false);
	let internalTitle = $state('');
	let contentMode = $state<ContentMode>('display_only');
	let contentLinks = $state<ContentLink[]>(initialContentLinks);
	let nextContentLinkId = $state(initialContentLinks.length + 1);
	let contentOptions = $state<ContentOption[]>(initialContentOptions);
	let attributeValueDisplay = $state<AttributeValueDisplay>('masked_values');
	let nextContentOptionId = $state(initialContentOptions.length + 1);
	let selectedLanguage = $state<ContentLanguageCode>('en');
	let defaultLanguage = $state<ContentLanguageCode>('en');
	let activeLanguageCodes = $state<ContentLanguageCode[]>(
		languageOptions.map((language) => language.code)
	);
	let contentDrafts = $state<Record<ContentLanguageCode, string>>(createEmptyLanguageMap());
	let loadingStatement = $state(false);
	let savingStatement = $state(false);
	let deletingStatement = $state(false);
	let saveError = $state('');
	let loadedStatementId = $state('');
	let loadedStatementSlug = $state('');
	let loadedStatementActive = $state(true);
	let loadedVersionId = $state('');
	let loadedVersionName = $state(todayVersion());
	let loadedVersionStatus = $state<'draft' | 'active' | 'retired' | string>('draft');

	const editingStatementId = $derived($page.url.searchParams.get('edit') ?? '');
	const selectedTemplate = $derived(
		selectedTemplateId
			? templates.find((template) => template.id === selectedTemplateId)
			: undefined
	);
	const selectedBindingDescription = $derived(bindingDescription(bindingType));
	const selectedBindingLabel = $derived(bindingLabel(bindingType));
	const activeFieldMappingSets = $derived(
		fieldMappingSets.filter((fieldMappingSet) => fieldMappingSet.lifecycleState === 'active')
	);
	const customSelected = $derived(selectedTemplateId === 'custom');
	const singleOptionTemplate = $derived(
		selectedTemplateId === 'terms-of-service' || selectedTemplateId === 'privacy-policy'
	);
	const selectedPreviewHtml = $derived(
		renderConsentPreviewHtml(contentDrafts[selectedLanguage] ?? '', selectedLanguage)
	);
	const selectedModePreviewHtml = $derived(renderContentModePreviewHtml(selectedLanguage));

	onMount(() => {
		void initializePage();
	});

	async function initializePage() {
		await loadFieldMappingSets();
		if (editingStatementId) {
			await loadStatementForEdit(editingStatementId);
		} else {
			const templateId = templateIdFromParam($page.url.searchParams.get('template'));
			if (templateId) selectTemplate(templateId);
		}
	}

	async function loadFieldMappingSets() {
		try {
			const result = await adminIdentityMappingAPI.listFieldMappingSets();
			fieldMappingSets = result.fieldMappingSets || [];
		} catch {
			fieldMappingSets = [];
		} finally {
			fieldMappingSetsLoaded = true;
		}
	}

	$effect(() => {
		if (bindingType !== 'destination_field_mapping_set') return;
		if (
			selectedFieldMappingSetId &&
			activeFieldMappingSets.some(
				(fieldMappingSet) => fieldMappingSet.id === selectedFieldMappingSetId
			)
		) {
			return;
		}
		selectedFieldMappingSetId = activeFieldMappingSets[0]?.id ?? '';
	});

	function selectTemplate(templateId: TemplateId) {
		const template = templates.find((candidate) => candidate.id === templateId);
		selectedTemplateId = templateId;
		collectionMode = template?.defaultCollectionMode ?? 'required';
		bindingType = template?.defaultBindingType ?? 'subject';
		internalTitle = templateTitle(templateId);
		contentMode = defaultContentMode(templateId);
		contentLinks = createDefaultContentLinks(templateId);
		nextContentLinkId = contentLinks.length + 1;
		contentOptions = createDefaultContentOptions(templateId);
		nextContentOptionId = contentOptions.length + 1;
		attributeValueDisplay = 'masked_values';
		selectedLanguage = 'en';
		defaultLanguage = 'en';
		activeLanguageCodes = languageOptions.map((language) => language.code);
		contentDrafts = createContentDrafts(templateId);
	}

	async function loadStatementForEdit(statementId: string) {
		loadingStatement = true;
		saveError = '';
		try {
			const [{ statement }, { versions }, { requirements }] = await Promise.all([
				adminConsentStatementsAPI.getStatement(statementId),
				adminConsentStatementsAPI.listVersions(statementId),
				adminConsentStatementsAPI.listRequirements()
			]);
			const currentVersion =
				versions.find((version) => version.is_current) ??
				[...versions].sort((a, b) => b.created_at - a.created_at)[0];
			const localizationResult = currentVersion
				? await adminConsentStatementsAPI.listLocalizations(statementId, currentVersion.id)
				: { localizations: [] };
			applyStatementForEdit(
				statement,
				currentVersion,
				localizationResult.localizations || [],
				requirements.find((requirement) => requirement.statement_id === statementId)
			);
		} catch (err) {
			saveError = err instanceof Error ? err.message : localText('loadFailed');
		} finally {
			loadingStatement = false;
		}
	}

	function applyStatementForEdit(
		statement: ConsentStatement,
		version: ConsentStatementVersion | undefined,
		localizations: ConsentStatementLocalization[],
		requirement: TenantConsentRequirement | undefined
	) {
		const templateId = templateIdFromStatement(statement);
		selectTemplate(templateId);
		loadedStatementId = statement.id;
		loadedStatementSlug = statement.slug;
		loadedStatementActive = Boolean(statement.is_active);
		loadedVersionId = version?.id ?? '';
		loadedVersionName = validDateVersion(version?.version) ? version.version : todayVersion();
		loadedVersionStatus = version?.status ?? 'draft';
		internalTitle =
			localizations.find((localization) => localization.language === 'en')?.title ||
			localizations[0]?.title ||
			templateTitle(templateId);
		collectionMode = collectionModeFromRequirement(statement, requirement);
		const requirementRules = parseRequirementRules(requirement);
		if (isBindingType(requirementRules.binding_type)) {
			bindingType = requirementRules.binding_type;
		}
		if (
			bindingType === 'destination_field_mapping_set' &&
			typeof requirementRules.binding_value === 'string'
		) {
			selectedFieldMappingSetId = requirementRules.binding_value;
		}
		if (isContentMode(requirementRules.content_mode)) {
			contentMode = requirementRules.content_mode;
		}
		if (isAttributeValueDisplay(requirementRules.attribute_value_display)) {
			attributeValueDisplay = requirementRules.attribute_value_display;
		}

		const knownLanguages = localizations
			.map((localization) => localization.language)
			.filter((language): language is ContentLanguageCode => isContentLanguageCode(language));
		if (knownLanguages.length > 0) {
			activeLanguageCodes = knownLanguages;
			defaultLanguage = knownLanguages.includes('en') ? 'en' : knownLanguages[0];
			selectedLanguage = defaultLanguage;
		}

		const drafts = createContentDrafts(templateId);
		const options = createDefaultContentOptions(templateId);
		for (const localization of localizations) {
			if (!isContentLanguageCode(localization.language)) continue;
			const inlineContent = localization.inline_content || '';
			drafts[localization.language] = inlineContent;
			if (options[0]) {
				options[0].descriptions = {
					...options[0].descriptions,
					[localization.language]: inlineContent
				};
			}
		}
		contentDrafts = drafts;
		contentOptions = normalizeContentOptions(requirementRules.content_options, options);
		nextContentOptionId = contentOptions.length + 1;
	}

	async function saveTemplateStatement() {
		if (savingStatement || deletingStatement) return;
		if (!selectedTemplateId) {
			saveError = localText('templateRequired');
			return;
		}
		savingStatement = true;
		saveError = '';
		try {
			const statementData = createStatementPayload();
			let statementId = loadedStatementId || editingStatementId;
			if (statementId) {
				await adminConsentStatementsAPI.updateStatement(statementId, statementData);
			} else {
				const statement = await createOrReuseStatement(statementData);
				statementId = statement.id;
				loadedStatementId = statementId;
				loadedStatementSlug = statement.slug;
				loadedStatementActive = Boolean(statement.is_active);
			}

			let versionId = loadedVersionId;
			const versionName = validDateVersion(loadedVersionName) ? loadedVersionName : todayVersion();
			if (versionId) {
				if (loadedVersionStatus === 'draft') {
					await adminConsentStatementsAPI.updateVersion(statementId, versionId, {
						version: versionName,
						content_type: 'inline',
						effective_at: Date.now(),
						effective_until: null
					});
				}
			} else {
				const version = await createOrReuseVersion(statementId, {
					version: versionName,
					content_type: 'inline',
					effective_at: Date.now(),
					effective_until: null
				});
				versionId = version.id;
				loadedVersionId = versionId;
				loadedVersionStatus = version.status;
			}
			loadedVersionName = versionName;

			await saveRequirement(statementId, versionName);
			await saveLocalizations(statementId, versionId);
			if (loadedVersionStatus === 'draft') {
				const result = await adminConsentStatementsAPI.activateVersion(statementId, versionId);
				loadedVersionStatus = result.version.status;
			}
			goto(`/admin/consent-statements/${encodeURIComponent(statementId)}`);
		} catch (err) {
			saveError = err instanceof Error ? err.message : localText('saveFailed');
		} finally {
			savingStatement = false;
		}
	}

	async function createOrReuseStatement(
		statementData: ReturnType<typeof createStatementPayload>
	): Promise<ConsentStatement> {
		try {
			const result = await adminConsentStatementsAPI.createStatement(statementData);
			return result.statement;
		} catch (error) {
			if (!isConflictLikeError(error)) throw error;
			const existing = await findStatementBySlug(statementData.slug);
			if (!existing) throw error;
			await adminConsentStatementsAPI.updateStatement(existing.id, statementData);
			const result = await adminConsentStatementsAPI.getStatement(existing.id);
			return result.statement;
		}
	}

	async function findStatementBySlug(slug: string): Promise<ConsentStatement | null> {
		const result = await adminConsentStatementsAPI.listStatements();
		return result.statements.find((statement) => statement.slug === slug) ?? null;
	}

	async function createOrReuseVersion(
		statementId: string,
		versionData: {
			version: string;
			content_type?: string;
			effective_at: number;
			effective_until?: number | null;
		}
	): Promise<ConsentStatementVersion> {
		try {
			const result = await adminConsentStatementsAPI.createVersion(statementId, versionData);
			return result.version;
		} catch (error) {
			if (!isConflictLikeError(error)) throw error;
			const existing = await findStatementVersion(statementId, versionData.version);
			if (!existing) throw error;
			if (existing.status === 'draft') {
				const result = await adminConsentStatementsAPI.updateVersion(statementId, existing.id, {
					version: versionData.version,
					content_type: versionData.content_type,
					effective_at: versionData.effective_at,
					effective_until: versionData.effective_until ?? null
				});
				return result.version;
			}
			return existing;
		}
	}

	async function findStatementVersion(
		statementId: string,
		versionName: string
	): Promise<ConsentStatementVersion | null> {
		const result = await adminConsentStatementsAPI.listVersions(statementId);
		return result.versions.find((version) => version.version === versionName) ?? null;
	}

	function isConflictLikeError(error: unknown): boolean {
		return error instanceof Error && error.message.toLowerCase().includes('exist');
	}

	async function deleteCurrentStatement() {
		const statementId = loadedStatementId || editingStatementId;
		if (!statementId || deletingStatement) return;
		const statementTitle = loadedStatementSlug || statementId;
		if (!confirm(localText('deleteConfirm').replace('{title}', statementTitle))) return;
		deletingStatement = true;
		saveError = '';
		try {
			await adminConsentStatementsAPI.deleteStatement(statementId);
			await goto('/admin/consent-statements');
		} catch (err) {
			saveError = err instanceof Error ? err.message : localText('deleteFailed');
		} finally {
			deletingStatement = false;
		}
	}

	function createStatementPayload() {
		if (!selectedTemplateId) throw new Error(localText('templateRequired'));
		const slug =
			loadedStatementSlug ||
			(selectedTemplateId === 'custom'
				? `${statementSlug(selectedTemplateId)}_${Date.now()}`
				: statementSlug(selectedTemplateId));
		return {
			slug,
			category: statementCategory(selectedTemplateId),
			legal_basis: 'consent',
			processing_purpose: templateProcessingPurpose(selectedTemplateId),
			display_order: 0,
			is_active: loadedStatementActive,
			record_retention_days: null,
			withdrawal_allowed: selectedTemplateId !== 'terms-of-service',
			withdrawal_impact: null,
			reconsent_on_version_change: true,
			reconsent_interval_days: null
		};
	}

	async function saveRequirement(statementId: string, versionName: string) {
		if (collectionMode === 'hidden') {
			if (editingStatementId || loadedStatementId) {
				await adminConsentStatementsAPI.deleteRequirement(statementId).catch(() => undefined);
			}
			return;
		}
		await adminConsentStatementsAPI.upsertRequirement(statementId, {
			is_required: collectionMode === 'required',
			min_version: versionName,
			enforcement: collectionMode === 'required' ? 'block' : 'allow_continue',
			show_deletion_link: false,
			deletion_url: undefined,
			conditional_rules_json: JSON.stringify({
				mode: collectionMode,
				binding_type: bindingType,
				binding_value:
					bindingType === 'destination_field_mapping_set' ? selectedFieldMappingSetId : null,
				content_mode: contentMode,
				content_options: contentOptions.map((option) => ({
					id: option.id,
					value_mode: option.valueMode,
					value: option.value,
					labels: option.labels,
					descriptions: option.descriptions
				})),
				attribute_value_display: attributeValueDisplay
			}),
			display_order: 0
		});
	}

	async function saveLocalizations(statementId: string, versionId: string) {
		if (!selectedTemplateId) throw new Error(localText('templateRequired'));
		const templateId = selectedTemplateId;
		for (const language of activeLanguageCodes) {
			try {
				await adminConsentStatementsAPI.upsertLocalization(statementId, versionId, language, {
					title: internalTitle.trim() || templateTitle(templateId),
					description: templateDescription(templateId),
					processing_purpose: templateProcessingPurpose(templateId),
					inline_content: buildInlineContent(language)
				});
			} catch (error) {
				const message =
					error instanceof Error ? error.message : localText('localizationSaveFailed');
				throw new Error(`${localText('localizationSaveFailed')} (${language}): ${message}`);
			}
		}
	}

	function buildInlineContent(language: ContentLanguageCode): string {
		if (contentMode === 'display_only') {
			return renderConsentPreviewHtml(contentDrafts[language] || '', language);
		}
		return contentOptions
			.map((option, index) => {
				const body =
					option.descriptions[language] ||
					option.descriptions[defaultLanguage] ||
					option.descriptions.en ||
					option.labels[language] ||
					option.labels[defaultLanguage] ||
					option.labels.en ||
					`Option ${index + 1}`;
				return `<p>${renderConsentPreviewHtml(body, language)}</p>`;
			})
			.join('');
	}

	function templateIdFromStatement(statement: ConsentStatement): TemplateId {
		switch (statement.category) {
			case 'terms_of_service':
				return 'terms-of-service';
			case 'privacy_policy':
				return 'privacy-policy';
			case 'saml_attribute_release_confirmation':
				return 'saml-attribute-release-confirmation';
			case 'saml_attribute_release':
				return 'saml-attribute-release';
			case 'user_data_release':
				return 'user-data-release-consent';
			default:
				return 'custom';
		}
	}

	function templateIdFromParam(value: string | null): TemplateId | undefined {
		return templates.some((template) => template.id === value) ? (value as TemplateId) : undefined;
	}

	function todayVersion(): string {
		const now = new Date();
		const year = now.getFullYear();
		const month = `${now.getMonth() + 1}`.padStart(2, '0');
		const day = `${now.getDate()}`.padStart(2, '0');
		return `${year}${month}${day}`;
	}

	function validDateVersion(value: string | undefined): value is string {
		if (!value || !/^\d{8}$/.test(value)) return false;
		const year = Number(value.slice(0, 4));
		const month = Number(value.slice(4, 6));
		const day = Number(value.slice(6, 8));
		const date = new Date(year, month - 1, day);
		return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
	}

	function parseRequirementRules(
		requirement: TenantConsentRequirement | undefined
	): Record<string, unknown> {
		if (!requirement?.conditional_rules_json) return {};
		try {
			const parsed = JSON.parse(requirement.conditional_rules_json) as unknown;
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	}

	function isContentMode(value: unknown): value is ContentMode {
		return value === 'display_only' || value === 'checkbox' || value === 'radio';
	}

	function isBindingType(value: unknown): value is BindingType {
		return (
			value === 'subject' ||
			value === 'identity_schema' ||
			value === 'destination_field_mapping_set' ||
			value === 'user_decision'
		);
	}

	function isAttributeValueDisplay(value: unknown): value is AttributeValueDisplay {
		return value === 'names' || value === 'masked_values' || value === 'full_values';
	}

	function normalizeContentOptions(value: unknown, fallback: ContentOption[]): ContentOption[] {
		if (!Array.isArray(value)) return fallback;
		const options = value
			.map((raw, index) => {
				if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
				const record = raw as Record<string, unknown>;
				const id =
					typeof record.id === 'string' && record.id.trim()
						? record.id.trim()
						: `option-${index + 1}`;
				const value = typeof record.value === 'string' ? record.value : '';
				const labels =
					record.labels && typeof record.labels === 'object' && !Array.isArray(record.labels)
						? (record.labels as Partial<Record<ContentLanguageCode, string>>)
						: {};
				const descriptions =
					record.descriptions &&
					typeof record.descriptions === 'object' &&
					!Array.isArray(record.descriptions)
						? (record.descriptions as Partial<Record<ContentLanguageCode, string>>)
						: {};
				return createContentOption(
					id,
					value,
					{ ...createEmptyLanguageMap(), ...labels },
					{ ...createEmptyLanguageMap(), ...descriptions }
				);
			})
			.filter((option): option is ContentOption => Boolean(option));
		return options.length > 0 ? options : fallback;
	}

	function collectionModeFromRequirement(
		statement: ConsentStatement,
		requirement: TenantConsentRequirement | undefined
	): CollectionMode {
		if (!requirement) {
			const templateId = templateIdFromStatement(statement);
			return (
				templates.find((template) => template.id === templateId)?.defaultCollectionMode ??
				'required'
			);
		}
		if (requirement.is_required) return 'required';
		if (statement.category === 'saml_attribute_release_confirmation') return 'display';
		return 'optional';
	}

	function isContentLanguageCode(value: string): value is ContentLanguageCode {
		return languageOptions.some((language) => language.code === value);
	}

	function statementSlug(templateId: TemplateId): string {
		switch (templateId) {
			case 'terms-of-service':
				return 'terms_of_service';
			case 'privacy-policy':
				return 'privacy_policy';
			case 'user-data-release-consent':
				return 'user_data_release';
			case 'saml-attribute-release':
				return 'saml_attribute_release';
			case 'saml-attribute-release-confirmation':
				return 'saml_attribute_release_confirmation';
			case 'custom':
				return 'custom_consent';
		}
	}

	function statementCategory(templateId: TemplateId): string {
		switch (templateId) {
			case 'terms-of-service':
				return 'terms_of_service';
			case 'privacy-policy':
				return 'privacy_policy';
			case 'user-data-release-consent':
				return 'user_data_release';
			case 'saml-attribute-release':
				return 'saml_attribute_release';
			case 'saml-attribute-release-confirmation':
				return 'saml_attribute_release_confirmation';
			case 'custom':
				return 'custom';
		}
	}

	function templateProcessingPurpose(templateId: TemplateId): string {
		switch (templateId) {
			case 'terms-of-service':
				return 'Service terms agreement';
			case 'privacy-policy':
				return 'Privacy policy agreement';
			case 'user-data-release-consent':
				return 'User data release consent';
			case 'saml-attribute-release':
				return 'SAML attribute release consent';
			case 'saml-attribute-release-confirmation':
				return 'SAML attribute release confirmation';
			case 'custom':
				return internalTitle.trim() || 'Custom consent statement';
		}
	}

	function localText(key: string): string {
		const ja = getLocale() === 'ja';
		const labels: Record<string, { ja: string; en: string }> = {
			loadFailed: { ja: '同意文の読み込みに失敗しました。', en: 'Failed to load statement.' },
			saveFailed: { ja: '同意文の保存に失敗しました。', en: 'Failed to save statement.' },
			deleteFailed: { ja: '同意文の削除に失敗しました。', en: 'Failed to delete statement.' },
			deleteConfirm: {
				ja: '同意文「{title}」を削除します。よろしいですか？',
				en: 'Delete consent statement "{title}"?'
			},
			templateRequired: { ja: 'テンプレートを選択してください。', en: 'Select a template.' },
			localizationSaveFailed: {
				ja: '同意文の言語別コンテンツ保存に失敗しました。',
				en: 'Failed to save localized consent content.'
			},
			delete: { ja: '削除', en: 'Delete' },
			deleting: { ja: '削除中...', en: 'Deleting...' },
			save: { ja: '保存', en: 'Save' },
			saving: { ja: '保存中...', en: 'Saving...' },
			attributeValueDisplay: { ja: '属性値表示', en: 'Attribute value display' },
			attributeValueDisplayDescription: {
				ja: 'SAML属性送信確認で、ユーザーに属性値をどの粒度で表示するかを指定します。',
				en: 'Controls how attribute values are shown in SAML attribute release confirmation.'
			},
			attributeValueNames: { ja: '属性名のみ表示', en: 'Show attribute names only' },
			attributeValueMasked: { ja: '値をマスクして表示', en: 'Show masked values' },
			attributeValueFull: { ja: '値をそのまま表示', en: 'Show full values' }
		};
		return ja ? labels[key]?.ja || key : labels[key]?.en || key;
	}

	function templateTitle(id: TemplateId): string {
		switch (id) {
			case 'terms-of-service':
				return $LL.admin_consent_templates_terms_title();
			case 'privacy-policy':
				return $LL.admin_consent_templates_privacy_title();
			case 'user-data-release-consent':
				return $LL.admin_consent_templates_user_data_title();
			case 'saml-attribute-release':
				return $LL.admin_consent_templates_saml_release_title();
			case 'saml-attribute-release-confirmation':
				return $LL.admin_consent_templates_saml_confirmation_title();
			case 'custom':
				return $LL.admin_consent_templates_custom_title();
		}
	}

	function templateDescription(id: TemplateId): string {
		switch (id) {
			case 'terms-of-service':
				return $LL.admin_consent_templates_terms_description();
			case 'privacy-policy':
				return $LL.admin_consent_templates_privacy_description();
			case 'user-data-release-consent':
				return $LL.admin_consent_templates_user_data_description();
			case 'saml-attribute-release':
				return $LL.admin_consent_templates_saml_release_description();
			case 'saml-attribute-release-confirmation':
				return $LL.admin_consent_templates_saml_confirmation_description();
			case 'custom':
				return $LL.admin_consent_templates_custom_description();
		}
	}

	function modeLabel(mode: CollectionMode): string {
		switch (mode) {
			case 'required':
				return $LL.admin_consent_templates_mode_required();
			case 'optional':
				return $LL.admin_consent_templates_mode_optional();
			case 'display':
				return $LL.admin_consent_templates_mode_display();
			case 'hidden':
				return $LL.admin_consent_templates_mode_hidden();
		}
	}

	function modeDescription(mode: CollectionMode): string {
		switch (mode) {
			case 'required':
				return $LL.admin_consent_templates_mode_required_description();
			case 'optional':
				return $LL.admin_consent_templates_mode_optional_description();
			case 'display':
				return $LL.admin_consent_templates_mode_display_description();
			case 'hidden':
				return $LL.admin_consent_templates_mode_hidden_description();
		}
	}

	function modeIcon(mode: CollectionMode): string {
		switch (mode) {
			case 'required':
				return 'i-ph-lock-key';
			case 'optional':
				return 'i-ph-toggle-left';
			case 'display':
				return 'i-ph-eye';
			case 'hidden':
				return 'i-ph-eye-slash';
		}
	}

	function bindingLabel(type: BindingType): string {
		switch (type) {
			case 'subject':
				return $LL.admin_consent_templates_binding_subject();
			case 'identity_schema':
				return $LL.admin_consent_templates_binding_identity_schema();
			case 'destination_field_mapping_set':
				return $LL.admin_consent_templates_binding_destination_field_mapping_sets();
			case 'user_decision':
				return $LL.admin_consent_templates_binding_user_decision();
		}
	}

	function bindingDescription(type: BindingType): string {
		switch (type) {
			case 'subject':
				return $LL.admin_consent_templates_binding_subject_description();
			case 'identity_schema':
				return $LL.admin_consent_templates_binding_identity_schema_description();
			case 'destination_field_mapping_set':
				return $LL.admin_consent_templates_binding_destination_field_mapping_sets_description();
			case 'user_decision':
				return $LL.admin_consent_templates_binding_user_decision_description();
		}
	}

	function createContentDrafts(templateId: TemplateId): Record<ContentLanguageCode, string> {
		const empty = createEmptyLanguageMap();
		switch (templateId) {
			case 'terms-of-service':
				return termsAgreementText();
			case 'privacy-policy':
				return privacyAgreementText();
			case 'saml-attribute-release-confirmation':
				return samlAttributeReleaseConfirmationText();
			case 'user-data-release-consent':
			case 'saml-attribute-release':
			case 'custom':
				return empty;
		}
	}

	function termsAgreementText(): Record<ContentLanguageCode, string> {
		return {
			en: 'I have read and agree to the %link1%.',
			ja: '%link1%を読み、その内容に同意します。',
			'zh-CN': '我已阅读%link1%并同意其内容。',
			'zh-TW': '我已閱讀%link1%並同意其內容。',
			es: 'He leído los %link1% y los acepto.',
			pt: 'Li os %link1% e concordo com eles.',
			fr: "J'ai lu les %link1% et je les accepte.",
			de: 'Ich habe die %link1% gelesen und stimme ihnen zu.',
			ko: '%link1%을 읽었으며 그 내용에 동의합니다.',
			ru: 'Я прочитал(а) %link1% и принимаю их условия.',
			id: 'Saya telah membaca %link1% dan menyetujuinya.',
			ar: 'لقد قرأت %link1% وأوافق عليها.',
			it: 'Ho letto e accetto i %link1%.',
			th: 'ฉันได้อ่านและยอมรับ%link1%แล้ว',
			vi: 'Tôi đã đọc và đồng ý với %link1%.'
		};
	}

	function privacyAgreementText(): Record<ContentLanguageCode, string> {
		return {
			en: 'I have read and agree to the %link1%.',
			ja: '%link1%を読み、その内容に同意します。',
			'zh-CN': '我已阅读%link1%并同意其内容。',
			'zh-TW': '我已閱讀%link1%並同意其內容。',
			es: 'He leído la %link1% y la acepto.',
			pt: 'Li a %link1% e concordo com ela.',
			fr: "J'ai lu la %link1% et je l'accepte.",
			de: 'Ich habe die %link1% gelesen und stimme ihr zu.',
			ko: '%link1%을 읽었으며 그 내용에 동의합니다.',
			ru: 'Я прочитал(а) %link1% и принимаю её условия.',
			id: 'Saya telah membaca %link1% dan menyetujuinya.',
			ar: 'لقد قرأت %link1% وأوافق عليها.',
			it: 'Ho letto e accetto l’%link1%.',
			th: 'ฉันได้อ่านและยอมรับ%link1%แล้ว',
			vi: 'Tôi đã đọc và đồng ý với %link1%.'
		};
	}

	function samlAttributeReleaseConfirmationText(): Record<ContentLanguageCode, string> {
		return {
			en: 'Choose how to handle the requested attribute release for this service.',
			ja: 'このサービスへの属性送信をどのように扱うか選択してください。',
			'zh-CN': '请选择如何处理向此服务发送所请求属性。',
			'zh-TW': '請選擇如何處理向此服務傳送所要求的屬性。',
			es: 'Elige cómo gestionar el envío de los atributos solicitados a este servicio.',
			pt: 'Escolha como tratar o envio dos atributos solicitados para este serviço.',
			fr: "Choisissez comment gérer l'envoi des attributs demandés à ce service.",
			de: 'Wählen Sie aus, wie die angeforderte Attributfreigabe für diesen Dienst behandelt werden soll.',
			ko: '이 서비스에 요청된 속성을 전송하는 방법을 선택하세요.',
			ru: 'Выберите, как обработать передачу запрошенных атрибутов этому сервису.',
			id: 'Pilih cara menangani pengiriman atribut yang diminta ke layanan ini.',
			ar: 'اختر كيفية التعامل مع إرسال السمات المطلوبة إلى هذه الخدمة.',
			it: 'Scegli come gestire il rilascio degli attributi richiesti a questo servizio.',
			th: 'เลือกวิธีจัดการการส่งแอตทริบิวต์ที่บริการนี้ร้องขอ',
			vi: 'Chọn cách xử lý việc cung cấp các thuộc tính mà dịch vụ này yêu cầu.'
		};
	}

	function createEmptyLanguageMap(): Record<ContentLanguageCode, string> {
		return Object.fromEntries(languageOptions.map((language) => [language.code, ''])) as Record<
			ContentLanguageCode,
			string
		>;
	}

	function defaultContentMode(templateId: TemplateId): ContentMode {
		switch (templateId) {
			case 'terms-of-service':
			case 'privacy-policy':
				return 'checkbox';
			case 'user-data-release-consent':
			case 'saml-attribute-release':
				return 'radio';
			case 'saml-attribute-release-confirmation':
				return 'radio';
			case 'custom':
				return 'display_only';
		}
	}

	function createContentOption(
		id: string,
		value: string,
		labels: Record<ContentLanguageCode, string>,
		descriptions: Record<ContentLanguageCode, string>
	): ContentOption {
		return {
			id,
			valueMode: value === 'true' || value === 'false' ? 'boolean' : 'value',
			value,
			labels,
			descriptions
		};
	}

	function genericContentOptionLabels(
		index: number,
		agreement: boolean
	): Record<ContentLanguageCode, string> {
		if (agreement) {
			return {
				en: 'I agree',
				ja: '同意します',
				'zh-CN': '我同意',
				'zh-TW': '我同意',
				es: 'Acepto',
				pt: 'Concordo',
				fr: 'J’accepte',
				de: 'Ich stimme zu',
				ko: '동의합니다',
				ru: 'Я согласен(на)',
				id: 'Saya setuju',
				ar: 'أوافق',
				it: 'Accetto',
				th: 'ยอมรับ',
				vi: 'Tôi đồng ý'
			};
		}

		return {
			en: `Option ${index}`,
			ja: `選択肢 ${index}`,
			'zh-CN': `选项 ${index}`,
			'zh-TW': `選項 ${index}`,
			es: `Opción ${index}`,
			pt: `Opção ${index}`,
			fr: `Option ${index}`,
			de: `Option ${index}`,
			ko: `옵션 ${index}`,
			ru: `Вариант ${index}`,
			id: `Opsi ${index}`,
			ar: `الخيار ${index}`,
			it: `Opzione ${index}`,
			th: `ตัวเลือก ${index}`,
			vi: `Tùy chọn ${index}`
		};
	}

	function samlAllowOnceLabels(): Record<ContentLanguageCode, string> {
		return {
			en: 'Allow this time only',
			ja: '今回のみ同意',
			'zh-CN': '仅本次允许',
			'zh-TW': '僅本次允許',
			es: 'Permitir solo esta vez',
			pt: 'Permitir apenas desta vez',
			fr: 'Autoriser uniquement cette fois',
			de: 'Nur dieses Mal erlauben',
			ko: '이번에만 허용',
			ru: 'Разрешить только сейчас',
			id: 'Izinkan hanya kali ini',
			ar: 'السماح لهذه المرة فقط',
			it: 'Consenti solo questa volta',
			th: 'อนุญาตเฉพาะครั้งนี้',
			vi: 'Chỉ cho phép lần này'
		};
	}

	function samlAllowOnceDescriptions(): Record<ContentLanguageCode, string> {
		return {
			en: 'Allow this attribute release only for the current sign-in.',
			ja: '今回のログインに限って属性送信を許可します。',
			'zh-CN': '仅允许在本次登录时发送这些属性。',
			'zh-TW': '僅允許在本次登入時傳送這些屬性。',
			es: 'Permite este envío de atributos solo para el inicio de sesión actual.',
			pt: 'Permite este envio de atributos apenas para o login atual.',
			fr: "Autorise cet envoi d'attributs uniquement pour la connexion actuelle.",
			de: 'Diese Attributfreigabe nur für die aktuelle Anmeldung erlauben.',
			ko: '현재 로그인에 한해서만 이 속성 전송을 허용합니다.',
			ru: 'Разрешить передачу этих атрибутов только для текущего входа.',
			id: 'Izinkan pengiriman atribut ini hanya untuk proses masuk saat ini.',
			ar: 'السماح بإرسال هذه السمات لعملية تسجيل الدخول الحالية فقط.',
			it: 'Consenti il rilascio di questi attributi solo per l’accesso corrente.',
			th: 'อนุญาตให้ส่งแอตทริบิวต์เหล่านี้เฉพาะการเข้าสู่ระบบครั้งนี้',
			vi: 'Chỉ cho phép cung cấp các thuộc tính này trong lần đăng nhập hiện tại.'
		};
	}

	function samlAlwaysAllowLabels(): Record<ContentLanguageCode, string> {
		return {
			en: 'Always allow for this service',
			ja: '今後も同意',
			'zh-CN': '始终允许此服务',
			'zh-TW': '一律允許此服務',
			es: 'Permitir siempre para este servicio',
			pt: 'Permitir sempre para este serviço',
			fr: 'Toujours autoriser pour ce service',
			de: 'Für diesen Dienst immer erlauben',
			ko: '이 서비스에 항상 허용',
			ru: 'Всегда разрешать для этого сервиса',
			id: 'Selalu izinkan untuk layanan ini',
			ar: 'السماح دائمًا لهذه الخدمة',
			it: 'Consenti sempre per questo servizio',
			th: 'อนุญาตสำหรับบริการนี้เสมอ',
			vi: 'Luôn cho phép đối với dịch vụ này'
		};
	}

	function samlAlwaysAllowDescriptions(): Record<ContentLanguageCode, string> {
		return {
			en: 'Remember this choice for future sign-ins to this service.',
			ja: 'このサービスへの今後のログインでも、この選択を利用します。',
			'zh-CN': '记住此选择，并在今后登录此服务时使用。',
			'zh-TW': '記住此選擇，並在日後登入此服務時使用。',
			es: 'Recuerda esta elección para futuros inicios de sesión en este servicio.',
			pt: 'Lembre esta escolha para futuros logins neste serviço.',
			fr: 'Mémorise ce choix pour les prochaines connexions à ce service.',
			de: 'Diese Auswahl für zukünftige Anmeldungen bei diesem Dienst merken.',
			ko: '이 서비스에 향후 로그인할 때 이 선택을 기억합니다.',
			ru: 'Запомнить этот выбор для будущих входов в этот сервис.',
			id: 'Ingat pilihan ini untuk proses masuk berikutnya ke layanan ini.',
			ar: 'تذكّر هذا الاختيار لعمليات تسجيل الدخول القادمة إلى هذه الخدمة.',
			it: 'Ricorda questa scelta per i prossimi accessi a questo servizio.',
			th: 'จดจำตัวเลือกนี้สำหรับการเข้าสู่ระบบบริการนี้ในครั้งต่อไป',
			vi: 'Ghi nhớ lựa chọn này cho những lần đăng nhập sau vào dịch vụ này.'
		};
	}

	function samlDenyLabels(): Record<ContentLanguageCode, string> {
		return {
			en: 'Do not allow',
			ja: '同意しない',
			'zh-CN': '不允许',
			'zh-TW': '不允許',
			es: 'No permitir',
			pt: 'Não permitir',
			fr: 'Ne pas autoriser',
			de: 'Nicht erlauben',
			ko: '허용하지 않음',
			ru: 'Не разрешать',
			id: 'Jangan izinkan',
			ar: 'عدم السماح',
			it: 'Non consentire',
			th: 'ไม่อนุญาต',
			vi: 'Không cho phép'
		};
	}

	function samlDenyDescriptions(): Record<ContentLanguageCode, string> {
		return {
			en: 'Do not release these attributes.',
			ja: 'これらの属性を送信しません。',
			'zh-CN': '不发送这些属性。',
			'zh-TW': '不傳送這些屬性。',
			es: 'No enviar estos atributos.',
			pt: 'Não enviar estes atributos.',
			fr: 'Ne pas envoyer ces attributs.',
			de: 'Diese Attribute nicht senden.',
			ko: '이 속성을 전송하지 않습니다.',
			ru: 'Не передавать эти атрибуты.',
			id: 'Jangan kirim atribut ini.',
			ar: 'عدم إرسال هذه السمات.',
			it: 'Non rilasciare questi attributi.',
			th: 'ไม่ส่งแอตทริบิวต์เหล่านี้',
			vi: 'Không cung cấp các thuộc tính này.'
		};
	}

	function releaseAllInformationLabels(): Record<ContentLanguageCode, string> {
		return {
			en: 'Release all requested information',
			ja: '要求された情報をすべて提供する',
			'zh-CN': '提供所有请求的信息',
			'zh-TW': '提供所有要求的資訊',
			es: 'Compartir toda la información solicitada',
			pt: 'Compartilhar todas as informações solicitadas',
			fr: 'Partager toutes les informations demandées',
			de: 'Alle angeforderten Informationen freigeben',
			ko: '요청된 모든 정보 제공',
			ru: 'Предоставить всю запрошенную информацию',
			id: 'Bagikan semua informasi yang diminta',
			ar: 'مشاركة جميع المعلومات المطلوبة',
			it: 'Condividi tutte le informazioni richieste',
			th: 'เปิดเผยข้อมูลทั้งหมดที่ร้องขอ',
			vi: 'Cung cấp toàn bộ thông tin được yêu cầu'
		};
	}

	function releaseAllInformationDescriptions(): Record<ContentLanguageCode, string> {
		return {
			en: 'Release all fields requested by this service.',
			ja: 'このサービスが要求した項目をすべて提供します。',
			'zh-CN': '提供此服务请求的所有字段。',
			'zh-TW': '提供此服務要求的所有欄位。',
			es: 'Comparte todos los campos solicitados por este servicio.',
			pt: 'Compartilha todos os campos solicitados por este serviço.',
			fr: 'Partage tous les champs demandés par ce service.',
			de: 'Alle von diesem Dienst angeforderten Felder freigeben.',
			ko: '이 서비스에서 요청한 모든 항목을 제공합니다.',
			ru: 'Предоставить все поля, запрошенные этим сервисом.',
			id: 'Bagikan semua kolom yang diminta oleh layanan ini.',
			ar: 'مشاركة جميع الحقول التي تطلبها هذه الخدمة.',
			it: 'Condividi tutti i campi richiesti da questo servizio.',
			th: 'เปิดเผยช่องข้อมูลทั้งหมดที่บริการนี้ร้องขอ',
			vi: 'Cung cấp tất cả các trường mà dịch vụ này yêu cầu.'
		};
	}

	function releaseMinimumInformationLabels(): Record<ContentLanguageCode, string> {
		return {
			en: 'Release only minimum information',
			ja: '必要最小限の情報だけ提供する',
			'zh-CN': '仅提供最低限度的信息',
			'zh-TW': '僅提供最低限度的資訊',
			es: 'Compartir solo la información mínima',
			pt: 'Compartilhar apenas as informações mínimas',
			fr: 'Partager uniquement le minimum d’informations',
			de: 'Nur die erforderlichen Mindestinformationen freigeben',
			ko: '최소한의 정보만 제공',
			ru: 'Предоставить только минимально необходимые данные',
			id: 'Bagikan informasi minimum saja',
			ar: 'مشاركة الحد الأدنى من المعلومات فقط',
			it: 'Condividi solo le informazioni minime',
			th: 'เปิดเผยเฉพาะข้อมูลขั้นต่ำ',
			vi: 'Chỉ cung cấp thông tin tối thiểu'
		};
	}

	function releaseMinimumInformationDescriptions(): Record<ContentLanguageCode, string> {
		return {
			en: 'Release only the minimum fields required to continue.',
			ja: '利用継続に必要な最小限の項目だけ提供します。',
			'zh-CN': '仅提供继续操作所需的最少字段。',
			'zh-TW': '僅提供繼續操作所需的最低限度欄位。',
			es: 'Comparte solo los campos mínimos necesarios para continuar.',
			pt: 'Compartilha apenas os campos mínimos necessários para continuar.',
			fr: 'Ne partage que les champs indispensables pour continuer.',
			de: 'Nur die mindestens erforderlichen Felder freigeben, um fortzufahren.',
			ko: '계속하는 데 필요한 최소한의 항목만 제공합니다.',
			ru: 'Предоставить только минимальный набор полей, необходимый для продолжения.',
			id: 'Bagikan hanya kolom minimum yang diperlukan untuk melanjutkan.',
			ar: 'مشاركة الحد الأدنى من الحقول اللازمة للمتابعة.',
			it: 'Condividi solo i campi indispensabili per continuare.',
			th: 'เปิดเผยเฉพาะช่องข้อมูลขั้นต่ำที่จำเป็นต่อการดำเนินการต่อ',
			vi: 'Chỉ cung cấp các trường tối thiểu cần thiết để tiếp tục.'
		};
	}

	function releaseNoInformationLabels(): Record<ContentLanguageCode, string> {
		return {
			en: 'Do not release information',
			ja: '提供しない',
			'zh-CN': '不提供信息',
			'zh-TW': '不提供資訊',
			es: 'No compartir información',
			pt: 'Não compartilhar informações',
			fr: 'Ne pas partager d’informations',
			de: 'Keine Informationen freigeben',
			ko: '정보 제공 안 함',
			ru: 'Не предоставлять информацию',
			id: 'Jangan bagikan informasi',
			ar: 'عدم مشاركة المعلومات',
			it: 'Non condividere informazioni',
			th: 'ไม่เปิดเผยข้อมูล',
			vi: 'Không cung cấp thông tin'
		};
	}

	function releaseNoInformationDescriptions(): Record<ContentLanguageCode, string> {
		return {
			en: 'Do not release optional information.',
			ja: '任意の情報は提供しません。',
			'zh-CN': '不提供可选信息。',
			'zh-TW': '不提供選填資訊。',
			es: 'No compartir información opcional.',
			pt: 'Não compartilhar informações opcionais.',
			fr: 'Ne pas partager les informations facultatives.',
			de: 'Keine optionalen Informationen freigeben.',
			ko: '선택 정보를 제공하지 않습니다.',
			ru: 'Не предоставлять необязательные данные.',
			id: 'Jangan bagikan informasi opsional.',
			ar: 'عدم مشاركة المعلومات الاختيارية.',
			it: 'Non condividere le informazioni facoltative.',
			th: 'ไม่เปิดเผยข้อมูลที่ไม่บังคับ',
			vi: 'Không cung cấp thông tin không bắt buộc.'
		};
	}

	function createDefaultContentOptions(templateId: TemplateId): ContentOption[] {
		switch (templateId) {
			case 'terms-of-service':
				return [
					createContentOption(
						'option-1',
						'true',
						{
							en: 'I agree',
							ja: '同意します',
							'zh-CN': '我同意',
							'zh-TW': '我同意',
							es: 'Acepto',
							pt: 'Concordo',
							fr: "J'accepte",
							de: 'Ich stimme zu',
							ko: '동의합니다',
							ru: 'Я согласен(на)',
							id: 'Saya setuju',
							ar: 'أوافق',
							it: 'Accetto',
							th: 'ยอมรับ',
							vi: 'Tôi đồng ý'
						},
						termsAgreementText()
					)
				];
			case 'privacy-policy':
				return [
					createContentOption(
						'option-1',
						'true',
						{
							en: 'I consent',
							ja: '同意します',
							'zh-CN': '我同意',
							'zh-TW': '我同意',
							es: 'Doy mi consentimiento',
							pt: 'Dou meu consentimento',
							fr: 'Je consens',
							de: 'Ich willige ein',
							ko: '동의합니다',
							ru: 'Я даю согласие',
							id: 'Saya menyetujui',
							ar: 'أوافق',
							it: 'Acconsento',
							th: 'ยินยอม',
							vi: 'Tôi đồng ý'
						},
						privacyAgreementText()
					)
				];
			case 'user-data-release-consent':
				return [
					createContentOption(
						'option-1',
						'full',
						releaseAllInformationLabels(),
						releaseAllInformationDescriptions()
					),
					createContentOption(
						'option-2',
						'minimal',
						releaseMinimumInformationLabels(),
						releaseMinimumInformationDescriptions()
					),
					createContentOption(
						'option-3',
						'none',
						releaseNoInformationLabels(),
						releaseNoInformationDescriptions()
					)
				];
			case 'saml-attribute-release':
				return [
					createContentOption(
						'option-1',
						'once',
						samlAllowOnceLabels(),
						samlAllowOnceDescriptions()
					),
					createContentOption(
						'option-2',
						'always',
						samlAlwaysAllowLabels(),
						samlAlwaysAllowDescriptions()
					),
					createContentOption('option-3', 'none', samlDenyLabels(), samlDenyDescriptions())
				];
			case 'saml-attribute-release-confirmation':
				return [
					createContentOption(
						'option-1',
						'once',
						samlAllowOnceLabels(),
						samlAllowOnceDescriptions()
					),
					createContentOption(
						'option-2',
						'always',
						samlAlwaysAllowLabels(),
						samlAlwaysAllowDescriptions()
					)
				];
			case 'custom':
				return [];
		}
	}

	function createDefaultContentLinks(templateId: TemplateId): ContentLink[] {
		switch (templateId) {
			case 'terms-of-service':
				return [
					{
						id: 'link-1',
						href: 'https://example.com/tos',
						labels: {
							en: 'Terms of Service',
							ja: '利用規約',
							'zh-CN': '服务条款',
							'zh-TW': '服務條款',
							es: 'Términos de servicio',
							pt: 'Termos de Serviço',
							fr: "Conditions d'utilisation",
							de: 'Nutzungsbedingungen',
							ko: '이용약관',
							ru: 'Условия обслуживания',
							id: 'Ketentuan Layanan',
							ar: 'شروط الخدمة',
							it: 'Termini di servizio',
							th: 'ข้อกำหนดการให้บริการ',
							vi: 'Điều khoản dịch vụ'
						}
					}
				];
			case 'privacy-policy':
				return [
					{
						id: 'link-1',
						href: 'https://example.com/privacy',
						labels: {
							en: 'Privacy Policy',
							ja: 'プライバシーポリシー',
							'zh-CN': '隐私政策',
							'zh-TW': '隱私權政策',
							es: 'Política de privacidad',
							pt: 'Política de Privacidade',
							fr: 'Politique de confidentialité',
							de: 'Datenschutzerklärung',
							ko: '개인정보 처리방침',
							ru: 'Политика конфиденциальности',
							id: 'Kebijakan Privasi',
							ar: 'سياسة الخصوصية',
							it: 'Informativa sulla privacy',
							th: 'นโยบายความเป็นส่วนตัว',
							vi: 'Chính sách quyền riêng tư'
						}
					}
				];
			case 'user-data-release-consent':
			case 'saml-attribute-release':
			case 'saml-attribute-release-confirmation':
			case 'custom':
				return [];
		}
	}

	function removeLanguage(code: ContentLanguageCode) {
		if (activeLanguageCodes.length <= 1) return;
		activeLanguageCodes = activeLanguageCodes.filter((languageCode) => languageCode !== code);
		if (defaultLanguage === code) {
			defaultLanguage = activeLanguageCodes[0] ?? 'en';
		}
		if (selectedLanguage === code) {
			selectedLanguage = activeLanguageCodes[0] ?? 'en';
		}
	}

	function selectLanguage(code: ContentLanguageCode) {
		selectedLanguage = code;
	}

	function handleLanguageKeydown(event: KeyboardEvent, code: ContentLanguageCode) {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		selectLanguage(code);
	}

	function languageLabel(code: ContentLanguageCode): string {
		return languageOptions.find((language) => language.code === code)?.label ?? code;
	}

	function updateSelectedContent(value: string) {
		contentDrafts = {
			...contentDrafts,
			[selectedLanguage]: value
		};
	}

	function setContentMode(mode: ContentMode) {
		contentMode = mode;
		if (mode !== 'display_only' && contentOptions.length === 0) {
			contentOptions = [
				createContentOption(
					`option-${nextContentOptionId}`,
					mode === 'checkbox' ? 'true' : 'value',
					genericContentOptionLabels(nextContentOptionId, mode === 'checkbox'),
					createEmptyLanguageMap()
				)
			];
			nextContentOptionId += 1;
		}
	}

	function contentModeLabel(mode: ContentMode): string {
		switch (mode) {
			case 'display_only':
				return $LL.admin_consent_templates_content_mode_display();
			case 'checkbox':
				return $LL.admin_consent_templates_content_mode_checkbox();
			case 'radio':
				return $LL.admin_consent_templates_content_mode_radio();
		}
	}

	function contentModeDescription(mode: ContentMode): string {
		switch (mode) {
			case 'display_only':
				return $LL.admin_consent_templates_content_mode_display_description();
			case 'checkbox':
				return $LL.admin_consent_templates_content_mode_checkbox_description();
			case 'radio':
				return $LL.admin_consent_templates_content_mode_radio_description();
		}
	}

	function addContentLink() {
		contentLinks = [
			...contentLinks,
			{
				id: `link-${nextContentLinkId}`,
				href: '',
				labels: createEmptyLanguageMap()
			}
		];
		nextContentLinkId += 1;
	}

	function removeContentLink(id: string) {
		contentLinks = contentLinks.filter((link) => link.id !== id);
	}

	function updateContentLinkHref(id: string, href: string) {
		contentLinks = contentLinks.map((link) => (link.id === id ? { ...link, href } : link));
	}

	function updateContentLinkLabel(id: string, label: string) {
		contentLinks = contentLinks.map((link) =>
			link.id === id
				? {
						...link,
						labels: {
							...link.labels,
							[selectedLanguage]: label
						}
					}
				: link
		);
	}

	function addContentOption() {
		contentOptions = [
			...contentOptions,
			createContentOption(
				`option-${nextContentOptionId}`,
				contentMode === 'checkbox' ? 'true' : '',
				genericContentOptionLabels(nextContentOptionId, contentMode === 'checkbox'),
				createEmptyLanguageMap()
			)
		];
		nextContentOptionId += 1;
	}

	function removeContentOption(id: string) {
		if (contentOptions.length <= 1) return;
		contentOptions = contentOptions.filter((option) => option.id !== id);
	}

	function updateContentOptionValueMode(id: string, valueMode: ContentOptionValueMode) {
		contentOptions = contentOptions.map((option) =>
			option.id === id
				? {
						...option,
						valueMode,
						value: valueMode === 'boolean' ? 'true' : option.value === 'true' ? '' : option.value
					}
				: option
		);
	}

	function updateContentOptionValue(id: string, value: string) {
		contentOptions = contentOptions.map((option) =>
			option.id === id ? { ...option, value } : option
		);
	}

	function updateContentOptionDescription(id: string, description: string) {
		contentOptions = contentOptions.map((option) =>
			option.id === id
				? {
						...option,
						descriptions: {
							...option.descriptions,
							[selectedLanguage]: description
						}
					}
				: option
		);
	}

	function renderConsentPreviewHtml(value: string, language: ContentLanguageCode): string {
		let output = '';
		let cursor = 0;
		const tokenPattern =
			/%(link\d*|identity_schema|destination_field_mapping_set|user_decision|binding_list|subject)%/g;
		for (const match of value.matchAll(tokenPattern)) {
			output += sanitizeConsentHtml(value.slice(cursor, match.index));
			output += renderPlaceholder(match[1], language);
			cursor = (match.index ?? 0) + match[0].length;
		}
		output += sanitizeConsentHtml(value.slice(cursor));
		return output;
	}

	function renderContentModePreviewHtml(language: ContentLanguageCode): string {
		if (contentMode === 'display_only') {
			return selectedPreviewHtml || '<div class="consent-preview-empty"></div>';
		}
		const inputType = contentMode === 'checkbox' ? 'checkbox' : 'radio';
		const name = contentMode === 'radio' ? 'consent-preview-choice' : '';
		const items = contentOptions
			.map((option, index) => {
				const body =
					option.descriptions[language] ||
					option.descriptions[defaultLanguage] ||
					option.descriptions.en ||
					option.labels[language] ||
					option.labels[defaultLanguage] ||
					option.labels.en ||
					`Option ${index + 1}`;
				const bodyHtml = renderConsentPreviewHtml(body, language);
				const value = option.value || `option-${index + 1}`;
				const nameAttribute = name ? ` name="${escapeAttribute(name)}"` : '';
				return `<label class="consent-preview-choice"><input type="${inputType}"${nameAttribute} value="${escapeAttribute(
					value
				)}" /><span>${bodyHtml}</span></label>`;
			})
			.join('');
		return `<div class="consent-preview-choices">${items}</div>`;
	}

	function renderPlaceholder(token: string, language: ContentLanguageCode): string {
		if (token === 'link') return renderContentLinkHtml(0, language);
		if (/^link\d+$/.test(token)) {
			const index = Number(token.slice(4)) - 1;
			return renderContentLinkHtml(index, language);
		}
		switch (token) {
			case 'identity_schema':
				return bindingType === 'identity_schema'
					? escapeHtml(bindingLabel(bindingType))
					: escapeHtml('%identity_schema%');
			case 'destination_field_mapping_set':
				return bindingType === 'destination_field_mapping_set'
					? escapeHtml(selectedFieldMappingSetLabel())
					: escapeHtml('%destination_field_mapping_set%');
			case 'user_decision':
				return bindingType === 'user_decision'
					? escapeHtml(bindingLabel(bindingType))
					: escapeHtml('%user_decision%');
			case 'binding_list':
				return escapeHtml(bindingListLabel());
			case 'subject':
				return bindingType === 'subject'
					? escapeHtml(subjectLabel(language))
					: escapeHtml('%subject%');
			default:
				return escapeHtml(`%${token}%`);
		}
	}

	function selectedFieldMappingSetLabel(): string {
		const selected = activeFieldMappingSets.find(
			(fieldMappingSet) => fieldMappingSet.id === selectedFieldMappingSetId
		);
		if (!selected) return bindingLabel('destination_field_mapping_set');
		return `${selected.displayName} (${selected.fieldMappingKey})`;
	}

	function bindingListLabel(): string {
		if (bindingType === 'destination_field_mapping_set') return selectedFieldMappingSetLabel();
		return bindingLabel(bindingType);
	}

	function renderContentLinkHtml(index: number, language: ContentLanguageCode): string {
		const link = contentLinks[index];
		if (!link) return escapeHtml(`%link${index + 1}%`);
		const safeHref = sanitizeHref(link.href);
		if (!safeHref) return escapeHtml(`%link${index + 1}%`);
		const label = contentLinkLabel(link, language) || safeHref;
		return `<a href="${escapeAttribute(safeHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
			label
		)}</a>`;
	}

	function contentLinkLabel(link: ContentLink, language: ContentLanguageCode): string {
		return link.labels[language] || link.labels[defaultLanguage] || link.labels.en || '';
	}

	function subjectLabel(language: ContentLanguageCode): string {
		switch (language) {
			case 'ja':
				return 'ログイン中の本人';
			case 'ko':
				return '현재 로그인한 사용자';
			case 'zh-CN':
				return '当前登录的本人';
			case 'zh-TW':
				return '目前登入的本人';
			case 'es':
				return 'el sujeto que ha iniciado sesión';
			case 'pt':
				return 'o sujeito conectado';
			case 'fr':
				return 'le sujet connecté';
			case 'de':
				return 'das angemeldete Subjekt';
			case 'ru':
				return 'вошедший субъект';
			case 'id':
				return 'subjek yang sedang masuk';
			case 'ar':
				return 'المستخدم الذي سجّل الدخول';
			case 'it':
				return 'l’utente che ha effettuato l’accesso';
			case 'th':
				return 'ผู้ใช้ที่เข้าสู่ระบบ';
			case 'vi':
				return 'người dùng đã đăng nhập';
			case 'en':
			default:
				return 'the signed-in subject';
		}
	}

	function sanitizeConsentHtml(value: string): string {
		let output = '';
		let cursor = 0;
		const tagPattern = /<[^>]*>/g;
		for (const match of value.matchAll(tagPattern)) {
			output += escapeHtml(value.slice(cursor, match.index));
			output += sanitizeAllowedTag(match[0]);
			cursor = (match.index ?? 0) + match[0].length;
		}
		output += escapeHtml(value.slice(cursor));
		return output.replace(/\n/g, '<br>');
	}

	function sanitizeAllowedTag(tag: string): string {
		if (/^<br\s*\/?>$/i.test(tag)) return '<br>';
		if (/^<p\s*>$/i.test(tag)) return '<p>';
		if (/^<\/p\s*>$/i.test(tag)) return '</p>';
		if (/^<span\s*>$/i.test(tag)) return '<span>';
		if (/^<\/span\s*>$/i.test(tag)) return '</span>';
		if (/^<strong\s*>$/i.test(tag)) return '<strong>';
		if (/^<\/strong\s*>$/i.test(tag)) return '</strong>';
		if (/^<\/a\s*>$/i.test(tag)) return '</a>';
		const anchorMatch = tag.match(/^<a\s+([^>]*)>$/i);
		if (!anchorMatch) return escapeHtml(tag);
		const hrefMatch = anchorMatch[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
		const href = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? '';
		const safeHref = sanitizeHref(href);
		if (!safeHref) return escapeHtml(tag);
		return `<a href="${escapeAttribute(safeHref)}" target="_blank" rel="noopener noreferrer">`;
	}

	function sanitizeHref(value: string): string {
		const trimmed = value.trim();
		if (!trimmed) return '';
		if (
			trimmed.startsWith('/') ||
			trimmed.startsWith('./') ||
			trimmed.startsWith('../') ||
			trimmed.startsWith('#')
		) {
			return trimmed;
		}
		try {
			const url = new URL(trimmed);
			return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:'
				? trimmed
				: '';
		} catch {
			return /^[a-z0-9._~!$&'()*+,;=:@/-]+$/i.test(trimmed) ? trimmed : '';
		}
	}

	function escapeHtml(value: string): string {
		return value
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;')
			.replaceAll("'", '&#39;');
	}

	function escapeAttribute(value: string): string {
		return escapeHtml(value).replaceAll('`', '&#96;');
	}
</script>

<svelte:head>
	<title>{$LL.admin_consent_templates_page_title()}</title>
</svelte:head>

<AdminPageShell>
	<div class="template-page">
		{#if loadingStatement}
			<div class="loading-state">
				<i class="i-ph-circle-notch loading-spinner" aria-hidden="true"></i>
				<p>{$LL.admin_consent_statements_loading()}</p>
			</div>
		{:else}
			<div class="template-header">
				<div>
					<h1>{$LL.admin_consent_templates_page_title()}</h1>
					{#if editingStatementId}
						<div class="statement-title-row">
							<label class="statement-slug-field">
								<span class="sr-only">Slug</span>
								<input
									class="admin-input"
									bind:value={loadedStatementSlug}
									placeholder="terms_of_service"
									disabled={deletingStatement}
								/>
							</label>
							<ToggleSwitch
								id="statement-active"
								bind:checked={loadedStatementActive}
								disabled={savingStatement || deletingStatement}
								label={$LL.admin_consent_statements_active()}
								ariaLabel={$LL.admin_consent_statements_active()}
								size="sm"
							/>
							<button
								type="button"
								class="btn btn-danger"
								disabled={savingStatement || deletingStatement}
								onclick={deleteCurrentStatement}
							>
								{#if deletingStatement}
									<i class="i-ph-circle-notch loading-spinner" aria-hidden="true"></i>
									{localText('deleting')}
								{:else}
									<i class="i-ph-trash" aria-hidden="true"></i>
									{localText('delete')}
								{/if}
							</button>
						</div>
					{:else}
						<p>{$LL.admin_consent_templates_page_description()}</p>
					{/if}
				</div>
				<a href="/admin/consent-statements" class="btn btn-secondary">
					{$LL.admin_consent_templates_back()}
				</a>
			</div>

			{#if saveError}
				<div class="alert alert-error">{saveError}</div>
			{/if}

			<section class="template-grid" aria-label={$LL.admin_consent_templates_template_aria()}>
				{#each templates as template (template.id)}
					<button
						type="button"
						class="template-card"
						class:selected={selectedTemplateId === template.id}
						onclick={() => selectTemplate(template.id)}
					>
						<span class="template-card__icon">
							<i class={template.icon} aria-hidden="true"></i>
						</span>
						<span class="template-card__body">
							<span class="template-card__title">{templateTitle(template.id)}</span>
							<span class="template-card__description">{templateDescription(template.id)}</span>
						</span>
					</button>
				{/each}
			</section>

			{#if selectedTemplate}
				<section
					class="collection-panel"
					aria-label={$LL.admin_consent_templates_collection_aria()}
				>
					<div class="collection-panel__header">
						<div>
							<p class="template-kicker">{$LL.admin_consent_templates_collection_kicker()}</p>
							<h2>{templateTitle(selectedTemplate.id)}</h2>
						</div>
					</div>
					<div
						class="mode-list"
						role="radiogroup"
						aria-label={$LL.admin_consent_templates_collection_aria()}
					>
						{#each modeOptions as option (option)}
							<label class="mode-card" class:selected={collectionMode === option}>
								<input type="radio" bind:group={collectionMode} value={option} />
								<span class="template-card__icon mode-card__icon">
									<i class={modeIcon(option)} aria-hidden="true"></i>
								</span>
								<span class="template-card__body">
									<span class="template-card__title">{modeLabel(option)}</span>
									<span class="template-card__description">{modeDescription(option)}</span>
								</span>
							</label>
						{/each}
					</div>
				</section>

				<section class="binding-panel" aria-label={$LL.admin_consent_templates_binding_aria()}>
					<div class="collection-panel__header">
						<div>
							<p class="template-kicker">{$LL.admin_consent_templates_binding_kicker()}</p>
							<h2>{$LL.admin_consent_templates_binding_title()}</h2>
							<p class="panel-description">
								{$LL.admin_consent_templates_binding_description()}
							</p>
						</div>
					</div>
					<div class="binding-grid">
						<div class="binding-type-stack">
							<label class="admin-field">
								<span class="admin-field__label">{$LL.admin_consent_templates_binding_type()}</span>
								<select class="admin-select" bind:value={bindingType}>
									<option value="subject">{$LL.admin_consent_templates_binding_subject()}</option>
									<option value="identity_schema">
										{$LL.admin_consent_templates_binding_identity_schema()}
									</option>
									<option value="destination_field_mapping_set">
										{$LL.admin_consent_templates_binding_destination_field_mapping_sets()}
									</option>
									<option value="user_decision">
										{$LL.admin_consent_templates_binding_user_decision()}
									</option>
								</select>
							</label>
							<div class="binding-help" aria-live="polite">
								<strong>{selectedBindingLabel}</strong>
								<p>{selectedBindingDescription}</p>
							</div>
						</div>
						{#if bindingType === 'destination_field_mapping_set'}
							<div class="binding-type-stack">
								<label class="admin-field">
									<span class="admin-field__label">
										{$LL.admin_consent_templates_binding_field_mapping_set()}
									</span>
									<select
										class="admin-select"
										bind:value={selectedFieldMappingSetId}
										disabled={activeFieldMappingSets.length === 0}
									>
										{#if activeFieldMappingSets.length === 0}
											<option value="">
												{fieldMappingSetsLoaded
													? $LL.admin_consent_templates_binding_no_field_mapping_sets()
													: $LL.admin_consent_templates_binding_loading_field_mapping_sets()}
											</option>
										{:else}
											{#each activeFieldMappingSets as fieldMappingSet (fieldMappingSet.id)}
												<option value={fieldMappingSet.id}>{fieldMappingSet.displayName}</option>
											{/each}
										{/if}
									</select>
								</label>
								<a class="field-hint-link" href="/admin/field-mapping/field-mapping-sets">
									{$LL.admin_consent_templates_option_open_field_mapping()}
								</a>
							</div>
						{/if}
					</div>
					{#if selectedTemplate.id === 'saml-attribute-release-confirmation'}
						<div class="binding-extra-grid">
							<label class="admin-field">
								<span class="admin-field__label">{localText('attributeValueDisplay')}</span>
								<select class="admin-select" bind:value={attributeValueDisplay}>
									<option value="names">{localText('attributeValueNames')}</option>
									<option value="masked_values">{localText('attributeValueMasked')}</option>
									<option value="full_values">{localText('attributeValueFull')}</option>
								</select>
							</label>
							<div class="binding-help">
								<strong>{localText('attributeValueDisplay')}</strong>
								<p>{localText('attributeValueDisplayDescription')}</p>
							</div>
						</div>
					{/if}
				</section>

				<section class="content-panel" aria-label={$LL.admin_consent_templates_content_aria()}>
					<div class="collection-panel__header">
						<div>
							<h2>{$LL.admin_consent_templates_content_title()}</h2>
						</div>
					</div>
					<div class="content-editor">
						<label class="admin-field content-title-field">
							<span class="admin-field__label">{$LL.admin_consent_templates_internal_title()}</span>
							<input
								class="admin-input"
								bind:value={internalTitle}
								placeholder={templateTitle(selectedTemplate.id)}
							/>
						</label>

						<div
							class="content-mode-panel"
							role="radiogroup"
							aria-label={$LL.admin_consent_templates_content_mode()}
						>
							{#each contentModeOptions as option (option)}
								<label class="content-mode-card" class:selected={contentMode === option}>
									<input
										type="radio"
										checked={contentMode === option}
										value={option}
										onchange={() => setContentMode(option)}
									/>
									<span>
										<strong>{contentModeLabel(option)}</strong>
										<small>{contentModeDescription(option)}</small>
									</span>
								</label>
							{/each}
						</div>

						<div class="content-mode-preview-panel">
							<aside
								class="language-panel preview-language-panel"
								aria-label={$LL.admin_consent_templates_languages()}
							>
								<div class="language-list">
									{#each activeLanguageCodes as languageCode (languageCode)}
										<div
											role="button"
											tabindex="0"
											class="language-item"
											class:selected={selectedLanguage === languageCode}
											onclick={() => selectLanguage(languageCode)}
											onkeydown={(event) => handleLanguageKeydown(event, languageCode)}
										>
											<span>
												{languageLabel(languageCode)}
												{#if defaultLanguage === languageCode}
													<span class="language-default">
														{$LL.admin_consent_templates_default_language_badge()}
													</span>
												{/if}
											</span>
											{#if activeLanguageCodes.length > 1}
												<button
													type="button"
													class="language-remove"
													aria-label={$LL.admin_consent_templates_remove_language({
														language: languageLabel(languageCode)
													})}
													onclick={(event) => {
														event.stopPropagation();
														removeLanguage(languageCode);
													}}
												>
													<i class="i-ph-x" aria-hidden="true"></i>
												</button>
											{/if}
										</div>
									{/each}
								</div>
							</aside>

							<section
								class="content-mode-preview"
								aria-label={$LL.admin_consent_templates_preview_tab()}
							>
								<div class="language-editor__header">
									<h3>
										{$LL.admin_consent_templates_preview_tab()} ({languageLabel(selectedLanguage)})
									</h3>
									<label class="default-language-toggle">
										<input
											type="checkbox"
											checked={defaultLanguage === selectedLanguage}
											onchange={() => (defaultLanguage = selectedLanguage)}
										/>
										<span>{$LL.admin_consent_templates_default_language()}</span>
									</label>
								</div>
								<div
									class="content-preview mode-preview"
									dir={selectedLanguage === 'ar' ? 'rtl' : 'ltr'}
									role="presentation"
								>
									<SanitizedHtmlPreview html={selectedModePreviewHtml} />
								</div>
							</section>
						</div>

						{#if contentMode !== 'display_only'}
							<div class="content-options-panel">
								<div class="content-links-panel__header">
									<div>
										<h3>{$LL.admin_consent_templates_options_title()}</h3>
										<p>{$LL.admin_consent_templates_options_description()}</p>
									</div>
									{#if !singleOptionTemplate}
										<button
											type="button"
											class="btn btn-secondary btn-sm"
											onclick={addContentOption}
										>
											<i class="i-ph-plus" aria-hidden="true"></i>
											{$LL.admin_consent_templates_options_add()}
										</button>
									{/if}
								</div>

								<div class="content-option-list">
									{#each contentOptions as option, index (option.id)}
										<section class="content-option-card">
											<div class="content-option-card__header">
												<h4>
													{$LL.admin_consent_templates_option_title({ index: index + 1 })}
												</h4>
												<button
													type="button"
													class="content-link-remove"
													disabled={contentOptions.length <= 1}
													aria-label={$LL.admin_consent_templates_option_remove({
														index: index + 1
													})}
													onclick={() => removeContentOption(option.id)}
												>
													<i class="i-ph-trash" aria-hidden="true"></i>
												</button>
											</div>

											<div class="content-option-grid">
												<div class="content-option-value-mode">
													<span class="admin-field__label">
														{$LL.admin_consent_templates_option_value_type()}
													</span>
													<div class="segmented-control">
														<label>
															<input
																type="radio"
																checked={option.valueMode === 'boolean'}
																onchange={() => updateContentOptionValueMode(option.id, 'boolean')}
															/>
															<span>boolean</span>
														</label>
														<label>
															<input
																type="radio"
																checked={option.valueMode === 'value'}
																onchange={() => updateContentOptionValueMode(option.id, 'value')}
															/>
															<span>value</span>
														</label>
													</div>
												</div>

												<label class="admin-field">
													<span class="admin-field__label">
														{$LL.admin_consent_templates_option_value()}
													</span>
													<input
														class="admin-input"
														value={option.value}
														disabled={option.valueMode === 'boolean'}
														placeholder="once / always / minimal / none"
														oninput={(event) =>
															updateContentOptionValue(option.id, event.currentTarget.value)}
													/>
												</label>
											</div>

											<div class="option-text-panel">
												<div class="option-text-panel__header">
													<h5>
														{$LL.admin_consent_templates_option_body({
															language: languageLabel(selectedLanguage)
														})}
													</h5>
													<p>{$LL.admin_consent_templates_option_body_description()}</p>
												</div>

												<section
													class="option-text-editor"
													aria-label={languageLabel(selectedLanguage)}
												>
													<div class="language-editor__header">
														<h3>{languageLabel(selectedLanguage)}</h3>
													</div>

													<div class="admin-field content-textarea-field">
														<span class="admin-field__label">
															{$LL.admin_consent_templates_text_label()}
														</span>
														{#key `${option.id}-${selectedLanguage}`}
															<MonacoTextEditor
																value={option.descriptions[selectedLanguage]}
																language="authrim-consent-html"
																ariaLabel={$LL.admin_consent_templates_option_body({
																	language: languageLabel(selectedLanguage)
																})}
																minHeight={96}
																onchange={(value) =>
																	updateContentOptionDescription(option.id, value)}
															/>
														{/key}
													</div>
													<p class="content-hint">{$LL.admin_consent_templates_text_hint()}</p>

													<div class="content-links-panel option-links-panel">
														<div class="content-links-panel__header">
															<div>
																<h3>{$LL.admin_consent_templates_links_title()}</h3>
																<p>{$LL.admin_consent_templates_links_description()}</p>
															</div>
															<button
																type="button"
																class="btn btn-secondary btn-sm"
																onclick={addContentLink}
															>
																<i class="i-ph-plus" aria-hidden="true"></i>
																{$LL.admin_consent_templates_links_add()}
															</button>
														</div>

														<div class="content-link-list">
															{#each contentLinks as link, linkIndex (link.id)}
																<div class="content-link-row">
																	<div class="content-link-token">
																		<span class="admin-field__label">
																			{$LL.admin_consent_templates_link_token()}
																		</span>
																		<code>{`%link${linkIndex + 1}%`}</code>
																	</div>
																	<label class="admin-field">
																		<span class="admin-field__label">
																			{$LL.admin_consent_templates_link_url()}
																		</span>
																		<input
																			class="admin-input"
																			value={link.href}
																			placeholder="https://example.com/terms"
																			oninput={(event) =>
																				updateContentLinkHref(link.id, event.currentTarget.value)}
																		/>
																	</label>
																	<label class="admin-field">
																		<span class="admin-field__label">
																			{$LL.admin_consent_templates_link_label({
																				language: languageLabel(selectedLanguage)
																			})}
																		</span>
																		<input
																			class="admin-input"
																			value={link.labels[selectedLanguage]}
																			placeholder={contentLinkLabel(link, selectedLanguage) ||
																				'Terms of Service'}
																			oninput={(event) =>
																				updateContentLinkLabel(link.id, event.currentTarget.value)}
																		/>
																	</label>
																	<button
																		type="button"
																		class="content-link-remove"
																		aria-label={$LL.admin_consent_templates_links_remove({
																			token: `%link${linkIndex + 1}%`
																		})}
																		onclick={() => removeContentLink(link.id)}
																	>
																		<i class="i-ph-trash" aria-hidden="true"></i>
																	</button>
																</div>
															{:else}
																<p class="content-empty-note">
																	{$LL.admin_consent_templates_links_empty()}
																</p>
															{/each}
														</div>
													</div>
												</section>
											</div>
										</section>
									{/each}
								</div>
							</div>
						{/if}

						{#if contentMode === 'display_only'}
							<div class="option-text-panel">
								<div class="option-text-panel__header">
									<h5>{languageLabel(selectedLanguage)}</h5>
									<p>{$LL.admin_consent_templates_option_body_description()}</p>
								</div>

								<section class="option-text-editor" aria-label={languageLabel(selectedLanguage)}>
									<div class="language-editor__header">
										<h3>{languageLabel(selectedLanguage)}</h3>
									</div>

									<div class="admin-field content-textarea-field">
										<span class="admin-field__label"
											>{$LL.admin_consent_templates_text_label()}</span
										>
										{#key selectedLanguage}
											<MonacoTextEditor
												value={contentDrafts[selectedLanguage]}
												language="authrim-consent-html"
												ariaLabel={$LL.admin_consent_templates_text_label()}
												minHeight={96}
												onchange={updateSelectedContent}
											/>
										{/key}
									</div>
									<p class="content-hint">{$LL.admin_consent_templates_text_hint()}</p>

									<div class="content-links-panel option-links-panel">
										<div class="content-links-panel__header">
											<div>
												<h3>{$LL.admin_consent_templates_links_title()}</h3>
												<p>{$LL.admin_consent_templates_links_description()}</p>
											</div>
											<button
												type="button"
												class="btn btn-secondary btn-sm"
												onclick={addContentLink}
											>
												<i class="i-ph-plus" aria-hidden="true"></i>
												{$LL.admin_consent_templates_links_add()}
											</button>
										</div>

										<div class="content-link-list">
											{#each contentLinks as link, index (link.id)}
												<div class="content-link-row">
													<div class="content-link-token">
														<span class="admin-field__label">
															{$LL.admin_consent_templates_link_token()}
														</span>
														<code>{`%link${index + 1}%`}</code>
													</div>
													<label class="admin-field">
														<span class="admin-field__label">
															{$LL.admin_consent_templates_link_url()}
														</span>
														<input
															class="admin-input"
															value={link.href}
															placeholder="https://example.com/terms"
															oninput={(event) =>
																updateContentLinkHref(link.id, event.currentTarget.value)}
														/>
													</label>
													<label class="admin-field">
														<span class="admin-field__label">
															{$LL.admin_consent_templates_link_label({
																language: languageLabel(selectedLanguage)
															})}
														</span>
														<input
															class="admin-input"
															value={link.labels[selectedLanguage]}
															placeholder={contentLinkLabel(link, selectedLanguage) ||
																'Terms of Service'}
															oninput={(event) =>
																updateContentLinkLabel(link.id, event.currentTarget.value)}
														/>
													</label>
													<button
														type="button"
														class="content-link-remove"
														aria-label={$LL.admin_consent_templates_links_remove({
															token: `%link${index + 1}%`
														})}
														onclick={() => removeContentLink(link.id)}
													>
														<i class="i-ph-trash" aria-hidden="true"></i>
													</button>
												</div>
											{:else}
												<p class="content-empty-note">
													{$LL.admin_consent_templates_links_empty()}
												</p>
											{/each}
										</div>
									</div>
								</section>
							</div>
						{/if}
					</div>
				</section>

				<div class="template-actions">
					<a href="/admin/consent-statements" class="btn btn-secondary">
						{$LL.admin_consent_templates_back()}
					</a>
					<button
						type="button"
						class="btn btn-primary"
						disabled={savingStatement || deletingStatement}
						onclick={saveTemplateStatement}
					>
						{#if savingStatement}
							<i class="i-ph-circle-notch loading-spinner" aria-hidden="true"></i>
							{localText('saving')}
						{:else if editingStatementId}
							{localText('save')}
						{:else if customSelected}
							{$LL.admin_consent_templates_create_custom()}
						{:else}
							{$LL.admin_consent_templates_create_from_template()}
						{/if}
					</button>
				</div>
			{/if}
		{/if}
	</div>
</AdminPageShell>

<style>
	.template-page {
		max-width: 1180px;
		margin: 0 auto;
		padding: 32px 24px 56px;
	}

	.template-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 24px;
	}

	.template-header h1,
	.collection-panel h2 {
		margin: 0;
		color: var(--color-text-primary);
		line-height: 1.25;
	}

	.template-header h1 {
		font-size: 1.7rem;
	}

	.template-header p {
		margin: 8px 0 0;
		color: var(--color-text-muted);
	}

	.statement-title-row {
		display: grid;
		grid-template-columns: minmax(240px, 520px) auto auto;
		gap: 12px;
		align-items: center;
		margin-top: 12px;
	}

	.statement-slug-field {
		min-width: 0;
	}

	.template-kicker {
		margin: 0 0 6px;
		color: var(--color-text-muted);
		font-size: 0.75rem;
		font-weight: 700;
		letter-spacing: 0;
		text-transform: uppercase;
	}

	.template-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
		margin-bottom: 18px;
	}

	.template-card {
		display: flex;
		align-items: flex-start;
		gap: 14px;
		min-height: 84px;
		padding: 12px 16px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.template-card:hover,
	.template-card:focus-visible {
		border-color: color-mix(in srgb, var(--color-primary) 42%, var(--color-border));
		outline: none;
	}

	.template-card.selected {
		border-color: var(--color-primary);
		background: color-mix(in srgb, var(--color-primary) 14%, var(--color-surface));
		box-shadow:
			inset 0 0 0 1px color-mix(in srgb, var(--color-primary) 36%, transparent),
			0 0 0 1px color-mix(in srgb, var(--color-primary) 12%, transparent);
	}

	.template-card__icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-primary) 9%, transparent);
		color: var(--color-primary);
		font-size: 1.2rem;
	}

	.template-card__body {
		display: grid;
		gap: 6px;
		min-width: 0;
	}

	.template-card__title {
		color: var(--color-text-primary);
		font-size: 1rem;
		font-weight: 800;
		line-height: 1.35;
	}

	.template-card__description {
		color: var(--color-text-muted);
		font-size: 0.85rem;
		line-height: 1.55;
	}

	.collection-panel {
		padding: 20px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
	}

	.binding-panel,
	.content-panel {
		margin-top: 18px;
		padding: 20px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
	}

	.panel-description {
		margin: 8px 0 0;
		color: var(--color-text-muted);
		font-size: 0.86rem;
		line-height: 1.55;
	}

	.binding-grid {
		display: grid;
		grid-template-columns: minmax(220px, 0.8fr) minmax(280px, 1.2fr);
		gap: 14px;
	}

	.binding-extra-grid {
		display: grid;
		grid-template-columns: minmax(220px, 0.8fr) minmax(280px, 1.2fr);
		gap: 14px;
		margin-top: 14px;
	}

	.binding-type-stack {
		display: grid;
		gap: 10px;
	}

	.binding-help {
		padding: 12px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-primary) 5%, var(--color-surface));
	}

	.binding-help strong {
		display: block;
		color: var(--color-text-primary);
		font-size: 0.9rem;
		line-height: 1.4;
	}

	.binding-help p {
		margin: 5px 0 0;
		color: var(--color-text-muted);
		font-size: 0.82rem;
		line-height: 1.55;
	}

	.content-editor {
		display: grid;
		gap: 14px;
	}

	.content-title-field {
		max-width: 520px;
	}

	.content-mode-panel {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 10px;
	}

	.content-mode-card {
		position: relative;
		display: block;
		min-height: 78px;
		padding: 13px 14px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
		cursor: pointer;
	}

	.content-mode-card:hover,
	.content-mode-card:focus-within {
		border-color: color-mix(in srgb, var(--color-primary) 42%, var(--color-border));
	}

	.content-mode-card.selected {
		border-color: var(--color-primary);
		background: color-mix(in srgb, var(--color-primary) 14%, var(--color-surface));
		box-shadow:
			inset 0 0 0 1px color-mix(in srgb, var(--color-primary) 36%, transparent),
			0 0 0 1px color-mix(in srgb, var(--color-primary) 12%, transparent);
	}

	.content-mode-card input {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}

	.content-mode-card span {
		display: grid;
		gap: 6px;
	}

	.content-mode-card strong {
		color: var(--color-text-primary);
		font-size: 0.95rem;
		line-height: 1.35;
	}

	.content-mode-card small {
		color: var(--color-text-muted);
		font-size: 0.8rem;
		line-height: 1.5;
	}

	.content-mode-preview-panel {
		display: grid;
		grid-template-columns: minmax(220px, 260px) minmax(0, 1fr);
		gap: 14px;
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-primary) 3%, var(--color-surface));
	}

	.preview-language-panel {
		min-height: 220px;
		height: 100%;
	}

	.preview-language-panel .language-list {
		max-height: none;
	}

	.content-mode-preview {
		min-width: 0;
	}

	.mode-preview {
		min-height: 220px;
	}

	.mode-preview :global(.consent-preview-empty) {
		min-height: 72px;
	}

	.mode-preview :global(.consent-preview-choices) {
		display: grid;
		gap: 10px;
	}

	.mode-preview :global(.consent-preview-choice) {
		display: grid;
		grid-template-columns: 18px minmax(0, 1fr);
		gap: 10px;
		align-items: start;
		padding: 10px 12px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
		color: var(--color-text-primary);
		cursor: pointer;
	}

	.mode-preview :global(.consent-preview-choice input) {
		width: 16px;
		height: 16px;
		margin: 2px 0 0;
		accent-color: var(--color-primary);
		cursor: pointer;
	}

	.mode-preview :global(.consent-preview-choice span) {
		min-width: 0;
		line-height: 1.55;
	}

	.content-links-panel {
		display: grid;
		gap: 12px;
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-primary) 4%, var(--color-surface));
	}

	.content-links-panel__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}

	.content-links-panel__header h3 {
		margin: 0;
		color: var(--color-text-primary);
		font-size: 0.95rem;
		line-height: 1.35;
	}

	.content-links-panel__header p {
		margin: 4px 0 0;
		color: var(--color-text-muted);
		font-size: 0.8rem;
		line-height: 1.5;
	}

	.content-link-list {
		display: grid;
		gap: 10px;
	}

	.content-link-row {
		display: grid;
		grid-template-columns: minmax(120px, 0.35fr) minmax(220px, 1fr) minmax(220px, 1fr) 38px;
		gap: 10px;
		align-items: end;
	}

	.content-link-row .admin-input {
		height: 38px;
		min-height: 38px;
		padding-top: 0;
		padding-bottom: 0;
	}

	.content-link-token {
		display: grid;
		gap: 7px;
		min-width: 0;
	}

	.content-link-token code {
		display: inline-flex;
		align-items: center;
		min-height: 38px;
		padding: 0 10px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
		color: var(--color-text-primary);
		font-size: 0.85rem;
		white-space: nowrap;
	}

	.content-link-remove {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 38px;
		height: 38px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
		color: var(--color-danger);
		cursor: pointer;
	}

	.content-link-remove:disabled {
		color: var(--color-text-subtle);
		cursor: not-allowed;
		opacity: 0.55;
	}

	.content-empty-note {
		margin: 0;
		padding: 10px 12px;
		border: 1px dashed var(--color-border);
		border-radius: 8px;
		color: var(--color-text-muted);
		font-size: 0.82rem;
	}

	.content-options-panel {
		display: grid;
		gap: 12px;
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-primary) 3%, var(--color-surface));
	}

	.content-option-list {
		display: grid;
		gap: 12px;
	}

	.content-option-card {
		display: grid;
		gap: 12px;
		padding: 14px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
	}

	.content-option-card__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.content-option-card__header h4 {
		margin: 0;
		color: var(--color-text-primary);
		font-size: 0.95rem;
		line-height: 1.35;
	}

	.content-option-grid {
		display: grid;
		grid-template-columns: minmax(180px, 0.65fr) minmax(220px, 1fr);
		gap: 10px;
		align-items: end;
	}

	.content-option-value-mode {
		display: grid;
		gap: 7px;
	}

	.option-text-panel {
		display: grid;
		gap: 12px;
		padding: 12px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-primary) 2%, var(--color-surface));
	}

	.option-text-panel__header h5 {
		margin: 0;
		color: var(--color-text-primary);
		font-size: 0.9rem;
		line-height: 1.35;
	}

	.option-text-panel__header p {
		margin: 4px 0 0;
		color: var(--color-text-muted);
		font-size: 0.8rem;
		line-height: 1.5;
	}

	.option-links-panel {
		margin-top: 12px;
		background: color-mix(in srgb, var(--color-surface) 96%, transparent);
	}

	.option-text-editor {
		min-width: 0;
	}

	.segmented-control {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		min-height: 38px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-surface) 94%, transparent);
		overflow: hidden;
	}

	.segmented-control label {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--color-text-muted);
		font-size: 0.84rem;
		cursor: pointer;
	}

	.segmented-control label + label {
		border-left: 1px solid var(--color-border);
	}

	.segmented-control input {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}

	.segmented-control label:has(input:checked) {
		background: color-mix(in srgb, var(--color-primary) 18%, var(--color-surface));
		color: var(--color-text-primary);
		font-weight: 700;
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-primary) 30%, transparent);
	}

	.field-hint-link {
		display: inline-flex;
		align-items: center;
		min-height: 38px;
		color: var(--color-primary);
		font-size: 0.84rem;
		text-decoration: underline;
		white-space: nowrap;
	}

	.content-edit-area {
		display: grid;
		grid-template-columns: minmax(300px, 0.9fr) minmax(0, 1.8fr);
		gap: 18px;
		align-items: start;
	}

	.language-panel {
		display: flex;
		flex-direction: column;
		min-height: 340px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-surface) 92%, transparent);
		overflow: hidden;
	}

	.language-list {
		flex: 1;
		min-height: 0;
		max-height: 340px;
		overflow: auto;
		padding: 8px;
	}

	.language-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
		min-width: max-content;
		padding: 7px 8px;
		border-radius: 6px;
		color: var(--color-text-primary);
		font-size: 0.86rem;
		line-height: 1.35;
		white-space: nowrap;
		cursor: pointer;
	}

	.language-item > span {
		overflow: visible;
		white-space: nowrap;
	}

	.language-item:hover,
	.language-item:focus-visible {
		background: color-mix(in srgb, var(--color-primary) 8%, transparent);
		outline: none;
	}

	.language-item.selected {
		background: color-mix(in srgb, var(--color-primary) 18%, var(--color-surface));
		color: var(--color-text-primary);
		box-shadow: inset 3px 0 0 var(--color-primary);
	}

	.language-default {
		margin-left: 4px;
		color: var(--color-text-muted);
		font-size: 0.78rem;
	}

	.language-remove {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--color-danger);
		opacity: 0;
		cursor: pointer;
	}

	.language-item:hover .language-remove,
	.language-item:focus-within .language-remove {
		opacity: 1;
	}

	.language-remove:focus-visible {
		opacity: 1;
		outline: 2px solid var(--color-primary);
		outline-offset: 1px;
	}

	.language-editor {
		min-width: 0;
	}

	.language-editor__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 10px;
	}

	.language-editor__header h3 {
		margin: 0;
		color: var(--color-text-primary);
		font-size: 1rem;
		line-height: 1.35;
	}

	.default-language-toggle {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--color-text-muted);
		font-size: 0.82rem;
		white-space: nowrap;
	}

	.content-textarea-field {
		display: grid;
		gap: 6px;
	}

	.content-preview {
		min-height: 164px;
	}

	.content-hint {
		margin: 8px 0 0;
		color: var(--color-text-muted);
		font-size: 0.78rem;
	}

	.content-preview {
		padding: 12px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-surface) 94%, transparent);
		color: var(--color-text-primary);
		font-size: 0.9rem;
		line-height: 1.6;
	}

	.content-preview :global(a) {
		color: var(--color-primary);
		text-decoration: underline;
	}

	.content-preview :global(ol) {
		margin: 8px 0 0;
		padding-left: 1.35rem;
	}

	.content-preview :global(li) {
		margin: 3px 0;
	}

	.collection-panel__header {
		margin-bottom: 14px;
	}

	.mode-list {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px;
	}

	.mode-card {
		position: relative;
		display: flex;
		align-items: flex-start;
		gap: 12px;
		min-height: 84px;
		padding: 12px 16px;
		border: 1px solid var(--color-border);
		border-radius: 8px;
		background: var(--color-surface);
		color: inherit;
		cursor: pointer;
	}

	.mode-card:hover,
	.mode-card:focus-within {
		border-color: color-mix(in srgb, var(--color-primary) 42%, var(--color-border));
	}

	.mode-card.selected {
		border-color: var(--color-primary);
		background: color-mix(in srgb, var(--color-primary) 14%, var(--color-surface));
		box-shadow:
			inset 0 0 0 1px color-mix(in srgb, var(--color-primary) 36%, transparent),
			0 0 0 1px color-mix(in srgb, var(--color-primary) 12%, transparent);
	}

	.mode-card input {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}

	.mode-card__icon {
		flex: 0 0 auto;
	}

	.template-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 10px;
		margin-top: 18px;
	}

	@media (max-width: 720px) {
		.template-page {
			padding: 24px 16px 44px;
		}

		.template-header {
			display: grid;
		}

		.template-grid,
		.mode-list,
		.content-mode-panel {
			grid-template-columns: 1fr;
		}

		.template-actions {
			justify-content: stretch;
		}

		.template-actions :global(.btn),
		.template-actions .btn {
			justify-content: center;
			width: 100%;
		}
		.binding-grid,
		.binding-extra-grid {
			grid-template-columns: 1fr;
		}

		.content-edit-area {
			grid-template-columns: 1fr;
		}

		.content-mode-preview-panel {
			grid-template-columns: 1fr;
		}

		.content-links-panel__header,
		.content-link-row,
		.content-option-grid {
			grid-template-columns: 1fr;
		}

		.content-links-panel__header {
			display: grid;
		}

		.content-link-remove {
			width: 100%;
		}

		.language-panel,
		.language-list {
			max-height: 240px;
			min-height: 0;
		}
	}
</style>
