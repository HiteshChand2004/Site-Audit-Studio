// @ts-check
// The owner's photos and logo of a saved site (Build mode). They live beside the site, never inside its saved state: one folder
// per site, data/buildmode/sites/<id>/images/, with every image as <uuid>.webp, a small <uuid>-thumb.webp for the app, and
// index.json listing them (id, role, size). Whatever arrives is checked by its bytes (JPEG, PNG or WebP only, never SVG), then
// drawn again with sharp: turned upright, at most MAX_SIDE px, as WebP, with every bit of metadata (location, camera) left behind.
// Ids are made here, so no name or path from the client ever reaches the disk. The descriptions (alt texts) are the app's: they
// are kept with the site's state and come with the build request. At build time the images are copied into the project
// (placeImages), where the agent is told to use them.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { SITES_DIR, getSite } from './sites.js';
import { MAX_ALT, MAX_PHOTOS, plainText } from './details.js';

export const IMAGE_LIMITS = { photos: MAX_PHOTOS, logos: 1, uploadBytes: 8 * 1024 * 1024, maxSide: 2000, thumbSide: 400, inputPixels: 100_000_000 };
export const IMAGE_ROLES = ['photo', 'logo'];
const ID = /^[0-9a-f-]{36}$/;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class ImageError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * @typedef {{ id: string, role: 'photo' | 'logo', width: number, height: number, bytes: number, createdAt: string }} StoredImage
 */

const dirOf = (/** @type {string} */ siteId) => path.join(SITES_DIR, siteId, 'images');
const indexOf = (/** @type {string} */ siteId) => path.join(dirOf(siteId), 'index.json');
const fileOf = (/** @type {string} */ siteId, /** @type {string} */ id, thumb = false) => path.join(dirOf(siteId), `${id}${thumb ? '-thumb' : ''}.webp`);

/** What the bytes are, whatever the request said: 'jpeg', 'png', 'webp' or null. */
export function sniffImage(/** @type {Buffer} */ buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG)) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** @type {Map<string, Promise<any>>} the last change of each site's images, so changes to one index never overlap */
const changing = new Map();

