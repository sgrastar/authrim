/**
 * In-memory consent statements for Storybook, the whole-console mock and tests. Answers as the
 * Admin API does: a key is unique (409), a version number is YYYYMMDD and unique per statement,
 * only a draft version or its texts can be changed (400 for the version, 409 for its texts), a
 * version needs a text to be published, and a statement used nowhere and never published is
 * deleted while any other is retired.
 */
import { ApiError, ConflictError } from '../api-error';
import type {
	ConsentLocalization,
	ConsentStatement,
	ConsentStatementUsage,
	ConsentStatementsClient,
	ConsentVersion
} from '../consent-statements';

export interface FakeConsentStatementsOptions {
	statements?: ConsentStatement[];
	versions?: ConsentVersion[];
	/** Texts by version id. */
	localizations?: Record<string, ConsentLocalization[]>;
	usages?: Record<string, ConsentStatementUsage>;
	/** The usage call fails (an API that does not have it yet). */
	usagesFail?: boolean;
	usagesComplete?: boolean;
	delay?: number;
	now?: () => number;
}

const VERSION = /^(\d{4})(\d{2})(\d{2})$/u;

function validVersion(value: unknown): value is string {
	const match = typeof value === 'string' ? VERSION.exec(value) : null;
	if (!match) return false;
	const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
	return date.getUTCMonth() === +match[2] - 1 && date.getUTCDate() === +match[3];
}

const invalid = (message: string) => new ApiError(400, 'invalid_request', message);

