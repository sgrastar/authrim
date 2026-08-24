import { describe, expect, it } from 'vitest';
import { updateDeploymentProgress } from '../core/deployment-progress.js';

describe('updateDeploymentProgress', () => {
  it('uses a fixed ten-phase denominator and never moves backwards', () => {
    const started = updateDeploymentProgress(
      null,
      'Deploying workers...',
      new Date('2026-08-24T00:00:00.000Z')
    );
    const later = updateDeploymentProgress(
      started,
      'Refreshing wrangler.toml files...',
      new Date('2026-08-24T00:00:01.000Z')
    );

    expect(started).toMatchObject({ step: 4, totalSteps: 10, phase: 'workers' });
    expect(later).toMatchObject({ step: 4, totalSteps: 10, phase: 'workers' });
    expect(later.startedAt).toBe(started.startedAt);
  });

  it('distinguishes propagation waits, optional warnings, and real failures', () => {
    const waiting = updateDeploymentProgress(
      null,
      'Waiting for tenant routing and runtime discovery; retrying in 2s...'
    );
    const warning = updateDeploymentProgress(
      waiting,
      'Optional downstream grant introspection was deferred'
    );
    const warningDetail = updateDeploymentProgress(
      warning,
      'Core login, Admin UI, and token issuance remain available.'
    );
    const warningFailure = updateDeploymentProgress(
      warningDetail,
      'Warning: optional integration failed and was deferred'
    );
    const failed = updateDeploymentProgress(warningFailure, '❌ Deployment failed: build failed');

    expect(waiting).toMatchObject({ step: 8, status: 'waiting' });
    expect(warning).toMatchObject({ step: 9, status: 'warning' });
    expect(warningDetail).toMatchObject({ step: 9, status: 'warning' });
    expect(warningFailure).toMatchObject({ step: 9, status: 'warning' });
    expect(failed).toMatchObject({ step: 9, status: 'error' });
  });

  it('keeps transient retry failures in a waiting state instead of showing a terminal error', () => {
    const deployRetry = updateDeploymentProgress(
      null,
      '✗ Attempt 1 failed: Cloudflare API temporarily unavailable'
    );
    const healthRetry = updateDeploymentProgress(
      deployRetry,
      'Worker HTTP health pending (2 failed). Retrying in 1.0s...'
    );

    expect(deployRetry).toMatchObject({ status: 'waiting' });
    expect(healthRetry).toMatchObject({ step: 5, phase: 'verification', status: 'waiting' });
  });

  it('keeps manual wildcard DNS recovery in the routing phase for status reconnection', () => {
    const workers = updateDeploymentProgress(null, 'Deploying workers...');
    const manualDns = updateDeploymentProgress(
      workers,
      '⚠️ Automatic wildcard DNS setup is unavailable.'
    );

    expect(manualDns).toMatchObject({ step: 8, phase: 'routing', status: 'warning' });
  });

  it('does not mistake a normal ar-userinfo Worker deployment for the integrations phase', () => {
    expect(updateDeploymentProgress(null, 'Deploying worker: ar-userinfo')).toMatchObject({
      step: 4,
      phase: 'workers',
      status: 'running',
    });
  });

  it('marks the final phase complete', () => {
    expect(updateDeploymentProgress(null, 'Deployment complete!')).toMatchObject({
      step: 10,
      totalSteps: 10,
      phase: 'ui',
      status: 'complete',
    });
  });

  it('does not treat a zero-failure deployment summary as an error', () => {
    const workers = updateDeploymentProgress(null, 'Deploying workers...');
    const summary = updateDeploymentProgress(workers, 'Failed: 0');
    const complete = updateDeploymentProgress(summary, 'Deployment complete!');

    expect(summary).toMatchObject({ step: 4, phase: 'workers', status: 'running' });
    expect(complete).toMatchObject({ step: 10, phase: 'ui', status: 'complete' });
  });

  it('keeps completion terminal when trailing log metadata arrives', () => {
    const complete = updateDeploymentProgress(null, 'Deployment complete!');
    const logSaved = updateDeploymentProgress(
      complete,
      'Progress log saved: /tmp/authrim-deploy.log'
    );

    expect(logSaved).toMatchObject({ step: 10, phase: 'ui', status: 'complete' });
  });

  it('follows the real initial-deploy order without jumping on preparatory messages', () => {
    const messages = [
      'Loaded locked config from /tmp/authrim/.authrim/test/config.json',
      'Prepared 23 secret value(s) for Worker deployment.',
      'Running exact release migrations before Worker deployment...',
      'Exact release migrations completed before Worker deployment',
      'Initial Control Plane bindings and schema state ready (3 created)',
      'Building ar-login-ui...',
      'ar-login-ui deployed as UI Worker: test-ar-login-ui',
      'Deploying workers...',
      'Verifying Worker deployments are visible (15 workers)...',
      'Waiting for Control bootstrap verification of 15 Worker(s)...',
      'Ensuring initial tenant exists (first)...',
      'Checking tenant routing for optional integrations...',
      'Configuring downstream grant introspection...',
      'Deploying Login/Admin UI to Cloudflare Workers...',
    ];
    const expectedSteps = [1, 1, 2, 2, 3, 3, 3, 4, 5, 6, 7, 8, 9, 10];
    let snapshot = null;

    for (const [index, message] of messages.entries()) {
      snapshot = updateDeploymentProgress(snapshot, message);
      expect(snapshot.step, message).toBe(expectedSteps[index]);
    }
  });
});
