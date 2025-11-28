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

    // Only pass variant if it has actual properties
    // Empty variant object causes issues with some test plans
    if (variant && Object.keys(variant).length > 0) {
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

    // Only pass variant if it has actual properties
    // Some test plans (like oidcc-config-certification-test-plan) set variants internally
    // and passing them again causes ClassCastException on the server
    if (variant && Object.keys(variant).length > 0) {
      params.set('variant', JSON.stringify(variant));
    }

    // When creating a test from a plan, we don't send a request body
    // Don't include Content-Type header when there's no body to avoid ClassCastException
    const response = await fetch(
      `${this.serverUrl}/api/runner?${params.toString()}`,
      {
        method: 'POST',
        headers: {
          Authorization: this.headers.Authorization,
        },
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

  // ============================================================
  // Image API - For uploading screenshots/evidence to test logs
  // ============================================================

  /**
   * Get all images for a test
   */
  async getTestImages(moduleId: string): Promise<Array<{ placeholder: string; description?: string }>> {
    const response = await fetch(`${this.serverUrl}/api/log/${moduleId}/images`, {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`Failed to get test images: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Upload an image to a test log
   * @param moduleId - The test module ID
   * @param imageData - Base64 encoded image data
   * @param description - Optional description for the image
   */
  async uploadImage(
    moduleId: string,
    imageData: string,
    description?: string
  ): Promise<void> {
    const params = new URLSearchParams();
    if (description) {
      params.set('description', description);
    }

    const url = `${this.serverUrl}/api/log/${moduleId}/images${params.toString() ? '?' + params.toString() : ''}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.headers,
        'Content-Type': 'text/plain;charset=UTF-8',
      },
      body: imageData, // Send raw Data URI string, not JSON-encoded
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to upload image: ${response.status} ${errorText}`);
    }
  }

  /**
   * Upload an image to an existing log entry placeholder
   * This is used when a test creates a placeholder for an image during execution
   * @param moduleId - The test module ID
   * @param placeholder - The placeholder ID created during test execution
   * @param imageData - Base64 encoded image data
   */
  async uploadImageToPlaceholder(
    moduleId: string,
    placeholder: string,
    imageData: string
  ): Promise<void> {
    const response = await fetch(
      `${this.serverUrl}/api/log/${moduleId}/images/${encodeURIComponent(placeholder)}`,
      {
        method: 'POST',
        headers: {
          ...this.headers,
          'Content-Type': 'text/plain;charset=UTF-8',
        },
        body: imageData, // Send raw Data URI string, not JSON-encoded
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to upload image to placeholder: ${response.status} ${errorText}`);
    }
  }

  /**
   * Upload a screenshot file to a test log
   * @param moduleId - The test module ID
   * @param filePath - Path to the screenshot file
   * @param description - Optional description for the image
   */
  async uploadScreenshot(
    moduleId: string,
    filePath: string,
    description?: string
  ): Promise<void> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const imageBuffer = await fs.readFile(filePath);
    const base64Data = imageBuffer.toString('base64');

    // Determine MIME type from file extension
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';

    // API expects Data URI format: data:image/png;base64,<base64data>
    const dataUri = `data:${mimeType};base64,${base64Data}`;
    await this.uploadImage(moduleId, dataUri, description);
  }

  /**
   * Upload a screenshot file to an existing log entry placeholder
   * @param moduleId - The test module ID
   * @param placeholder - The placeholder ID created during test execution
   * @param filePath - Path to the screenshot file
   */
  async uploadScreenshotToPlaceholder(
    moduleId: string,
    placeholder: string,
    filePath: string
  ): Promise<void> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const imageBuffer = await fs.readFile(filePath);
    const base64Data = imageBuffer.toString('base64');

    // Determine MIME type from file extension
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';

    // API expects Data URI format: data:image/png;base64,<base64data>
    const dataUri = `data:${mimeType};base64,${base64Data}`;
    await this.uploadImageToPlaceholder(moduleId, placeholder, dataUri);
  }

  /**
   * Find image placeholders in test logs that need to be filled
   * @param moduleId - The test module ID
   * @returns Array of placeholder IDs that need images
   */
  async findImagePlaceholders(moduleId: string): Promise<string[]> {
    const logs = await this.getTestLog(moduleId);
    const placeholders: string[] = [];

    for (const log of logs) {
      // Look for upload field which contains placeholder information
      // The upload field can be either a string (placeholder ID) or an object with placeholder property
      if (log.upload) {
        if (typeof log.upload === 'string') {
          // Direct placeholder ID
          placeholders.push(log.upload);
        } else if (typeof log.upload === 'object') {
          const uploadInfo = log.upload as Record<string, unknown>;
          if (uploadInfo.placeholder && typeof uploadInfo.placeholder === 'string') {
            placeholders.push(uploadInfo.placeholder);
          }
        }
      }
    }

    return placeholders;
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
