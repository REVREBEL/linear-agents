// Linux-only ABR-94 read-only file gate. No user-supplied path is passed to
// an ordinary path-following open() after containment validation.
//
// The open /proc/self/fd/<directory fd>/<one component> path pins each parent
// directory independently. O_NOFOLLOW on every component makes rename/symlink
// swaps fail closed without escaping to an attacker-controlled parent.
// Unsupported platforms or unavailable procfs must fail closed (ABR-96/97).
import { constants } from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';
import path from 'node:path';

export const MAX_FILE_BYTES = 262_144;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY |
  constants.O_NOFOLLOW | constants.O_NONBLOCK;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const MAX_SYMLINK_HOPS = 16;

function within(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

export async function openScopedFile(root, input, { onDirectoryOpened, rootIdentity } = {}) {
  if (process.platform !== 'linux' || !Number.isInteger(constants.O_DIRECTORY)) {
    throw Error('SAFE_OPEN_UNAVAILABLE');
  }
  if (typeof root !== 'string' || !path.isAbsolute(root) ||
      typeof input !== 'string' || input.length === 0 || input.length > 4_096 ||
      input.includes('\0')) throw Error('INVALID_PATH');
  const destination = path.resolve(root, input);
  if (!within(root, destination)) throw Error('OUTSIDE_AUTHORIZED_WORKSPACE');
  let relative = path.relative(root, destination);
  if (!relative) throw Error('NOT_A_REGULAR_FILE');

  // Open exactly the approved root once; every descendant is reached via this
  // pinned directory chain. Never trust the same pathname a second time.
  const rootHandle = await open(root, DIRECTORY_FLAGS);
  const original = await rootHandle.stat();
  if (!original.isDirectory() || (rootIdentity &&
      (original.dev !== rootIdentity.dev || original.ino !== rootIdentity.ino))) {
    await rootHandle.close();
    throw Error('OUTSIDE_AUTHORIZED_WORKSPACE');
  }
  const procfs = '/proc/self/fd/';
  try {
    for (let hops = 0; hops <= MAX_SYMLINK_HOPS; hops++) {
      const segments = relative.split(path.sep);
      const parents = [];
      try {
        let parent = rootHandle;
        let restart = false;
        for (let index = 0; index < segments.length; index++) {
          const segment = segments[index];
          const candidate = `${procfs}${parent.fd}/${segment}`;
          const last = index === segments.length - 1;
          const metadata = await lstat(candidate);
          if (metadata.isSymbolicLink()) {
            const target = await readlink(candidate);
            const lexicalParent = path.join(root, ...segments.slice(0, index));
            const resolved = path.resolve(lexicalParent, target, ...segments.slice(index + 1));
            if (!within(root, resolved)) throw Error('OUTSIDE_AUTHORIZED_WORKSPACE');
            relative = path.relative(root, resolved);
            if (!relative) throw Error('NOT_A_REGULAR_FILE');
            restart = true;
            break;
          }
          let fd;
          try {
            fd = await open(candidate, last ? FILE_FLAGS : DIRECTORY_FLAGS);
          } catch (error) {
            // lstat/readlink are advisory; O_NOFOLLOW is the actual
            // no-symlink check at the point of opening each pinned component.
            if (error.code === 'ELOOP' || error.code === 'ENOTDIR') {
              throw Error('OUTSIDE_AUTHORIZED_WORKSPACE');
            }
            throw error;
          }
          const info = await fd.stat();
          if (last) {
            if (!info.isFile()) {
              await fd.close();
              throw Error('NOT_A_REGULAR_FILE');
            }
            return fd;
          }
          if (!info.isDirectory()) {
            await fd.close();
            throw Error('OUTSIDE_AUTHORIZED_WORKSPACE');
          }
          parents.push(fd);
          parent = fd;
          await onDirectoryOpened?.(segments.slice(0, index + 1).join(path.sep));
        }
        if (!restart) throw Error('READ_FAILED');
      } finally {
        for (const fd of parents.reverse()) await fd.close();
      }
    }
    throw Error('TOO_MANY_SYMLINKS');
  } finally {
    await rootHandle.close();
  }
}

// The first stat is a fast refusal for already-large files, not the byte
// boundary: read only into a fixed 256-KiB+1 buffer and reject the extra byte,
// including when a concurrent writer grows the file after fstat.
export async function readBoundedFile(file) {
  const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
  let readTotal = 0;
  while (readTotal < bytes.length) {
    const { bytesRead } = await file.read(bytes, readTotal, bytes.length - readTotal, null);
    if (bytesRead === 0) break;
    readTotal += bytesRead;
  }
  if (readTotal > MAX_FILE_BYTES) throw Error('FILE_TOO_LARGE');
  return bytes.subarray(0, readTotal);
}
