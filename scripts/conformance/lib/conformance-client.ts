/**
 * OpenID Conformance Suite API Client
 *
 * Wrapper for the OpenID Conformance Suite REST API
 * Reference: https://www.certification.openid.net/swagger-ui/index.html
 */

import type {
  TestPlan,
  TestModule,
  TestPlanConfig,
  TestPlanName,
  ModuleInfo,
  TestLog,
  TestStatus,
} from './types.js';

export class ConformanceClient {
  private readonly serverUrl: string;
  private readonly token: string;
  private readonly headers: Record<string, string>;

  constructor(serverUrl: string, token: string) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.token = token;
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
  }

  /**
   * Create a new test plan
   */
  async createTestPlan(
    planName: TestPlanName,
    config: TestPlanConfig,
    variant?: Record<string, string>
  ): Promise<TestPlan> {
    const params = new URLSearchParams();
    params.set('planName', planName);

    if (variant) {
      params.set('variant', JSON.stringify(variant));
    }

    const response = await fetch(`${this.serverUrl}/api/plan?${params.toString()}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(config),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create test plan: ${response.status} ${errorText}`);
    }

    return response.json();
  }

  /**
   * Get test plan details
   */
  async getTestPlan(planId: string): Promise<TestPlan> {
    const response = await fetch(`${this.serverUrl}/api/plan/${planId}`, {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`Failed to get test plan: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Get all test modules for a plan
   */
  async getTestModules(planId: string): Promise<TestModule[]> {
    const plan = await this.getTestPlan(planId);
    return plan.modules || [];
  }

  /**
   * Create and start a test module from a plan using the runner API
   */
  async createTestFromPlan(
    planId: string,
    testName: string,
    variant?: Record<string, string>
  ): Promise<TestModule> {
    const params = new URLSearchParams();
    params.set('plan', planId);
    params.set('test', testName);

    if (variant) {
      params.set('variant', JSON.stringify(variant));
    }

    const response = await fetch(
      `${this.serverUrl}/api/runner?${params.toString()}`,
      {
        method: 'POST',
        headers: this.headers,
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create test module: ${response.status} ${errorText}`);
    }

    return response.json();
  }

  /**
   * Start a test that requires manual triggering
   */
  async startTest(moduleId: string): Promise<void> {
    const response = await fetch(`${this.serverUrl}/api/runner/${moduleId}`, {
      method: 'POST',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`Failed to start test: ${response.status}`);
    }
  }

  /**
   * Get module information including status and exposed values
   */
  async getModuleInfo(moduleId: string): Promise<ModuleInfo> {
    const response = await fetch(`${this.serverUrl}/api/info/${moduleId}`, {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`Failed to get module info: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Get test logs for a module
   */
  async getTestLog(moduleId: string): Promise<TestLog[]> {
    const response = await fetch(`${this.serverUrl}/api/log/${moduleId}`, {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`Failed to get test log: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Get all available test modules
   */
  async getAllTestModules(): Promise<Array<{ testName: string; displayName: string }>> {
    const response = await fetch(`${this.serverUrl}/api/runner/available`, {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`Failed to get available test modules: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Wait for a module to reach one of the target states
   */
  async waitForState(
    moduleId: string,
    targetStates: TestStatus[],
    options: {
      timeoutMs?: number;
      pollIntervalMs?: number;
      onPoll?: (status: TestStatus) => void;
    } = {}
  ): Promise<TestStatus> {
    const { timeoutMs = 300000, pollIntervalMs = 2000, onPoll } = options;

    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const info = await this.getModuleInfo(moduleId);
      const currentStatus = info.status;

      if (onPoll) {
        onPoll(currentStatus);
      }

      if (targetStates.includes(currentStatus)) {
        return currentStatus;
      }

      // If the test is finished or interrupted, return immediately
      if (currentStatus === 'FINISHED' || currentStatus === 'INTERRUPTED') {
        return currentStatus;
      }

      await this.sleep(pollIntervalMs);
    }

    throw new Error(`Timeout waiting for state. Target states: ${targetStates.join(', ')}`);
  }

  /**
   * Export test plan results as HTML
   */
  async exportHtml(planId: string, outputDir: string): Promise<string> {
    const response = await fetch(`${this.serverUrl}/api/plan/${planId}/export`, {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`Failed to export HTML: ${response.status}`);
    }

    const html = await response.text();
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `plan-${planId}.html`);
    await fs.writeFile(outputPath, html);

    return outputPath;
  }

  /**
   * Get the URL for viewing plan details in the web UI
   */
  getPlanUrl(planId: string): string {
    return `${this.serverUrl}/plan-detail.html?plan=${planId}`;
  }

  /**
   * Get the URL for viewing module details in the web UI
   */
  getModuleUrl(moduleId: string): string {
    return `${this.serverUrl}/log-detail.html?log=${moduleId}`;
  }

  /**
   * Get exposed values from a module (e.g., authorization_endpoint_url)
   */
  async getExposedValue(moduleId: string, key: string): Promise<unknown> {
    const info = await this.getModuleInfo(moduleId);
    return info.exposed?.[key];
  }

  /**
   * Utility: Sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create a ConformanceClient from environment variables
 */
export function createConformanceClientFromEnv(): ConformanceClient {
  const serverUrl = process.env.CONFORMANCE_SERVER;
  const token = process.env.CONFORMANCE_TOKEN;

  if (!serverUrl) {
    throw new Error('CONFORMANCE_SERVER environment variable is required');
  }

  if (!token) {
    throw new Error('CONFORMANCE_TOKEN environment variable is required');
  }

  return new ConformanceClient(serverUrl, token);
}
