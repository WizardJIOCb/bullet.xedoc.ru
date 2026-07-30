export const MUSIC_LIBRARY_VERSION = 1 as const;
export const MUSIC_LIBRARY_METADATA_KEY = 'ballistic-edge-music-library-v1';
export const MUSIC_LIBRARY_DB_NAME = 'ballistic-edge-music-v1';
export const MUSIC_LIBRARY_BLOB_STORE = 'track-blobs';

const DEFAULT_PLAYLIST_NAME = 'My tracks';
const LEGACY_DEFAULT_PLAYLIST_NAMES = new Set(['My tracks', 'Мои треки']);
const MAX_PLAYLIST_NAME_LENGTH = 64;
const MAX_TRACK_TITLE_LENGTH = 160;

export interface MusicLibraryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface TrackBlobStore {
  put(trackId: string, blob: Blob): Promise<void>;
  get(trackId: string): Promise<Blob | null>;
  delete(trackId: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface MusicLibraryPersistenceStatus {
  degraded: boolean;
  metadataDurable: boolean;
  blobsDurable: boolean;
}

interface PersistenceAwareStore {
  readonly persistent: boolean;
  readonly persistenceDegraded: boolean;
}

export interface LocalMusicTrack {
  id: string;
  title: string;
  fileName: string;
  mimeType: string;
  bytes: number;
  lastModified: number;
  duration: number | null;
  bpm: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface MusicPlaylist {
  id: string;
  name: string;
  /** Built-in list name is translated at render time; custom names stay untouched. */
  system?: boolean;
  trackIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface MusicLibrarySnapshot {
  version: typeof MUSIC_LIBRARY_VERSION;
  tracks: LocalMusicTrack[];
  playlists: MusicPlaylist[];
  activePlaylistId: string | null;
  activeTrackId: string | null;
}

export interface AddTrackOptions {
  playlistId?: string | null;
  title?: string;
  fileName?: string;
  lastModified?: number;
  duration?: number | null;
  bpm?: number | null;
  activate?: boolean;
}

export interface UpdateTrackMetadata {
  title?: string;
  duration?: number | null;
  bpm?: number | null;
}

export interface MusicLibraryOptions {
  metadataStorage: MusicLibraryStorage;
  blobStore: TrackBlobStore;
  now?: () => number;
  idFactory?: (kind: 'playlist' | 'track') => string;
  metadataKey?: string;
}

export type MusicLibraryListener = (snapshot: MusicLibrarySnapshot) => void;

export type MusicLibraryErrorCode =
  | 'empty-file'
  | 'invalid-name'
  | 'playlist-not-found'
  | 'track-not-found'
  | 'track-not-in-playlist'
  | 'blob-not-found'
  | 'file-api-unavailable';

export class MusicLibraryError extends Error {
  constructor(readonly code: MusicLibraryErrorCode, message: string) {
    super(message);
    this.name = 'MusicLibraryError';
  }
}

interface StoredBlobRecord {
  id: string;
  blob: Blob;
}

function cloneTrack(track: LocalMusicTrack): LocalMusicTrack {
  return { ...track };
}

function clonePlaylist(playlist: MusicPlaylist): MusicPlaylist {
  return { ...playlist, trackIds: [...playlist.trackIds] };
}

function cloneSnapshot(snapshot: MusicLibrarySnapshot): MusicLibrarySnapshot {
  return {
    version: MUSIC_LIBRARY_VERSION,
    tracks: snapshot.tracks.map(cloneTrack),
    playlists: snapshot.playlists.map(clonePlaylist),
    activePlaylistId: snapshot.activePlaylistId,
    activeTrackId: snapshot.activeTrackId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteOrNull(value: unknown, minimum = 0): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum ? value : null;
}

function finiteTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function compactText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maximum) : '';
}

function requireName(value: unknown, label: string, maximum: number): string {
  const name = compactText(value, maximum);
  if (!name) throw new MusicLibraryError('invalid-name', `${label} cannot be empty`);
  return name;
}

function titleFromFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[a-z0-9]{1,8}$/i, '');
  return compactText(withoutExtension || fileName, MAX_TRACK_TITLE_LENGTH) || 'Untitled';
}

function fileProperties(blob: Blob): { name?: string; lastModified?: number } {
  const candidate = blob as Blob & { name?: unknown; lastModified?: unknown };
  return {
    name: typeof candidate.name === 'string' ? candidate.name : undefined,
    lastModified: typeof candidate.lastModified === 'number' ? candidate.lastModified : undefined,
  };
}

function defaultIdFactory(kind: 'playlist' | 'track'): string {
  const cryptoApi = globalThis.crypto;
  const random = cryptoApi?.randomUUID?.();
  if (random) return `${kind}-${random}`;
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function emptySnapshot(): MusicLibrarySnapshot {
  return {
    version: MUSIC_LIBRARY_VERSION,
    tracks: [],
    playlists: [],
    activePlaylistId: null,
    activeTrackId: null,
  };
}

function sanitizeSnapshot(value: unknown, now: number): MusicLibrarySnapshot {
  if (!isRecord(value) || value.version !== MUSIC_LIBRARY_VERSION) return emptySnapshot();

  const tracks: LocalMusicTrack[] = [];
  const trackIds = new Set<string>();
  if (Array.isArray(value.tracks)) {
    for (const raw of value.tracks) {
      if (!isRecord(raw)) continue;
      const id = compactText(raw.id, 200);
      const title = compactText(raw.title, MAX_TRACK_TITLE_LENGTH);
      const fileName = compactText(raw.fileName, 255);
      const bytes = finiteOrNull(raw.bytes, 1);
      if (!id || !title || !fileName || bytes === null || trackIds.has(id)) continue;
      const createdAt = finiteTimestamp(raw.createdAt, now);
      tracks.push({
        id,
        title,
        fileName,
        mimeType: compactText(raw.mimeType, 120),
        bytes,
        lastModified: finiteTimestamp(raw.lastModified, createdAt),
        duration: finiteOrNull(raw.duration),
        bpm: finiteOrNull(raw.bpm, 1),
        createdAt,
        updatedAt: finiteTimestamp(raw.updatedAt, createdAt),
      });
      trackIds.add(id);
    }
  }

  const playlists: MusicPlaylist[] = [];
  const playlistIds = new Set<string>();
  if (Array.isArray(value.playlists)) {
    for (const raw of value.playlists) {
      if (!isRecord(raw)) continue;
      const id = compactText(raw.id, 200);
      const name = compactText(raw.name, MAX_PLAYLIST_NAME_LENGTH);
      if (!id || !name || playlistIds.has(id)) continue;
      const createdAt = finiteTimestamp(raw.createdAt, now);
      const membership = Array.isArray(raw.trackIds) ? raw.trackIds : [];
      const seen = new Set<string>();
      const validTrackIds = membership.filter((trackId): trackId is string => {
        if (typeof trackId !== 'string' || !trackIds.has(trackId) || seen.has(trackId)) return false;
        seen.add(trackId);
        return true;
      });
      playlists.push({
        id,
        name,
        system: raw.system === true,
        trackIds: validTrackIds,
        createdAt,
        updatedAt: finiteTimestamp(raw.updatedAt, createdAt),
      });
      playlistIds.add(id);
    }
  }
  if (!playlists.some((playlist) => playlist.system)) {
    const legacyDefault = playlists.find((playlist) => LEGACY_DEFAULT_PLAYLIST_NAMES.has(playlist.name));
    if (legacyDefault) legacyDefault.system = true;
  }

  const requestedPlaylistId = typeof value.activePlaylistId === 'string' ? value.activePlaylistId : null;
  const activePlaylistId = requestedPlaylistId && playlistIds.has(requestedPlaylistId)
    ? requestedPlaylistId
    : playlists[0]?.id ?? null;
  const activePlaylist = playlists.find((playlist) => playlist.id === activePlaylistId);
  const requestedTrackId = typeof value.activeTrackId === 'string' ? value.activeTrackId : null;
  const activeTrackId = requestedTrackId && activePlaylist?.trackIds.includes(requestedTrackId)
    ? requestedTrackId
    : activePlaylist?.trackIds[0] ?? null;

  return {
    version: MUSIC_LIBRARY_VERSION,
    tracks,
    playlists,
    activePlaylistId,
    activeTrackId,
  };
}

export class MemoryMusicLibraryStorage implements MusicLibraryStorage {
  readonly values = new Map<string, string>();
  readonly persistent = false;
  readonly persistenceDegraded = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

/** Mirrors small metadata into memory so locked-down localStorage never breaks a run. */
export class FallbackMusicLibraryStorage implements MusicLibraryStorage {
  private degraded = false;

  constructor(
    private readonly primary: MusicLibraryStorage,
    private readonly fallback: MusicLibraryStorage = new MemoryMusicLibraryStorage(),
  ) {}

  get persistent(): boolean { return !this.degraded; }
  get persistenceDegraded(): boolean { return this.degraded; }

  getItem(key: string): string | null {
    try {
      const value = this.primary.getItem(key);
      if (value !== null) {
        this.fallback.setItem(key, value);
        return value;
      }
    } catch {
      this.degraded = true;
      // Read the last mirrored value below.
    }
    return this.fallback.getItem(key);
  }

  setItem(key: string, value: string): void {
    this.fallback.setItem(key, value);
    try {
      this.primary.setItem(key, value);
    } catch {
      this.degraded = true;
      // The memory mirror remains usable for the current page lifetime.
    }
  }

  removeItem(key: string): void {
    this.fallback.removeItem?.(key);
    try {
      this.primary.removeItem?.(key);
    } catch {
      this.degraded = true;
      // The fallback was still cleared.
    }
  }
}

export class MemoryTrackBlobStore implements TrackBlobStore {
  readonly blobs = new Map<string, Blob>();
  readonly persistent = false;
  readonly persistenceDegraded = false;

  async put(trackId: string, blob: Blob): Promise<void> {
    this.blobs.set(trackId, blob);
  }

  async get(trackId: string): Promise<Blob | null> {
    return this.blobs.get(trackId) ?? null;
  }

  async delete(trackId: string): Promise<void> {
    this.blobs.delete(trackId);
  }

  async keys(): Promise<string[]> {
    return [...this.blobs.keys()];
  }
}

export class IndexedDbTrackBlobStore implements TrackBlobStore {
  private databasePromise: Promise<IDBDatabase> | null = null;
  readonly persistent = true;
  readonly persistenceDegraded = false;

  constructor(
    private readonly indexedDb: IDBFactory,
    private readonly databaseName = MUSIC_LIBRARY_DB_NAME,
    private readonly storeName = MUSIC_LIBRARY_BLOB_STORE,
  ) {}

  async put(trackId: string, blob: Blob): Promise<void> {
    await this.request('readwrite', (store) => store.put({ id: trackId, blob } satisfies StoredBlobRecord));
  }

  async get(trackId: string): Promise<Blob | null> {
    const value = await this.request<StoredBlobRecord | undefined>('readonly', (store) => store.get(trackId));
    return value?.blob instanceof Blob ? value.blob : null;
  }

  async delete(trackId: string): Promise<void> {
    await this.request('readwrite', (store) => store.delete(trackId));
  }

  async keys(): Promise<string[]> {
    const keys = await this.request<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
    return keys.filter((key): key is string => typeof key === 'string');
  }

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.indexedDb.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(this.storeName)) {
          database.createObjectStore(this.storeName, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened'));
      request.onblocked = () => reject(new Error('IndexedDB upgrade was blocked'));
    });
    this.databasePromise.catch(() => {
      this.databasePromise = null;
    });
    return this.databasePromise;
  }

  private async request<T = undefined>(
    mode: IDBTransactionMode,
    createRequest: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const database = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(this.storeName, mode);
      const request = createRequest(transaction.objectStore(this.storeName));
      let result: T;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted'));
    });
  }
}

