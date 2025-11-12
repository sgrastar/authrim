/**
 * Storage Abstraction Layer
 *
 * Provides abstract interfaces for storage operations, enabling support for
 * multiple storage backends (KV, D1, Durable Objects, etc.)
 *
 * This foundation is designed for Phase 6, where we will implement
 * full database support for users, sessions, and clients.
 */

/**
 * Base storage interface for all storage operations
 */
export interface IStorage {
  /**
   * Get a value by key
   * @param key - The key to retrieve
   * @returns The value, or null if not found
   */
  get(key: string): Promise<string | null>;

  /**
   * Set a value with optional TTL
   * @param key - The key to set
   * @param value - The value to store
   * @param options - Optional configuration (TTL, metadata, etc.)
   */
  put(key: string, value: string, options?: StorageOptions): Promise<void>;

  /**
   * Delete a value by key
   * @param key - The key to delete
   */
  delete(key: string): Promise<void>;

  /**
   * List keys with optional prefix filtering
   * @param options - List options (prefix, limit, cursor)
   * @returns List result with keys and cursor for pagination
   */
  list(options?: ListOptions): Promise<ListResult>;
}

/**
 * Options for storage operations
 */
export interface StorageOptions {
  /** TTL in seconds (time-to-live) */
  expirationTtl?: number;
  /** Expiration timestamp (Unix timestamp in seconds) */
  expiration?: number;
  /** Metadata to attach to the key */
  metadata?: Record<string, string>;
}

/**
 * Options for listing keys
 */
export interface ListOptions {
  /** Prefix to filter keys */
  prefix?: string;
  /** Maximum number of keys to return */
  limit?: number;
  /** Cursor for pagination */
  cursor?: string;
}

/**
 * Result of a list operation
 */
export interface ListResult {
  /** Array of keys */
  keys: Array<{ name: string; expiration?: number; metadata?: Record<string, string> }>;
  /** Cursor for next page (undefined if no more pages) */
  cursor?: string;
  /** Whether there are more keys to fetch */
  list_complete: boolean;
}

/**
 * User repository interface
 * Manages user accounts and authentication data
 */
export interface IUserRepository {
  /**
   * Get user by ID
   * @param userId - User identifier
   * @returns User object or null if not found
   */
  getById(userId: string): Promise<User | null>;

  /**
   * Get user by email
   * @param email - User email address
   * @returns User object or null if not found
   */
  getByEmail(email: string): Promise<User | null>;

  /**
   * Create a new user
   * @param user - User data
   * @returns Created user with ID
   */
  create(user: Omit<User, 'id' | 'created_at' | 'updated_at'>): Promise<User>;

  /**
   * Update an existing user
   * @param userId - User identifier
   * @param updates - Partial user data to update
   * @returns Updated user
   */
  update(userId: string, updates: Partial<User>): Promise<User>;

  /**
   * Delete a user
   * @param userId - User identifier
   */
  delete(userId: string): Promise<void>;
}

/**
 * User model
 */
export interface User {
  id: string; // Unique user identifier (UUID)
  email: string;
  email_verified: boolean;
  password_hash?: string; // For local authentication
  // Profile claims (OIDC standard claims)
  name?: string;
  family_name?: string;
  given_name?: string;
  middle_name?: string;
  nickname?: string;
  preferred_username?: string;
  profile?: string; // Profile page URL
  picture?: string; // Avatar URL
  website?: string;
  gender?: string;
  birthdate?: string; // YYYY-MM-DD format
  zoneinfo?: string; // Time zone (e.g., 'America/Los_Angeles')
  locale?: string; // Locale (e.g., 'en-US')
  // Phone claims
  phone_number?: string;
  phone_number_verified?: boolean;
  // Address claim
  address?: {
    formatted?: string;
    street_address?: string;
    locality?: string;
    region?: string;
    postal_code?: string;
    country?: string;
  };
  // Audit fields
  created_at: number; // Unix timestamp
  updated_at: number; // Unix timestamp
  last_login_at?: number; // Unix timestamp
  // MFA (Multi-Factor Authentication)
  mfa_enabled?: boolean;
  mfa_secret?: string; // TOTP secret (encrypted)
  // Account status
  is_active: boolean;
  is_locked?: boolean;
  failed_login_attempts?: number;
}

