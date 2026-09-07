import { constants, type BigIntStats } from 'node:fs';
import { chmod, lstat, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface PrivateTemporaryFileOptions {
  /** Non-sensitive prefix used only for identifying Authrim-owned temporary directories. */
  directoryPrefix?: string;
  /** A single safe path component; the file is always created inside the private directory. */
  filename?: string;
}

type PrivateTemporaryFileValue = string | Uint8Array;

export interface PrivateTemporaryFileAccess {
  /** Read callback output from a descriptor pinned to the originally-created inode. */
  readBytes(maxBytes: number, sizeLimitError?: string): Promise<Uint8Array>;
}

const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_DIRECTORY_PREFIX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}-$/u;

function assertSafeOptions(options: PrivateTemporaryFileOptions): {
  directoryPrefix: string;
  filename: string;
} {
  const directoryPrefix = options.directoryPrefix ?? 'authrim-private-';
  const filename = options.filename ?? 'value';
  if (!SAFE_DIRECTORY_PREFIX.test(directoryPrefix)) {
    throw new Error('invalid_private_temporary_directory_prefix');
  }
  if (!SAFE_FILENAME.test(filename) || filename === '.' || filename === '..') {
    throw new Error('invalid_private_temporary_filename');
  }
  return { directoryPrefix, filename };
}

function createPrivateFileFlags(): number {
  return (
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_WRONLY |
    (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
  );
}

function readPrivateFileFlags(): number {
  return (
    constants.O_RDONLY |
    (process.platform === 'win32' ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW)
  );
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertPrivateDirectoryMetadata(metadata: BigIntStats): void {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('private_temporary_directory_identity_changed');
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o777n) !== 0o700n) {
    throw new Error('private_temporary_directory_permissions_changed');
  }
}

function assertPrivateFileMetadata(metadata: BigIntStats): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new Error('private_temporary_file_identity_changed');
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o777n) !== 0o600n) {
    throw new Error('private_temporary_file_permissions_changed');
  }
}

async function readVerifiedMetadata(
  path: string,
  kind: 'directory' | 'file'
): Promise<BigIntStats> {
  const metadata = await lstat(path, { bigint: true });
  if (kind === 'directory') {
    assertPrivateDirectoryMetadata(metadata);
  } else {
    assertPrivateFileMetadata(metadata);
  }
  return metadata;
}

async function writeInitialValue(
  handle: FileHandle,
  value: PrivateTemporaryFileValue
): Promise<void> {
  if (typeof value === 'string') {
    await handle.writeFile(value, { encoding: 'utf-8' });
  } else {
    await handle.writeFile(value);
  }
}

