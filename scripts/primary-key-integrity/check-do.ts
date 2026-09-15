import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = wranglerRequire('miniflare') as typeof import('miniflare');
const { buildSync } = wranglerRequire('esbuild') as typeof import('esbuild');
const output = process.argv[2];
if (!output) throw new Error('Evidence directory required');
const bundled = buildSync({
  stdin: {
    contents: `
    import {DurableObject} from 'cloudflare:workers';
    import {initializeCredentialStoreSchema,VCI_INITIAL_SCHEMA,VCI_PRIMARY_KEY_MIGRATION,VP_INITIAL_SCHEMA,VP_PRIMARY_KEY_MIGRATION} from './packages/ar-vc/src/common/primary-key-schema.ts';
    export class Check extends DurableObject {
      async fetch(request) {
        const url=new URL(request.url), kind=url.searchParams.get('kind'), mode=url.searchParams.get('mode');
        const ddl=kind==='VCI'?VCI_INITIAL_SCHEMA:VP_INITIAL_SCHEMA;
        const migration=kind==='VCI'?VCI_PRIMARY_KEY_MIGRATION:VP_PRIMARY_KEY_MIGRATION;
        const tables=kind==='VCI'?['credential_offers','proof_nonces']:['vp_requests'];
        const sql=this.ctx.storage.sql;
        const snapshot=()=>JSON.stringify({schema:sql.exec("SELECT name,sql FROM sqlite_schema WHERE name NOT GLOB '__cf_*' ORDER BY name").toArray(),rows:tables.map(t=>sql.exec('SELECT rowid,* FROM '+t).toArray())});
        if(mode!=='fresh') {
          sql.exec(ddl.replaceAll('id TEXT PRIMARY KEY NOT NULL,','id TEXT PRIMARY KEY,'));
          for(const table of tables) {
            const columns=sql.exec('PRAGMA table_info('+table+')').toArray();
            const required=columns.filter(c=>c.name==='id'||(c.notnull && c.dflt_value===null));
            const values=required.map(c=>c.name==='id'?(mode==='corrupt'?null:table+'-id'):c.name==='status'?(table==='proof_nonces'?'issued':'pending'):c.name==='response_mode'?'direct_post':c.type==='INTEGER'?1:table+'-'+c.name);
            sql.exec('INSERT INTO '+table+'('+required.map(c=>c.name).join(',')+') VALUES ('+required.map(()=>'?').join(',')+')',...values);
          }
          const before=snapshot();
          if(mode==='corrupt') {
            let rejected=false;try{initializeCredentialStoreSchema(this.ctx.storage,ddl,migration,tables)}catch(e){rejected=String(e).includes('primary_key_integrity_preflight')}
            return Response.json({rejected,unchanged:snapshot()===before});
          }
        }
        const beforeRows=mode==='fresh'?null:tables.map(t=>sql.exec('SELECT rowid,* FROM '+t).toArray());
        initializeCredentialStoreSchema(this.ctx.storage,ddl,migration,tables);
        initializeCredentialStoreSchema(this.ctx.storage,ddl,migration,tables);
        const unchanged=beforeRows===null||JSON.stringify(beforeRows)===JSON.stringify(tables.map(t=>sql.exec('SELECT rowid,* FROM '+t).toArray()));
        let rejected=0;
        for(const table of tables) {
          const columns=sql.exec('PRAGMA table_info('+table+')').toArray();
          if(!columns.filter(c=>c.pk).every(c=>c.notnull===1))throw Error('missing_not_null');
          try{sql.exec('INSERT INTO '+table+'(id) VALUES(NULL)')}catch(e){if(String(e).includes('NOT NULL'))rejected++}
          if(mode!=='fresh')try{sql.exec('UPDATE '+table+' SET id=NULL')}catch(e){if(String(e).includes('NOT NULL'))rejected++}
        }
        return Response.json({unchanged,rejected,expected:tables.length*(mode==='fresh'?1:2)});
      }
    }
    export default {};`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  external: ['cloudflare:workers'],
});
const runtime = new Miniflare({
  modules: true,
  script: bundled.outputFiles[0].text,
  host: '127.0.0.1',
  compatibilityDate: '2026-07-08',
  durableObjects: { CHECK: { className: 'Check', useSQLite: true } },
});
const results = [];
try {
  const namespace = await runtime.getDurableObjectNamespace('CHECK');
  for (const kind of ['VCI', 'VP'])
    for (const mode of ['fresh', 'upgrade', 'corrupt']) {
      const stub = namespace.get(namespace.idFromName(kind + '-' + mode));
      const response = await stub.fetch('http://local.test/?kind=' + kind + '&mode=' + mode);
      assert.equal(response.status, 200, await response.clone().text());
      const result = (await response.json()) as {
        unchanged: boolean;
        rejected: number | boolean;
        expected?: number;
      };
      assert.equal(result.unchanged, true);
      assert.equal(result.rejected, mode === 'corrupt' ? true : result.expected);
      results.push({ kind, mode, ...result });
    }
} finally {
  await runtime.dispose();
}
writeFileSync(
  resolve(output, 'local-do-rebuild-evidence.json'),
  JSON.stringify(results, null, 2) + '\n'
);
process.stdout.write('VCI/VP local DO fresh, upgrade and corrupt-data rollback checks passed\n');
