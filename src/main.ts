import './styles.css';
import { AudioEngine, type CatalogAudioTrack } from './audio/AudioEngine';
import { ABILITIES, TRACKS, WEAPONS, type AbilityId, type GarageState, type RunConfig, type RunResult, type RunStats, type TrackId, type UpgradeDefinition, type WeaponId } from './core/types';
import { BallisticGame } from './game/Game';

const query = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing UI element: ${selector}`);
  return element;
};

const queryAll = <T extends Element>(selector: string): T[] => Array.from(document.querySelectorAll<T>(selector));
const setText = (selector: string, value: string): void => { query<HTMLElement>(selector).textContent = value; };

interface MusicCatalogEntry extends CatalogAudioTrack {
  bytes: number;
  format: string;
}

interface MusicManifest {
  version: 1;
  tracks: MusicCatalogEntry[];
}

const DEFAULT_GARAGE: GarageState = {
  credits: 900,
  engine: 0,
  cooling: 0,
  shield: 0,
  weapon: 0,
  bestScore: 0,
  runs: 0,
};

function loadGarage(): GarageState {
  try {
    const saved = JSON.parse(localStorage.getItem('ballistic-edge-save-v1') || 'null') as Partial<GarageState> | null;
    return { ...DEFAULT_GARAGE, ...(saved || {}) };
  } catch {
    return { ...DEFAULT_GARAGE };
  }
}

function saveGarage(state: GarageState): void {
  localStorage.setItem('ballistic-edge-save-v1', JSON.stringify(state));
}

function randomSeed(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] || Date.now();
}

const app = query<HTMLElement>('#app');
const menu = query<HTMLElement>('#menu');
const hud = query<HTMLElement>('#hud');
const upgradeScreen = query<HTMLElement>('#upgrade-screen');
const resultsScreen = query<HTMLElement>('#results-screen');
const startButton = query<HTMLButtonElement>('#start-run');
const musicLibrary = query<HTMLFieldSetElement>('#music-library');
const musicCatalog = query<HTMLSelectElement>('#music-catalog');
const musicCatalogRetry = query<HTMLButtonElement>('#music-catalog-retry');
const musicCatalogError = query<HTMLElement>('#music-catalog-error');
const audio = new AudioEngine();
let garage = loadGarage();
let selectedTrack: TrackId = 'aurora';
let selectedWeapon: WeaponId = 'pulse';
let selectedAbility: AbilityId = 'phase';
let lastRunSeed = randomSeed();
let lastConfig: RunConfig | null = null;
let toastTimer = 0;
let reducedEffects = localStorage.getItem('ballistic-edge-reduced-fx') === '1';
let musicLoading = false;
let musicCatalogReady = false;
let musicCatalogEntries: MusicCatalogEntry[] = [];
let selectedMusicId = 'synthetic';

const game = new BallisticGame(query<HTMLCanvasElement>('#game-canvas'), audio, {
  onHud: updateHud,
  onToast: showToast,
  onUpgrade: showUpgrade,
  onFinish: showResults,
  onCountdown: showCountdown,
  onSection: (name, index) => {
    setText('#section-label', `SECTOR 0${index} // ${name}`);
    showToast(`SECTOR 0${index}`, name, index === 3 ? 'gold' : 'cyan');
  },
});

function selectRadio<T extends string>(selector: string, value: T, attribute: string): void {
  for (const button of queryAll<HTMLButtonElement>(selector)) {
    const selected = button.dataset[attribute] === value;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-checked', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
}

function installRadioKeyboard(buttons: HTMLButtonElement[]): void {
  for (const button of buttons) {
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const currentIndex = buttons.indexOf(button);
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (currentIndex + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      buttons[nextIndex].focus();
      buttons[nextIndex].click();
    });
  }
}

