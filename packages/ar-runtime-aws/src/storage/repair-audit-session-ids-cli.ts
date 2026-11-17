import { Client } from 'pg';
import {
  countLegacyAuditSessionIds,
  repairLegacyAuditSessionIds,
} from './repair-audit-session-ids';

const apply = process.argv.slice(2).join(' ') === '--apply';
if (process.argv.length > 2 && !apply) {
  throw new Error('usage: pnpm audit:repair-aws-session-ids [--apply]');
}
const connectionString = process.env.AUTHRIM_AWS_STATE_DATABASE_URL;
if (!connectionString) throw new Error('AUTHRIM_AWS_STATE_DATABASE_URL is required');

const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
try {
  await client.connect();
  const before = await countLegacyAuditSessionIds(client);
  if (!apply) {
    process.stdout.write(`Legacy session audit rows: ${before}\n`);
  } else {
    const result = await repairLegacyAuditSessionIds(client);
    process.stdout.write(
      `Legacy session audit rows before: ${before}; updated: ${result.updated}; remaining: ${result.remaining}\n`
    );
    if (result.remaining !== 0) throw new Error('aws_audit_repair_incomplete');
  }
} finally {
  await client.end();
}
