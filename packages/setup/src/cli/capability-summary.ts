import chalk from 'chalk';
import {
  deriveSetupCapabilityStatuses,
  getSetupCapabilityDiagnostics,
  type CloudflareAuth,
  type SetupCapabilityDiagnostics,
  type SetupCapabilityStatus,
} from '../core/cloudflare.js';
import { getSetupCapabilityCopy, type SetupCapabilityCopy } from '../core/setup-capability-copy.js';

export interface CliCapabilityRow {
  label: string;
  status: SetupCapabilityStatus;
  description: string;
}

function describeCapability(
  key: 'workersDeploy' | 'customDomain' | 'pages',
  status: SetupCapabilityStatus,
  diagnostics: SetupCapabilityDiagnostics,
  copy: SetupCapabilityCopy
): string {
  if (key === 'workersDeploy') {
    return status === 'ok'
      ? copy.workersDeployOk
      : status === 'review'
        ? copy.workersDeployReview
        : copy.workersDeployNg;
  }

  if (key === 'customDomain') {
    return status === 'ok'
      ? copy.customDomainOk
      : status === 'review'
        ? copy.customDomainReviewZoneRead
        : diagnostics.wranglerInstalled && diagnostics.loggedIn
          ? copy.customDomainNgNoZone
          : copy.workersDeployNg;
  }

  return status === 'ok'
    ? copy.pagesOk
    : status === 'review'
      ? copy.pagesReview
      : copy.workersDeployNg;
}

export function buildCliCapabilityRows(
  diagnostics: SetupCapabilityDiagnostics,
  locale = 'en'
): {
  title: string;
  hint: string;
  okLabel: string;
  reviewLabel: string;
  ngLabel: string;
  rows: CliCapabilityRow[];
} {
  const copy = getSetupCapabilityCopy(locale);
  const statuses = deriveSetupCapabilityStatuses(diagnostics);

  return {
    title: copy.title,
    hint: copy.hint,
    okLabel: copy.ok,
    reviewLabel: copy.review,
    ngLabel: copy.ng,
    rows: [
      {
        label: copy.workersDeploy,
        status: statuses.workersDeploy,
        description: describeCapability('workersDeploy', statuses.workersDeploy, diagnostics, copy),
      },
      {
        label: copy.customDomain,
        status: statuses.customDomain,
        description: describeCapability('customDomain', statuses.customDomain, diagnostics, copy),
      },
      {
        label: copy.pages,
        status: statuses.pages,
        description: describeCapability('pages', statuses.pages, diagnostics, copy),
      },
    ],
  };
}

export async function printCliCapabilitySummary(options: {
  auth: CloudflareAuth;
  wranglerInstalled: boolean;
  workersSubdomain?: string | null;
  locale?: string;
}): Promise<void> {
  const diagnostics = await getSetupCapabilityDiagnostics(
    options.auth,
    options.wranglerInstalled,
    options.workersSubdomain
  );
  const summary = buildCliCapabilityRows(diagnostics, options.locale || 'en');

  console.log('');
  console.log(chalk.blue(`━━━ ${summary.title} ━━━`));
  console.log(chalk.gray(`  ${summary.hint}`));
  console.log('');

  for (const row of summary.rows) {
    const status =
      row.status === 'ok'
        ? chalk.green(summary.okLabel.padEnd(4))
        : row.status === 'review'
          ? chalk.yellow(summary.reviewLabel.padEnd(4))
          : chalk.red(summary.ngLabel.padEnd(4));
    console.log(`  ${status}  ${row.label}`);
    console.log(chalk.gray(`      ${row.description}`));
  }

  console.log('');
}
