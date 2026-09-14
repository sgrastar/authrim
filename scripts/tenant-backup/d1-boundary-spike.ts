import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitMigrationSql } from '../../packages/ar-lib-core/src/services/control-plane/migration-sql.js';
import { TENANT_BACKUP_BEGIN_BUDGET_MS } from '../../packages/ar-lib-core/src/services/tenant-portability/module-contract.js';
import { sqliteSnapshotStartStatement } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-capture-plan.js';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotPageQuery,
  sqliteSnapshotTriggers,
} from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-snapshot.js';

// Local feasibility fixture, not a production coordinator. Only the explicitly admitted fixture
// writers participate. Production writer coverage, authentication, fencing at every source write,
// recovery, inventory pinning and bounded admission cost remain Phase 0/2 requirements.
const schema = {
  table: 'fixture_users',
  tenantColumn: 'tenant_id',
  columns: ['tenant_id', 'id', 'revision'],
  primaryKey: ['tenant_id', 'id'],
  uniqueKeys: [],
};
const controlDdl = `
  CREATE TABLE IF NOT EXISTS clock(id TEXT PRIMARY KEY NOT NULL, now INTEGER NOT NULL,
    wall_clock INTEGER NOT NULL DEFAULT 0);
  INSERT OR IGNORE INTO clock(id,now) VALUES('clock',0);
  CREATE TABLE IF NOT EXISTS active_writers(id TEXT PRIMARY KEY NOT NULL);
  CREATE TABLE IF NOT EXISTS boundary(id TEXT PRIMARY KEY NOT NULL, phase TEXT NOT NULL,
    deadline INTEGER NOT NULL, core_ready INTEGER NOT NULL DEFAULT 0, pii_ready INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS canonical(id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
  INSERT OR IGNORE INTO canonical VALUES('settings','v0');
  CREATE TABLE IF NOT EXISTS published(id TEXT PRIMARY KEY NOT NULL, canonical_value TEXT NOT NULL);
`;
const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler/package.json'))(
  'miniflare'
) as typeof import('miniflare');
const script = `
import { DurableObject } from 'cloudflare:workers';
export class Boundary extends DurableObject {
  constructor(ctx,env) { super(ctx,env); this.ctx.storage.sql.exec(${JSON.stringify(controlDdl)}); }
  now() { const clock=this.ctx.storage.sql.exec("SELECT * FROM clock").one(); return clock.wall_clock ? Date.now() : clock.now; }
  useWallClock(enabled) { this.ctx.storage.sql.exec("UPDATE clock SET wall_clock=?",enabled?1:0); return this.now(); }
  advanceClock(ms) { this.ctx.storage.sql.exec("UPDATE clock SET now=now+?",ms); return this.now(); }
  active() { return this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM active_writers").one().n; }
  gate() {
    this.ctx.storage.sql.exec("UPDATE boundary SET phase='aborted' WHERE phase IN ('draining','preparing') AND deadline <= ?",this.now());
    return this.ctx.storage.sql.exec("SELECT * FROM boundary WHERE phase IN ('draining','preparing')").toArray()[0];
  }
  admit(id) {
    if(this.gate()) return {accepted:false,reason:'boundary_begin_in_progress'};
    this.ctx.storage.sql.exec("INSERT INTO active_writers VALUES(?)",id);
    return {accepted:true};
  }
  finish(id) {
    const removed=this.ctx.storage.sql.exec("DELETE FROM active_writers WHERE id=? RETURNING id",id).toArray();
    if(removed.length!==1) throw Error('writer_not_active');
    return {finished:true};
  }
  setCanonical(writerId,value) {
    if(!this.ctx.storage.sql.exec("SELECT id FROM active_writers WHERE id=?",writerId).toArray().length) throw Error('writer_not_active');
    this.ctx.storage.sql.exec("UPDATE canonical SET value=? WHERE id='settings'",value);
    return {stored:true};
  }
  begin(id,budget) {
    if(this.gate()) return {accepted:false,reason:'another_boundary'};
    this.ctx.storage.sql.exec("INSERT INTO boundary(id,phase,deadline) VALUES(?,'draining',?)",id,this.now()+budget);
    return {accepted:true,active:this.active()};
  }
  async prepare(id,participant,sql,params,advanceAfterActivation=0) {
    const gate=this.gate();
    if(!gate || gate.id!==id) return {prepared:false,reason:'boundary_inactive'};
    if(this.active()) return {prepared:false,reason:'writers_not_drained'};
    if(participant!=='CORE' && participant!=='PII') throw Error('unknown_participant');
    const column=participant==='CORE'?'core_ready':'pii_ready';
    if(gate[column]) return {prepared:true,reused:true};
    this.ctx.storage.sql.exec("UPDATE boundary SET phase='preparing' WHERE id=?",id);
    // No blockConcurrencyWhile around remote I/O. The durable gate excludes new writers;
    // the post-I/O check prevents a timed-out or superseded boundary from publishing.
    const result=await this.env[participant].prepare(sql).bind(...params).run();
    if(result.meta.changes!==1) {
      this.ctx.storage.sql.exec("UPDATE boundary SET phase='aborted' WHERE id=? AND phase='preparing'",id);
      return {prepared:false,reason:'participant_not_ready'};
    }
    if(advanceAfterActivation) this.advanceClock(advanceAfterActivation);
    const current=this.gate();
    if(!current || current.id!==id) return {prepared:false,reason:'boundary_expired_during_prepare'};
    this.ctx.storage.sql.exec('UPDATE boundary SET '+column+'=1 WHERE id=?',id);
    return {prepared:true};
  }
  async publish(id) {
    let gate=this.gate();
    if(!gate || gate.id!==id || this.active() || !gate.core_ready || !gate.pii_ready) return {published:false};
    for(const participant of ['CORE','PII']) {
      const protectedId=await this.env[participant].prepare("SELECT id FROM tenant_backup_snapshots WHERE id=? AND tenant_id='a' AND state='capturing'").bind(id).first('id');
      if(protectedId!==id) {
        this.ctx.storage.sql.exec("UPDATE boundary SET phase='aborted' WHERE id=? AND phase='preparing'",id);
        return {published:false,reason:'participant_protection_lost'};
      }
    }
    gate=this.gate();
    if(!gate || gate.id!==id || this.active() || !gate.core_ready || !gate.pii_ready) return {published:false};
    this.ctx.storage.transactionSync(()=>{
      this.ctx.storage.sql.exec("INSERT INTO published SELECT ?,value FROM canonical WHERE id='settings'",id);
      this.ctx.storage.sql.exec("UPDATE boundary SET phase='published' WHERE id=?",id);
    });
    return {published:true};
  }
  readSnapshot(id) {
    return this.ctx.storage.sql.exec("SELECT * FROM published WHERE id=?",id).toArray()[0]??null;
  }
  state(id) { return this.ctx.storage.sql.exec("SELECT * FROM boundary WHERE id=?",id).toArray()[0]??null; }
}
export default { async fetch(request,env) {
  const {method,args}=await request.json();
  if(!['admit','finish','setCanonical','begin','prepare','publish','advanceClock','useWallClock','readSnapshot','state'].includes(method)) return new Response('unknown', {status:400});
  const stub=env.BOUNDARY.getByName('fixture-tenant-a');
  return Response.json(await stub[method](...args));
}};
`;
const persistence = mkdtempSync(join(tmpdir(), 'authrim-backup-boundary-'));
const makeRuntime = () =>
  new Miniflare({
    modules: true,
    script,
    host: '127.0.0.1',
    compatibilityDate: '2026-07-08',
    d1Databases: ['CORE', 'PII'],
    kvNamespaces: ['KV_PROJECTION'],
    durableObjects: { BOUNDARY: { className: 'Boundary', useSQLite: true } },
    d1Persist: join(persistence, 'd1'),
    durableObjectsPersist: join(persistence, 'do'),
    kvPersist: join(persistence, 'kv'),
  });
