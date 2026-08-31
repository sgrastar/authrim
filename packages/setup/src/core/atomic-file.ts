import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface ReadPrivateFileOptions {
  /** Maximum accepted on-disk size before the file is read into memory. */
  maxBytes: number;
  /** Stable, non-sensitive error returned for malformed files and filesystem failures. */
  invalidError: string;
  /** Stable error returned when a POSIX file is not exactly owner read/write (0600). */
  permissionsError: string;
  /** Optional stable error used when the regular file exceeds maxBytes. */
  tooLargeError?: string;
}

function privateFileOpenFlags(): number {
  // O_NOFOLLOW closes the final-component symlink race. O_NONBLOCK prevents a replaced FIFO from
  // hanging setup before fstat can reject it as a non-regular file.
  return (
    constants.O_RDONLY |
    (process.platform === 'win32' ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW)
  );
}

function privateFileMetadataMatches(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function privateFileIdentityMatches(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

interface SecurePrivateFileSnapshot {
  content: string;
  metadata: BigIntStats;
}

async function openPrivateFileSecurely(
  path: string,
  options: ReadPrivateFileOptions
): Promise<FileHandle | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, privateFileOpenFlags());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(options.invalidError, { cause: error });
  }

  if (process.platform === 'win32') {
    try {
      const [pathMetadata, openedMetadata] = await Promise.all([
        lstat(path, { bigint: true }),
        handle.stat({ bigint: true }),
      ]);
      if (
        pathMetadata.isSymbolicLink() ||
        !pathMetadata.isFile() ||
        !openedMetadata.isFile() ||
        !privateFileIdentityMatches(pathMetadata, openedMetadata)
      ) {
        throw new Error(options.invalidError);
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      if (error instanceof Error && error.message === options.invalidError) throw error;
      throw new Error(options.invalidError, { cause: error });
    }
  }
  return handle;
}

async function readOpenedPrivateFileSecurely(
  handle: FileHandle,
  options: ReadPrivateFileOptions
): Promise<SecurePrivateFileSnapshot> {
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(options.invalidError);
    if (process.platform !== 'win32' && (before.mode & 0o777n) !== 0o600n) {
      throw new Error(options.permissionsError);
    }
    if (before.size > BigInt(options.maxBytes)) {
      throw new Error(options.tooLargeError ?? options.invalidError);
    }

    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      BigInt(content.byteLength) !== before.size ||
      !after.isFile() ||
      !privateFileMetadataMatches(before, after)
    ) {
      throw new Error(options.invalidError);
    }
    return { content: content.toString('utf8'), metadata: after };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === options.invalidError ||
        error.message === options.permissionsError ||
        error.message === options.tooLargeError)
    ) {
      throw error;
    }
    throw new Error(options.invalidError, { cause: error });
  }
}

async function restoreClaimedPrivateFile(
  claimedPath: string,
  originalPath: string
): Promise<boolean> {
  try {
    // link(2) fails with EEXIST rather than replacing a newer entry at originalPath. Once the
    // claimed inode has a name at the original path, removing our private link cannot delete it.
    await link(claimedPath, originalPath);
    await unlink(claimedPath);
    return true;
  } catch {
    // Preserve the claimed entry in its mode-0700 directory when the original name is occupied or
    // restoration is otherwise unsafe. A replacement must never be deleted merely to tidy up.
    return false;
  }
}

