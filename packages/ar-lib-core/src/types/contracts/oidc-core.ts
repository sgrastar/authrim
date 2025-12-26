/**
 * OIDC Core Node Constants
 *
 * Constants and types for OIDC Core nodes.
 * These nodes are fixed by the OIDC specification and cannot be customized.
 */

// =============================================================================
// OIDC Core Node Constants
// =============================================================================

/**
 * OIDC Core nodes - immutable, cannot be edited.
 * These represent the standard OIDC endpoints and processing.
 */
export const OIDC_CORE_NODES = [
  'oidc.authorize',
  'oidc.token',
  'oidc.refresh',
  'oidc.logout',
  'oidc.introspection',
  'oidc.revocation',
  'oidc.userinfo',
] as const;

export type OidcCoreNode = (typeof OIDC_CORE_NODES)[number];

/**
 * Configurable OIDC nodes - can be customized within policy bounds.
 */
export const CONFIGURABLE_OIDC_NODES = ['oidc.consent'] as const;

export type ConfigurableOidcNode = (typeof CONFIGURABLE_OIDC_NODES)[number];

/**
 * All OIDC nodes (core + configurable).
 */
export const ALL_OIDC_NODES = [...OIDC_CORE_NODES, ...CONFIGURABLE_OIDC_NODES] as const;

export type OidcNode = OidcCoreNode | ConfigurableOidcNode;

// =============================================================================
// OIDC Node Definitions
// =============================================================================

/**
 * OIDC Core node definition.
 */
export interface OidcCoreNodeDefinition {
  /** Node ID */
  id: OidcCoreNode;
  /** Display name (Japanese) */
  displayName: string;
  /** Display name (English) */
  displayNameEn: string;
  /** Description (Japanese) */
  description: string;
  /** Description (English) */
  descriptionEn: string;
  /** RFC reference */
  rfc?: string;
  /** RFC URL */
  rfcUrl?: string;
  /** Whether this node is read-only in flow designer */
  readonly: true;
  /** HTTP method */
  httpMethod?: 'GET' | 'POST';
  /** Endpoint path pattern */
  endpointPath?: string;
}

/**
 * OIDC Core node registry with definitions.
 */
export const OIDC_CORE_NODE_REGISTRY: Record<OidcCoreNode, OidcCoreNodeDefinition> = {
  'oidc.authorize': {
    id: 'oidc.authorize',
    displayName: '認可エンドポイント',
    displayNameEn: 'Authorization Endpoint',
    description: 'OAuth 2.0認可リクエストを処理し、認証フローを開始します',
    descriptionEn: 'Processes OAuth 2.0 authorization requests and initiates authentication flow',
    rfc: 'RFC 6749 Section 3.1',
    rfcUrl: 'https://www.rfc-editor.org/rfc/rfc6749#section-3.1',
    readonly: true,
    httpMethod: 'GET',
    endpointPath: '/authorize',
  },
  'oidc.token': {
    id: 'oidc.token',
    displayName: 'トークンエンドポイント',
    displayNameEn: 'Token Endpoint',
    description: '認可コードをアクセストークン・IDトークンに交換します',
    descriptionEn: 'Exchanges authorization code for access token and ID token',
    rfc: 'RFC 6749 Section 3.2',
    rfcUrl: 'https://www.rfc-editor.org/rfc/rfc6749#section-3.2',
    readonly: true,
    httpMethod: 'POST',
    endpointPath: '/token',
  },
  'oidc.refresh': {
    id: 'oidc.refresh',
    displayName: 'トークンリフレッシュ',
    displayNameEn: 'Token Refresh',
    description: 'リフレッシュトークンを使用して新しいアクセストークンを発行します',
    descriptionEn: 'Issues new access token using refresh token',
    rfc: 'RFC 6749 Section 6',
    rfcUrl: 'https://www.rfc-editor.org/rfc/rfc6749#section-6',
    readonly: true,
    httpMethod: 'POST',
    endpointPath: '/token',
  },
  'oidc.logout': {
    id: 'oidc.logout',
    displayName: 'ログアウトエンドポイント',
    displayNameEn: 'End Session Endpoint',
    description: 'ユーザーセッションを終了し、ログアウト処理を実行します',
    descriptionEn: 'Terminates user session and performs logout',
    rfc: 'OpenID Connect RP-Initiated Logout 1.0',
    rfcUrl: 'https://openid.net/specs/openid-connect-rpinitiated-1_0.html',
    readonly: true,
    httpMethod: 'GET',
    endpointPath: '/logout',
  },
  'oidc.introspection': {
    id: 'oidc.introspection',
    displayName: 'イントロスペクションエンドポイント',
    displayNameEn: 'Introspection Endpoint',
    description: 'トークンの有効性と属性を検証します',
    descriptionEn: 'Validates token and returns its attributes',
    rfc: 'RFC 7662',
    rfcUrl: 'https://www.rfc-editor.org/rfc/rfc7662',
    readonly: true,
    httpMethod: 'POST',
    endpointPath: '/introspect',
  },
  'oidc.revocation': {
    id: 'oidc.revocation',
    displayName: 'トークン取り消しエンドポイント',
    displayNameEn: 'Token Revocation Endpoint',
    description: 'アクセストークンまたはリフレッシュトークンを無効化します',
    descriptionEn: 'Invalidates access token or refresh token',
    rfc: 'RFC 7009',
    rfcUrl: 'https://www.rfc-editor.org/rfc/rfc7009',
    readonly: true,
    httpMethod: 'POST',
    endpointPath: '/revoke',
  },
  'oidc.userinfo': {
    id: 'oidc.userinfo',
    displayName: 'UserInfoエンドポイント',
    displayNameEn: 'UserInfo Endpoint',
    description: 'アクセストークンを使用してユーザー情報を取得します',
    descriptionEn: 'Retrieves user information using access token',
    rfc: 'OpenID Connect Core 1.0 Section 5.3',
    rfcUrl: 'https://openid.net/specs/openid-connect-core-1_0.html#UserInfo',
    readonly: true,
    httpMethod: 'GET',
    endpointPath: '/userinfo',
  },
};

