/**
 * Status List Manager
 *
 * Manages Bitstring Status List 2021 lifecycle including:
 * - Creating new status lists
 * - Allocating indices for new credentials
 * - Updating credential status (revoke/suspend/activate)
 * - List rotation when capacity is reached
 *
 * @see https://w3c-ccg.github.io/vc-status-list-2021/
 */

import { StatusValue, getStatusAtIndex } from './status-list';

/**
 * Status list states
 */
export type StatusListState = 'active' | 'sealed' | 'archived';

/**
 * Status list purpose
 */
export type StatusListPurpose = 'revocation' | 'suspension';

/**
 * Status list record from database
 */
export interface StatusListRecord {
  id: string;
  tenant_id: string;
  purpose: StatusListPurpose;
  encoded_list: string;
  current_index: number;
  capacity: number;
  used_count: number;
  state: StatusListState;
  created_at: string;
  updated_at: string;
  sealed_at: string | null;
}

/**
 * Result of index allocation
 */
export interface IndexAllocation {
  listId: string;
  index: number;
}

/**
 * Database adapter interface for status list storage
 */
export interface StatusListRepository {
  /**
   * Find active status list for tenant/purpose
   */
  findActiveList(tenantId: string, purpose: StatusListPurpose): Promise<StatusListRecord | null>;

  /**
   * Find status list by ID
   */
  findById(listId: string): Promise<StatusListRecord | null>;

  /**
   * Create new status list
   */
  create(record: Omit<StatusListRecord, 'created_at' | 'updated_at'>): Promise<void>;

  /**
   * Update status list
   */
  update(
    listId: string,
    updates: Partial<Pick<StatusListRecord, 'encoded_list' | 'used_count' | 'state' | 'sealed_at'>>
  ): Promise<void>;

  /**
   * Increment used_count and return new count (atomic)
   */
  incrementUsedCount(listId: string): Promise<number>;

  /**
   * List all status lists for tenant
   */
  listByTenant(
    tenantId: string,
    options?: { purpose?: StatusListPurpose; state?: StatusListState }
  ): Promise<StatusListRecord[]>;
}

/**
 * Default capacity: 131072 = 16KB (1 bit per status)
 */
const DEFAULT_CAPACITY = 131072;

/**
 * Maximum retry attempts for race condition recovery
 */
const MAX_ALLOCATION_RETRIES = 3;

/**
 * Custom error for race condition detection
 */
export class StatusListAllocationError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = 'StatusListAllocationError';
  }
}

/**
 * Generate a unique list ID
 */
function generateListId(tenantId: string, purpose: StatusListPurpose): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomUUID().split('-')[0];
  return `sl_${purpose.charAt(0)}_${tenantId.substring(0, 8)}_${timestamp}_${random}`;
}

/**
 * Create an empty bitstring encoded as base64url + gzip
 */
async function createEmptyBitstring(capacity: number): Promise<string> {
  // Create zero-filled bitstring (capacity bits = capacity/8 bytes)
  const byteCount = Math.ceil(capacity / 8);
  const bitstring = new Uint8Array(byteCount);

  // Compress with gzip
  const stream = new CompressionStream('gzip');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  const writePromise = (async () => {
    await writer.write(bitstring);
    await writer.close();
  })();

  const chunks: Uint8Array[] = [];
  const readPromise = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  })();

  await Promise.all([writePromise, readPromise]);

  // Concatenate chunks
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const compressed = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    compressed.set(chunk, offset);
    offset += chunk.length;
  }

  // Encode as base64url
  return btoa(String.fromCharCode(...compressed))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Decode base64url encoded gzip compressed bitstring
 */
async function decodeBitstring(encoded: string): Promise<Uint8Array> {
  // Add padding if needed
  const padded = encoded + '==='.slice(0, (4 - (encoded.length % 4)) % 4);
  const decoded = Uint8Array.from(atob(padded.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
    c.charCodeAt(0)
  );

  // Check for GZIP magic bytes
  if (decoded.length >= 2 && decoded[0] === 0x1f && decoded[1] === 0x8b) {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    const writePromise = (async () => {
      await writer.write(decoded);
      await writer.close();
    })();

    const chunks: Uint8Array[] = [];
    const readPromise = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
    })();

    await Promise.all([writePromise, readPromise]);

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  return decoded;
}

/**
 * Encode bitstring as base64url + gzip
 */
