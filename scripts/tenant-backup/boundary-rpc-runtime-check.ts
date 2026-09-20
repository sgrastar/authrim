/** Local-only native WorkerEntrypoint RPC and D1 check; never deploys or opens a remote DB. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { splitMigrationSql } from '../../packages/ar-lib-core/src/services/control-plane/migration-sql.js';

const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler/package.json'))(
  'miniflare'
) as typeof import('miniflare');
const root = fileURLToPath(new URL('../../', import.meta.url));
const driver = `
import {createTenantBackupBoundaryRpcClient} from './packages/ar-lib-core/src/services/tenant-portability/boundary-rpc-client';
import {startTenantBackupSnapshotBoundary} from './packages/ar-lib-core/src/services/tenant-portability/snapshot-boundary';
import {runTenantBackupCoveredMutation} from './packages/ar-management/src/tenant-backup-writer';
import {TenantBackupMutationAdmission} from './packages/ar-lib-core/src/services/tenant-portability/mutation-admission';
import {TenantBackupBoundaryReceipts} from './packages/ar-lib-core/src/services/tenant-portability/boundary-receipts';
function check(condition,message){if(!condition)throw new Error(message);}
async function denied(run,code){try{await run();}catch(error){check(error.message.includes(code),'wrong rejection: '+error.message);return;}throw new Error('expected rejection');}
export default {
  async fetch(request,env){
    const scope={environmentId:'env-a',tenantId:'tenant',operationId:'native-rpc',inventoryDigest:'ab'.repeat(32)};
    const identity={...scope,boundaryId:'cd'.repeat(32)};
    const client=createTenantBackupBoundaryRpcClient(env.CONTROL,scope);
    const permitId=crypto.randomUUID();
    check((await env.CONTROL.acquireTenantBackupMutationPermit({tenantId:'tenant',permitId})).admitted,'writer admission');
    const begin=await client.admission.begin({id:identity.boundaryId,tenantId:'tenant',operationId:scope.operationId,inventoryDigest:scope.inventoryDigest,now:Date.now()});
    check(begin && begin.deadline_at-begin.created_at===2000,'fixed deadline');
    const participants=[{resourceId:'core',snapshotId:'core-image'},{resourceId:'pii',snapshotId:'pii-image'}];
    check(await client.receipts.plan(identity,participants,Date.now()),'participant plan');
    check(await client.admission.hold('tenant',identity.boundaryId,Date.now())===null,'must drain writer');
    await env.CONTROL.completeTenantBackupMutationPermit({tenantId:'tenant',permitId});
    let starts=0;
    let writes=0;
    const mutation={env:{TENANT_BACKUP_WRAPPING_KEY:'ab'.repeat(32),CONTROL:env.CONTROL},tenantId:'tenant',async run(){writes++;return new Response('saved');}};
    const sharedMutation={env:mutation.env,scope:'environment',run:mutation.run};
    const input={...client,identity,now:Date.now,signal:new AbortController().signal,async assertReady(){},
      participants:participants.map(p=>({...p,async start(assertHeld){
        await assertHeld();
        check(!(await env.CONTROL.acquireTenantBackupMutationPermit({tenantId:'tenant',permitId:crypto.randomUUID()})).admitted,'new writer blocked');
        check((await runTenantBackupCoveredMutation(mutation)).status===503,'covered mutation blocked');
        check((await runTenantBackupCoveredMutation(sharedMutation)).status===503,'shared mutation blocked');
        check(writes===0,'no blocked side effects');
        starts++;
      }})),
    };
    const released=await startTenantBackupSnapshotBoundary(input);
    check(released.state==='released','release');
    check((await startTenantBackupSnapshotBoundary(input)).released_at===released.released_at,'replay');
    check(starts===2,'no repeated starts');
    const after=crypto.randomUUID();
    check((await env.CONTROL.acquireTenantBackupMutationPermit({tenantId:'tenant',permitId:after})).admitted,'writer resumes');
    await env.CONTROL.completeTenantBackupMutationPermit({tenantId:'tenant',permitId:after});
    check((await runTenantBackupCoveredMutation(mutation)).status===200,'covered mutation resumes');
    check(writes===1,'mutation executes once');
    check((await runTenantBackupCoveredMutation(sharedMutation)).status===200,'shared mutation resumes');
    check(writes===2,'shared mutation executes once');
    await denied(()=>env.BAD.tenantBackupSnapshotBoundary({}), 'control_rpc_caller_unauthorized');
    await denied(()=>env.CONTROL.tenantBackupSnapshotBoundary({action:'begin',tenantId:'tenant',operationId:'bad',boundaryId:'ef'.repeat(32),inventoryDigest:scope.inventoryDigest,environmentId:'forged'}),'invalid_backup_boundary_request');
    const other=createTenantBackupBoundaryRpcClient(env.OTHER,scope);
    await denied(()=>other.receipts.readReleased(identity,participants,Date.now()),'backup_boundary_rpc_invalid');
    const lateIdentity={...identity,boundaryId:'ef'.repeat(32)};
    check(await client.admission.begin({id:lateIdentity.boundaryId,tenantId:'tenant',operationId:scope.operationId,inventoryDigest:scope.inventoryDigest,now:Date.now()}),'late attempt begins');
    check(await client.receipts.plan(lateIdentity,participants,Date.now()),'late plan');
    const direct={async queryOne(sql,params=[]){return env.CLOCK_DB.prepare(sql).bind(...params).first();},
      async execute(sql,params=[]){const result=await env.CLOCK_DB.prepare(sql).bind(...params).run();return {success:result.success,rowsAffected:result.meta.changes};}};
    const dbAdmission=new TenantBackupMutationAdmission(direct,'clock-test',true);
    const dbReceipts=new TenantBackupBoundaryReceipts(direct,true);
    const frozenNow=Date.now();
    const delayed={environmentId:'clock-test',tenantId:'delayed',boundaryId:'delayed',operationId:'delayed',inventoryDigest:scope.inventoryDigest};
    const one=[{resourceId:'delayed-core',snapshotId:'delayed-snapshot'}];
    check(await dbAdmission.begin({id:delayed.boundaryId,tenantId:delayed.tenantId,operationId:delayed.operationId,inventoryDigest:delayed.inventoryDigest,now:frozenNow}),'delayed begin');
    check(await dbReceipts.plan(delayed,one,frozenNow),'delayed plan');
    check(await dbAdmission.hold(delayed.tenantId,delayed.boundaryId,frozenNow),'delayed hold');
    check(await dbReceipts.acknowledge(delayed,one[0],frozenNow),'delayed receipt');
    await new Promise(resolve=>setTimeout(resolve,2100));
    check(await dbReceipts.release(delayed,frozenNow)===null,'database clock rejects delayed release');
    check(await dbReceipts.readReleased(delayed,one,Date.now())===null,'no late success receipt');
    check(await client.admission.hold('tenant',lateIdentity.boundaryId,Date.now())===null,'expired hold rejected');
    check(await client.receipts.release(lateIdentity,Date.now())===null,'expired release rejected');
    check((await runTenantBackupCoveredMutation(mutation)).status===200,'expired attempt does not block writes');
    return Response.json({starts,boundaryMilliseconds:released.released_at-released.created_at,nativeRpc:true,deadlineExpiry:true,databaseClockExpiry:true,productionWriterCoverage:false});
  }
};`;
const options = {
  bundle: true,
  write: false,
  format: 'esm' as const,
  platform: 'node' as const,
  mainFields: ['module', 'main'],
  external: ['cloudflare:*', 'node:*'],
  absWorkingDir: root,
  logLevel: 'silent' as const,
};
const [controlBundle, driverBundle] = await Promise.all([
  build({ ...options, entryPoints: ['packages/ar-control/src/index.ts'] }),
  build({
    ...options,
    stdin: { contents: driver, resolveDir: root, sourcefile: 'boundary-driver.js' },
  }),
]);
const controlScript = controlBundle.outputFiles?.[0]?.text;
const driverScript = driverBundle.outputFiles?.[0]?.text;
assert(controlScript);
assert(driverScript);
const props = { caller: 'ar-management', audience: 'authrim-control-v1', environmentId: 'env-a' };
const runtime = new Miniflare({
  host: '127.0.0.1',
  workers: [
    {
      name: 'driver',
      modules: true,
      script: driverScript,
      compatibilityDate: '2026-07-08',
      d1Databases: { CLOCK_DB: 'boundary-clock-test' },
      serviceBindings: {
        CONTROL: { name: 'control', props },
        BAD: { name: 'control', props: { ...props, caller: 'ar-plugin-runner' } },
        OTHER: { name: 'control', props: { ...props, environmentId: 'env-b' } },
      },
    },
    {
      name: 'control',
      modules: true,
      script: controlScript,
      compatibilityDate: '2026-07-08',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { CONTROL_DB: 'boundary-clock-test' },
    },
  ],
});
try {
  const database = await runtime.getD1Database('CONTROL_DB', 'control');
  for (const file of [
    '005_tenant_backup_mutation_admission.sql',
    '006_tenant_backup_mutation_environment_scope.sql',
    '007_tenant_backup_boundary_receipts.sql',
    '010_tenant_backup_snapshot_timestamp.sql',
  ]) {
    const sql = readFileSync(
      new URL('../../migrations/control/d1/' + file, import.meta.url),
      'utf8'
    );
    await database.batch(splitMigrationSql(sql).map((statement) => database.prepare(statement)));
  }
  await database
    .prepare('CREATE TABLE control_tenant_placement_policies(environment_id TEXT,tenant_id TEXT)')
    .run();
  await database
    .prepare(
      "INSERT INTO control_tenant_placement_policies VALUES ('env-a','tenant'),('env-b','tenant')"
    )
    .run();
  const response = await runtime.dispatchFetch('http://localhost/run');
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const result = JSON.parse(body) as {
    starts: number;
    nativeRpc: boolean;
    databaseClockExpiry: boolean;
  };
  assert.equal(result.starts, 2);
  assert.equal(result.nativeRpc, true);
  assert.equal(result.databaseClockExpiry, true);
  assert.equal(
    (
      await database
        .prepare('SELECT count(*) n FROM tenant_backup_boundary_receipts')
        .first<{ n: number }>()
    )?.n,
    3
  );
  process.stdout.write(body + '\n');
} finally {
  await runtime.dispose();
}