export function createFakeConsentStatements(
	options: FakeConsentStatementsOptions = {}
): ConsentStatementsClient {
	let statements = structuredClone(options.statements ?? []);
	let versions = structuredClone(options.versions ?? []);
	const texts: Record<string, ConsentLocalization[]> = structuredClone(options.localizations ?? {});
	const now = options.now ?? Date.now;
	let sequence = statements.length + versions.length;
	const wait = () =>
		options.delay ? new Promise((resolve) => setTimeout(resolve, options.delay)) : null;

	const statementOf = (id: string) => {
		const found = statements.find((item) => item.id === id);
		if (!found) throw new ApiError(404, 'not_found', 'Statement not found');
		return found;
	};
	const versionOf = (statementId: string, versionId: string) => {
		const found = versions.find(
			(item) => item.id === versionId && item.statement_id === statementId
		);
		if (!found) throw new ApiError(404, 'not_found', 'Version not found');
		return found;
	};
	const draftOnly = (version: ConsentVersion) => {
		if (version.status !== 'draft') {
			throw new ConflictError(
				'Only draft versions allow localization changes; create a new version',
				{ error: 'conflict' }
			);
		}
	};
	const versionsNewestFirst = (statementId: string) =>
		versions
			.filter((item) => item.statement_id === statementId)
			.sort((a, b) => b.effective_at - a.effective_at);

	return {
		async list() {
			await wait();
			return structuredClone(statements)
				.sort((a, b) => a.display_order - b.display_order || a.created_at - b.created_at)
				.map((statement) => {
					const own = versionsNewestFirst(statement.id);
					const current = own.find((item) => item.is_current) ?? null;
					const shown = current ?? own.find((item) => item.status === 'draft') ?? null;
					const titles: Record<string, string> = {};
					for (const item of shown ? (texts[shown.id] ?? []) : [])
						titles[item.language] = item.title;
					return {
						statement,
						current: structuredClone(current),
						hasDraft: own.some((item) => item.status === 'draft'),
						titles
					};
				});
		},
		async get(id) {
			await wait();
			return {
				statement: structuredClone(statementOf(id)),
				versions: structuredClone(versionsNewestFirst(id))
			};
		},
		async usages() {
			await wait();
			if (options.usagesFail) throw new ApiError(404, 'not_found', 'Not found');
			return {
				byStatement: structuredClone(options.usages ?? {}),
				complete: options.usagesComplete ?? true
			};
		},
		async create(input) {
			await wait();
			if (!input.slug?.trim()) throw invalid('slug is required');
			if (statements.some((item) => item.slug === input.slug)) {
				throw new ConflictError('A statement with this slug already exists', { error: 'conflict' });
			}
			const at = now();
			const statement: ConsentStatement = {
				id: `stmt_${++sequence}`,
				slug: input.slug,
				category: input.category ?? 'custom',
				legal_basis: input.legal_basis ?? 'consent',
				processing_purpose: input.processing_purpose ?? null,
				display_order: 0,
				is_active: true,
				record_retention_days: input.record_retention_days ?? null,
				withdrawal_allowed: input.withdrawal_allowed !== false,
				withdrawal_impact: input.withdrawal_impact?.trim() || null,
				required_consent_version: null,
				reconsent_interval_days: input.reconsent_interval_days ?? null,
				retired_at: null,
				created_at: at,
				updated_at: at
			};
			statements = [...statements, statement];
			return structuredClone(statement);
		},
		async update(id, input) {
			await wait();
			const current = statementOf(id);
			if (input.is_active && current.retired_at !== null) {
				throw new ConflictError('Retired statements cannot be reactivated', { error: 'conflict' });
			}
			for (const key of ['record_retention_days', 'reconsent_interval_days'] as const) {
				const value = input[key];
				if (value !== undefined && value !== null && (!Number.isInteger(value) || value < 0)) {
					throw invalid(`${key} must be >= 0`);
				}
			}
			if (Object.keys(input).length === 0) throw invalid('No fields to update');
			Object.assign(current, input, { updated_at: now() });
			return structuredClone(current);
		},
		async remove(id) {
			await wait();
			const current = statementOf(id);
			const own = versions.filter((item) => item.statement_id === id);
			if (own.every((item) => item.status === 'draft') && !current.is_active) {
				versions = versions.filter((item) => item.statement_id !== id);
				statements = statements.filter((item) => item.id !== id);
				return 'deleted';
			}
			current.is_active = false;
			current.retired_at = now();
			return 'retired';
		},
		async localizations(statementId, versionId) {
			await wait();
			versionOf(statementId, versionId);
			return structuredClone(texts[versionId] ?? []).sort((a, b) =>
				a.language.localeCompare(b.language)
			);
		},
		async createVersion(statementId, input) {
			await wait();
			statementOf(statementId);
			if (!validVersion(input.version)) {
				throw invalid('version must be YYYYMMDD format (8 digits, valid date)');
			}
			if (
				versions.some((item) => item.statement_id === statementId && item.version === input.version)
			) {
				throw new ConflictError('This version already exists for this statement', {
					error: 'conflict'
				});
			}
			const at = now();
			const version: ConsentVersion = {
				id: `ver_${++sequence}`,
				statement_id: statementId,
				version: input.version,
				content_type: input.content_type ?? 'inline',
				effective_at: input.effective_at,
				effective_until: input.effective_until ?? null,
				is_current: false,
				status: 'draft',
				created_at: at,
				updated_at: at
			};
			versions = [...versions, version];
			return structuredClone(version);
		},
		async updateVersion(statementId, versionId, input) {
			await wait();
			const version = versionOf(statementId, versionId);
			if (version.status !== 'draft') throw invalid('Only draft versions can be edited');
			if (input.version !== undefined && !validVersion(input.version)) {
				throw invalid('version must be YYYYMMDD format (8 digits, valid date)');
			}
			Object.assign(version, input, { updated_at: now() });
			return structuredClone(version);
		},
		async removeVersion(statementId, versionId) {
			await wait();
			const version = versionOf(statementId, versionId);
			if (version.status !== 'draft') throw invalid('Only draft versions can be deleted');
			versions = versions.filter((item) => item.id !== versionId);
			delete texts[versionId];
		},
		async activateVersion(statementId, versionId, activation = {}) {
			await wait();
			const statement = statementOf(statementId);
			const version = versionOf(statementId, versionId);
			if ((texts[versionId] ?? []).length === 0) {
				throw invalid('Cannot activate version without at least one localization');
			}
			const reconsent = activation.reconsent !== false;
			if (
				!reconsent &&
				statement.required_consent_version &&
				version.version < statement.required_consent_version
			) {
				throw invalid(
					'This version is older than the one agreement is required from; publish it asking people again (reconsent: true)'
				);
			}
			for (const other of versions) {
				if (other.statement_id === statementId && other.is_current) {
					other.is_current = false;
					other.status = 'archived';
				}
			}
			version.is_current = true;
			version.status = 'active';
			if (reconsent || !statement.required_consent_version) {
				statement.required_consent_version = version.version;
			}
			statement.updated_at = now();
			return structuredClone(version);
		},
		async saveLocalization(statementId, versionId, language, input) {
			await wait();
			draftOnly(versionOf(statementId, versionId));
			if (!input.title || !input.description) throw invalid('title and description are required');
			if (input.document_url && !/^https?:\/\//u.test(input.document_url)) {
				throw invalid('document_url must be an http(s) URL');
			}
			const saved: ConsentLocalization = {
				language,
				title: input.title,
				description: input.description,
				processing_purpose: input.processing_purpose ?? null,
				withdrawal_impact: input.withdrawal_impact ?? null,
				document_url: input.document_url ?? null,
				inline_content: input.inline_content ?? null
			};
			texts[versionId] = [
				...(texts[versionId] ?? []).filter((item) => item.language !== language),
				saved
			];
			return structuredClone(saved);
		},
		async removeLocalization(statementId, versionId, language) {
			await wait();
			draftOnly(versionOf(statementId, versionId));
			texts[versionId] = (texts[versionId] ?? []).filter((item) => item.language !== language);
		}
	};
}

