// @ts-check
// Go live → "Move logins and data to Remastly": unpacking the backup the owner downloaded from their hosting panel (a cPanel
// full backup is a .tar.gz; a file manager gives a .zip). The archive comes from outside, so it is listed first and refused
// when it is too large once unpacked, and only plain files and folders are written: a link, a device or a name that leaves
// the folder is skipped (tar strips them by default; yauzl refuses such names).
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import yauzl from 'yauzl';

const MB = 1024 * 1024;
// A WordPress site with years of uploads is a few GB; more than this unpacked is not a website backup (or a zip bomb).
export const UNPACK_LIMITS = {
  bytes: (Number(process.env.SAS_BOX_UNPACKED_MB) || 16_384) * MB,
  entries: 500_000,
};

/** What an uploaded file is, from its name; null = not one Remastly can read. @param {string} name */
export function kindOf(name) {
  const n = name.toLowerCase();
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz') || n.endsWith('.tar')) return 'tar';
  if (n.endsWith('.zip')) return 'zip';
  if (n.endsWith('.sql') || n.endsWith('.sql.gz')) return 'sql';
  return null;
}

export class ArchiveError extends Error {}

const tooBig = () => new ArchiveError(`The backup is larger than ${Math.round(UNPACK_LIMITS.bytes / 1024 / MB)} GB once unpacked, or has too many files. Upload only the website's own folder and its database.`);

/** Unpacks a .tar / .tar.gz into `dir`. @param {string} file @param {string} dir */
async function untar(file, dir) {
  let bytes = 0;
  let entries = 0;
  await tar.t({ file, onReadEntry: (e) => { bytes += e.size ?? 0; entries += 1; } }).catch(() => { throw new ArchiveError('This .tar.gz file could not be read. Download it again from the hosting panel.'); });
  if (bytes > UNPACK_LIMITS.bytes || entries > UNPACK_LIMITS.entries) throw tooBig();
  await mkdir(dir, { recursive: true });
  await tar.x({
    file,
    cwd: dir,
    // Only files and folders; tar already refuses absolute names and "..".
    filter: (_p, e) => ['File', 'OldFile', 'ContiguousFile', 'Directory'].includes(/** @type {any} */ (e).type),
    noChmod: true,
    preserveOwner: false,
  });
}

/** Unpacks a .zip into `dir`. @param {string} file @param {string} dir */
function unzip(file, dir) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return reject(new ArchiveError('This .zip file could not be read. Download it again.'));
      if (zip.entryCount > UNPACK_LIMITS.entries) {
        zip.close();
        return reject(tooBig());
      }
      let bytes = 0;
      const fail = (e) => {
        zip.close();
        reject(e instanceof ArchiveError ? e : new ArchiveError(`This .zip file could not be unpacked (${e?.message ?? e}).`));
      };
      zip.on('error', fail);
      zip.on('end', () => resolve(undefined));
      zip.on('entry', (entry) => {
        const type = (entry.externalFileAttributes >>> 16) & 0o170000;
        const to = path.join(dir, entry.fileName);
        if (entry.fileName.endsWith('/')) {
          mkdir(to, { recursive: true }).then(() => zip.readEntry(), fail);
          return;
        }
        // A link (or anything but a plain file) is skipped; 0 = made on a system that does not say.
        if (type !== 0 && type !== 0o100000) return zip.readEntry();
        bytes += entry.uncompressedSize;
        if (bytes > UNPACK_LIMITS.bytes) return fail(tooBig());
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return fail(e);
          mkdir(path.dirname(to), { recursive: true })
            .then(() => pipeline(stream, createWriteStream(to)))
            .then(() => zip.readEntry(), fail);
        });
      });
      zip.readEntry();
    });
  });
}

/** Unpacks an uploaded archive into `dir`. @param {string} file @param {string} dir */
export async function unpack(file, dir) {
  const kind = kindOf(path.basename(file));
  if (kind === 'tar') return untar(file, dir);
  if (kind === 'zip') return unzip(file, dir);
  throw new ArchiveError(`${path.basename(file)} is not an archive.`);
}
