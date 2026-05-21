import type { LogPlane, LogType } from '../registry';

export interface LoggingKeyScope {
  tenantKey: string;
  surface?: string;
  logType: LogType;
  plane: LogPlane;
}

export {
  activateCredentialRotation,
  finishCredentialRetirement,
  markCredentialRotationReady,
  prepareCredentialRotation,
  type CredentialRotationActivationResult,
  type CredentialRotationState,
  type CredentialRotationStatus,
} from './credential-rotation';

export {
  D1EncryptedCredentialSecretBackend,
  ExternalCredentialSecretManagerStub,
  R2EncryptedCredentialSecretBackend,
  CredentialSecretBackendError,
  assertCredentialRefVersion,
  buildCredentialSecretRef,
  decryptCredentialSecret,
  encryptCredentialSecret,
  parseCredentialSecretRef,
  type CredentialSecretBackend,
  type CredentialSecretBackendKind,
  type CredentialSecretSqlStore,
  type CredentialSecretR2Bucket,
  type D1EncryptedCredentialSecretBackendOptions,
  type R2EncryptedCredentialSecretBackendOptions,
  type EncryptedCredentialSecretEnvelope,
  type CredentialSecretMaterial,
  type CredentialSecretMetadata,
  type CredentialSecretPutInput,
  type CredentialSecretRefParts,
  type CredentialSecretRefScheme,
  type CredentialSecretRotateInput,
  type CredentialSecretStatus,
} from './credential-secret-backend';

export {
  D1WrappedLoggingKeyMaterialBackend,
  ExternalLoggingKeyMaterialBackendStub,
  LoggingKeyMaterialBackendError,
  R2WrappedLoggingKeyMaterialBackend,
  buildLoggingKeyMaterialRef,
  parseLoggingKeyMaterialRef,
  unwrapLoggingKeyMaterial,
  wrapLoggingKeyMaterial,
  type D1WrappedLoggingKeyMaterialBackendOptions,
  type LoggingKeyMaterial,
  type LoggingKeyMaterialBackend,
  type LoggingKeyMaterialBackendKind,
  type LoggingKeyMaterialPutInput,
  type LoggingKeyMaterialR2Bucket,
  type LoggingKeyMaterialRefParts,
  type LoggingKeyMaterialSqlStore,
  type R2WrappedLoggingKeyMaterialBackendOptions,
  type WrappedLoggingKeyMaterialEnvelope,
} from './key-material-backend';

export {
  buildRuntimeLoggingKeyRegistrySnapshot,
  type LoggingKeyRegistryRow,
  type LoggingKeyRegistryStatus,
  type LoggingKeyVersionRow,
  type LoggingKeyVersionStatus,
  type RuntimeLoggingKeyRegistrySnapshot,
  type RuntimeLoggingKeyVersionSnapshot,
} from './key-registry-snapshot';

export {
  rotateLoggingKeyRegistry,
  type RotateLoggingKeyRegistryInput,
  type RotateLoggingKeyRegistryResult,
} from './key-rotation';

export {
  classifyLoggingRewrapPriority,
  shouldSkipLoggingRewrapForRetention,
  SqlLoggingRewrapJobQueue,
  type ClassifyLoggingRewrapInput,
  type CompleteLoggingRewrapJobInput,
  type EnqueueLoggingRewrapJobInput,
  type LoggingRewrapJobRecord,
  type LoggingRewrapJobStatus,
  type LoggingRewrapPriorityDecision,
  type LoggingRewrapReason,
  type LoggingRewrapRetentionDecisionInput,
  type LoggingRewrapSqlExecutor,
} from './rewrap-policy';