/** Uses IndexedDB when available and transparently falls back after browser/storage failures. */
export class FallbackTrackBlobStore implements TrackBlobStore {
  private degraded = false;

  constructor(
    private readonly primary: TrackBlobStore,
    private readonly fallback: TrackBlobStore = new MemoryTrackBlobStore(),
  ) {}

  get persistent(): boolean { return !this.degraded; }
  get persistenceDegraded(): boolean { return this.degraded; }

  async put(trackId: string, blob: Blob): Promise<void> {
    try {
      await this.primary.put(trackId, blob);
      return;
    } catch {
      this.degraded = true;
    }
    await this.fallback.put(trackId, blob);
  }

  async get(trackId: string): Promise<Blob | null> {
    try {
      const blob = await this.primary.get(trackId);
      if (blob) return blob;
    } catch {
      this.degraded = true;
    }
    return this.fallback.get(trackId);
  }

  async delete(trackId: string): Promise<void> {
    try {
      await this.primary.delete(trackId);
    } catch {
      this.degraded = true;
    }
    await this.fallback.delete(trackId);
  }

  async keys(): Promise<string[]> {
    let primaryKeys: string[] = [];
    try {
      primaryKeys = await this.primary.keys();
    } catch {
      this.degraded = true;
    }
    const fallbackKeys = await this.fallback.keys();
    return [...new Set([...primaryKeys, ...fallbackKeys])];
  }
}