function updateGarageUi(): void {
  setText('#credits-value', garage.credits.toLocaleString('ru-RU'));
  const modules: Array<keyof Pick<GarageState, 'engine' | 'cooling' | 'shield' | 'weapon'>> = ['engine', 'cooling', 'shield', 'weapon'];
  for (const module of modules) {
    const level = garage[module];
    const cost = 250 + level * 300;
    setText(`[data-level-for="${module}"]`, `LV.${level}`);
    setText(`[data-cost-for="${module}"]`, level >= 5 ? 'MAX' : `${cost} CR`);
    const button = query<HTMLButtonElement>(`.garage-module[data-module="${module}"]`);
    button.disabled = level >= 5;
    button.classList.toggle('is-affordable', garage.credits >= cost && level < 5);
  }
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes.toString().padStart(2, '0')}:${rest}`;
}

function updateMusicUi(): void {
  const profile = audio.getProfile();
  const sourceLabel = {
    synthetic: 'Встроенный синтезатор',
    catalog: 'Серверная библиотека',
    local: 'Локальный аудиофайл',
  }[audio.getSourceKind()];
  setText('#music-title', `${profile.title} // ${profile.bpm} BPM`);
  setText('#music-meta', `${sourceLabel} · ${formatDuration(profile.duration)}`);
  setText('#music-action', audio.getSourceKind() === 'local' ? 'CHANGE FILE' : 'LOAD FILE');
  setText('#music-hud', `${profile.title} // ${profile.bpm} BPM`);
}

function updateHud(stats: RunStats): void {
  setText('#speed-value', Math.round(stats.speed).toString().padStart(4, '0'));
  setText('#sync-value', `×${stats.sync}`);
  setText('#score-value', stats.score.toString().padStart(6, '0'));
  setText('#rank-value', String(stats.rank));
  setText('#heat-value', Math.round(stats.heat).toString().padStart(2, '0'));
  setText('#flux-value', Math.round(stats.flux).toString());
  query<HTMLElement>('#progress-fill').style.width = `${stats.progress * 100}%`;
  query<HTMLElement>('#heat-fill').style.height = `${stats.heat}%`;
  query<HTMLElement>('#flux-fill').style.height = `${stats.flux}%`;
  query<HTMLElement>('#rhythm-ring').style.setProperty('--pulse', String(stats.rhythmPulse));
  query<HTMLElement>('#weapon-ready').style.setProperty('--cooldown', String(Math.min(1, stats.weaponCooldown * 2)));
  setText('#ability-ready', stats.abilityCooldown <= 0 ? 'READY // Q' : `${stats.abilityCooldown.toFixed(1)} SEC`);
  app.classList.toggle('is-overheated', stats.overheated);
  app.classList.toggle('is-phasing', stats.phaseActive);
  app.classList.toggle('is-low-shield', stats.shield <= 1);
  const pips = query<HTMLElement>('#shield-pips');
  pips.innerHTML = Array.from({ length: stats.maxShield }, (_, index) => `<i class="${index < stats.shield ? 'is-active' : ''}"></i>`).join('');
}

function showToast(message: string, detail = '', tone: 'cyan' | 'gold' | 'red' | 'violet' = 'cyan'): void {
  const toast = query<HTMLElement>('#event-toast');
  window.clearTimeout(toastTimer);
  toast.dataset.tone = tone;
  toast.innerHTML = `<strong>${message}</strong>${detail ? `<span>${detail}</span>` : ''}`;
  toast.classList.remove('is-visible');
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 1300);
}

function showCountdown(value: string | null): void {
  const countdown = query<HTMLElement>('#countdown');
  countdown.textContent = value || '';
  countdown.classList.toggle('is-visible', Boolean(value));
  if (value) {
    countdown.classList.remove('is-pulse');
    requestAnimationFrame(() => countdown.classList.add('is-pulse'));
  }
}