// =============================================================================
// Configurable Node Definition
// =============================================================================

/**
 * Configurable OIDC node definition.
 */
export interface ConfigurableOidcNodeDefinition {
  /** Node ID */
  id: ConfigurableOidcNode;
  /** Display name (Japanese) */
  displayName: string;
  /** Display name (English) */
  displayNameEn: string;
  /** Description (Japanese) */
  description: string;
  /** Description (English) */
  descriptionEn: string;
  /** RFC reference */
  rfc?: string;
  /** Whether this node is read-only in flow designer */
  readonly: false;
  /** Configurable options */
  configurableOptions: string[];
}

/**
 * Configurable OIDC node registry.
 */
export const CONFIGURABLE_OIDC_NODE_REGISTRY: Record<
  ConfigurableOidcNode,
  ConfigurableOidcNodeDefinition
> = {
  'oidc.consent': {
    id: 'oidc.consent',
    displayName: '同意画面',
    displayNameEn: 'Consent Screen',
    description: 'ユーザーにスコープ・権限の同意を求める画面',
    descriptionEn: 'Screen requesting user consent for scopes and permissions',
    rfc: 'OpenID Connect Core 1.0 Section 3.1.2.4',
    readonly: false,
    configurableOptions: [
      'policy', // always, remember, skip
      'rememberDuration',
      'implicitScopes',
      'scopeDescriptions',
      'brandingOverride',
    ],
  },
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if a node ID is an OIDC Core node.
 */
export function isOidcCoreNode(nodeId: string): nodeId is OidcCoreNode {
  return OIDC_CORE_NODES.includes(nodeId as OidcCoreNode);
}

/**
 * Check if a node ID is a configurable OIDC node.
 */
export function isConfigurableOidcNode(nodeId: string): nodeId is ConfigurableOidcNode {
  return CONFIGURABLE_OIDC_NODES.includes(nodeId as ConfigurableOidcNode);
}

/**
 * Check if a node ID is any OIDC node.
 */
export function isOidcNode(nodeId: string): nodeId is OidcNode {
  return isOidcCoreNode(nodeId) || isConfigurableOidcNode(nodeId);
}

/**
 * Check if a node is read-only (cannot be edited in flow designer).
 */
export function isReadOnlyNode(nodeId: string): boolean {
  return isOidcCoreNode(nodeId);
}

/**
 * Get node definition by ID.
 */
export function getOidcNodeDefinition(nodeId: OidcCoreNode): OidcCoreNodeDefinition;
export function getOidcNodeDefinition(nodeId: ConfigurableOidcNode): ConfigurableOidcNodeDefinition;
export function getOidcNodeDefinition(
  nodeId: OidcNode
): OidcCoreNodeDefinition | ConfigurableOidcNodeDefinition;
export function getOidcNodeDefinition(
  nodeId: string
): OidcCoreNodeDefinition | ConfigurableOidcNodeDefinition | undefined;
export function getOidcNodeDefinition(
  nodeId: string
): OidcCoreNodeDefinition | ConfigurableOidcNodeDefinition | undefined {
  if (isOidcCoreNode(nodeId)) {
    return OIDC_CORE_NODE_REGISTRY[nodeId];
  }
  if (isConfigurableOidcNode(nodeId)) {
    return CONFIGURABLE_OIDC_NODE_REGISTRY[nodeId];
  }
  return undefined;
}

/**
 * Get all OIDC node definitions for flow designer display.
 */
export function getAllOidcNodeDefinitions(): (
  | OidcCoreNodeDefinition
  | ConfigurableOidcNodeDefinition
)[] {
  return [
    ...Object.values(OIDC_CORE_NODE_REGISTRY),
    ...Object.values(CONFIGURABLE_OIDC_NODE_REGISTRY),
  ];
}
