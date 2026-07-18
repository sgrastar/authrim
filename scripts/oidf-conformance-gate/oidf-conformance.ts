export type ConformanceProfile = 'basic-op' | 'config-op' | 'dynamic-op' | 'fapi-2';

export interface ModuleEvidence {
  profile: ConformanceProfile;
  planId: string;
  planName: string;
  moduleName: string;
  moduleId: string;
  started: string;
  status: string;
  result: string | null;
  reviewEvidenceUploaded?: boolean;
}

interface PlanModule {
  testModule?: string;
  instances?: string[];
}

interface PlanResponse {
  planName?: string;
  started?: string;
  config?: {
    server?: {
      discoveryUrl?: string;
    };
  };
  modules?: PlanModule[];
}

interface ModuleResponse {
  planId?: string;
  started?: string;
  status?: string;
  result?: string | null;
  testName?: string;
}

interface ModuleLogResponse {
  img?: unknown;
}

const PROFILE_ENV: Record<ConformanceProfile, string> = {
  'basic-op': 'OIDF_CONFORMANCE_BASIC_PLAN_ID',
  'config-op': 'OIDF_CONFORMANCE_CONFIG_PLAN_ID',
  'dynamic-op': 'OIDF_CONFORMANCE_DYNAMIC_PLAN_ID',
  'fapi-2': 'OIDF_CONFORMANCE_FAPI2_PLAN_ID',
};

const EXPECTED_PLAN_NAME: Partial<Record<ConformanceProfile, string>> = {
  'basic-op': 'oidcc-basic-certification-test-plan',
  'config-op': 'oidcc-config-certification-test-plan',
  'dynamic-op': 'oidcc-dynamic-certification-test-plan',
};

const CERTIFICATION_ACCEPTABLE_RESULTS = new Set(['PASSED', 'WARNING', 'SKIPPED']);

export function isCertificationAcceptableEvidence(entry: ModuleEvidence): boolean {
  return (
    entry.status === 'FINISHED' &&
    entry.result !== null &&
    (CERTIFICATION_ACCEPTABLE_RESULTS.has(entry.result) ||
      (entry.result === 'REVIEW' && entry.reviewEvidenceUploaded === true))
  );
}

async function hasUploadedReviewEvidence(moduleId: string): Promise<boolean> {
  const logs = await getJson<ModuleLogResponse[]>(`/api/log/${encodeURIComponent(moduleId)}`);
  return logs.some(
    (log) =>
      typeof log.img === 'string' &&
      /^data:image\/(?:png|jpeg);base64,/i.test(log.img) &&
      log.img.length > 64
  );
}

export function profilesForArgument(value: string): ConformanceProfile[] {
  if (value === 'all') return ['basic-op', 'config-op', 'dynamic-op'];
  if (value in PROFILE_ENV) return [value as ConformanceProfile];
  throw new Error(`Unknown conformance profile: ${value}`);
}

function requiredPlanId(profile: ConformanceProfile): string {
  const envName = PROFILE_ENV[profile];
  const value = process.env[envName]?.trim();
  if (!value) {
    throw new Error(
      `${envName} is required. Run the profile in the OpenID Foundation Conformance Suite ` +
        'and provide the resulting plan ID as external evidence.'
    );
  }
  return value;
}

function requestHeaders(): HeadersInit {
  const token = process.env.OIDF_CONFORMANCE_API_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function baseUrl(): string {
  const configured =
    process.env.OIDF_CONFORMANCE_BASE_URL?.trim() || 'https://www.certification.openid.net';
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('OIDF_CONFORMANCE_BASE_URL must be an absolute HTTPS origin.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('OIDF_CONFORMANCE_BASE_URL must be an absolute HTTPS origin.');
  }
  return url.origin;
}

function requiredExpectedDiscoveryUrl(): string {
  const value = process.env.OIDF_CONFORMANCE_EXPECTED_DISCOVERY_URL?.trim();
  if (!value) {
    throw new Error(
      'OIDF_CONFORMANCE_EXPECTED_DISCOVERY_URL is required to bind evidence to the tested Authrim environment.'
    );
  }
  try {
    return new URL(value).toString();
  } catch {
    throw new Error('OIDF_CONFORMANCE_EXPECTED_DISCOVERY_URL must be an absolute URL.');
  }
}

function requiredMinimumStartedAt(): number {
  const value = process.env.OIDF_CONFORMANCE_MIN_STARTED_AT?.trim();
  if (!value) {
    throw new Error(
      'OIDF_CONFORMANCE_MIN_STARTED_AT is required to reject evidence created before the tested deployment.'
    );
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error('OIDF_CONFORMANCE_MIN_STARTED_AT must be an ISO-8601 timestamp.');
  }
  return timestamp;
}

function parseStartedAt(value: string | undefined, label: string): number {
  if (!value) throw new Error(`${label} does not contain a started timestamp`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp))
    throw new Error(`${label} contains an invalid started timestamp`);
  return timestamp;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, {
    headers: requestHeaders(),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`OIDF Conformance API ${path} returned ${response.status}: ${body}`);
  }
  return (await response.json()) as T;
}

