/**
 * Result Processor for OIDC Conformance Tests
 *
 * Processes test results and generates reports
 */

import type {
  TestLog,
  ExpectedFailure,
  ExpectedSkip,
  ProcessedResult,
  ProcessedModuleResult,
  TestSummary,
  UnexpectedFailure,
  ConditionResult,
  TestResult,
  ModuleInfo,
} from './types.js';

export class ResultProcessor {
  /**
   * Process test results and compare against expected failures
   */
  processResults(
    planId: string,
    planName: string,
    modules: ModuleInfo[],
    expectedFailures: ExpectedFailure[] = [],
    expectedSkips: ExpectedSkip[] = []
  ): ProcessedResult {
    const processedModules: ProcessedModuleResult[] = [];
    const unexpectedFailures: UnexpectedFailure[] = [];
    const unexpectedWarnings: UnexpectedFailure[] = [];
    const expectedFailuresMatched: ExpectedFailure[] = [];
    const expectedFailuresUnmatched = [...expectedFailures];

    let totalPassed = 0;
    let totalFailed = 0;
    let totalWarning = 0;
    let totalSkipped = 0;

    for (const module of modules) {
      const logs = module.logs || [];
      const conditions = this.extractConditions(logs);

      // Check for expected failures
      for (const condition of conditions) {
        if (condition.result === 'FAILURE') {
          const expectedFailure = expectedFailures.find(
            (ef) => ef.testId === module.testId && (!ef.condition || ef.condition === condition.src)
          );

          if (expectedFailure) {
            condition.isExpected = true;
            if (!expectedFailuresMatched.includes(expectedFailure)) {
              expectedFailuresMatched.push(expectedFailure);
            }
            // Remove from unmatched list
            const unmatchedIndex = expectedFailuresUnmatched.findIndex(
              (ef) => ef.testId === expectedFailure.testId && ef.condition === expectedFailure.condition
            );
            if (unmatchedIndex > -1) {
              expectedFailuresUnmatched.splice(unmatchedIndex, 1);
            }
          } else {
            unexpectedFailures.push({
              testId: module.testId,
              testName: module.testName,
              condition: condition.src,
              message: condition.message,
            });
          }
        } else if (condition.result === 'WARNING') {
          unexpectedWarnings.push({
            testId: module.testId,
            testName: module.testName,
            condition: condition.src,
            message: condition.message,
          });
        }
      }

      // Count results
      const result = module.result || this.determineResult(conditions);
      switch (result) {
        case 'PASSED':
          totalPassed++;
          break;
        case 'FAILED':
          totalFailed++;
          break;
        case 'WARNING':
          totalWarning++;
          break;
        case 'SKIPPED':
          totalSkipped++;
          break;
      }

      processedModules.push({
        testId: module.testId,
        testName: module.testName,
        status: module.status,
        result,
        conditions,
      });
    }

    const total = modules.length;
    const passRate = total > 0 ? (totalPassed / total) * 100 : 0;

    const summary: TestSummary = {
      total,
      passed: totalPassed,
      failed: totalFailed,
      warning: totalWarning,
      skipped: totalSkipped,
      passRate: Math.round(passRate * 100) / 100,
      duration: 0, // To be calculated from timestamps if available
    };

    return {
      planId,
      planName,
      timestamp: new Date().toISOString(),
      summary,
      modules: processedModules,
      unexpectedFailures,
      unexpectedWarnings,
      expectedFailuresMatched,
      expectedFailuresUnmatched,
    };
  }

  /**
   * Extract conditions from test logs
   */
  private extractConditions(logs: TestLog[]): ConditionResult[] {
    return logs
      .filter((log) => log.result && ['SUCCESS', 'FAILURE', 'WARNING'].includes(log.result))
      .map((log) => ({
        src: log.src,
        result: log.result as 'SUCCESS' | 'FAILURE' | 'WARNING',
        message: log.msg,
        isExpected: false,
      }));
  }

  /**
   * Determine the overall result based on conditions
   */
  private determineResult(conditions: ConditionResult[]): TestResult {
    const hasUnexpectedFailure = conditions.some(
      (c) => c.result === 'FAILURE' && !c.isExpected
    );
    const hasWarning = conditions.some((c) => c.result === 'WARNING');

    if (hasUnexpectedFailure) {
      return 'FAILED';
    }
    if (hasWarning) {
      return 'WARNING';
    }
    return 'PASSED';
  }

