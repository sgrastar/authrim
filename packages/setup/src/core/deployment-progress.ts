export const DEPLOYMENT_PHASES = [
  { id: 'preparation', label: 'Preparing deployment' },
  { id: 'schema', label: 'Applying database schema' },
  { id: 'configuration', label: 'Generating configuration' },
  { id: 'workers', label: 'Deploying API Workers' },
  { id: 'verification', label: 'Verifying Worker readiness' },
  { id: 'control', label: 'Reconciling the Control Plane' },
  { id: 'bootstrap', label: 'Bootstrapping tenant services' },
  { id: 'routing', label: 'Verifying tenant routing' },
  { id: 'integrations', label: 'Configuring optional integrations' },
  { id: 'ui', label: 'Deploying Login and Admin UI' },
] as const;

export type DeploymentPhaseId = (typeof DEPLOYMENT_PHASES)[number]['id'];
export type DeploymentProgressStatus = 'running' | 'waiting' | 'warning' | 'error' | 'complete';

export interface DeploymentProgressSnapshot {
  operation: 'deploy';
  phase: DeploymentPhaseId;
  step: number;
  totalSteps: number;
  status: DeploymentProgressStatus;
  message: string;
  startedAt: string;
  updatedAt: string;
  terminal?: boolean;
}

function phaseStepForMessage(message: string): number {
  const normalized = message.toLowerCase();

  if (normalized.includes('deployment complete') || normalized.includes('release state verified')) {
    return 10;
  }
  if (
    normalized.includes('deploying login/admin ui') ||
    normalized.includes('login ui client') ||
    normalized.includes('all ui packages deployed')
  ) {
    return 10;
  }
  if (normalized.includes('downstream') || normalized.includes('grant introspection')) {
    return 9;
  }
  if (
    normalized.includes('tenant routing') ||
    normalized.includes('runtime discovery') ||
    normalized.includes('wildcard dns')
  ) {
    return 8;
  }
  if (
    normalized.includes('initial tenant') ||
    normalized.includes('notification provider') ||
    normalized.includes('admin role') ||
    normalized.includes('setup machine') ||
    normalized.includes('canonical field') ||
    normalized.includes('runtime profile') ||
    normalized.includes('runtime snapshot')
  ) {
    return 7;
  }
  if (
    normalized.includes('control bootstrap') ||
    normalized.includes('control verification') ||
    normalized.includes('control is reconciling') ||
    normalized.includes('control verified') ||
    normalized.includes('topology accepted') ||
    normalized.includes('initial d1 topology accepted')
  ) {
    return 6;
  }
  if (
    normalized.includes('worker http') ||
    normalized.includes('verifying worker deployment') ||
    normalized.includes('worker deployments are visible') ||
    normalized.includes('worker deployment visibility') ||
    normalized.includes('api router') ||
    normalized.includes('health check') ||
    normalized.includes('visible')
  ) {
    return 5;
  }
  if (normalized.includes('deploying worker') || normalized.includes('worker(s) deployed')) {
    return 4;
  }
  if (
    normalized.includes('wrangler') ||
    normalized.includes('control signing key') ||
    normalized.includes('control plane bindings') ||
    normalized.includes('desired worker inventory')
  ) {
    return 3;
  }
  if (normalized.includes('migration') || normalized.includes('database schema')) {
    return 2;
  }
  return 1;
}

function statusForMessage(message: string): DeploymentProgressStatus {
  const normalized = message.toLowerCase();
  if (normalized.includes('deployment complete')) return 'complete';
  if (/\bfailed\s*:\s*0\b/u.test(normalized) || /\b0\s+(?:\w+\s+)*failed\b/u.test(normalized)) {
    return 'running';
  }
  if (normalized.includes('❌')) return 'error';
  if (
    normalized.includes('⚠') ||
    normalized.includes('warning') ||
    normalized.includes('deferred')
  ) {
    return 'warning';
  }
  if (
    normalized.includes('waiting') ||
    normalized.includes('retrying') ||
    normalized.includes('reconciling') ||
    normalized.includes('confirming') ||
    normalized.includes('propagat') ||
    normalized.includes('pending') ||
    normalized.includes('falling back') ||
    /attempt\s+\d+\s+failed/u.test(normalized)
  ) {
    return 'waiting';
  }
  if (normalized.includes('failed')) return 'error';
  return 'running';
}

export function updateDeploymentProgress(
  previous: DeploymentProgressSnapshot | null,
  message: string,
  now = new Date()
): DeploymentProgressSnapshot {
  const detectedStep = phaseStepForMessage(message);
  const step = Math.max(previous?.step ?? 1, detectedStep);
  const phase = DEPLOYMENT_PHASES[step - 1] ?? DEPLOYMENT_PHASES[0];
  const timestamp = now.toISOString();
  const detectedStatus = statusForMessage(message);
  const status =
    detectedStatus === 'complete'
      ? 'complete'
      : previous?.status === 'complete'
        ? 'complete'
        : previous?.status === 'error'
          ? 'error'
          : previous?.status === 'warning' &&
              detectedStatus === 'running' &&
              detectedStep <= previous.step
            ? 'warning'
            : detectedStatus;
  return {
    operation: 'deploy',
    phase: phase.id,
    step,
    totalSteps: DEPLOYMENT_PHASES.length,
    status,
    message,
    startedAt: previous?.startedAt ?? timestamp,
    updatedAt: timestamp,
  };
}
