import type { Pool, PoolClient } from 'pg';
import { canonicalRestoreJson } from '../import/restore-evidence';

export interface ReplicationJournalRecord<T> {
  operationId: string;
  planSha256: string;
  revision: number;
  value: T;
}

const ignoreClientError = (): void => undefined;

/** How long a closing session may spend giving back its advisory lock before it is discarded anyway. */
const ADVISORY_UNLOCK_TIMEOUT_MS = 2_000;

/** Durable operation checkpoints, independently of whether the operator's setup window is open. */
export class ReplicationJournal {
  private readonly table: string;
  constructor(
    private readonly pool: Pick<Pool, 'connect'>,
    private readonly scope: 'tenant' | 'environment' = 'tenant'
  ) {
    if (scope !== 'tenant' && scope !== 'environment')
      throw new Error('replication_journal_invalid');
    this.table =
      scope === 'environment'
        ? 'authrim_replication_environment_journal'
        : 'authrim_replication_journal';
  }

  async withOperation<T, Result>(input: {
    pairId: string;
    operationId: string;
    planSha256: string;
    initial: T;
    run(
      this: void,
      journal: {
        current(): ReplicationJournalRecord<T>;
        save(value: T): Promise<ReplicationJournalRecord<T>>;
      }
    ): Promise<Result>;
  }): Promise<Result> {
    const pinned = {
      pairId: input.pairId,
      operationId: input.operationId,
      planSha256: input.planSha256,
      initial: structuredClone(input.initial),
      run: input.run,
    };
    input = pinned;
    const table = this.table;
    if (
      !/^[A-Za-z0-9_.:-]{1,128}$/u.test(input.pairId) ||
      !/^[A-Za-z0-9_.:-]{1,128}$/u.test(input.operationId) ||
      !/^[a-f0-9]{64}$/u.test(input.planSha256)
    )
      throw new Error('replication_journal_invalid');
    const lockKey =
      this.scope === 'environment'
        ? `authrim:replication:environment:${input.pairId}`
        : `authrim:replication:${input.pairId}`;
    let client: PoolClient | undefined;
    let lockHeld = false;
    let active = true;
    try {
      client = await this.pool.connect();
      // The pool detaches its own error listener while a client is checked out, and an
      // unhandled 'error' event would end the process. A failure still reaches the pending
      // query as a rejection; the session is discarded in `finally`.
      client.on('error', ignoreClientError);
      const locked = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',
        [lockKey]
      );
      if (locked.rows[0]?.acquired !== true) throw new Error('replication_operation_busy');
      lockHeld = true;
      await client.query(
        `INSERT INTO ${table} (operation_id,pair_id,plan_sha256,revision,value_json)
         VALUES ($1,$2,$3,1,$4) ON CONFLICT (operation_id) DO NOTHING`,
        [input.operationId, input.pairId, input.planSha256, canonicalRestoreJson(input.initial)]
      );
      const stored = await client.query<{
        pair_id: string;
        plan_sha256: string;
        revision: string;
        value_json: string;
      }>(`SELECT pair_id,plan_sha256,revision,value_json FROM ${table} WHERE operation_id=$1`, [
        input.operationId,
      ]);
      const row = stored.rows[0];
      if (
        stored.rows.length !== 1 ||
        row.pair_id !== input.pairId ||
        row.plan_sha256 !== input.planSha256 ||
        !Number.isSafeInteger(Number(row.revision)) ||
        Number(row.revision) < 1
      )
        throw new Error('replication_plan_conflict');
      let current: ReplicationJournalRecord<T> = {
        operationId: input.operationId,
        planSha256: input.planSha256,
        revision: Number(row.revision),
        value: JSON.parse(row.value_json) as T,
      };
      const owner = client;
      return await input.run({
        current: () => structuredClone(current),
        async save(value) {
          if (!active) throw new Error('replication_journal_closed');
          // A lost physical session loses its advisory lock and can never publish through a new
          // connection. An interrupted restore resumes into a new generation, not these targets.
          const next = current.revision + 1;
          if (!Number.isSafeInteger(next)) throw new Error('replication_journal_invalid');
          const result = await owner.query<{ revision: string }>(
            `UPDATE ${table} SET revision=$4,value_json=$5,updated_at=clock_timestamp()
             WHERE operation_id=$1 AND pair_id=$2 AND plan_sha256=$3 AND revision=$6 RETURNING revision`,
            [
              input.operationId,
              input.pairId,
              input.planSha256,
              next,
              canonicalRestoreJson(value),
              current.revision,
            ]
          );
          if (result.rows.length !== 1 || Number(result.rows[0].revision) !== next)
            throw new Error('replication_journal_conflict');
          current = { ...current, revision: next, value: structuredClone(value) };
          return structuredClone(current);
        },
      });
    } finally {
      active = false;
      // Give the lock back on the live session first. Destroying a session only closes its
      // socket; the server releases the session's advisory lock when it notices that, which can
      // lag behind a retry on a new session (replication_operation_busy). A broken or slow
      // session just falls through to being destroyed, and its lock goes with it.
      if (client && lockHeld) await releaseAdvisoryLock(client, lockKey);
      // Always discard the dedicated session: outstanding session advisory locks cannot leak
      // into the pool, including after an unknown protocol/commit result.
      client?.release(true);
    }
  }
}

async function releaseAdvisoryLock(client: PoolClient, key: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ADVISORY_UNLOCK_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // The session is unusable; destroying it releases the lock.
  } finally {
    clearTimeout(timer);
  }
}
