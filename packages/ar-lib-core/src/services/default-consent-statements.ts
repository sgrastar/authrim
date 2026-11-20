/**
 * The consent statements every tenant starts with: a terms of service and a privacy policy, each
 * published (its first version) in the languages the admin console writes statements in, with the
 * earlier admin UI's agreement sentence as its description. Their document link is left empty for
 * the admin to give; the description is HTML the admin may change as they like.
 *
 * A new tenant gets them when it is seeded (`seedDefaultConsentStatements`); tenants that existed
 * before got the same rows once from core migration 013 (`013_default_consent_statements.sql`),
 * whose content hash is `DEFAULT_CONSENT_STATEMENT_CONTENT_HASH` (its ids are made from the
 * tenant's id there, once; here they are random). A tenant that already has a
 * statement of the same kind or key is given none of that kind, and one the admin deletes is not
 * made again.
 */
import type { DatabaseAdapter } from '../db/adapter';
import { activateVersion } from '../utils/consent-statements';
import { DEFAULT_CONSENT_STATEMENT_VERSION } from './default-consent-statement-version';

export type DefaultConsentStatementKind = 'terms' | 'privacy';

export interface DefaultConsentStatement {
  kind: DefaultConsentStatementKind;
  slug: string;
  category: string;
  /** Title and description by language. */
  texts: Readonly<Record<string, { title: string; description: string }>>;
}

/** The languages, as the admin console writes them. */
export const DEFAULT_CONSENT_STATEMENT_LANGUAGES = ['ar', 'de', 'en', 'ja'] as const;

export const DEFAULT_CONSENT_STATEMENTS: readonly DefaultConsentStatement[] = [
  {
    kind: 'terms',
    slug: 'terms-of-service',
    category: 'terms_of_service',
    texts: {
      ja: { title: '利用規約', description: '利用規約を読み、その内容に同意します。' },
      en: {
        title: 'Terms of Service',
        description: 'I have read and agree to the Terms of Service.',
      },
      de: {
        title: 'Nutzungsbedingungen',
        description: 'Ich habe die Nutzungsbedingungen gelesen und stimme ihnen zu.',
      },
      ar: { title: 'شروط الخدمة', description: 'لقد قرأت شروط الخدمة وأوافق عليها.' },
    },
  },
  {
    kind: 'privacy',
    slug: 'privacy-policy',
    category: 'privacy_policy',
    texts: {
      ja: {
        title: 'プライバシーポリシー',
        description: 'プライバシーポリシーを読み、その内容に同意します。',
      },
      en: { title: 'Privacy Policy', description: 'I have read and agree to the Privacy Policy.' },
      de: {
        title: 'Datenschutzerklärung',
        description: 'Ich habe die Datenschutzerklärung gelesen und stimme ihr zu.',
      },
      ar: {
        title: 'سياسة الخصوصية',
        description: 'لقد قرأت سياسة الخصوصية وأوافق عليها.',
      },
    },
  },
];

export {
  DEFAULT_CONSENT_STATEMENT_CONTENT_HASH,
  DEFAULT_CONSENT_STATEMENT_VERSION,
} from './default-consent-statement-version';

const OWN_ID_PREFIX = 'cst_default_';

/**
 * A default statement's ids. The statement's is new for each tenant (not made from the tenant's
 * id: a renamed initial tenant keeps its rows' ids, and a tenant made later with its old name
 * must not take them); its version's and texts' follow from it.
 */
function idsOf(statementId: string) {
  const suffix = statementId.slice('cst_'.length);
  return {
    statementId,
    versionId: `csv_${suffix}`,
    localizationId: (language: string) => `csl_${suffix}_${language}`,
  };
}

/**
 * Give a tenant the default statements it does not have yet, published. Safe to run again (a
 * seed that stopped part way is finished), and never adds one of a kind or key the tenant has.
 */
