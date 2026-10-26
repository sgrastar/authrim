import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AuroraDsqlAdapter } from './adapter';
import { validateDsqlConnectionConfig, type DsqlConnectionConfig } from './connection';
import { assessDsqlCompatibility, type DsqlCompatibilitySource } from './compatibility';
import { runDsqlProbe } from './probe';
import { runDsqlIdentityProbe } from './identity-probe';
import { runDsqlConfigurationProbe } from './configuration-probe';

/** Fixed public source inventory: never traverse private files or read deployment secrets. */
export async function loadDsqlAssessmentSources(root: string): Promise<DsqlCompatibilitySource[]> {
  const result: DsqlCompatibilitySource[] = [];
  for (const directory of [
    'migrations/core/postgresql',
    'migrations/pii/postgresql',
    'packages/ar-runtime-aws/src/storage',
  ]) {
    const entries = await readdir(resolve(root, directory));
    for (const name of entries.filter((name) => name.endsWith('.sql')).sort()) {
      const path = `${directory}/${name}`;
      result.push({ path, sql: await readFile(resolve(root, path), 'utf8'), kind: 'sql' });
    }
  }
  for (const path of [
    'packages/ar-runtime-aws/src/maintenance/database.ts',
    'packages/ar-runtime-aws/src/import/aws-schema-bootstrap.ts',
    'packages/ar-runtime-aws/src/import/postgres-restore.ts',
    'packages/ar-runtime-aws/src/import/state-restore.ts',
    'packages/ar-runtime-aws/src/storage/postgres-account-auth-state.ts',
    'packages/ar-runtime-aws/src/storage/postgres-authorization-code.ts',
  ]) {
    result.push({ path, sql: await readFile(resolve(root, path), 'utf8'), kind: 'typescript' });
  }
  return result;
}

export async function runDsqlCli(args: readonly string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'Experimental DSQL compatibility tools; do not activate the SAML runtime.\n' +
        '  assess --root <repository>\n' +
        '  probe --config <connection.json> [--write-probe]\n' +
        '  identity-probe --config <connection.json> --write-probe [--users <1..2000>]\n' +
        '  configuration-probe --config <connection.json> --write-probe [--sps <1..2000>]\n' +
        'Assessment is local only. Probe is read-only unless --write-probe is specified.\n' +
        'Write probes use a new synthetic schema and remove only their own objects.\n'
    );
    return 0;
  }
  try {
    if (args.length === 3 && args[0] === 'assess' && args[1] === '--root') {
      const report = assessDsqlCompatibility(await loadDsqlAssessmentSources(args[2]));
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      // An assessment that identifies blockers must not look like a readiness check.
      return report.findings.some((finding) => finding.severity === 'blocker') ? 2 : 0;
    }
    if (
      (args[0] === 'identity-probe' || args[0] === 'configuration-probe') &&
      (args.length === 4 ||
        (args.length === 6 && args[4] === (args[0] === 'identity-probe' ? '--users' : '--sps'))) &&
      args[1] === '--config' &&
      args[3] === '--write-probe'
    ) {
      const userCount =
        args.length === 6 ? Number(args[5]) : args[0] === 'identity-probe' ? 201 : 101;
      if (
        (args.length === 6 && !/^[1-9]\d{0,3}$/u.test(args[5])) ||
        !Number.isSafeInteger(userCount) ||
        userCount < 1 ||
        userCount > 2000
      )
        throw new Error('dsql_cli_user_count_invalid');
      const config = JSON.parse(await readFile(args[2], 'utf8')) as DsqlConnectionConfig;
      validateDsqlConnectionConfig(config);
      const db = new AuroraDsqlAdapter(config);
      try {
        const report =
          args[0] === 'identity-probe'
            ? await runDsqlIdentityProbe(db, { writeProbe: true, userCount })
            : await runDsqlConfigurationProbe(db, { writeProbe: true, spCount: userCount });
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return report.passed ? 0 : 1;
      } finally {
        await db.close();
      }
    }
    if (
      (args.length === 3 || (args.length === 4 && args[3] === '--write-probe')) &&
      args[0] === 'probe' &&
      args[1] === '--config'
    ) {
      const config = JSON.parse(await readFile(args[2], 'utf8')) as DsqlConnectionConfig;
      validateDsqlConnectionConfig(config);
      const db = new AuroraDsqlAdapter(config);
      try {
        const report = await runDsqlProbe(db, { writeProbe: args[3] === '--write-probe' });
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return report.passed ? 0 : 1;
      } finally {
        await db.close();
      }
    }
    throw new Error('dsql_cli_arguments_invalid');
  } catch {
    process.stderr.write(
      'dsql_evaluation_failed; configuration and server details were withheld\n'
    );
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runDsqlCli(process.argv.slice(2));
}
