import type { ClientMetadata, DeviceSecretPolicyErrorDetailCode } from '@authrim/ar-lib-core';

export type DeviceSecretCallerClass =
  | 'native_public_client'
  | 'public_client'
  | 'confidential_or_service_client';

export type DeviceSecretPolicyErrorCode = DeviceSecretPolicyErrorDetailCode;

export type DeviceSecretPolicyDecision =
  | {
      allowed: true;
      callerClass: DeviceSecretCallerClass;
    }
  | {
      allowed: false;
      callerClass: DeviceSecretCallerClass;
      code: DeviceSecretPolicyErrorCode;
      description: string;
    };

type DeviceSecretPolicyMetadata = ClientMetadata & {
  device_secret_revoke_enabled?: boolean;
  device_secret_introspection_enabled?: boolean;
  device_secret_revoke_trust_groups?: string[];
  device_secret_introspection_trust_groups?: string[];
};

export interface DeviceSecretPolicyTarget {
  clientId?: string | null;
  trustGroupId?: string | null;
}

export function resolveDeviceSecretCallerClass(
  clientMetadata: ClientMetadata
): DeviceSecretCallerClass {
  const isPublicClient = !clientMetadata.client_secret_hash;
  if (isPublicClient && clientMetadata.application_type === 'native') {
    return 'native_public_client';
  }
  if (isPublicClient) {
    return 'public_client';
  }
  return 'confidential_or_service_client';
}

export function evaluateDeviceSecretRevokePolicy(
  clientMetadata: ClientMetadata,
  target: DeviceSecretPolicyTarget = {}
): DeviceSecretPolicyDecision {
  const callerClass = resolveDeviceSecretCallerClass(clientMetadata);
  const policyMetadata = clientMetadata as DeviceSecretPolicyMetadata;
  const ownDeviceSecret = isOwnDeviceSecret(clientMetadata, target);

  if (callerClass === 'native_public_client' && ownDeviceSecret) {
    return { allowed: true, callerClass };
  }

  if (
    callerClass === 'confidential_or_service_client' &&
    ownDeviceSecret &&
    policyMetadata.device_secret_revoke_enabled === true
  ) {
    return { allowed: true, callerClass };
  }

  if (
    callerClass === 'confidential_or_service_client' &&
    isTrustGroupAllowlisted(
      clientMetadata,
      target,
      policyMetadata.device_secret_revoke_trust_groups
    )
  ) {
    return { allowed: true, callerClass };
  }

  return {
    allowed: false,
    callerClass,
    code: 'revoke_disabled',
    description: 'Device secret revocation is disabled for this caller',
  };
}

export function evaluateDeviceSecretIntrospectionPolicy(
  clientMetadata: ClientMetadata,
  target: DeviceSecretPolicyTarget = {}
): DeviceSecretPolicyDecision {
  const callerClass = resolveDeviceSecretCallerClass(clientMetadata);
  const policyMetadata = clientMetadata as DeviceSecretPolicyMetadata;

  if (callerClass !== 'confidential_or_service_client') {
    return {
      allowed: false,
      callerClass,
      code: 'unauthorized_introspection_caller',
      description: 'This caller is not authorized to introspect device secrets',
    };
  }

  if (policyMetadata.device_secret_introspection_enabled === false) {
    return {
      allowed: false,
      callerClass,
      code: 'introspection_disabled',
      description: 'Device secret introspection is disabled for this caller',
    };
  }

  const ownDeviceSecret = isOwnDeviceSecret(clientMetadata, target);
  if (!ownDeviceSecret) {
    if (
      isTrustGroupAllowlisted(
        clientMetadata,
        target,
        policyMetadata.device_secret_introspection_trust_groups
      )
    ) {
      return { allowed: true, callerClass };
    }

    return {
      allowed: false,
      callerClass,
      code: 'unauthorized_introspection_caller',
      description: 'This caller is not authorized to introspect device secrets',
    };
  }

  return { allowed: true, callerClass };
}

function getClientTrustGroup(clientMetadata: ClientMetadata): string | undefined {
  return clientMetadata.trust_group_id ?? clientMetadata.trust_group;
}

function isOwnDeviceSecret(
  clientMetadata: ClientMetadata,
  target: DeviceSecretPolicyTarget
): boolean {
  return !target.clientId || target.clientId === clientMetadata.client_id;
}

function isTrustGroupAllowlisted(
  clientMetadata: ClientMetadata,
  target: DeviceSecretPolicyTarget,
  allowlist: string[] | undefined
): boolean {
  const callerTrustGroup = getClientTrustGroup(clientMetadata);
  if (!callerTrustGroup || !target.trustGroupId || callerTrustGroup !== target.trustGroupId) {
    return false;
  }
  return Boolean(allowlist?.includes('*') || allowlist?.includes(target.trustGroupId));
}
