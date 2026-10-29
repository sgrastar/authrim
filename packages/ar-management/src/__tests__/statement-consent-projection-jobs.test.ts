import { afterEach, describe, expect, it } from 'vitest';
import {
  enqueueStatementConsentProjection,
  projectStatementConsentGeneration,
} from '@authrim/ar-lib-core';
import { openCoreStore } from './helpers/core-schema-sqlite';
import { projectStatementConsentJobPage } from '../statement-consent-projection-jobs';

const opened: ReturnType<typeof openCoreStore>[] = [];
afterEach(() => {
  for (const store of opened.splice(0)) store.db.close();
});
function core() {
  const store = openCoreStore('tenant-a');
  const fixture = { ...store, adapter: { ...store.adapter, getType: () => 'd1' } };
  opened.push(fixture);
  return fixture;
}
async function setup() {
  const metadata = core();
  const first = core();
  const second = core();
  const outsider = core();
  await metadata.adapter.execute(
    "INSERT INTO consent_statements(id,tenant_id,slug,definition_generation,closed_generation,created_at,updated_at) VALUES('terms','tenant-a','terms',1,0,1,1)"
  );
  const enqueue = enqueueStatementConsentProjection('tenant-a', 'terms', Date.now());
  await metadata.adapter.execute(enqueue.sql, enqueue.params);
  return {
    metadata,
    first,
    second,
    outsider,
    stores: [
      { bindingRef: 'a', adapter: first.adapter },
      { bindingRef: 'b', adapter: second.adapter },
    ],
  };
}
const guard = (store: ReturnType<typeof core>) =>
  store.adapter.queryOne(
    "SELECT definition_generation,closed_generation,mode FROM statement_consent_guards WHERE tenant_id='tenant-a' AND scope_kind='statement'"
  );

describe('durable statement consent generation fan-out (real SQLite databases)', () => {
  it('acknowledges a bounded page, resumes, and never writes unrelated stores', async () => {
    const f = await setup();
    await projectStatementConsentJobPage(f.metadata.adapter, 'tenant-a', f.stores, 1);
    expect(await guard(f.first)).toMatchObject({ definition_generation: 1 });
    expect(await guard(f.second)).toBeNull();
    expect(
      await f.metadata.adapter.queryOne(
        'SELECT cursor_binding_ref FROM statement_consent_projection_jobs'
      )
    ).toEqual({ cursor_binding_ref: 'a' });
    await projectStatementConsentJobPage(f.metadata.adapter, 'tenant-a', f.stores, 1);
    expect(await guard(f.second)).toMatchObject({ definition_generation: 1 });
    expect(
      await f.metadata.adapter.query('SELECT * FROM statement_consent_projection_jobs')
    ).toEqual([]);
    expect(await guard(f.outsider)).toBeNull();
  });
  it('keeps failed shard work durable and retries it without moving generations backwards', async () => {
    const f = await setup();
    f.second.db.exec(
      "CREATE TRIGGER injected_projection_failure BEFORE INSERT ON statement_consent_guards BEGIN SELECT RAISE(ABORT, 'projection_failure'); END;"
    );
    await expect(
      projectStatementConsentJobPage(f.metadata.adapter, 'tenant-a', f.stores, 2)
    ).rejects.toThrow('projection_failure');
    expect(
      await f.metadata.adapter.queryOne(
        'SELECT cursor_binding_ref FROM statement_consent_projection_jobs'
      )
    ).toEqual({ cursor_binding_ref: 'a' });
    f.second.db.exec('DROP TRIGGER injected_projection_failure');
    await projectStatementConsentJobPage(f.metadata.adapter, 'tenant-a', f.stores, 2);
    await projectStatementConsentGeneration(f.first.adapter, 'tenant-a', {
      statement_id: 'terms',
      definition_generation: 2,
      closed_generation: 1,
      mode: 'closed',
    });
    await projectStatementConsentGeneration(f.first.adapter, 'tenant-a', {
      statement_id: 'terms',
      definition_generation: 1,
      closed_generation: 0,
      mode: 'enforced',
    });
    expect(await guard(f.first)).toEqual({
      definition_generation: 2,
      closed_generation: 1,
      mode: 'closed',
    });
  });
  it('keeps a newer generation queued when an older worker is acknowledging a shard', async () => {
    const f = await setup();
    const execute = f.first.adapter.execute.bind(f.first.adapter);
    let bump = true;
    const racing = {
      ...f.first.adapter,
      execute: async (...args: Parameters<typeof execute>) => {
        const result = await execute(...args);
        if (bump && args[0].includes("VALUES(?,'statement'")) {
          bump = false;
          await f.metadata.adapter.execute(
            "UPDATE consent_statements SET definition_generation=2 WHERE tenant_id='tenant-a' AND id='terms'"
          );
          const next = enqueueStatementConsentProjection('tenant-a', 'terms', Date.now());
          await f.metadata.adapter.execute(next.sql, next.params);
        }
        return result;
      },
    };
    await projectStatementConsentJobPage(
      f.metadata.adapter,
      'tenant-a',
      [{ bindingRef: 'a', adapter: racing }, f.stores[1]],
      2
    );
    expect(
      await f.metadata.adapter.queryOne(
        'SELECT definition_generation,cursor_binding_ref FROM statement_consent_projection_jobs'
      )
    ).toEqual({ definition_generation: 2, cursor_binding_ref: null });
    await projectStatementConsentJobPage(f.metadata.adapter, 'tenant-a', f.stores, 2);
    expect(await guard(f.first)).toMatchObject({ definition_generation: 2 });
    expect(await guard(f.second)).toMatchObject({ definition_generation: 2 });
  });
});