async function consumeOpenedPrivateFile(
  path: string,
  handle: FileHandle,
  snapshot: SecurePrivateFileSnapshot,
  options: ReadPrivateFileOptions
): Promise<void> {
  const consumeDirectory = await mkdtemp(join(dirname(path), '.authrim-consume-')).catch(
    (error) => {
      throw new Error(options.invalidError, { cause: error });
    }
  );
  const claimedPath = join(consumeDirectory, 'private-file');
  let claimed = false;
  try {
    await chmod(consumeDirectory, 0o700);
    const beforeClaim = await handle.stat({ bigint: true });
    if (
      !beforeClaim.isFile() ||
      beforeClaim.nlink !== 1n ||
      !privateFileMetadataMatches(snapshot.metadata, beforeClaim)
    ) {
      throw new Error(options.invalidError);
    }

    // Rename atomically claims whichever inode currently occupies the operator-supplied path. The
    // private directory prevents a later path replacement from being unlinked in its place.
    await rename(path, claimedPath);
    claimed = true;

    let claimedHandle: FileHandle | undefined;
    let claimedMetadata: BigIntStats;
    try {
      claimedHandle = (await openPrivateFileSecurely(claimedPath, options)) ?? undefined;
      if (!claimedHandle) throw new Error(options.invalidError);
      claimedMetadata = await claimedHandle.stat({ bigint: true });
    } catch (error) {
      claimed = !(await restoreClaimedPrivateFile(claimedPath, path));
      throw new Error(options.invalidError, { cause: error });
    } finally {
      await claimedHandle?.close().catch(() => undefined);
    }

    const openedMetadata = await handle.stat({ bigint: true });
    if (
      !claimedMetadata.isFile() ||
      claimedMetadata.nlink !== 1n ||
      !openedMetadata.isFile() ||
      openedMetadata.nlink !== 1n ||
      !privateFileIdentityMatches(snapshot.metadata, claimedMetadata) ||
      !privateFileIdentityMatches(snapshot.metadata, openedMetadata)
    ) {
      claimed = !(await restoreClaimedPrivateFile(claimedPath, path));
      throw new Error(options.invalidError);
    }

    try {
      await unlink(claimedPath);
      claimed = false;
    } catch (error) {
      claimed = !(await restoreClaimedPrivateFile(claimedPath, path));
      throw new Error(options.invalidError, { cause: error });
    }
  } catch (error) {
    if (error instanceof Error && error.message === options.invalidError) throw error;
    throw new Error(options.invalidError, { cause: error });
  } finally {
    if (claimed) await restoreClaimedPrivateFile(claimedPath, path);
    await rmdir(consumeDirectory).catch(() => undefined);
  }
}

/**
 * Read a private local checkpoint from one pinned file descriptor.
 *
 * The open itself rejects final-component symlinks, fstat rejects non-regular and over-sized
 * artifacts, and the second fstat rejects replacement or concurrent mutation during the read.
 */
export async function readPrivateFileSecurely(
  path: string,
  options: ReadPrivateFileOptions
): Promise<string | null> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new Error('invalid_private_file_size_limit');
  }

  const handle = await openPrivateFileSecurely(path, options);
  if (!handle) return null;

  try {
    return (await readOpenedPrivateFileSecurely(handle, options)).content;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Validate and consume a private one-time file without unlinking a path replacement.
 *
 * The validator runs while the securely opened descriptor remains pinned. Only after validation do
 * we atomically claim the path into a private directory, prove that the claimed inode is the opened
 * inode, and unlink it there. Invalid content is therefore left at its original path for inspection.
 */
export async function consumePrivateFileSecurely<T>(
  path: string,
  options: ReadPrivateFileOptions,
  validate: (content: string) => T
): Promise<T | null> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new Error('invalid_private_file_size_limit');
  }

  const handle = await openPrivateFileSecurely(path, options);
  if (!handle) return null;
  try {
    const snapshot = await readOpenedPrivateFileSecurely(handle, options);
    const value = validate(snapshot.content);
    await consumeOpenedPrivateFile(path, handle, snapshot, options);
    return value;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Persist a private local artifact without exposing a truncated final path after interruption. */
export async function writePrivateFileAtomically(
  path: string,
  content: string,
  mode = 0o600
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', mode);
    // open(2) applies umask to the requested mode. Restore the exact intended mode before the
    // artifact is made visible so strict readers remain reliable under unusually restrictive
    // operator umasks.
    await handle.chmod(mode);
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    const directoryHandle = await open(directory, 'r').catch(() => undefined);
    if (directoryHandle) {
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