async function encodeBitstring(bitstring: Uint8Array): Promise<string> {
  const stream = new CompressionStream('gzip');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  const writePromise = (async () => {
    await writer.write(bitstring);
    await writer.close();
  })();

  const chunks: Uint8Array[] = [];
  const readPromise = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  })();

  await Promise.all([writePromise, readPromise]);

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const compressed = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    compressed.set(chunk, offset);
    offset += chunk.length;
  }

  return btoa(String.fromCharCode(...compressed))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Set status at a specific index in the bitstring
 */
function setStatusAtIndex(bitstring: Uint8Array, index: number, status: StatusValue): void {
  // SECURITY: Validate index is a non-negative integer
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Index must be a non-negative integer, got: ${index}`);
  }

  const byteIndex = Math.floor(index / 8);
  const bitPosition = 7 - (index % 8); // MSB first

  if (byteIndex >= bitstring.length) {
    throw new Error(`Index ${index} out of bounds (max: ${bitstring.length * 8 - 1})`);
  }

  if (status === StatusValue.VALID) {
    // Clear bit (set to 0)
    bitstring[byteIndex] &= ~(1 << bitPosition);
  } else {
    // Set bit (set to 1)
    bitstring[byteIndex] |= 1 << bitPosition;
  }
}

/**
 * Status List Manager
 *
 * Handles the lifecycle of status lists including:
 * - Automatic list creation when none exists
 * - Index allocation with automatic rotation when full
 * - Status updates (revoke/suspend/activate)
 */
export class StatusListManager {
  constructor(private readonly repository: StatusListRepository) {}

  /**
   * Create a new status list
   *
   * @param tenantId - Tenant identifier
   * @param purpose - 'revocation' or 'suspension'
   * @param capacity - Maximum number of entries (default: 131072)
   * @returns Created status list record
   */
  async createStatusList(
    tenantId: string,
    purpose: StatusListPurpose,
    capacity: number = DEFAULT_CAPACITY
  ): Promise<StatusListRecord> {
    const listId = generateListId(tenantId, purpose);
    const encodedList = await createEmptyBitstring(capacity);
    const now = new Date().toISOString();

    const record: Omit<StatusListRecord, 'created_at' | 'updated_at'> = {
      id: listId,
      tenant_id: tenantId,
      purpose,
      encoded_list: encodedList,
      current_index: 0,
      capacity,
      used_count: 0,
      state: 'active',
      sealed_at: null,
    };

    await this.repository.create(record);

    return {
      ...record,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * Allocate an index for a new credential
   *
   * Automatically creates a new list if none exists,
   * or rotates to a new list if the current one is full.
   *
   * Uses retry logic to handle race conditions when multiple
   * processes attempt to allocate indices concurrently.
   *
   * @param tenantId - Tenant identifier
   * @param purpose - 'revocation' or 'suspension' (default: 'revocation')
   * @returns The list ID and allocated index
   * @throws StatusListAllocationError if allocation fails after retries
   */
  async allocateIndex(
    tenantId: string,
    purpose: StatusListPurpose = 'revocation'
  ): Promise<IndexAllocation> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_ALLOCATION_RETRIES; attempt++) {
      try {
        return await this.tryAllocateIndex(tenantId, purpose);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if error is retryable (race condition detected)
        const isRetryable =
          error instanceof StatusListAllocationError
            ? error.retryable
            : lastError.message.includes('constraint') ||
              lastError.message.includes('duplicate') ||
              lastError.message.includes('UNIQUE');

        if (!isRetryable || attempt === MAX_ALLOCATION_RETRIES - 1) {
          throw error;
        }

        // Exponential backoff with jitter
        const backoffMs = Math.min(100 * Math.pow(2, attempt) + Math.random() * 50, 1000);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    throw new StatusListAllocationError(
      `Failed to allocate index after ${MAX_ALLOCATION_RETRIES} attempts: ${lastError?.message}`,
      false
    );
  }

  /**
   * Internal method to attempt index allocation
   * Separated for retry logic
   */
  private async tryAllocateIndex(
    tenantId: string,
    purpose: StatusListPurpose
  ): Promise<IndexAllocation> {
    // Find active list
    let activeList = await this.repository.findActiveList(tenantId, purpose);

    // Create new list if none exists
    if (!activeList) {
      try {
        activeList = await this.createStatusList(tenantId, purpose);
      } catch (error) {
        // Race condition: another process may have created the list
        // Try to find the newly created list
        activeList = await this.repository.findActiveList(tenantId, purpose);
        if (!activeList) {
          throw new StatusListAllocationError(
            `Failed to create or find active list: ${error instanceof Error ? error.message : 'Unknown'}`,
            true // Retryable
          );
        }
      }
    }

    // Check if list is full BEFORE attempting allocation
    if (activeList.used_count >= activeList.capacity) {
      // Seal current list
      try {
        await this.repository.update(activeList.id, {
          state: 'sealed',
          sealed_at: new Date().toISOString(),
        });
      } catch {
        // Another process may have sealed it, continue
      }

      // Create new list
      activeList = await this.createStatusList(tenantId, purpose);
    }

    // Atomically increment used_count and get the new index
    try {
      const newCount = await this.repository.incrementUsedCount(activeList.id);

      // Check if we exceeded capacity (race condition on full list)
      // This can happen if another process allocated the last slot between our check and increment
      if (newCount > activeList.capacity) {
        throw new StatusListAllocationError(
          'List capacity exceeded during allocation',
          true // Retryable
        );
      }

      const index = newCount - 1; // Index is 0-based, count is 1-based

      return {
        listId: activeList.id,
        index,
      };
    } catch (error) {
      // If incrementUsedCount failed or we detected race condition
      if (error instanceof StatusListAllocationError) {
        throw error;
      }

      throw error;
    }
  }

  /**
   * Update the status of a credential
   *
   * @param listId - Status list ID
   * @param index - Index in the status list
   * @param status - New status value
   */
  async updateStatus(listId: string, index: number, status: StatusValue): Promise<void> {
    const list = await this.repository.findById(listId);
    if (!list) {
      throw new Error(`Status list not found: ${listId}`);
    }

    // Decode bitstring
    const bitstring = await decodeBitstring(list.encoded_list);

    // Update status
    setStatusAtIndex(bitstring, index, status);

    // Re-encode and save
    const encodedList = await encodeBitstring(bitstring);
    await this.repository.update(listId, { encoded_list: encodedList });
  }

  /**
   * Revoke a credential (set status to INVALID)
   */
  async revoke(listId: string, index: number): Promise<void> {
    await this.updateStatus(listId, index, StatusValue.INVALID);
  }

  /**
   * Suspend a credential (set status to INVALID)
   */
  async suspend(listId: string, index: number): Promise<void> {
    await this.updateStatus(listId, index, StatusValue.INVALID);
  }

  /**
   * Activate a credential (set status to VALID)
   */
  async activate(listId: string, index: number): Promise<void> {
    await this.updateStatus(listId, index, StatusValue.VALID);
  }

  /**
   * Get the encoded bitstring for a status list
   *
   * @param listId - Status list ID
   * @returns Base64url encoded gzip compressed bitstring
   */
  async getEncodedList(listId: string): Promise<string> {
    const list = await this.repository.findById(listId);
    if (!list) {
      throw new Error(`Status list not found: ${listId}`);
    }
    return list.encoded_list;
  }

  /**
   * Get status list record
   */
  async getStatusList(listId: string): Promise<StatusListRecord | null> {
    return this.repository.findById(listId);
  }

  /**
   * List all status lists for a tenant
   */
  async listStatusLists(
    tenantId: string,
    options?: { purpose?: StatusListPurpose; state?: StatusListState }
  ): Promise<StatusListRecord[]> {
    return this.repository.listByTenant(tenantId, options);
  }

  /**
   * Get the status at a specific index
   *
   * @param listId - Status list ID
   * @param index - Index in the status list
   * @returns The status value (0 = valid, 1 = invalid)
   */
  async getStatus(listId: string, index: number): Promise<StatusValue> {
    const list = await this.repository.findById(listId);
    if (!list) {
      throw new Error(`Status list not found: ${listId}`);
    }

    const bitstring = await decodeBitstring(list.encoded_list);
    return getStatusAtIndex(bitstring, index) as StatusValue;
  }

  /**
   * Calculate ETag for cache validation
   *
   * @param listId - Status list ID
   * @returns ETag string
   */
  async calculateETag(listId: string): Promise<string> {
    const list = await this.repository.findById(listId);
    if (!list) {
      throw new Error(`Status list not found: ${listId}`);
    }

    // Use a hash of the encoded list as ETag
    const encoder = new TextEncoder();
    const data = encoder.encode(list.encoded_list + list.updated_at);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    return `"${hashHex.substring(0, 16)}"`;
  }
}

// Re-export for convenience
export { StatusValue };
