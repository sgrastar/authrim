/**
 * The first version of each default consent statement (`default-consent-statements.ts`), kept
 * apart with no imports so the backup and restore code can name it without the seeding code.
 */
/** The first version's label (YYYYMMDD), the same for every tenant. */
export const DEFAULT_CONSENT_STATEMENT_VERSION = '20261118';

/**
 * The content hash of each default statement's first version (`computeContentHash`): a link
 * version with no link, no purpose and no withdrawal note in each language. The same for both.
 */
export const DEFAULT_CONSENT_STATEMENT_CONTENT_HASH =
  '93b2806611c768398c2970d31ad962c2abfe4659dcfe24be428e0a2edd705741';