function showUpgrade(options: UpgradeDefinition[]): void {
  const container = query<HTMLElement>('#upgrade-options');
  container.innerHTML = options.map((upgrade, index) => `
    <button class="upgrade-card upgrade-card--${upgrade.tone}" data-upgrade="${upgrade.id}" type="button">
      <span class="upgrade-card__index">0${index + 1}</span>
      <span class="upgrade-card__glyph"><i></i><i></i><i></i></span>
      <small>${upgrade.tag}</small>
      <strong>${upgrade.name}</strong>
      <p>${upgrade.description}</p>
      <span class="upgrade-card__install">INSTALL MODULE <b>→</b></span>
    </button>
  `).join('');
  for (const button of queryAll<HTMLButtonElement>('[data-upgrade]')) {
    button.addEventListener('click', async () => {
      upgradeScreen.classList.remove('is-active');
      await game.chooseUpgrade(button.dataset.upgrade as UpgradeDefinition['id']);
    }, { once: true });
  }
  upgradeScreen.classList.add('is-active');
}

function rankFromResult(result: RunResult): string {
  if (!result.survived) return 'D';
  if (result.rank === 1 && result.accuracy > 0.55 && result.perfects >= 8) return 'S';
  if (result.rank <= 2) return 'A';
  if (result.rank === 3) return 'B';
  return 'C';
}

function showResults(result: RunResult): void {
  const wasBest = result.score > garage.bestScore;
  garage.credits += result.credits;
  garage.runs += 1;
  garage.bestScore = Math.max(garage.bestScore, result.score);
  saveGarage(garage);
  updateGarageUi();
  hud.classList.remove('is-active');
  app.classList.remove('is-overheated', 'is-phasing', 'is-low-shield');
  setText('#result-rank', rankFromResult(result));
  setText('#result-status', result.survived ? 'SIGNAL CONQUERED' : 'HULL SIGNAL LOST');
  setText('#result-title', result.survived ? 'PULSE COMPLETE' : 'RUN TERMINATED');
  setText('#result-route', `${result.trackName.toUpperCase()} // SEED ${result.seed.toString(16).toUpperCase().padStart(8, '0')}`);
  setText('#result-score', result.score.toString().padStart(6, '0'));
  setText('#result-best', wasBest ? 'NEW PERSONAL BEST' : `PERSONAL BEST ${garage.bestScore.toLocaleString('ru-RU')}`);
  setText('#result-speed', `${Math.round(result.maxSpeed).toLocaleString('ru-RU')} KM/H`);
  setText('#result-accuracy', `${Math.round(result.accuracy * 100)}%`);
  setText('#result-perfects', String(result.perfects));
  setText('#result-near', String(result.nearMisses));
  setText('#result-kills', String(result.kills));
  setText('#result-credits', `+${result.credits} CR`);
  resultsScreen.classList.add('is-active');
}

async function launchRun(replay = false): Promise<void> {
  if (startButton.disabled || musicLoading) return;
  if (!replay) lastRunSeed = randomSeed();
  lastConfig = {
    track: selectedTrack,
    weapon: selectedWeapon,
    ability: selectedAbility,
    seed: lastRunSeed,
    garage: { ...garage },
  };
  startButton.disabled = true;
  resultsScreen.classList.remove('is-active');
  menu.classList.add('is-hidden');
  hud.classList.add('is-active');
  setText('#hud-track', TRACKS[selectedTrack].name.toUpperCase());
  setText('#hud-weapon', WEAPONS[selectedWeapon].name.toUpperCase());
  setText('#hud-ability', ABILITIES[selectedAbility].name.toUpperCase());
  setText('#section-label', 'SECTOR 01 // IGNITION');
  try {
    await game.startRun(lastConfig);
  } catch (error) {
    console.error(error);
    game.backToMenu();
    audio.useSynthetic();
    selectedMusicId = 'synthetic';
    renderMusicCatalog();
    updateMusicUi();
    hud.classList.remove('is-active');
    menu.classList.remove('is-hidden');
    game.previewTrack(selectedTrack, lastRunSeed);
    setMusicCatalogError('Не удалось начать воспроизведение. Включён синтетический режим.');
    setText('#music-catalog-status', 'SYNTHETIC MODE ONLINE');
    showToast('AUDIO START ERROR', 'Включён синтетический режим — запустите заезд ещё раз', 'red');
  } finally {
    startButton.disabled = musicLoading;
  }
}

