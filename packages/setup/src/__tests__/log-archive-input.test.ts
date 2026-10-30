import * as input from '../web/log-archive-input.js';
import { resolveLogArchiveTokenInput } from '../core/log-archive-token-issuance.js';
import { describe, expect, it } from 'vitest';
import {
  logArchiveInputError,
  logArchiveErrorMessage,
  LOG_ARCHIVE_ERROR_MESSAGES,
} from '../web/log-archive-input.js';
describe('log archive input UX', () => {
  it('validates mode, missing manual fields, pipeline sink and duplicate values', () => {
    expect(logArchiveInputError({ mode: '' })).toBe('log_archive_mode_required');
    expect(logArchiveInputError({ mode: 'scheduled' })).toBe(
      'log_archive_catalog_credentials_required'
    );
    expect(logArchiveInputError({ mode: 'pipeline', readToken: 'a', writeToken: 'b' })).toBe(
      'log_archive_sink_credential_required'
    );
    expect(
      logArchiveInputError({ mode: 'pipeline', readToken: ' a ', writeToken: 'b', sinkToken: 'a' })
    ).toBe('log_archive_distinct_catalog_credentials_required');
    expect(logArchiveInputError({ mode: 'scheduled', readToken: 'a', writeToken: 'b' })).toBeNull();
  });
  it('provides Japanese and English readable messages and an unknown-code fallback', () => {
    for (const code of Object.keys(LOG_ARCHIVE_ERROR_MESSAGES)) {
      expect(logArchiveErrorMessage(code, 'ja')).not.toBe(code);
      expect(logArchiveErrorMessage(code, 'en')).not.toBe(code);
    }
    expect(logArchiveErrorMessage('log_archive_future_error', 'en')).toContain(
      'log_archive_future_error'
    );
    expect(logArchiveErrorMessage('log_archive_catalog_credentials_required', 'ja')).toContain(
      'トークン'
    );
  });
  it('includes revocation guidance when an issuance precondition leaves the bootstrap unused', () => {
    expect(logArchiveErrorMessage('log_archive_environment_config_required', 'ja', true)).toContain(
      '失効'
    );
    expect(logArchiveErrorMessage('log_archive_environment_config_required', 'en', true)).toContain(
      'revocation'
    );
  });
  it('offers staged reuse after reload only for a complete matching account and mode', () => {
    const ready = {
      complete: true,
      mode: 'scheduled' as const,
      accountMatches: true,
      pendingRecovery: false,
    };
    expect(input.logArchiveStagedChoice(ready, 'scheduled')).toEqual({
      useStaged: true,
      messageCode: 'log_archive_staged_tokens_ready',
    });
    expect(input.logArchiveStagedChoice({ ...ready, accountMatches: false }, 'scheduled')).toEqual({
      useStaged: false,
      messageCode: 'log_archive_staged_account_mismatch',
    });
    expect(input.logArchiveStagedChoice(ready, 'pipeline')).toEqual({
      useStaged: false,
      messageCode: 'log_archive_staged_mode_mismatch',
    });
    expect(input.logArchiveStagedChoice(null, 'scheduled').useStaged).toBe(false);
    expect(
      input.logArchiveStagedChoice(
        { ...ready, pendingRecovery: true, complete: false },
        'scheduled'
      )
    ).toEqual({ useStaged: false, messageCode: 'log_archive_pending_recovery_required' });
    expect(input.logArchiveStagedChoice({ ...ready, pendingRecovery: true }, 'scheduled')).toEqual({
      useStaged: true,
      messageCode: 'log_archive_local_cleanup_pending',
    });
  });
  it.each(['ja', 'en'])(
    'translates CLI source-resolution and asynchronous issuance failures (%s)',
    async (locale) => {
      const sentinel = 'SENTINEL_CLI_SECRET';
      let conflict: unknown;
      try {
        input.withLogArchiveCliErrors(locale, () =>
          resolveLogArchiveTokenInput({
            LOG_ARCHIVE_BOOTSTRAP_TOKEN: sentinel,
            LOG_ARCHIVE_CATALOG_READ_TOKEN: sentinel,
          })
        );
      } catch (error) {
        conflict = error;
      }
      expect(conflict).toBeInstanceOf(Error);
      expect((conflict as Error).message).toBe(
        logArchiveErrorMessage('log_archive_token_sources_conflict', locale)
      );
      for (const guidance of [{ cleanupRequired: true }, { childCleanupRequired: true }]) {
        const error = await input
          .withLogArchiveCliErrors(locale, async () => {
            throw Object.assign(new Error(sentinel), {
              code: 'log_archive_token_issuance_failed',
              ...guidance,
            });
          })
          .catch((error: unknown) => error);
        expect((error as Error).message).toBe(
          logArchiveErrorMessage('log_archive_token_issuance_failed', locale, true)
        );
        expect(String(error)).not.toContain(sentinel);
      }
      const unknown = await input
        .withLogArchiveCliErrors(locale, async () => {
          throw new Error(sentinel);
        })
        .catch((error: unknown) => error);
      expect((unknown as Error).message).toBe(
        logArchiveErrorMessage('log_archive_token_issuance_failed', locale)
      );
    }
  );
});