export async function seedDefaultConsentStatements(
  adapter: DatabaseAdapter,
  tenantId: string,
  now: number = Date.now()
): Promise<void> {
  for (const preset of DEFAULT_CONSENT_STATEMENTS) {
    // One this seed (or another run of it) began and did not finish is finished; otherwise a
    // new one is begun. A run that lost the race to begin it carries on with the one that won.
    const begun = () =>
      adapter.queryOne<{ id: string }>(
        `SELECT id FROM consent_statements
          WHERE tenant_id = ? AND slug = ? AND substr(id, 1, ${OWN_ID_PREFIX.length}) = ?`,
        [tenantId, preset.slug, OWN_ID_PREFIX]
      );
    let ids = idsOf((await begun())?.id ?? `${OWN_ID_PREFIX}${preset.kind}_${crypto.randomUUID()}`);
    await writeDraft(adapter, tenantId, preset, ids, now);
    const owner = await begun();
    if (!owner) continue; // The tenant has one of its own of this kind or key.
    if (owner.id !== ids.statementId) {
      ids = idsOf(owner.id);
      await writeDraft(adapter, tenantId, preset, ids, now);
    }
    // Published as any first version is: nobody has agreed to an earlier one.
    const status = async () =>
      (
        await adapter.queryOne<{ status: string }>(
          `SELECT status FROM consent_statement_versions WHERE tenant_id = ? AND id = ?`,
          [tenantId, ids.versionId]
        )
      )?.status;
    if ((await status()) !== 'draft') continue;
    try {
      await activateVersion(adapter, tenantId, ids.statementId, ids.versionId, { onlyDraft: true });
    } catch (error) {
      // Another run published it meanwhile.
      if ((await status()) !== 'active') throw error;
    }
  }
}

/** The statement, its first version (a draft) and its texts, each only where it is missing. */
function writeDraft(
  adapter: DatabaseAdapter,
  tenantId: string,
  preset: DefaultConsentStatement,
  { statementId, versionId, localizationId }: ReturnType<typeof idsOf>,
  now: number
) {
  return adapter.batch([
    {
      sql: `INSERT INTO consent_statements
					(id, tenant_id, slug, category, legal_basis, display_order, is_active, withdrawal_allowed,
					 created_at, updated_at)
				SELECT ?, ?, ?, ?, 'consent', 0, 1, 1, ?, ?
				WHERE NOT EXISTS (
					SELECT 1 FROM consent_statements
					 WHERE tenant_id = ? AND (id = ? OR slug = ? OR category = ?)
				)`,
      params: [
        statementId,
        tenantId,
        preset.slug,
        preset.category,
        now,
        now,
        tenantId,
        statementId,
        preset.slug,
        preset.category,
      ],
    },
    {
      sql: `INSERT INTO consent_statement_versions
					(id, tenant_id, statement_id, version, content_type, effective_at, is_current, status,
					 created_at, updated_at)
				SELECT ?, ?, ?, ?, 'url', ?, 0, 'draft', ?, ?
				WHERE EXISTS (SELECT 1 FROM consent_statements WHERE tenant_id = ? AND id = ?)
				  AND NOT EXISTS (SELECT 1 FROM consent_statement_versions WHERE tenant_id = ? AND statement_id = ?)`,
      params: [
        versionId,
        tenantId,
        statementId,
        DEFAULT_CONSENT_STATEMENT_VERSION,
        now,
        now,
        now,
        tenantId,
        statementId,
        tenantId,
        statementId,
      ],
    },
    ...DEFAULT_CONSENT_STATEMENT_LANGUAGES.map((language) => ({
      sql: `INSERT INTO consent_statement_localizations
					(id, tenant_id, version_id, language, title, description, created_at, updated_at)
				SELECT ?, ?, ?, ?, ?, ?, ?, ?
				WHERE EXISTS (
					SELECT 1 FROM consent_statement_versions
					 WHERE tenant_id = ? AND id = ? AND status = 'draft'
				)
				  AND NOT EXISTS (
					SELECT 1 FROM consent_statement_localizations WHERE version_id = ? AND language = ?
				)`,
      params: [
        localizationId(language),
        tenantId,
        versionId,
        language,
        preset.texts[language].title,
        preset.texts[language].description,
        now,
        now,
        tenantId,
        versionId,
        versionId,
        language,
      ],
    })),
  ]);
}