const trackButtons = queryAll<HTMLButtonElement>('[data-track]');
for (const button of trackButtons) {
  button.addEventListener('click', () => {
    selectedTrack = button.dataset.track as TrackId;
    selectRadio('[data-track]', selectedTrack, 'track');
    game.previewTrack(selectedTrack, lastRunSeed);
  });
}
installRadioKeyboard(trackButtons);

const weaponButtons = queryAll<HTMLButtonElement>('[data-weapon]');
for (const button of weaponButtons) {
  button.addEventListener('click', () => {
    selectedWeapon = button.dataset.weapon as WeaponId;
    selectRadio('[data-weapon]', selectedWeapon, 'weapon');
    setText('#weapon-description', WEAPONS[selectedWeapon].description);
  });
}
installRadioKeyboard(weaponButtons);

const abilityButtons = queryAll<HTMLButtonElement>('[data-ability]');
for (const button of abilityButtons) {
  button.addEventListener('click', () => {
    selectedAbility = button.dataset.ability as AbilityId;
    selectRadio('[data-ability]', selectedAbility, 'ability');
    setText('#ability-description', ABILITIES[selectedAbility].description);
  });
}
installRadioKeyboard(abilityButtons);

for (const button of queryAll<HTMLButtonElement>('.garage-module')) {
  button.addEventListener('click', () => {
    const module = button.dataset.module as keyof Pick<GarageState, 'engine' | 'cooling' | 'shield' | 'weapon'>;
    const level = garage[module];
    const cost = 250 + level * 300;
    if (level >= 5) return;
    if (garage.credits < cost) {
      button.classList.remove('is-denied');
      requestAnimationFrame(() => button.classList.add('is-denied'));
      return;
    }
    garage.credits -= cost;
    garage[module] += 1;
    saveGarage(garage);
    updateGarageUi();
  });
}

function formatFileSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function parseMusicManifest(value: unknown): MusicCatalogEntry[] {
  if (!value || typeof value !== 'object') throw new Error('Music manifest is not an object');
  const manifest = value as Partial<MusicManifest>;
  if (manifest.version !== 1 || !Array.isArray(manifest.tracks)) throw new Error('Unsupported music manifest');
  return manifest.tracks.filter((track): track is MusicCatalogEntry => Boolean(
    track
    && typeof track.id === 'string'
    && typeof track.title === 'string'
    && typeof track.file === 'string'
    && track.file.startsWith('/assets/music/')
    && typeof track.bytes === 'number'
    && typeof track.format === 'string',
  ));
}

function renderMusicCatalog(): void {
  musicCatalog.replaceChildren(new Option('EDGE SIGNAL // SYNTHETIC', 'synthetic'));
  for (const entry of musicCatalogEntries) {
    musicCatalog.add(new Option(`${entry.title} // ${entry.format} · ${formatFileSize(entry.bytes)}`, entry.id));
  }
  if (audio.getSourceKind() === 'local') {
    musicCatalog.add(new Option(`${audio.getProfile().title} // LOCAL FILE`, 'local'));
  }
  musicCatalog.value = selectedMusicId;
  if (!musicCatalog.value) {
    selectedMusicId = 'synthetic';
    musicCatalog.value = selectedMusicId;
  }
}

function setMusicLoading(loading: boolean): void {
  musicLoading = loading;
  startButton.disabled = loading;
  musicLibrary.setAttribute('aria-busy', String(loading));
  musicCatalog.disabled = loading || !musicCatalogReady;
  query<HTMLElement>('#music-drop').classList.toggle('is-loading', loading);
}

function setMusicCatalogError(message: string | null, allowRetry = false): void {
  musicLibrary.classList.toggle('has-error', Boolean(message));
  musicCatalogError.hidden = !message;
  musicCatalogError.textContent = message || '';
  musicCatalogRetry.hidden = !message || !allowRetry;
}

