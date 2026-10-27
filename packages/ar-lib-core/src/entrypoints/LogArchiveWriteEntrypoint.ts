import { WorkerEntrypoint } from 'cloudflare:workers';
import { LOG_ARCHIVE_PRODUCER_COMPONENTS } from '@authrim/ar-lib-logging/iceberg/capabilities';
import type { Env } from '../types/env';
import { assertLogIcebergActivated, resolveLogIcebergConfig } from '../services/log-iceberg-config';
import {
  createLogIcebergWritePort,
  captureLogIcebergRequest,
  type LogArchiveWriteServiceBinding,
  type LogIcebergQueueReference,
  type LogIcebergWriteRequest,
} from '../services/log-iceberg-runtime';
import { runTenantBackupCoveredEffect } from '../services/tenant-portability/covered-mutation';
import type { LogIcebergPolicyArtifactRequest } from '../services/log-iceberg-policy-artifacts';
import type {
  SignInAttemptLogCommit,
  SignInAttemptLogReservation,
} from '../services/log-iceberg-sign-in-attempt';

import type {
  CoreLogPublicationIdentity,
  CoreLogPublicationPreparation,
  CoreLogPublicationRequest,
  CoreLogPublicationReconcile,
} from '../services/log-iceberg-core-publication';

interface LogArchiveRpcProps {
  caller: string;
  audience: 'authrim-log-archive-v1';
  environmentId: string;
}

/** Internal named binding only. No fetch route or new deployed Worker. */
export class LogArchiveWriteEntrypoint extends WorkerEntrypoint<Env, LogArchiveRpcProps> {
  private mutate<T>(tenantId: string, run: () => Promise<T>): Promise<T> {
    return runTenantBackupCoveredEffect(
      { CONTROL: this.env.CONTROL, TENANT_BACKUP_WRAPPING_KEY: 'required' },
      { tenantId },
      run
    );
  }
  private port(): LogArchiveWriteServiceBinding {
    const props = this.ctx.props;
    if (
      !props ||
      props.audience !== 'authrim-log-archive-v1' ||
      !LOG_ARCHIVE_PRODUCER_COMPONENTS.some((component) => component === props.caller) ||
      !this.env.AUTHRIM_ENVIRONMENT_NAME ||
      props.environmentId !== this.env.AUTHRIM_ENVIRONMENT_NAME
    )
      throw new Error('log_iceberg_rpc_caller_denied');
    const config = resolveLogIcebergConfig(this.env);
    assertLogIcebergActivated(config);
    return createLogIcebergWritePort(this.env, config);
  }

  registerPiiPurgeScope(tenantId: string): Promise<void> {
    const port = this.port();
    return this.mutate(tenantId, () => port.registerPiiPurgeScope(tenantId));
  }
  resolveTenantKey(tenantId: string): Promise<string> {
    return this.port().resolveTenantKey(tenantId);
  }
  reserveCorePublication(input: Omit<CoreLogPublicationIdentity, 'sourceToken'>) {
    const port = this.port(),
      captured = { ...input, source: { ...input.source } };
    return this.mutate(captured.tenantId, () => port.reserveCorePublication(captured));
  }
  prepareCorePublication(input: CoreLogPublicationPreparation): Promise<void> {
    const port = this.port();
    const captured = {
      ...input,
      source: { ...input.source },
      record: captureLogIcebergRequest({
        tenantId: input.tenantId,
        storageGeneration: input.storageGeneration,
        records: [input.record],
      }).records[0],
    };
    // The source-bound durable publication permit covers this continuation, including DR draining.
    return port.prepareCorePublication(captured);
  }
  publishCorePublication(input: CoreLogPublicationRequest) {
    const port = this.port(),
      captured = { ...input };
    return port.publishCorePublication(captured);
  }
  reconcileCorePublications(input: CoreLogPublicationReconcile = {}) {
    // The port acquires one tenant admission permit per bounded item.
    return this.port().reconcileCorePublications({ ...input });
  }
  reserveSignInAttempt(input: SignInAttemptLogReservation): Promise<{ failedAt: number }> {
    const port = this.port();
    const captured = { ...input };
    if (
      !captured.tenantId ||
      captured.tenantId.length > 256 ||
      !/^sia:v1:[a-f0-9]{64}$/u.test(captured.eventId) ||
      !Number.isSafeInteger(captured.failedAt) ||
      captured.failedAt < 0 ||
      !/^[a-f0-9]{64}$/u.test(captured.logicalHmac)
    )
      throw new Error('log_sign_in_attempt_scope_invalid');
    return this.mutate(captured.tenantId, () => port.reserveSignInAttempt(captured));
  }
  commitSignInAttempt(input: SignInAttemptLogCommit): Promise<void> {
    const port = this.port();
    const captured = captureLogIcebergRequest({
      tenantId: input.tenantId,
      storageGeneration: input.record.storage_generation,
      records: [input.record],
    });
    const eventId = input.eventId;
    return this.mutate(captured.tenantId, () =>
      port.commitSignInAttempt({
        tenantId: captured.tenantId,
        eventId,
        record: captured.records[0],
      })
    );
  }
  readPolicyArtifact(input: LogIcebergPolicyArtifactRequest): Promise<string | null> {
    return this.port().readPolicyArtifact({ ...input });
  }
  writeRecords(request: LogIcebergWriteRequest): Promise<{ stored: number; queued: number }> {
    const port = this.port();
    const captured = captureLogIcebergRequest(request);
    return this.mutate(captured.tenantId, () => port.writeRecords(captured));
  }
  preparePipelineReferences(request: LogIcebergWriteRequest): Promise<LogIcebergQueueReference[]> {
    const port = this.port();
    const captured = captureLogIcebergRequest(request);
    return this.mutate(captured.tenantId, () => port.preparePipelineReferences(captured));
  }
  dispatchPipelineReferences(input: {
    tenantId: string;
    references: LogIcebergQueueReference[];
  }): Promise<void> {
    const port = this.port();
    const tenantId = input.tenantId;
    const references = input.references.map((ref) => ({ ...ref }));
    return this.mutate(tenantId, () => port.dispatchPipelineReferences({ tenantId, references }));
  }
}