const T0 = Date.UTC(2026, 0, 15);

const statement = (
	id: string,
	slug: string,
	category: string,
	extra: Partial<ConsentStatement> = {}
) =>
	({
		id,
		slug,
		category,
		legal_basis: 'consent',
		processing_purpose: null,
		display_order: 0,
		is_active: true,
		record_retention_days: null,
		withdrawal_allowed: true,
		withdrawal_impact: null,
		required_consent_version: null,
		reconsent_interval_days: null,
		retired_at: null,
		created_at: T0,
		updated_at: T0,
		...extra
	}) satisfies ConsentStatement;

const version = (
	id: string,
	statementId: string,
	number: string,
	status: ConsentVersion['status'],
	extra: Partial<ConsentVersion> = {}
) =>
	({
		id,
		statement_id: statementId,
		version: number,
		content_type: 'inline',
		effective_at: Date.UTC(+number.slice(0, 4), +number.slice(4, 6) - 1, +number.slice(6)),
		effective_until: null,
		is_current: status === 'active',
		status,
		created_at: T0,
		updated_at: T0,
		...extra
	}) satisfies ConsentVersion;

const text = (
	language: string,
	title: string,
	description: string,
	content: string
): ConsentLocalization => ({
	language,
	title,
	description,
	processing_purpose: null,
	withdrawal_impact: null,
	document_url: null,
	inline_content: content
});

/** Made-up statements for stories, tests and the console mock. */
export const MOCK_CONSENT_STATEMENTS: Required<
	Pick<FakeConsentStatementsOptions, 'statements' | 'versions' | 'localizations' | 'usages'>
> = {
	statements: [
		statement('stmt_terms', 'terms-of-service', 'terms_of_service', {
			required_consent_version: '20260401',
			withdrawal_allowed: false
		}),
		statement('stmt_privacy', 'privacy-policy', 'privacy_policy', {
			legal_basis: 'legitimate_interests',
			record_retention_days: 1825,
			reconsent_interval_days: 365,
			required_consent_version: '20260101'
		}),
		statement('stmt_marketing', 'marketing-mail', 'custom', {
			withdrawal_impact: 'You will no longer receive our newsletter.'
		}),
		statement('stmt_survey', 'research-survey', 'custom', { is_active: false })
	],
	versions: [
		version('ver_terms_2', 'stmt_terms', '20260401', 'active'),
		version('ver_terms_1', 'stmt_terms', '20260101', 'archived'),
		version('ver_terms_3', 'stmt_terms', '20261101', 'draft'),
		version('ver_privacy_1', 'stmt_privacy', '20260101', 'active', { content_type: 'url' }),
		version('ver_marketing_1', 'stmt_marketing', '20260301', 'draft'),
		version('ver_survey_1', 'stmt_survey', '20260201', 'active')
	],
	localizations: {
		ver_terms_2: [
			text('ja', '利用規約', 'サービスの利用条件です。', '第1条 本規約は…\n第2条 利用者は…'),
			text(
				'en',
				'Terms of service',
				'The conditions for using the service.',
				'Article 1. These terms…'
			)
		],
		ver_terms_1: [text('ja', '利用規約', 'サービスの利用条件です。', '第1条 旧版…')],
		ver_terms_3: [
			text('ja', '利用規約', 'サービスの利用条件です。', '第1条 本規約は…（改定案）'),
			text('en', 'Terms of service', 'The conditions for using the service.', 'Article 1. Revised…')
		],
		ver_privacy_1: [
			{
				...text('en', 'Privacy policy', 'How we handle personal data.', ''),
				inline_content: null,
				document_url: 'https://example.com/privacy'
			}
		],
		ver_marketing_1: [
			text('en', 'Marketing mail', 'Product news by email.', 'We send news about once a month.')
		],
		ver_survey_1: [
			text('ja', 'アンケートへの協力', '調査への協力のお願いです。', '調査にご協力ください。')
		]
	},
	usages: {
		stmt_terms: {
			flows: [
				{
					flow_id: 'flow_signup',
					name: 'Sign-up',
					kind: 'registration',
					draft: true,
					published: true
				}
			],
			services: [
				{ protocol: 'oidc', id: 'client_portal', name: 'Customer portal' },
				{ protocol: 'saml', id: 'sp_lms', name: 'Learning system' }
			]
		},
		stmt_privacy: {
			flows: [
				{
					flow_id: 'flow_signup',
					name: 'Sign-up',
					kind: 'registration',
					draft: false,
					published: true
				}
			],
			services: []
		}
	}
};