export class MusicLibrary {
  private readonly listeners = new Set<MusicLibraryListener>();
  private readonly now: () => number;
  private readonly idFactory: (kind: 'playlist' | 'track') => string;
  private readonly metadataKey: string;
  private state: MusicLibrarySnapshot;

  constructor(private readonly options: MusicLibraryOptions) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.metadataKey = options.metadataKey ?? MUSIC_LIBRARY_METADATA_KEY;
    this.state = this.load();
    if (this.state.playlists.length === 0) {
      const timestamp = this.now();
      const playlist: MusicPlaylist = {
        id: this.uniqueId('playlist'),
        name: DEFAULT_PLAYLIST_NAME,
        system: true,
        trackIds: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.state.playlists.push(playlist);
      this.state.activePlaylistId = playlist.id;
      this.persist(this.state);
    }
  }

  getSnapshot(): MusicLibrarySnapshot {
    return cloneSnapshot(this.state);
  }

  getPersistenceStatus(): MusicLibraryPersistenceStatus {
    const metadata = this.options.metadataStorage as MusicLibraryStorage & Partial<PersistenceAwareStore>;
    const blobs = this.options.blobStore as TrackBlobStore & Partial<PersistenceAwareStore>;
    const metadataDurable = metadata.persistent !== false && metadata.persistenceDegraded !== true;
    const blobsDurable = blobs.persistent !== false && blobs.persistenceDegraded !== true;
    return {
      degraded: !metadataDurable || !blobsDurable,
      metadataDurable,
      blobsDurable,
    };
  }