  /**
   * Generate a Markdown report
   */
  generateMarkdownReport(result: ProcessedResult): string {
    const lines: string[] = [];

    // Header
    lines.push(`# OIDC Conformance Test Report`);
    lines.push('');
    lines.push(`**Plan ID:** ${result.planId}`);
    lines.push(`**Plan Name:** ${result.planName}`);
    lines.push(`**Timestamp:** ${result.timestamp}`);
    lines.push('');

    // Summary
    lines.push('## Summary');
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total Tests | ${result.summary.total} |`);
    lines.push(`| Passed | ${result.summary.passed} |`);
    lines.push(`| Failed | ${result.summary.failed} |`);
    lines.push(`| Warnings | ${result.summary.warning} |`);
    lines.push(`| Skipped | ${result.summary.skipped} |`);
    lines.push(`| **Pass Rate** | **${result.summary.passRate}%** |`);
    lines.push('');

    // Unexpected Failures
    if (result.unexpectedFailures.length > 0) {
      lines.push('## Unexpected Failures');
      lines.push('');
      lines.push(`| Test ID | Test Name | Condition | Message |`);
      lines.push(`|---------|-----------|-----------|---------|`);
      for (const failure of result.unexpectedFailures) {
        lines.push(
          `| ${failure.testId} | ${failure.testName} | ${failure.condition} | ${this.escapeMarkdown(failure.message)} |`
        );
      }
      lines.push('');
    }

    // Warnings
    if (result.unexpectedWarnings.length > 0) {
      lines.push('## Warnings');
      lines.push('');
      lines.push(`| Test ID | Test Name | Condition | Message |`);
      lines.push(`|---------|-----------|-----------|---------|`);
      for (const warning of result.unexpectedWarnings) {
        lines.push(
          `| ${warning.testId} | ${warning.testName} | ${warning.condition} | ${this.escapeMarkdown(warning.message)} |`
        );
      }
      lines.push('');
    }

    // Expected Failures (Matched)
    if (result.expectedFailuresMatched.length > 0) {
      lines.push('## Expected Failures (Occurred as Expected)');
      lines.push('');
      lines.push(`| Test ID | Reason | Issue |`);
      lines.push(`|---------|--------|-------|`);
      for (const ef of result.expectedFailuresMatched) {
        lines.push(`| ${ef.testId} | ${ef.reason} | ${ef.issue || '-'} |`);
      }
      lines.push('');
    }

    // Expected Failures (Unmatched - might indicate a fix)
    if (result.expectedFailuresUnmatched.length > 0) {
      lines.push('## Expected Failures (Did Not Occur - Possible Fix?)');
      lines.push('');
      lines.push(`| Test ID | Reason | Issue |`);
      lines.push(`|---------|--------|-------|`);
      for (const ef of result.expectedFailuresUnmatched) {
        lines.push(`| ${ef.testId} | ${ef.reason} | ${ef.issue || '-'} |`);
      }
      lines.push('');
    }

    // All Test Results
    lines.push('## Test Results');
    lines.push('');
    lines.push(`| Status | Test ID | Test Name |`);
    lines.push(`|--------|---------|-----------|`);
    for (const module of result.modules) {
      const statusEmoji = this.getStatusEmoji(module.result);
      lines.push(`| ${statusEmoji} | ${module.testId} | ${module.testName} |`);
    }
    lines.push('');

    // Footer
    lines.push('---');
    lines.push('');
    lines.push('Generated by Authrim Conformance Test Automation');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Generate a JSON summary
   */
  generateJsonSummary(result: ProcessedResult): string {
    return JSON.stringify(
      {
        planId: result.planId,
        planName: result.planName,
        timestamp: result.timestamp,
        summary: result.summary,
        unexpectedFailures: result.unexpectedFailures.length,
        unexpectedWarnings: result.unexpectedWarnings.length,
        expectedFailuresMatched: result.expectedFailuresMatched.length,
        expectedFailuresUnmatched: result.expectedFailuresUnmatched.length,
      },
      null,
      2
    );
  }

  /**
   * Determine if the test run was successful
   * A test run is considered successful only if:
   * - No tests failed (including INTERRUPTED which is counted as FAILED)
   * - No unexpected failures occurred
   * - All expected failures were matched
   */
  isSuccessful(result: ProcessedResult): boolean {
    return (
      result.summary.failed === 0 &&
      result.unexpectedFailures.length === 0 &&
      result.expectedFailuresUnmatched.length === 0
    );
  }

  private getStatusEmoji(result: TestResult): string {
    switch (result) {
      case 'PASSED':
        return '✅';
      case 'FAILED':
        return '❌';
      case 'WARNING':
        return '⚠️';
      case 'SKIPPED':
        return '⏭️';
      case 'REVIEW':
        return '👀';
      default:
        return '❓';
    }
  }

  private escapeMarkdown(text: string): string {
    return text
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ')
      .substring(0, 100);
  }
}