let runtime = makeRuntime();
try {
  let core = await runtime.getD1Database('CORE');
  let pii = await runtime.getD1Database('PII');
  let kv = await runtime.getKVNamespace('KV_PROJECTION');
  async function restart(): Promise<void> {
    await runtime.dispose();
    runtime = makeRuntime();
    core = await runtime.getD1Database('CORE');
    pii = await runtime.getD1Database('PII');
    kv = await runtime.getKVNamespace('KV_PROJECTION');
  }
  for (const db of [core, pii]) {
    await db.batch(
      splitMigrationSql(`CREATE TABLE fixture_users (
      tenant_id TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(tenant_id,id));
      CREATE TABLE service_group_write_boundaries(id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,operation TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL);
      ${SQLITE_SNAPSHOT_SCHEMA} ${sqliteSnapshotTriggers(schema)}
      INSERT INTO fixture_users VALUES('a','user',0);`).map((sql) => db.prepare(sql))
    );
  }
  async function rpc(method: string, ...args: unknown[]): Promise<Record<string, unknown> | null> {
    const response = await runtime.dispatchFetch('http://fixture.local/', {
      method: 'POST',
      body: JSON.stringify({ method, args }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as Record<string, unknown> | null;
  }
  async function prepare(id: string, participant: string, advanceAfterActivation = 0) {
    const start = sqliteSnapshotStartStatement([schema], id, 'a');
    // A trusted participant condition belongs in the same atomic activation statement. A
    // prior read with no active RPCs does not prove that old failed business writes were repaired.
    start.sql += ` AND NOT EXISTS (SELECT 1 FROM service_group_write_boundaries
      WHERE tenant_id=snapshot.tenant_id)`;
    return rpc('prepare', id, participant, start.sql, start.params, advanceAfterActivation);
  }
  async function revision(db: typeof core, id: string): Promise<number> {
    const rows = await db
      .prepare(sqliteSnapshotPageQuery(schema))
      .bind(id, 'a', '', 100)
      .all<{ row_json: string }>();
    assert.equal(rows.results.length, 1);
    return Number(
      (JSON.parse(rows.results[0].row_json) as { revision: [string, string] }).revision[1]
    );
  }

  // Demonstrate why two successful D1 snapshots are not sufficient evidence on their own.
  const unsafeCore = sqliteSnapshotStartStatement([schema], 'unsafe', 'a');
  await core
    .prepare(unsafeCore.sql)
    .bind(...unsafeCore.params)
    .run();
  await core.prepare('UPDATE fixture_users SET revision=1').run();
  await pii.prepare('UPDATE fixture_users SET revision=1').run();
  const unsafePii = sqliteSnapshotStartStatement([schema], 'unsafe', 'a');
  await pii
    .prepare(unsafePii.sql)
    .bind(...unsafePii.params)
    .run();
  assert.deepEqual([await revision(core, 'unsafe'), await revision(pii, 'unsafe')], [0, 1]);

  assert.equal((await rpc('admit', 'existing'))?.accepted, true);
  await core.prepare('UPDATE fixture_users SET revision=2').run();
  assert.equal((await rpc('begin', 'safe', 100))?.active, 1);
  await restart();
  assert.equal((await prepare('safe', 'CORE'))?.reason, 'writers_not_drained');
  assert.equal((await rpc('admit', 'new-during-begin'))?.accepted, false);
  await pii.prepare('UPDATE fixture_users SET revision=2').run();
  await rpc('setCanonical', 'existing', 'v2');
  await rpc('finish', 'existing');
  // A deliberately stale KV projection cannot override the strongly consistent canonical state.
  await kv.put('settings', 'stale-v0');
  assert.equal((await prepare('safe', 'CORE'))?.prepared, true);
  assert.equal((await rpc('publish', 'safe'))?.published, false, 'one receipt is insufficient');
  assert.equal((await prepare('safe', 'PII'))?.prepared, true);
  assert.equal((await rpc('publish', 'safe'))?.published, true);
  assert.equal((await rpc('admit', 'after-begin'))?.accepted, true);
  await core.prepare('UPDATE fixture_users SET revision=3').run();
  await pii.prepare('UPDATE fixture_users SET revision=3').run();
  await rpc('setCanonical', 'after-begin', 'v3');
  await rpc('finish', 'after-begin');
  assert.deepEqual([await revision(core, 'safe'), await revision(pii, 'safe')], [2, 2]);
  assert.equal((await rpc('readSnapshot', 'safe'))?.canonical_value, 'v2');
  assert.equal(await kv.get('settings'), 'stale-v0');
  await restart();
  assert.equal((await rpc('readSnapshot', 'safe'))?.canonical_value, 'v2');
  assert.deepEqual([await revision(core, 'safe'), await revision(pii, 'safe')], [2, 2]);

  // Deterministic injected-clock deadline, not a real-world latency/SLO measurement.
  await rpc('begin', 'expired', 10);
  assert.equal((await prepare('expired', 'CORE'))?.prepared, true);
  await rpc('advanceClock', 10);
  assert.equal((await rpc('admit', 'after-timeout'))?.accepted, true);
  await core.prepare('UPDATE fixture_users SET revision=4').run();
  await pii.prepare('UPDATE fixture_users SET revision=4').run();
  await rpc('finish', 'after-timeout');
  assert.equal((await prepare('expired', 'PII'))?.prepared, false);
  assert.equal((await rpc('publish', 'expired'))?.published, false);
  assert.equal(await rpc('readSnapshot', 'expired'), null);
  assert.equal((await rpc('state', 'expired'))?.phase, 'aborted');
  // Partial captures may be cleaned without touching a different, published boundary.
  for (const db of [core, pii])
    await db.prepare("DELETE FROM tenant_backup_snapshots WHERE id='expired'").run();
  assert.deepEqual([await revision(core, 'safe'), await revision(pii, 'safe')], [2, 2]);
  await rpc('begin', 'late-receipt', 10);
  assert.equal(
    (await prepare('late-receipt', 'CORE', 10))?.reason,
    'boundary_expired_during_prepare'
  );
  assert.equal((await rpc('publish', 'late-receipt'))?.published, false);
  assert.equal(await rpc('readSnapshot', 'late-receipt'), null);
  assert.equal((await rpc('admit', 'after-late-receipt'))?.accepted, true);
  await rpc('finish', 'after-late-receipt');
  await rpc('begin', 'lost-protection', 100);
  assert.equal((await prepare('lost-protection', 'CORE'))?.prepared, true);
  assert.equal((await prepare('lost-protection', 'PII'))?.prepared, true);
  await pii
    .prepare("UPDATE tenant_backup_snapshots SET state='invalid' WHERE id='lost-protection'")
    .run();
  assert.equal((await rpc('publish', 'lost-protection'))?.reason, 'participant_protection_lost');
  assert.equal(await rpc('readSnapshot', 'lost-protection'), null);
  assert.equal((await rpc('admit', 'after-protection-loss'))?.accepted, true);
  await rpc('finish', 'after-protection-loss');
  await rpc('useWallClock', true);
  const beginSamplesMs: number[] = [];
  const normalWriteSamplesMs: number[] = [];
  for (let sample = 0; sample < 5; sample++) {
    const id = `measured-${sample}`;
    assert.equal((await rpc('admit', id))?.accepted, true);
    await core.prepare('UPDATE fixture_users SET revision=revision+1').run();
    const started = performance.now();
    assert.equal((await rpc('begin', id, TENANT_BACKUP_BEGIN_BUDGET_MS))?.active, 1);
    assert.equal((await rpc('admit', `excluded-${sample}`))?.accepted, false);
    // Finish a real cross-DB writer that was already active when begin closed admission.
    await pii.prepare('UPDATE fixture_users SET revision=revision+1').run();
    await rpc('finish', id);
    assert.equal((await prepare(id, 'CORE'))?.prepared, true);
    assert.equal((await prepare(id, 'PII'))?.prepared, true);
    assert.equal((await rpc('publish', id))?.published, true);
    beginSamplesMs.push(performance.now() - started);
    const capturedRevision = await revision(core, id);
    assert.equal(capturedRevision, await revision(pii, id));
    const writeStarted = performance.now();
    assert.equal((await rpc('admit', `normal-${sample}`))?.accepted, true);
    await core.prepare('UPDATE fixture_users SET revision=revision+1').run();
    await pii.prepare('UPDATE fixture_users SET revision=revision+1').run();
    await rpc('finish', `normal-${sample}`);
    normalWriteSamplesMs.push(performance.now() - writeStarted);
    assert.equal(await revision(core, id), capturedRevision);
    assert.equal(await revision(pii, id), capturedRevision);
  }
  // Verify the candidate budget using a real stalled writer and real clock expiry.
  assert.equal((await rpc('admit', 'wall-stalled'))?.accepted, true);
  await rpc('begin', 'wall-expired', TENANT_BACKUP_BEGIN_BUDGET_MS);
  await new Promise((resolve) => setTimeout(resolve, TENANT_BACKUP_BEGIN_BUDGET_MS + 10));
  assert.equal((await rpc('publish', 'wall-expired'))?.published, false);
  assert.equal((await rpc('state', 'wall-expired'))?.phase, 'aborted');
  assert.equal((await rpc('admit', 'wall-resumed'))?.accepted, true);
  await rpc('finish', 'wall-resumed');
  await rpc('finish', 'wall-stalled');
  await rpc('useWallClock', false);
  await core
    .prepare(
      "INSERT INTO service_group_write_boundaries VALUES ('foreign','b','user','profile','failed',1)"
    )
    .run();
  await rpc('begin', 'foreign-guard', 100);
  assert.equal((await prepare('foreign-guard', 'CORE'))?.prepared, true);
  assert.equal((await prepare('foreign-guard', 'PII'))?.prepared, true);
  assert.equal((await rpc('publish', 'foreign-guard'))?.published, true);
  await core
    .prepare(
      "INSERT INTO service_group_write_boundaries VALUES ('failed','a','user','profile','failed',1)"
    )
    .run();
  await rpc('begin', 'unsettled-source', 100);
  assert.equal((await prepare('unsettled-source', 'CORE'))?.reason, 'participant_not_ready');
  assert.equal((await rpc('publish', 'unsettled-source'))?.published, false);
  assert.equal(await rpc('readSnapshot', 'unsettled-source'), null);
  assert.equal(
    await core
      .prepare("SELECT COUNT(*) AS n FROM service_group_write_boundaries WHERE id='failed'")
      .first('n'),
    1
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        scope: 'local-d1-do-boundary-fixture',
        productionWriterCoverage: false,
        deadlineClock: 'injected-fault-tests-and-wall-clock-budget-test',
        admissionBudget: {
          budgetMs: TENANT_BACKUP_BEGIN_BUDGET_MS,
          beginSamplesMs,
          normalWriteSamplesMs,
          scope: 'warm local DO, two D1 participants, one active writer, five samples',
          productionSloVerified: false,
        },
        verified: [
          'uncoordinated cut is inconsistent',
          'drain existing writer before activation',
          'bounded admission window only',
          'require both participant receipts',
          'canonical DO state excludes stale KV projection',
          'writes continue after publication',
          'expired partial capture cannot publish',
          'cleanup preserves other capture',
          'draining writers and published evidence survive runtime restart',
          'late activation receipt cannot publish after deadline',
          'participant protection loss invalidates stale ready receipt',
          'unsettled source guard blocks activation atomically without affecting foreign tenant',
          'real-clock begin budget publishes a drained boundary and releases admission on expiry',
        ],
      },
      null,
      2
    )}\n`
  );
} finally {
  await runtime.dispose();
  rmSync(persistence, { recursive: true, force: true });
}