/**
 * Session repository interface
 * Manages user sessions and SSO state
 */
export interface ISessionRepository {
  /**
   * Get session by ID
   * @param sessionId - Session identifier
   * @returns Session object or null if not found
   */
  getById(sessionId: string): Promise<Session | null>;

  /**
   * Create a new session
   * @param session - Session data
   * @returns Created session with ID
   */
  create(session: Omit<Session, 'id'>): Promise<Session>;

  /**
   * Update an existing session
   * @param sessionId - Session identifier
   * @param updates - Partial session data to update
   * @returns Updated session
   */
  update(sessionId: string, updates: Partial<Session>): Promise<Session>;

  /**
   * Delete a session
   * @param sessionId - Session identifier
   */
  delete(sessionId: string): Promise<void>;

  /**
   * Delete all sessions for a user
   * @param userId - User identifier
   */
  deleteAllForUser(userId: string): Promise<void>;

  /**
   * List active sessions for a user
   * @param userId - User identifier
   * @returns Array of active sessions
   */
  listByUser(userId: string): Promise<Session[]>;
}

/**
 * Session model
 */
export interface Session {
  id: string; // Unique session identifier (UUID)
  user_id: string; // User ID this session belongs to
  created_at: number; // Unix timestamp
  expires_at: number; // Unix timestamp
  last_activity_at: number; // Unix timestamp
  // Device/client information
  user_agent?: string;
  ip_address?: string;
  // SSO state
  amr?: string[]; // Authentication Methods References
  acr?: string; // Authentication Context Class Reference
  // Session data (encrypted JSON)
  data?: Record<string, unknown>;
}

/**
 * Client repository interface
 * Manages OAuth 2.0 / OIDC client registrations
 */
export interface IClientRepository {
  /**
   * Get client by ID
   * @param clientId - Client identifier
   * @returns Client metadata or null if not found
   */
  getById(clientId: string): Promise<ClientData | null>;

  /**
   * Create a new client
   * @param client - Client data
   * @returns Created client with ID
   */
  create(client: Omit<ClientData, 'created_at' | 'updated_at'>): Promise<ClientData>;

  /**
   * Update an existing client
   * @param clientId - Client identifier
   * @param updates - Partial client data to update
   * @returns Updated client
   */
  update(clientId: string, updates: Partial<ClientData>): Promise<ClientData>;

  /**
   * Delete a client
   * @param clientId - Client identifier
   */
  delete(clientId: string): Promise<void>;

  /**
   * List all clients (with pagination)
   * @param options - List options
   * @returns Array of clients
   */
  list(options?: { limit?: number; offset?: number }): Promise<ClientData[]>;
}

/**
 * Client data model
 */
export interface ClientData {
  client_id: string;
  client_secret?: string; // Hashed
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  scope?: string;
  // OIDC-specific
  subject_type?: 'public' | 'pairwise';
  sector_identifier_uri?: string;
  // Metadata
  created_at: number;
  updated_at: number;
  // Additional fields from OIDC client registration
  [key: string]: unknown;
}

/**
 * Storage adapter factory
 * Creates storage implementations based on configuration
 */
export interface IStorageAdapterFactory {
  /**
   * Create a key-value storage instance
   * @param config - Storage configuration
   * @returns Storage instance
   */
  createStorage(config: StorageConfig): IStorage;

  /**
   * Create a user repository instance
   * @param config - Storage configuration
   * @returns User repository instance
   */
  createUserRepository(config: StorageConfig): IUserRepository;

  /**
   * Create a session repository instance
   * @param config - Storage configuration
   * @returns Session repository instance
   */
  createSessionRepository(config: StorageConfig): ISessionRepository;

  /**
   * Create a client repository instance
   * @param config - Storage configuration
   * @returns Client repository instance
   */
  createClientRepository(config: StorageConfig): IClientRepository;
}

/**
 * Storage configuration
 */
export interface StorageConfig {
  /** Storage backend type */
  type: 'kv' | 'd1' | 'durable-objects';
  /** Storage backend instance (KVNamespace, D1Database, DurableObjectNamespace, etc.) */
  backend: unknown;
  /** Additional options for the storage backend */
  options?: Record<string, unknown>;
}
