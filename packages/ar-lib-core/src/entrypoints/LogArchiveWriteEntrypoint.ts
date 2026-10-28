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
import { runSamlDrCoveredOperation } from '../services/tenant-portability/saml-dr-writer';
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
  private mutate<T>(
    tenantId: string,
    run: (port: LogArchiveWriteServiceBinding) => Promise<T>
  ): Promise<T> {
    this.assertCaller();
    return runSamlDrCoveredOperation(this.env, this.ctx, (covered) =>
      runTenantBackupCoveredEffect(
        Object.assign({}, covered, { TENANT_BACKUP_WRAPPING_KEY: 'required' }),
        { tenantId },
        () => run(this.port(covered))
      )
    );
  }
  private assertCaller(): void {
    const props = this.ctx.props;
    if (
      !props ||
      props.audience !== 'authrim-log-archive-v1' ||
      !LOG_ARCHIVE_PRODUCER_COMPONENTS.some((component) => component === props.caller) ||
      !this.env.AUTHRIM_ENVIRONMENT_NAME ||
      props.environmentId !== this.env.AUTHRIM_ENVIRONMENT_NAME
    )
      throw new Error('log_iceberg_rpc_caller_denied');
  }
  private port(env = this.env): LogArchiveWriteServiceBinding {
    this.assertCaller();
    const config = resolveLogIcebergConfig(env);
    assertLogIcebergActivated(config);
    return createLogIcebergWritePort(env, config);
  }

  registerPiiPurgeScope(tenantId: string): Promise<void> {
    return this.mutate(tenantId, (port) => port.registerPiiPurgeScope(tenantId));
  }
  resolveTenantKey(tenantId: string): Promise<string> {
    return this.port().resolveTenantKey(tenantId);
  }
  reserveCorePublication(input: Omit<CoreLogPublicationIdentity, 'sourceToken'>) {
    const captured = { ...input, source: { ...input.source } };
    return this.mutate(captured.tenantId, (port) => port.reserveCorePublication(captured));
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
    // The port verifies the source identity and resumes its durable environment admission.
    // A fresh environment permit here would deadlock an already draining backup.
    return port.prepareCorePublication(captured);
  }
  publishCorePublication(input: CoreLogPublicationRequest) {
    const port = this.port(),
      captured = { ...input };
    return port.publishCorePublication(captured);
  }
  reconcileCorePublications(input: CoreLogPublicationReconcile = {}) {
    // Each bounded item resumes its verified durable environment admission in the port.
    return this.port().reconcileCorePublications({ ...input });
  }
  reserveSignInAttempt(input: SignInAttemptLogReservation): Promise<{ failedAt: number }> {
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
    return this.mutate(captured.tenantId, (port) => port.reserveSignInAttempt(captured));
  }
  commitSignInAttempt(input: SignInAttemptLogCommit): Promise<void> {
    const captured = captureLogIcebergRequest({
      tenantId: input.tenantId,
      storageGeneration: input.record.storage_generation,
      records: [input.record],
    });
    const eventId = input.eventId;
    return this.mutate(captured.tenantId, (port) =>
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
    const captured = captureLogIcebergRequest(request);
    return this.mutate(captured.tenantId, (port) => port.writeRecords(captured));
  }
  preparePipelineReferences(request: LogIcebergWriteRequest): Promise<LogIcebergQueueReference[]> {
    const captured = captureLogIcebergRequest(request);
    return this.mutate(captured.tenantId, (port) => port.preparePipelineReferences(captured));
  }
  dispatchPipelineReferences(input: {
    tenantId: string;
    references: LogIcebergQueueReference[];
  }): Promise<void> {
    const tenantId = input.tenantId;
    const references = input.references.map((ref) => ({ ...ref }));
    return this.mutate(tenantId, (port) =>
      port.dispatchPipelineReferences({ tenantId, references })
    );
  }
}

/** Literal inventory: publication continuations enforce coverage inside their verified port. */
export const SAML_DR_WRITER_SURFACES = [
  'rpc:LogArchiveWriteEntrypoint.registerPiiPurgeScope',
  'rpc:LogArchiveWriteEntrypoint.reserveCorePublication',
  'rpc:LogArchiveWriteEntrypoint.prepareCorePublication',
  'rpc:LogArchiveWriteEntrypoint.publishCorePublication',
  'rpc:LogArchiveWriteEntrypoint.reconcileCorePublications',
  'rpc:LogArchiveWriteEntrypoint.reserveSignInAttempt',
  'rpc:LogArchiveWriteEntrypoint.commitSignInAttempt',
  'rpc:LogArchiveWriteEntrypoint.writeRecords',
  'rpc:LogArchiveWriteEntrypoint.preparePipelineReferences',
  'rpc:LogArchiveWriteEntrypoint.dispatchPipelineReferences',
] as const;
export const SAML_DR_READ_ONLY_SURFACES = [
  'rpc:LogArchiveWriteEntrypoint.resolveTenantKey',
  'rpc:LogArchiveWriteEntrypoint.readPolicyArtifact',
] as const;