  subscribe(listener: MusicLibraryListener, emitCurrent = false): () => void {
    this.listeners.add(listener);
    if (emitCurrent) listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  createPlaylist(name: string, activate = true): MusicPlaylist {
    const timestamp = this.now();
    const playlist: MusicPlaylist = {
      id: this.uniqueId('playlist'),
      name: requireName(name, 'Playlist name', MAX_PLAYLIST_NAME_LENGTH),
      trackIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.commit((next) => {
      next.playlists.push(playlist);
      if (activate) {
        next.activePlaylistId = playlist.id;
        next.activeTrackId = null;
      }
    });
    return clonePlaylist(playlist);
  }

  renamePlaylist(playlistId: string, name: string): MusicPlaylist {
    const normalized = requireName(name, 'Playlist name', MAX_PLAYLIST_NAME_LENGTH);
    let renamed: MusicPlaylist | null = null;
    this.commit((next) => {
      const playlist = this.requirePlaylist(next, playlistId);
      playlist.name = normalized;
      playlist.system = false;
      playlist.updatedAt = this.now();
      renamed = clonePlaylist(playlist);
    });
    return renamed!;
  }

  deletePlaylist(playlistId: string): void {
    this.commit((next) => {
      const index = next.playlists.findIndex((playlist) => playlist.id === playlistId);
      if (index < 0) throw new MusicLibraryError('playlist-not-found', `Unknown playlist: ${playlistId}`);
      next.playlists.splice(index, 1);
      if (next.playlists.length === 0) {
        const timestamp = this.now();
        next.playlists.push({
          id: this.uniqueId('playlist', next),
          name: DEFAULT_PLAYLIST_NAME,
          system: true,
          trackIds: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      if (next.activePlaylistId === playlistId) next.activePlaylistId = next.playlists[Math.min(index, next.playlists.length - 1)].id;
      this.reconcileSelection(next);
    });
  }

  async addTrack(blob: Blob, options: AddTrackOptions = {}): Promise<LocalMusicTrack> {
    if (!blob || typeof blob.size !== 'number' || blob.size <= 0) {
      throw new MusicLibraryError('empty-file', 'Audio file cannot be empty');
    }
    const file = fileProperties(blob);
    const fileName = requireName(options.fileName ?? file.name ?? 'track.audio', 'File name', 255);
    const title = requireName(options.title ?? titleFromFileName(fileName), 'Track title', MAX_TRACK_TITLE_LENGTH);
    const timestamp = this.now();
    const track: LocalMusicTrack = {
      id: this.uniqueId('track'),
      title,
      fileName,
      mimeType: compactText(blob.type, 120),
      bytes: blob.size,
      lastModified: finiteTimestamp(options.lastModified ?? file.lastModified, timestamp),
      duration: finiteOrNull(options.duration),
      bpm: finiteOrNull(options.bpm, 1),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const targetPlaylistId = options.playlistId === undefined ? this.state.activePlaylistId : options.playlistId;
    if (targetPlaylistId !== null) this.requirePlaylist(this.state, targetPlaylistId);
    await this.options.blobStore.put(track.id, blob);
    try {
      this.commit((next) => {
        next.tracks.push(track);
        if (targetPlaylistId !== null) {
          const playlist = this.requirePlaylist(next, targetPlaylistId);
          playlist.trackIds.push(track.id);
          playlist.updatedAt = timestamp;
          if (options.activate !== false) next.activePlaylistId = playlist.id;
        }
        if (options.activate !== false) next.activeTrackId = track.id;
        this.reconcileSelection(next);
      });
    } catch (error) {
      await this.options.blobStore.delete(track.id).catch(() => undefined);
      throw error;
    }
    return cloneTrack(track);
  }

  updateTrack(trackId: string, patch: UpdateTrackMetadata): LocalMusicTrack {
    let updated: LocalMusicTrack | null = null;
    this.commit((next) => {
      const track = this.requireTrack(next, trackId);
      if (patch.title !== undefined) track.title = requireName(patch.title, 'Track title', MAX_TRACK_TITLE_LENGTH);
      if (patch.duration !== undefined) track.duration = finiteOrNull(patch.duration);
      if (patch.bpm !== undefined) track.bpm = finiteOrNull(patch.bpm, 1);
      track.updatedAt = this.now();
      updated = cloneTrack(track);
    });
    return updated!;
  }

  async deleteTrack(trackId: string): Promise<void> {
    this.requireTrack(this.state, trackId);
    this.commit((next) => {
      next.tracks = next.tracks.filter((track) => track.id !== trackId);
      for (const playlist of next.playlists) {
        const nextIds = playlist.trackIds.filter((id) => id !== trackId);
        if (nextIds.length !== playlist.trackIds.length) {
          playlist.trackIds = nextIds;
          playlist.updatedAt = this.now();
        }
      }
      this.reconcileSelection(next);
    });
    await this.options.blobStore.delete(trackId);
  }

  addTrackToPlaylist(trackId: string, playlistId: string, index?: number): void {
    this.commit((next) => {
      this.requireTrack(next, trackId);
      const playlist = this.requirePlaylist(next, playlistId);
      if (playlist.trackIds.includes(trackId)) return;
      const insertion = typeof index === 'number' && Number.isFinite(index)
        ? Math.max(0, Math.min(playlist.trackIds.length, Math.trunc(index)))
        : playlist.trackIds.length;
      playlist.trackIds.splice(insertion, 0, trackId);
      playlist.updatedAt = this.now();
    });
  }

  removeTrackFromPlaylist(trackId: string, playlistId: string): void {
    this.commit((next) => {
      const playlist = this.requirePlaylist(next, playlistId);
      const index = playlist.trackIds.indexOf(trackId);
      if (index < 0) {
        throw new MusicLibraryError('track-not-in-playlist', `Track ${trackId} is not in playlist ${playlistId}`);
      }
      playlist.trackIds.splice(index, 1);
      playlist.updatedAt = this.now();
      this.reconcileSelection(next);
    });
  }

  moveTrackInPlaylist(trackId: string, playlistId: string, targetIndex: number): void {
    this.commit((next) => {
      const playlist = this.requirePlaylist(next, playlistId);
      const sourceIndex = playlist.trackIds.indexOf(trackId);
      if (sourceIndex < 0) {
        throw new MusicLibraryError('track-not-in-playlist', `Track ${trackId} is not in playlist ${playlistId}`);
      }
      playlist.trackIds.splice(sourceIndex, 1);
      const insertion = Math.max(0, Math.min(playlist.trackIds.length, Math.trunc(targetIndex)));
      playlist.trackIds.splice(insertion, 0, trackId);
      playlist.updatedAt = this.now();
    });
  }

  setActivePlaylist(playlistId: string | null): void {
    this.commit((next) => {
      if (playlistId !== null) this.requirePlaylist(next, playlistId);
      next.activePlaylistId = playlistId;
      this.reconcileSelection(next);
    });
  }

  setActiveTrack(trackId: string | null, playlistId?: string): void {
    this.commit((next) => {
      if (trackId === null) {
        next.activeTrackId = null;
        return;
      }
      this.requireTrack(next, trackId);
      const targetPlaylist = playlistId
        ? this.requirePlaylist(next, playlistId)
        : next.playlists.find((playlist) => playlist.id === next.activePlaylistId && playlist.trackIds.includes(trackId))
          ?? next.playlists.find((playlist) => playlist.trackIds.includes(trackId));
      if (!targetPlaylist || !targetPlaylist.trackIds.includes(trackId)) {
        throw new MusicLibraryError('track-not-in-playlist', `Track ${trackId} is not assigned to the selected playlist`);
      }
      next.activePlaylistId = targetPlaylist.id;
      next.activeTrackId = trackId;
    });
  }

  async getTrackBlob(trackId: string): Promise<Blob> {
    this.requireTrack(this.state, trackId);
    const blob = await this.options.blobStore.get(trackId);
    if (!blob) throw new MusicLibraryError('blob-not-found', `Audio data is missing for track ${trackId}`);
    return blob;
  }

  async getTrackFile(trackId: string): Promise<File> {
    const track = this.requireTrack(this.state, trackId);
    const blob = await this.getTrackBlob(trackId);
    const FileConstructor = globalThis.File;
    if (typeof FileConstructor !== 'function') {
      throw new MusicLibraryError('file-api-unavailable', 'The File API is unavailable in this environment');
    }
    return new FileConstructor([blob], track.fileName, {
      type: track.mimeType || blob.type,
      lastModified: track.lastModified,
    });
  }

  /** Removes metadata entries whose IndexedDB blobs no longer exist. */
  async pruneMissingTracks(): Promise<string[]> {
    const missing: string[] = [];
    for (const track of this.state.tracks) {
      if (!await this.options.blobStore.get(track.id)) missing.push(track.id);
    }
    if (missing.length === 0) return missing;
    const missingIds = new Set(missing);
    this.commit((next) => {
      next.tracks = next.tracks.filter((track) => !missingIds.has(track.id));
      for (const playlist of next.playlists) {
        playlist.trackIds = playlist.trackIds.filter((id) => !missingIds.has(id));
      }
      this.reconcileSelection(next);
    });
    return missing;
  }

  /** Removes IndexedDB records left behind by interrupted metadata writes. */
  async pruneOrphanedBlobs(): Promise<string[]> {
    const metadataIds = new Set(this.state.tracks.map((track) => track.id));
    const orphaned = (await this.options.blobStore.keys()).filter((id) => !metadataIds.has(id));
    await Promise.all(orphaned.map((id) => this.options.blobStore.delete(id)));
    return orphaned;
  }

  private load(): MusicLibrarySnapshot {
    try {
      const serialized = this.options.metadataStorage.getItem(this.metadataKey);
      if (!serialized) return emptySnapshot();
      return sanitizeSnapshot(JSON.parse(serialized) as unknown, this.now());
    } catch {
      return emptySnapshot();
    }
  }

  private persist(snapshot: MusicLibrarySnapshot): void {
    this.options.metadataStorage.setItem(this.metadataKey, JSON.stringify(snapshot));
  }

  private commit(mutator: (next: MusicLibrarySnapshot) => void): void {
    const next = cloneSnapshot(this.state);
    mutator(next);
    this.persist(next);
    this.state = next;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private uniqueId(kind: 'playlist' | 'track', snapshot = this.state): string {
    const occupied = new Set([
      ...snapshot.playlists.map((playlist) => playlist.id),
      ...snapshot.tracks.map((track) => track.id),
    ]);
    const candidate = compactText(this.idFactory(kind), 200) || defaultIdFactory(kind);
    if (!occupied.has(candidate)) return candidate;
    let suffix = 2;
    while (occupied.has(`${candidate}-${suffix}`)) suffix += 1;
    return `${candidate}-${suffix}`;
  }

  private requirePlaylist(snapshot: MusicLibrarySnapshot, playlistId: string): MusicPlaylist {
    const playlist = snapshot.playlists.find((candidate) => candidate.id === playlistId);
    if (!playlist) throw new MusicLibraryError('playlist-not-found', `Unknown playlist: ${playlistId}`);
    return playlist;
  }

  private requireTrack(snapshot: MusicLibrarySnapshot, trackId: string): LocalMusicTrack {
    const track = snapshot.tracks.find((candidate) => candidate.id === trackId);
    if (!track) throw new MusicLibraryError('track-not-found', `Unknown track: ${trackId}`);
    return track;
  }

  private reconcileSelection(snapshot: MusicLibrarySnapshot): void {
    const playlist = snapshot.playlists.find((candidate) => candidate.id === snapshot.activePlaylistId);
    if (!playlist) {
      snapshot.activePlaylistId = null;
      snapshot.activeTrackId = null;
      return;
    }
    if (!snapshot.activeTrackId || !playlist.trackIds.includes(snapshot.activeTrackId)) {
      snapshot.activeTrackId = playlist.trackIds[0] ?? null;
    }
  }
}

export interface BrowserMusicLibraryOptions {
  metadataStorage?: MusicLibraryStorage;
  fallbackMetadataStorage?: MusicLibraryStorage;
  blobStore?: TrackBlobStore;
  fallbackBlobStore?: TrackBlobStore;
  indexedDb?: IDBFactory | null;
  now?: () => number;
  idFactory?: (kind: 'playlist' | 'track') => string;
}

function browserLocalStorage(): MusicLibraryStorage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function browserIndexedDb(): IDBFactory | null {
  try {
    return typeof globalThis.indexedDB === 'undefined' ? null : globalThis.indexedDB;
  } catch {
    return null;
  }
}

/** Browser-ready factory: localStorage metadata + IndexedDB audio, both with injectable fallbacks. */
export function createBrowserMusicLibrary(options: BrowserMusicLibraryOptions = {}): MusicLibrary {
  const metadataFallback = options.fallbackMetadataStorage ?? new MemoryMusicLibraryStorage();
  const metadataPrimary = options.metadataStorage ?? browserLocalStorage();
  const metadataStorage = metadataPrimary
    ? new FallbackMusicLibraryStorage(metadataPrimary, metadataFallback)
    : metadataFallback;

  const blobFallback = options.fallbackBlobStore ?? new MemoryTrackBlobStore();
  const indexedDb = options.indexedDb === undefined ? browserIndexedDb() : options.indexedDb;
  const blobPrimary = options.blobStore ?? (indexedDb ? new IndexedDbTrackBlobStore(indexedDb) : null);
  const blobStore = blobPrimary ? new FallbackTrackBlobStore(blobPrimary, blobFallback) : blobFallback;

  return new MusicLibrary({
    metadataStorage,
    blobStore,
    now: options.now,
    idFactory: options.idFactory,
  });
}