async function loadMusicCatalog(): Promise<void> {
  musicLibrary.setAttribute('aria-busy', 'true');
  musicCatalog.disabled = true;
  musicCatalogRetry.hidden = true;
  setMusicCatalogError(null);
  setText('#music-catalog-status', 'Сканируем серверную библиотеку…');
  try {
    const response = await fetch('/assets/music/manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Manifest request failed: ${response.status}`);
    musicCatalogEntries = parseMusicManifest(await response.json());
    musicCatalogReady = true;
    renderMusicCatalog();
    setText('#music-catalog-status', `${musicCatalogEntries.length} SERVER TRACK${musicCatalogEntries.length === 1 ? '' : 'S'} ONLINE // трасса выбирается отдельно`);
  } catch (error) {
    console.error(error);
    musicCatalogEntries = [];
    musicCatalogReady = true;
    renderMusicCatalog();
    setText('#music-catalog-status', 'SYNTHETIC MODE ONLINE');
    setMusicCatalogError('Каталог музыки недоступен. Можно играть с синтезатором или загрузить свой файл.', true);
  } finally {
    musicLibrary.setAttribute('aria-busy', 'false');
    musicCatalog.disabled = musicLoading;
  }
}

async function loadCatalogTrack(entry: MusicCatalogEntry): Promise<void> {
  setMusicLoading(true);
  setMusicCatalogError(null);
  setText('#music-title', 'LOADING SERVER TRACK…');
  setText('#music-meta', `${entry.format} · ${formatFileSize(entry.bytes)} · анализируем BPM и спектр`);
  setText('#music-action', 'WAIT');
  setText('#music-catalog-status', `ANALYZING // ${entry.title}`);
  try {
    await audio.prepareCatalogTrack(entry);
    selectedMusicId = entry.id;
    renderMusicCatalog();
    updateMusicUi();
    game.previewTrack(selectedTrack, lastRunSeed);
    query<HTMLElement>('#music-drop').classList.remove('has-file');
    setText('#music-catalog-status', `ACTIVE // ${entry.title} // трасса выбирается отдельно в блоке 01`);
  } catch (error) {
    console.error(error);
    audio.useSynthetic();
    selectedMusicId = 'synthetic';
    renderMusicCatalog();
    updateMusicUi();
    game.previewTrack(selectedTrack, lastRunSeed);
    setMusicCatalogError('Трек не удалось загрузить или декодировать. Включён синтетический режим.');
    setText('#music-catalog-status', 'SYNTHETIC MODE ONLINE');
    showToast('AUDIO ERROR', 'Серверный трек не декодирован — включён синтетический режим', 'red');
  } finally {
    setMusicLoading(false);
  }
}

const musicFile = query<HTMLInputElement>('#music-file');
async function loadMusicFile(file: File): Promise<void> {
  const drop = query<HTMLElement>('#music-drop');
  setMusicLoading(true);
  setMusicCatalogError(null);
  setText('#music-title', 'ANALYZING SPECTRUM…');
  setText('#music-meta', 'Строим energy map, ищем BPM и транзиенты');
  setText('#music-action', 'WAIT');
  try {
    await audio.prepareFile(file);
    selectedMusicId = 'local';
    renderMusicCatalog();
    updateMusicUi();
    game.previewTrack(selectedTrack, lastRunSeed);
    drop.classList.add('has-file');
    setText('#music-catalog-status', `ACTIVE // ${audio.getProfile().title} // LOCAL FILE`);
  } catch (error) {
    console.error(error);
    audio.useSynthetic();
    selectedMusicId = 'synthetic';
    renderMusicCatalog();
    updateMusicUi();
    game.previewTrack(selectedTrack, lastRunSeed);
    setMusicCatalogError('Локальный файл не удалось декодировать. Включён синтетический режим.');
    setText('#music-catalog-status', 'SYNTHETIC MODE ONLINE');
    showToast('AUDIO ERROR', 'Формат не декодирован — включён синтетический трек', 'red');
  } finally {
    setMusicLoading(false);
  }
}

musicFile.addEventListener('change', () => {
  const file = musicFile.files?.[0];
  if (file) void loadMusicFile(file);
  musicFile.value = '';
});

const musicDrop = query<HTMLElement>('#music-drop');
for (const eventName of ['dragenter', 'dragover']) {
  musicDrop.addEventListener(eventName, (event) => {
    event.preventDefault();
    musicDrop.classList.add('is-dragging');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  musicDrop.addEventListener(eventName, (event) => {
    event.preventDefault();
    musicDrop.classList.remove('is-dragging');
  });
}
musicDrop.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file?.type.startsWith('audio/')) void loadMusicFile(file);
});

