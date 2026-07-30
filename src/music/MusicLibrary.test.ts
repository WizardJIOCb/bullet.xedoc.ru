import { describe, expect, it, vi } from 'vitest';
import {
  FallbackMusicLibraryStorage,
  FallbackTrackBlobStore,
  MUSIC_LIBRARY_METADATA_KEY,
  MemoryMusicLibraryStorage,
  MemoryTrackBlobStore,
  MusicLibrary,
  MusicLibraryError,
  createBrowserMusicLibrary,
  type MusicLibraryStorage,
  type TrackBlobStore,
} from './MusicLibrary';

function idFactory() {
  const counts = { playlist: 0, track: 0 };
  return (kind: 'playlist' | 'track') => `${kind}-${++counts[kind]}`;
}

function createHarness(metadata = new MemoryMusicLibraryStorage(), blobs = new MemoryTrackBlobStore()) {
  let now = 1000;
  const library = new MusicLibrary({
    metadataStorage: metadata,
    blobStore: blobs,
    now: () => ++now,
    idFactory: idFactory(),
  });
  return { library, metadata, blobs };
}

function audioBlob(contents = 'audio-data', type = 'audio/mpeg'): Blob {
  return new Blob([contents], { type });
}

describe('MusicLibrary', () => {
  it('creates and persists an isolated default playlist', () => {
    const { library, metadata } = createHarness();
    const first = library.getSnapshot();

    expect(first).toMatchObject({
      version: 1,
      activePlaylistId: 'playlist-1',
      activeTrackId: null,
      tracks: [],
      playlists: [{ id: 'playlist-1', name: 'My tracks', system: true, trackIds: [] }],
    });
    expect(metadata.getItem(MUSIC_LIBRARY_METADATA_KEY)).not.toBeNull();

    first.playlists[0].name = 'mutated outside';
    first.playlists[0].trackIds.push('ghost');
    expect(library.getSnapshot().playlists[0]).toMatchObject({ name: 'My tracks', trackIds: [] });
  });

  it('marks legacy built-in list names as localizable and makes a renamed list custom', () => {
    const metadata = new MemoryMusicLibraryStorage();
    metadata.setItem(MUSIC_LIBRARY_METADATA_KEY, JSON.stringify({
      version: 1,
      tracks: [],
      playlists: [{
        id: 'legacy-default',
        name: 'Мои треки',
        trackIds: [],
        createdAt: 10,
        updatedAt: 10,
      }],
      activePlaylistId: 'legacy-default',
      activeTrackId: null,
    }));
    const { library } = createHarness(metadata);

    expect(library.getSnapshot().playlists[0].system).toBe(true);
    expect(library.renamePlaylist('legacy-default', 'Night drive')).toMatchObject({
      name: 'Night drive',
      system: false,
    });
  });

  it('stores a Blob separately from localStorage metadata and restores it in another instance', async () => {
    const metadata = new MemoryMusicLibraryStorage();
    const blobs = new MemoryTrackBlobStore();
    const first = createHarness(metadata, blobs).library;
    const source = audioBlob('persistent-music');

    const track = await first.addTrack(source, {
      fileName: 'Neon Drop.mp3',
      duration: 123.4,
      bpm: 142,
    });

    expect(track).toMatchObject({
      id: 'track-1',
      title: 'Neon Drop',
      fileName: 'Neon Drop.mp3',
      mimeType: 'audio/mpeg',
      bytes: source.size,
      duration: 123.4,
      bpm: 142,
    });
    expect(first.getSnapshot()).toMatchObject({
      activePlaylistId: 'playlist-1',
      activeTrackId: 'track-1',
      playlists: [{ trackIds: ['track-1'] }],
    });
    expect(JSON.parse(metadata.getItem(MUSIC_LIBRARY_METADATA_KEY)!)).not.toHaveProperty('blob');

    const restored = createHarness(metadata, blobs).library;
    expect(restored.getSnapshot().tracks).toEqual([track]);
    expect(await (await restored.getTrackBlob(track.id)).text()).toBe('persistent-music');
  });

  it('supports playlist CRUD, membership, ordering, and active selection', async () => {
    const { library } = createHarness();
    const first = await library.addTrack(audioBlob('one'), { fileName: 'one.mp3' });
    const second = await library.addTrack(audioBlob('two'), { fileName: 'two.mp3' });
    const favorites = library.createPlaylist('  Night   rides  ');

    expect(favorites.name).toBe('Night rides');
    expect(library.getSnapshot()).toMatchObject({ activePlaylistId: favorites.id, activeTrackId: null });

    library.addTrackToPlaylist(second.id, favorites.id);
    library.addTrackToPlaylist(first.id, favorites.id, 0);
    library.moveTrackInPlaylist(second.id, favorites.id, 0);
    library.setActiveTrack(first.id, favorites.id);
    expect(library.getSnapshot()).toMatchObject({
      activePlaylistId: favorites.id,
      activeTrackId: first.id,
      playlists: expect.arrayContaining([
        expect.objectContaining({ id: favorites.id, trackIds: [second.id, first.id] }),
      ]),
    });

    const renamed = library.renamePlaylist(favorites.id, 'Boss waves');
    expect(renamed.name).toBe('Boss waves');
    library.removeTrackFromPlaylist(first.id, favorites.id);
    expect(library.getSnapshot().activeTrackId).toBe(second.id);

    library.deletePlaylist(favorites.id);
    expect(library.getSnapshot()).toMatchObject({
      activePlaylistId: 'playlist-1',
      activeTrackId: second.id,
    });
  });

  it('keeps at least one list after deleting the final playlist', () => {
    const { library } = createHarness();
    library.deletePlaylist('playlist-1');
    expect(library.getSnapshot()).toMatchObject({
      activePlaylistId: 'playlist-2',
      activeTrackId: null,
      playlists: [{ id: 'playlist-2', name: 'My tracks' }],
    });
  });

  it('deletes a user track from every playlist and binary storage', async () => {
    const { library, blobs } = createHarness();
    const track = await library.addTrack(audioBlob('delete-me'), { fileName: 'delete.mp3' });
    const secondList = library.createPlaylist('Second');
    library.addTrackToPlaylist(track.id, secondList.id);
    library.setActiveTrack(track.id, secondList.id);

    await library.deleteTrack(track.id);

    const snapshot = library.getSnapshot();
    expect(snapshot.tracks).toEqual([]);
    expect(snapshot.playlists.every((playlist) => playlist.trackIds.length === 0)).toBe(true);
    expect(snapshot.activeTrackId).toBeNull();
    expect(await blobs.get(track.id)).toBeNull();
  });

  it('updates analysis metadata without rewriting the stored audio', async () => {
    const { library, blobs } = createHarness();
    const track = await library.addTrack(audioBlob('same-blob'), { fileName: 'draft.wav' });
    const before = await blobs.get(track.id);

    const updated = library.updateTrack(track.id, { title: 'Final Mix', duration: 98.2, bpm: 174 });

    expect(updated).toMatchObject({ title: 'Final Mix', duration: 98.2, bpm: 174 });
    expect(await blobs.get(track.id)).toBe(before);
  });

  it('notifies subscribers with cloned snapshots after committed changes', () => {
    const { library } = createHarness();
    const listener = vi.fn();
    const unsubscribe = library.subscribe(listener, true);

    library.createPlaylist('New list');
    unsubscribe();
    library.createPlaylist('Not observed');

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0][0].playlists).toHaveLength(1);
    expect(listener.mock.calls[1][0].playlists).toHaveLength(2);
  });

  it('sanitizes corrupt metadata and dangling playlist references', () => {
    const metadata = new MemoryMusicLibraryStorage();
    metadata.setItem(MUSIC_LIBRARY_METADATA_KEY, JSON.stringify({
      version: 1,
      tracks: [
        { id: 'good', title: 'Good', fileName: 'good.mp3', bytes: 10, createdAt: 2 },
        { id: 'empty', title: '', fileName: 'bad.mp3', bytes: 10 },
        { id: 'good', title: 'Duplicate', fileName: 'dup.mp3', bytes: 12 },
      ],
      playlists: [{
        id: 'list',
        name: 'List',
        trackIds: ['good', 'missing', 'good'],
        createdAt: 3,
      }],
      activePlaylistId: 'missing-list',
      activeTrackId: 'missing',
    }));

    const library = createHarness(metadata).library;
    expect(library.getSnapshot()).toMatchObject({
      tracks: [{ id: 'good' }],
      playlists: [{ id: 'list', trackIds: ['good'] }],
      activePlaylistId: 'list',
      activeTrackId: 'good',
    });
  });

  it('prunes missing metadata and orphaned binary records independently', async () => {
    const { library, blobs } = createHarness();
    const missing = await library.addTrack(audioBlob('missing'), { fileName: 'missing.mp3' });
    const present = await library.addTrack(audioBlob('present'), { fileName: 'present.mp3' });
    await blobs.delete(missing.id);
    await blobs.put('orphan', audioBlob('orphan'));

    expect(await library.pruneMissingTracks()).toEqual([missing.id]);
    expect(library.getSnapshot().tracks.map((track) => track.id)).toEqual([present.id]);
    expect(await library.pruneOrphanedBlobs()).toEqual(['orphan']);
    expect(await blobs.keys()).toEqual([present.id]);
  });

  it('reports domain errors that the UI can map to messages', async () => {
    const { library } = createHarness();

    expect(() => library.createPlaylist('   ')).toThrowError(expect.objectContaining<Partial<MusicLibraryError>>({ code: 'invalid-name' }));
    expect(() => library.setActivePlaylist('unknown')).toThrowError(expect.objectContaining<Partial<MusicLibraryError>>({ code: 'playlist-not-found' }));
    await expect(library.addTrack(new Blob())).rejects.toMatchObject({ code: 'empty-file' });
    await expect(library.getTrackBlob('unknown')).rejects.toMatchObject({ code: 'track-not-found' });
  });
});

