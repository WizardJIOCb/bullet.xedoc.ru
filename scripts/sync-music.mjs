import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicMusicDir = path.join(projectRoot, 'public', 'assets', 'music');
const distMusicDir = path.join(projectRoot, 'dist', 'assets', 'music');
const supportedExtensions = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.webm']);
const publishableFileLimit = 48 * 1024 * 1024;

export function isSupported(name) {
  return supportedExtensions.has(path.extname(name).toLowerCase());
}

function slugify(value) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'music-track';
}

function titleFromFilename(name) {
  return path.parse(name).name
    .replace(/-[a-f0-9]{8}$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 56)
    .toUpperCase();
}

async function fileHash(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function listFiles(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && isSupported(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export function importedFilename(originalName, hash) {
  const extension = path.extname(originalName).toLowerCase();
  const base = path.parse(originalName).name.replace(/-[a-f0-9]{8}$/i, '');
  const semanticName = /neon[- ]?noir/i.test(base) ? 'neon-noir-protocol' : slugify(base).slice(0, 48);
  return `${semanticName}-${hash.slice(0, 8)}${extension}`;
}

function assertPublishableSize(name, bytes) {
  if (bytes > publishableFileLimit) {
    throw new Error(`${name} is larger than 48 MB. Compress or split it for browser playback.`);
  }
}

export async function syncMusic() {
  await mkdir(publicMusicDir, { recursive: true });

  for (const name of await listFiles(distMusicDir)) {
    const source = path.join(distMusicDir, name);
    const sourceStat = await stat(source);
    assertPublishableSize(name, sourceStat.size);
    const hash = await fileHash(source);
    const targetName = importedFilename(name, hash);
    const target = path.join(publicMusicDir, targetName);
    try {
      await stat(target);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await copyFile(source, target);
      console.log(`Imported music: ${name} -> ${targetName}`);
    }
  }

  const tracks = [];
  for (const name of await listFiles(publicMusicDir)) {
    const filePath = path.join(publicMusicDir, name);
    const fileStat = await stat(filePath);
    assertPublishableSize(name, fileStat.size);
    const hash = await fileHash(filePath);
    tracks.push({
      id: `${slugify(path.parse(name).name).replace(/-[a-f0-9]{8}$/i, '')}-${hash.slice(0, 8)}`,
      title: titleFromFilename(name),
      file: `/assets/music/${encodeURIComponent(name)}`,
      bytes: fileStat.size,
      format: path.extname(name).slice(1).toUpperCase(),
    });
  }

  const manifest = { version: 1, tracks };
  await writeFile(path.join(publicMusicDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Music manifest: ${tracks.length} track(s)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await syncMusic();
}