export async function collectProfileEvidence(
  profile: ConformanceProfile
): Promise<ModuleEvidence[]> {
  const planId = requiredPlanId(profile);
  const plan = await getJson<PlanResponse>(`/api/plan/${encodeURIComponent(planId)}`);
  const planName = plan.planName || 'unknown';
  const expectedPlanName = EXPECTED_PLAN_NAME[profile];
  if (expectedPlanName && planName !== expectedPlanName) {
    throw new Error(`OIDF plan ${planId} is ${planName}; ${profile} requires ${expectedPlanName}`);
  }
  const expectedDiscoveryUrl = requiredExpectedDiscoveryUrl();
  const actualDiscoveryUrl = plan.config?.server?.discoveryUrl;
  if (!actualDiscoveryUrl) {
    throw new Error(`OIDF plan ${planId} (${profile}) has no server.discoveryUrl`);
  }
  let normalizedActualDiscoveryUrl: string;
  try {
    normalizedActualDiscoveryUrl = new URL(actualDiscoveryUrl).toString();
  } catch {
    throw new Error(`OIDF plan ${planId} (${profile}) has an invalid server.discoveryUrl`);
  }
  if (normalizedActualDiscoveryUrl !== expectedDiscoveryUrl) {
    throw new Error(
      `OIDF plan ${planId} (${profile}) targets ${normalizedActualDiscoveryUrl}; ` +
        `expected ${expectedDiscoveryUrl}`
    );
  }
  const planStartedAt = parseStartedAt(plan.started, `OIDF plan ${planId} (${profile})`);
  const minimumStartedAt = requiredMinimumStartedAt();
  if (planStartedAt < minimumStartedAt) {
    throw new Error(
      `OIDF plan ${planId} (${profile}) started before OIDF_CONFORMANCE_MIN_STARTED_AT`
    );
  }
  const unexecutedModules = (plan.modules || []).filter(
    (module) => !module.instances || module.instances.length === 0
  );
  if (unexecutedModules.length > 0) {
    throw new Error(
      `OIDF plan ${planId} (${profile}) contains unexecuted modules: ` +
        unexecutedModules.map((module) => module.testModule || 'unknown').join(', ')
    );
  }
  const moduleRefs = (plan.modules || []).flatMap((module) =>
    (module.instances || []).map((moduleId) => ({
      moduleId,
      moduleName: module.testModule || 'unknown',
    }))
  );
  if (moduleRefs.length === 0) {
    throw new Error(`OIDF plan ${planId} (${profile}) contains no executed module instances`);
  }

  return Promise.all(
    moduleRefs.map(async ({ moduleId, moduleName }) => {
      const info = await getJson<ModuleResponse>(`/api/info/${encodeURIComponent(moduleId)}`);
      if (info.planId !== planId) {
        throw new Error(
          `OIDF module ${moduleId} belongs to ${info.planId || 'unknown'}; expected plan ${planId}`
        );
      }
      const moduleStartedAt = parseStartedAt(info.started, `OIDF module ${moduleId}`);
      if (moduleStartedAt < planStartedAt) {
        throw new Error(`OIDF module ${moduleId} started before its plan ${planId}`);
      }
      const result = info.result ?? null;
      const reviewEvidenceUploaded =
        result === 'REVIEW' ? await hasUploadedReviewEvidence(moduleId) : undefined;
      return {
        profile,
        planId,
        planName,
        moduleName: info.testName || moduleName,
        moduleId,
        started: info.started!,
        status: info.status || 'UNKNOWN',
        result,
        reviewEvidenceUploaded,
      };
    })
  );
}

export function assertPassingEvidence(evidence: ModuleEvidence[]): void {
  const failures = evidence.filter((entry) => !isCertificationAcceptableEvidence(entry));
  if (failures.length > 0) {
    const detail = failures
      .map(
        (entry) =>
          `${entry.profile}/${entry.moduleName} (${entry.moduleId}): ` +
          `status=${entry.status}, result=${entry.result ?? 'null'}, ` +
          `review_image=${entry.reviewEvidenceUploaded === true ? 'uploaded' : 'missing'}`
      )
      .join('\n');
    throw new Error(`OIDF conformance evidence is not passing:\n${detail}`);
  }
}

export function parsePlanArgument(argv: string[]): string {
  const index = argv.indexOf('--plan');
  if (index === -1) return 'all';
  const value = argv[index + 1];
  if (!value) throw new Error('--plan requires a value');
  return value;
}