async function withPrivateTemporaryFile<T>(
  value: PrivateTemporaryFileValue,
  operation: (path: string, access: PrivateTemporaryFileAccess) => Promise<T>,
  options: PrivateTemporaryFileOptions = {}
): Promise<T> {
  const { directoryPrefix, filename } = assertSafeOptions(options);
  const directory = await mkdtemp(join(tmpdir(), directoryPrefix));
  const path = join(directory, filename);
  let handle: FileHandle | undefined;

  try {
    // mkdtemp(3) creates mode 0700 on supported platforms, but an unusual umask can make it more
    // restrictive. Set and verify the exact mode because the private directory is the boundary
    // that prevents another user from replacing the path while Wrangler opens it.
    await chmod(directory, 0o700);
    const initialDirectoryMetadata = await readVerifiedMetadata(directory, 'directory');

    handle = await open(path, createPrivateFileFlags(), 0o600);
    await handle.chmod(0o600);
    await writeInitialValue(handle, value);
    await handle.sync();

    const descriptorMetadata = await handle.stat({ bigint: true });
    assertPrivateFileMetadata(descriptorMetadata);
    const initialPathMetadata = await readVerifiedMetadata(path, 'file');
    if (!sameFileIdentity(descriptorMetadata, initialPathMetadata)) {
      throw new Error('private_temporary_file_identity_changed');
    }
    await handle.close();
    handle = undefined;

    // Verify both path components immediately before giving the path to an external process.
    const beforeDirectoryMetadata = await readVerifiedMetadata(directory, 'directory');
    const beforeFileMetadata = await readVerifiedMetadata(path, 'file');
    if (
      !sameFileIdentity(initialDirectoryMetadata, beforeDirectoryMetadata) ||
      !sameFileIdentity(initialPathMetadata, beforeFileMetadata)
    ) {
      throw new Error('private_temporary_file_identity_changed');
    }

    const access: PrivateTemporaryFileAccess = {
      readBytes: async (
        maxBytes: number,
        sizeLimitError = 'private_temporary_output_size_limit_exceeded'
      ): Promise<Uint8Array> => {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
          throw new Error('invalid_private_temporary_output_size_limit');
        }
        let readHandle: FileHandle | undefined;
        try {
          try {
            readHandle = await open(path, readPrivateFileFlags());
          } catch (error) {
            throw new Error('private_temporary_file_identity_changed', { cause: error });
          }
          const beforeRead = await readHandle.stat({ bigint: true });
          assertPrivateFileMetadata(beforeRead);
          if (!sameFileIdentity(initialPathMetadata, beforeRead)) {
            throw new Error('private_temporary_file_identity_changed');
          }
          if (beforeRead.size > BigInt(maxBytes)) throw new Error(sizeLimitError);

          const bytes = await readHandle.readFile();
          const afterRead = await readHandle.stat({ bigint: true });
          if (
            BigInt(bytes.byteLength) !== beforeRead.size ||
            !afterRead.isFile() ||
            !sameFileSnapshot(beforeRead, afterRead)
          ) {
            throw new Error('private_temporary_file_changed_while_reading');
          }
          const afterReadPath = await readVerifiedMetadata(path, 'file');
          if (!sameFileIdentity(initialPathMetadata, afterReadPath)) {
            throw new Error('private_temporary_file_identity_changed');
          }
          return new Uint8Array(bytes);
        } finally {
          await readHandle?.close().catch(() => undefined);
        }
      },
    };

    const result = await operation(path, access);

    // Output helpers permit content/size changes, but never pathname replacement, symlinks,
    // hardlinks, or permission changes. A replaced file is rejected before its bytes are trusted.
    const afterDirectoryMetadata = await readVerifiedMetadata(directory, 'directory');
    const afterFileMetadata = await readVerifiedMetadata(path, 'file');
    if (
      !sameFileIdentity(initialDirectoryMetadata, afterDirectoryMetadata) ||
      !sameFileIdentity(initialPathMetadata, afterFileMetadata)
    ) {
      throw new Error('private_temporary_file_identity_changed');
    }
    return result;
  } finally {
    await handle?.close().catch(() => undefined);
    // Never silently report success when sensitive temporary material could not be removed.
    await rm(directory, { recursive: true, force: true });
  }
}

export async function withPrivateTemporaryTextFile<T>(
  value: string,
  operation: (path: string, access: PrivateTemporaryFileAccess) => Promise<T>,
  options: PrivateTemporaryFileOptions = {}
): Promise<T> {
  return withPrivateTemporaryFile(value, operation, options);
}

export async function withPrivateTemporaryBinaryFile<T>(
  value: Uint8Array,
  operation: (path: string, access: PrivateTemporaryFileAccess) => Promise<T>,
  options: PrivateTemporaryFileOptions = {}
): Promise<T> {
  return withPrivateTemporaryFile(value, operation, options);
}

export async function withPrivateTemporaryOutputFile<T>(
  operation: (path: string, access: PrivateTemporaryFileAccess) => Promise<T>,
  options: PrivateTemporaryFileOptions = {}
): Promise<T> {
  return withPrivateTemporaryFile(new Uint8Array(), operation, options);
}
