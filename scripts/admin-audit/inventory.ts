/**
 * Prints the core audit write inventory.
 *
 *   pnpm run audit:core-writes            # markdown table
 *   pnpm run audit:core-writes -- --json  # JSON
 */
import { fileURLToPath } from 'node:url';
import {
  findOtherOccurrences,
  inventoryCoreAuditWrites,
  inventorySystemEventWrites,
} from '../../packages/ar-management/src/__tests__/helpers/core-audit-inventory.js';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const sites = inventoryCoreAuditWrites(repositoryRoot);
const systemSites = inventorySystemEventWrites(repositoryRoot);
const ownFiles = new Set(sites.map((site) => site.file));
const others = findOtherOccurrences(
  repositoryRoot,
  sites.filter((site) => site.actionKnown).map((site) => site.action),
  ownFiles
);

if (process.argv.includes('--json')) {
  process.stdout.write(
    `${JSON.stringify(
      {
        core: sites.map((site) => ({ ...site, otherFiles: others.get(site.action) ?? [] })),
        system: systemSites,
      },
      null,
      2
    )}\n`
  );
} else {
  const mark = (value: boolean | null) => (value === null ? '?' : value ? '✓' : '–');
  const lines = [
    '| file:line | helper | action | resource | fail-closed | caller swallows | fixed id | system actor | action also in |',
    '|---|---|---|---|---|---|---|---|---|',
    ...sites.map((site) =>
      [
        `${site.file}:${site.line}`,
        site.helper,
        `\`${site.action}\``,
        `\`${site.resource}\``,
        mark(site.failClosed),
        mark(site.callerSwallows),
        mark(site.fixedId),
        mark(site.actorSystem),
        (others.get(site.action) ?? []).join('<br>') || '–',
      ].join(' | ')
    ),
  ].map((line) => (line.startsWith('|') ? line : `| ${line} |`));
  const systemLines = [
    '| file:line | source | action |',
    '|---|---|---|',
    ...systemSites.map(
      (site) => `| ${site.file}:${site.line} | \`${site.source}\` | \`${site.action}\` |`
    ),
  ];
  process.stdout.write(
    `${lines.join('\n')}\n\n${sites.length} core audit write sites.\n\n${systemLines.join('\n')}\n\n${systemSites.length} system log write sites.\n`
  );
}