describe('storage fallbacks', () => {
  it('mirrors metadata and remains usable when localStorage throws', () => {
    const primaryValues = new Map<string, string>();
    let failing = false;
    const primary: MusicLibraryStorage = {
      getItem: (key) => {
        if (failing) throw new Error('denied');
        return primaryValues.get(key) ?? null;
      },
      setItem: (key, value) => {
        if (failing) throw new Error('quota');
        primaryValues.set(key, value);
      },
    };
    const fallback = new MemoryMusicLibraryStorage();
    const storage = new FallbackMusicLibraryStorage(primary, fallback);

    storage.setItem('key', 'first');
    failing = true;
    expect(storage.getItem('key')).toBe('first');
    expect(() => storage.setItem('key', 'second')).not.toThrow();
    expect(storage.getItem('key')).toBe('second');
    expect(storage.persistenceDegraded).toBe(true);
  });

  it('uses the binary fallback after IndexedDB failure and reports degraded persistence', async () => {
    const primary: TrackBlobStore = {
      put: async () => { throw new Error('IndexedDB disabled'); },
      get: async () => { throw new Error('IndexedDB disabled'); },
      delete: async () => { throw new Error('IndexedDB disabled'); },
      keys: async () => { throw new Error('IndexedDB disabled'); },
    };
    const fallback = new MemoryTrackBlobStore();
    const storage = new FallbackTrackBlobStore(primary, fallback);
    const blob = audioBlob('fallback');

    await storage.put('track', blob);
    expect(storage.persistenceDegraded).toBe(true);
    expect(await storage.get('track')).toBe(blob);
    expect(await storage.keys()).toEqual(['track']);
    await storage.delete('track');
    expect(await storage.get('track')).toBeNull();
  });

  it('keeps reading durable tracks after a different IndexedDB write fails', async () => {
    const durable = audioBlob('durable');
    const primaryBlobs = new Map<string, Blob>([['old-track', durable]]);
    const primary: TrackBlobStore = {
      put: async (trackId, blob) => {
        if (trackId === 'new-track') throw new Error('quota');
        primaryBlobs.set(trackId, blob);
      },
      get: async (trackId) => primaryBlobs.get(trackId) ?? null,
      delete: async (trackId) => { primaryBlobs.delete(trackId); },
      keys: async () => [...primaryBlobs.keys()],
    };
    const storage = new FallbackTrackBlobStore(primary, new MemoryTrackBlobStore());
    const temporary = audioBlob('temporary');

    await storage.put('new-track', temporary);
    expect(storage.persistenceDegraded).toBe(true);
    expect(await storage.get('old-track')).toBe(durable);
    expect(await storage.get('new-track')).toBe(temporary);
    expect(await storage.keys()).toEqual(expect.arrayContaining(['old-track', 'new-track']));
  });

  it('exposes when a library save only survives in the current tab', async () => {
    const metadata = new FallbackMusicLibraryStorage({
      getItem: () => null,
      setItem: () => { throw new Error('localStorage quota'); },
    });
    const blobs = new FallbackTrackBlobStore({
      put: async () => { throw new Error('IndexedDB quota'); },
      get: async () => null,
      delete: async () => undefined,
      keys: async () => [],
    });
    const library = new MusicLibrary({
      metadataStorage: metadata,
      blobStore: blobs,
      now: () => 1,
      idFactory: idFactory(),
    });

    await library.addTrack(audioBlob('temporary'), { fileName: 'temporary.mp3' });
    expect(library.getPersistenceStatus()).toEqual({
      degraded: true,
      metadataDurable: false,
      blobsDurable: false,
    });
  });

  it('browser factory is fully testable without browser globals', async () => {
    const metadata = new MemoryMusicLibraryStorage();
    const blobs = new MemoryTrackBlobStore();
    const library = createBrowserMusicLibrary({
      metadataStorage: metadata,
      blobStore: blobs,
      indexedDb: null,
      now: () => 7,
      idFactory: idFactory(),
    });

    const track = await library.addTrack(audioBlob('factory'), { fileName: 'factory.ogg' });
    expect(await (await library.getTrackBlob(track.id)).text()).toBe('factory');
    expect(metadata.getItem(MUSIC_LIBRARY_METADATA_KEY)).toContain('factory.ogg');
  });
});
