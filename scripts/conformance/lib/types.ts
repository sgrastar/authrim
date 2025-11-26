/**
 * OIDC Conformance Test Automation - Type Definitions
 */

// ============================================================
// Conformance Suite API Types
// ============================================================

export interface TestPlan {
  id: string;
  name: string;
  planName: string;
  modules: TestModule[];
  started: string;
  description?: string;
}

export interface TestModule {
  id: string;
  testId: string;
  testName: string;
  status: TestStatus;
  result?: TestResult;
  variant?: Record<string, string>;
}

export type TestStatus =
  | 'CREATED'
  | 'CONFIGURED'
  | 'WAITING'
  | 'RUNNING'
  | 'FINISHED'
  | 'INTERRUPTED';

export type TestResult = 'PASSED' | 'FAILED' | 'WARNING' | 'REVIEW' | 'SKIPPED';

export interface TestLog {
  time: string;
  msg: string;
  src: string;
  result?: 'SUCCESS' | 'FAILURE' | 'WARNING' | 'INFO';
  requirements?: string[];
}

export interface ModuleInfo {
  testId: string;
  testName: string;
  status: TestStatus;
  result?: TestResult;
  logs?: TestLog[];
  exposed?: Record<string, unknown>;
}

export interface TestPlanConfig {
  alias: string;
  description?: string;
  server: {
    discoveryUrl: string;
  };
  client?: {
    client_id?: string;
    client_secret?: string;
    scope?: string;
    redirect_uri?: string;
  };
  client2?: {
    client_id?: string;
    client_secret?: string;
  };
  resource?: {
    resourceUrl?: string;
  };
  browser?: {
    show_console_log?: boolean;
  };
}

// ============================================================
// Test Plan Definitions
// ============================================================

export type TestPlanName =
  | 'oidcc-basic-certification-test-plan'
  | 'oidcc-config-certification-test-plan'
  | 'oidcc-dynamic-certification-test-plan'
  | 'fapi2-security-profile-id2-test-plan'
  | 'oidcc-formpost-basic-certification-test-plan'
  | 'oidcc-formpost-hybrid-certification-test-plan'
  | 'oidcc-hybrid-certification-test-plan';

export interface TestPlanDefinition {
  name: TestPlanName;
  displayName: string;
  profile: CertificationProfileName;
  configFile: string;
  variants?: Record<string, string>;
  requiresBrowser: boolean;
}

// ============================================================
// Profile Types
// ============================================================

export type CertificationProfileName =
  | 'basic-op'
  | 'config-op'
  | 'dynamic-op'
  | 'implicit-op'
  | 'hybrid-op'
  | 'fapi-1-advanced'
  | 'fapi-2'
  | 'fapi-2-dpop'
  | 'development';

export interface CertificationProfile {
  name: string;
  description: string;
  settings: {
    fapi: {
      enabled: boolean;
      requireDpop: boolean;
      allowPublicClients: boolean;
    };
    oidc: {
      requirePar: boolean;
      responseTypesSupported?: string[];
      tokenEndpointAuthMethodsSupported: string[];
      allowNoneAlgorithm?: boolean;
    };
  };
}

// ============================================================
// Discovery Metadata
// ============================================================

export interface DiscoveryMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  registration_endpoint?: string;
  require_pushed_authorization_requests?: boolean;
  pushed_authorization_request_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
  dpop_signing_alg_values_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
  scopes_supported?: string[];
}

// ============================================================
// Browser Automation Types
// ============================================================

export interface TestUser {
  email: string;
  password?: string;
  sub?: string;
  name?: string;
}

export interface BrowserAction {
  type: 'login' | 'consent' | 'logout' | 'custom';
  url: string;
  expectedRedirect?: string;
}

// ============================================================
// Result Processing Types
// ============================================================

export interface ExpectedFailure {
  testId: string;
  condition?: string;
  reason: string;
  issue?: string;
}

export interface ExpectedSkip {
  testId: string;
  reason: string;
}

export interface ProcessedResult {
  planId: string;
  planName: string;
  timestamp: string;
  summary: TestSummary;
  modules: ProcessedModuleResult[];
  unexpectedFailures: UnexpectedFailure[];
  unexpectedWarnings: UnexpectedFailure[];
  expectedFailuresMatched: ExpectedFailure[];
  expectedFailuresUnmatched: ExpectedFailure[];
}

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  warning: number;
  skipped: number;
  passRate: number;
  duration: number;
}

export interface ProcessedModuleResult {
  testId: string;
  testName: string;
  status: TestStatus;
  result: TestResult;
  duration?: number;
  conditions: ConditionResult[];
}

export interface ConditionResult {
  src: string;
  result: 'SUCCESS' | 'FAILURE' | 'WARNING';
  message: string;
  isExpected: boolean;
}

export interface UnexpectedFailure {
  testId: string;
  testName: string;
  condition: string;
  message: string;
}

// ============================================================
// CLI Options
// ============================================================

export interface ConformanceRunOptions {
  plan: TestPlanName | 'all';
  environment: 'conformance' | 'staging' | 'local';
  headless: boolean;
  parallel: number;
  exportDir: string;
  verbose: boolean;
  reportOnly: boolean;
}

// ============================================================
// Environment Configuration
// ============================================================

export interface ConformanceEnvironment {
  conformanceServer: string;
  conformanceToken: string;
  issuer: string;
  adminApiUrl: string;
  testUser: TestUser;
}