musicCatalog.addEventListener('change', () => {
  const value = musicCatalog.value;
  if (value === 'synthetic') {
    audio.useSynthetic();
    selectedMusicId = value;
    renderMusicCatalog();
    updateMusicUi();
    game.previewTrack(selectedTrack, lastRunSeed);
    musicDrop.classList.remove('has-file');
    setMusicCatalogError(null);
    setText('#music-catalog-status', 'ACTIVE // EDGE SIGNAL // трасса выбирается отдельно в блоке 01');
    return;
  }
  if (value === 'local') return;
  const entry = musicCatalogEntries.find((candidate) => candidate.id === value);
  if (entry) void loadCatalogTrack(entry);
});

musicCatalogRetry.addEventListener('click', () => void loadMusicCatalog());

query<HTMLButtonElement>('#effects-toggle').addEventListener('click', (event) => {
  reducedEffects = !reducedEffects;
  localStorage.setItem('ballistic-edge-reduced-fx', reducedEffects ? '1' : '0');
  game.setReducedEffects(reducedEffects);
  const button = event.currentTarget as HTMLButtonElement;
  button.setAttribute('aria-pressed', String(reducedEffects));
  button.classList.toggle('is-active', reducedEffects);
  button.querySelector('span')!.textContent = reducedEffects ? 'SAFE' : 'MAX';
});

startButton.addEventListener('click', () => void launchRun(false));
query<HTMLButtonElement>('#replay-run').addEventListener('click', () => void launchRun(true));
query<HTMLButtonElement>('#return-menu').addEventListener('click', () => {
  game.backToMenu();
  resultsScreen.classList.remove('is-active');
  hud.classList.remove('is-active');
  menu.classList.remove('is-hidden');
  lastRunSeed = randomSeed();
  game.previewTrack(selectedTrack, lastRunSeed);
});

for (const button of queryAll<HTMLButtonElement>('[data-control]')) {
  const control = button.dataset.control as 'left' | 'right' | 'boost' | 'cool';
  const down = (event: PointerEvent) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    game.setMobileControl(control, true);
  };
  const up = (event: PointerEvent) => {
    event.preventDefault();
    game.setMobileControl(control, false);
  };
  button.addEventListener('pointerdown', down);
  button.addEventListener('pointerup', up);
  button.addEventListener('pointercancel', up);
}

query<HTMLButtonElement>('[data-action="fire"]').addEventListener('pointerdown', (event) => { event.preventDefault(); game.fire(); });
query<HTMLButtonElement>('[data-action="ability"]').addEventListener('pointerdown', (event) => { event.preventDefault(); game.activateAbility(); });

game.setReducedEffects(reducedEffects);
const effectsButton = query<HTMLButtonElement>('#effects-toggle');
effectsButton.setAttribute('aria-pressed', String(reducedEffects));
effectsButton.classList.toggle('is-active', reducedEffects);
effectsButton.querySelector('span')!.textContent = reducedEffects ? 'SAFE' : 'MAX';
updateGarageUi();
selectRadio('[data-track]', selectedTrack, 'track');
selectRadio('[data-weapon]', selectedWeapon, 'weapon');
selectRadio('[data-ability]', selectedAbility, 'ability');
updateMusicUi();
setText('#seed-label', 'SEED // RANDOMIZED');
void loadMusicCatalog();

window.addEventListener('beforeunload', () => {
  game.dispose();
  void audio.dispose();
}, { once: true });