/** Runs `change` with the site's index; its result's `index` is written back. One change per site at a time. */
function withIndex(/** @type {string} */ siteId, /** @type {(index: StoredImage[]) => Promise<{ index?: StoredImage[], value: any }>} */ change) {
  const next = (changing.get(siteId) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const out = await change(await readIndex(siteId));
    if (out.index) {
      await mkdir(dirOf(siteId), { recursive: true });
      const tmp = `${indexOf(siteId)}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(out.index));
      await rename(tmp, indexOf(siteId));
    }
    return out.value;
  });
  changing.set(siteId, next);
  next.finally(() => { if (changing.get(siteId) === next) changing.delete(siteId); }).catch(() => {});
  return next;
}

/** @returns {Promise<StoredImage[]>} */
const readIndex = (/** @type {string} */ siteId) => readFile(indexOf(siteId), 'utf8').then((t) => {
  const list = JSON.parse(t);
  return Array.isArray(list) ? list : [];
}, () => []);

/** A site's images as the app lists them, or null when the site is not this owner's. */
export async function listImages(/** @type {string} */ siteId, /** @type {string | null} */ ownerId) {
  if (!(await getSite(siteId, ownerId))) return null;
  await changing.get(siteId)?.catch(() => {});
  return readIndex(siteId);
}

/** The image drawn again: upright, within `side` px, WebP, no metadata (sharp keeps none unless asked). */
const encode = (/** @type {Buffer} */ input, /** @type {number} */ side, /** @type {number} */ quality) => sharp(input, { limitInputPixels: IMAGE_LIMITS.inputPixels })
  .rotate()
  .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
  .webp({ quality })
  .toBuffer({ resolveWithObject: true });

/**
 * Adds one image to a site. null when the site is not this owner's; an ImageError (with its status) when the file or the limits
 * refuse it.
 * @param {string} siteId @param {string | null} ownerId @param {unknown} body  the file's bytes @param {unknown} role
 * @returns {Promise<StoredImage | null>}
 */
export async function addImage(siteId, ownerId, body, role) {
  if (!(await getSite(siteId, ownerId))) return null;
  if (typeof role !== 'string' || !IMAGE_ROLES.includes(role)) throw new ImageError('Say whether this is a photo or the logo.');
  if (!Buffer.isBuffer(body) || !body.length) throw new ImageError('Send the image file.');
  if (body.length > IMAGE_LIMITS.uploadBytes) throw new ImageError(`An image may be at most ${IMAGE_LIMITS.uploadBytes / 1024 / 1024} MB.`, 413);
  if (!sniffImage(body)) throw new ImageError('Only JPEG, PNG and WebP images can be added.', 415);
  let main;
  let thumb;
  try {
    main = await encode(body, IMAGE_LIMITS.maxSide, role === 'logo' ? 90 : 82);
    thumb = await encode(main.data, IMAGE_LIMITS.thumbSide, 75);
  } catch {
    throw new ImageError('This image could not be read. Try saving it again as JPEG or PNG.', 415);
  }
  return withIndex(siteId, async (index) => {
    const limit = role === 'logo' ? IMAGE_LIMITS.logos : IMAGE_LIMITS.photos;
    if (index.filter((i) => i.role === role).length >= limit) {
      throw new ImageError(role === 'logo' ? 'This site already has a logo. Remove it first.' : `A site can have at most ${limit} photos.`, 409);
    }
    /** @type {StoredImage} */
    const image = { id: randomUUID(), role: /** @type {'photo' | 'logo'} */ (role), width: main.info.width, height: main.info.height, bytes: main.data.length, createdAt: new Date().toISOString() };
    await mkdir(dirOf(siteId), { recursive: true });
    await writeFile(fileOf(siteId, image.id), main.data);
    await writeFile(fileOf(siteId, image.id, true), thumb.data);
    return { index: [...index, image], value: image };
  });
}

/** Removes one image: true when removed, false when the site has no such image, null when the site is not this owner's. */
export async function removeImage(/** @type {string} */ siteId, /** @type {string | null} */ ownerId, /** @type {string} */ imageId) {
  if (!(await getSite(siteId, ownerId))) return null;
  if (!ID.test(imageId)) return false;
  return withIndex(siteId, async (index) => {
    if (!index.some((i) => i.id === imageId)) return { value: false };
    await rm(fileOf(siteId, imageId), { force: true });
    await rm(fileOf(siteId, imageId, true), { force: true });
    return { index: index.filter((i) => i.id !== imageId), value: true };
  });
}

/** The small version of one image, for the app; null when there is none for this owner. */
export async function thumbnailOf(/** @type {string} */ siteId, /** @type {string | null} */ ownerId, /** @type {string} */ imageId) {
  const index = await listImages(siteId, ownerId);
  if (!index || !ID.test(imageId) || !index.some((i) => i.id === imageId)) return null;
  return readFile(fileOf(siteId, imageId, true)).catch(() => null);
}

/**
 * The images a build asked for ([{ id, alt }] from the request), as stored for this site and owner: the logo first, then the
 * photos in the order asked. Unknown ids are left out; a description is plain text, cut to MAX_ALT.
 * @param {string} siteId @param {string | null} ownerId @param {any} wanted
 * @returns {Promise<(StoredImage & { alt: string, file: string })[]>}
 */
export async function resolveImages(siteId, ownerId, wanted) {
  if (!Array.isArray(wanted) || !wanted.length) return [];
  const index = await listImages(siteId, ownerId);
  if (!index) return [];
  const byId = new Map(index.map((i) => [i.id, i]));
  const out = [];
  const seen = new Set();
  for (const w of wanted) {
    const stored = typeof w?.id === 'string' && !seen.has(w.id) ? byId.get(w.id) : undefined;
    if (!stored) continue;
    seen.add(stored.id);
    out.push({ ...stored, alt: plainText(typeof w.alt === 'string' ? w.alt : '').slice(0, MAX_ALT), file: fileOf(siteId, stored.id) });
  }
  return out.sort((a, b) => (a.role === 'logo' ? 0 : 1) - (b.role === 'logo' ? 0 : 1));
}

/**
 * Copies a build's images into its project: images/ in plain HTML (the project is the site root), public/images/ in an app
 * (served at /images/). Returns what the agent is told: the path in the project, the address a page uses, size and description.
 * @param {(StoredImage & { alt: string, file: string })[]} images @param {string} siteDir @param {{ publicDir: string }} stack
 */
export async function placeImages(images, siteDir, stack) {
  if (!images.length) return [];
  const dir = path.join(siteDir, stack.publicDir, 'images');
  await mkdir(dir, { recursive: true });
  let photo = 0;
  const placed = [];
  for (const img of images) {
    const name = img.role === 'logo' ? 'logo.webp' : `photo-${++photo}.webp`;
    await copyFile(img.file, path.join(dir, name));
    placed.push({
      path: [stack.publicDir, 'images', name].filter(Boolean).join('/'),
      url: stack.publicDir ? `/images/${name}` : `images/${name}`,
      role: img.role, width: img.width, height: img.height, alt: img.alt,
    });
  }
  return placed;
}
