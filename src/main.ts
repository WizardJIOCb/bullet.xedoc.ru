import './styles.css';
import { AudioEngine, type CatalogAudioTrack } from './audio/AudioEngine';
import { ABILITIES, TRACKS, WEAPONS, type AbilityId, type GarageState, type RunConfig, type RunResult, type RunStats, type TrackId, type UpgradeDefinition, type UpgradeId, type WeaponId } from './core/types';
import { BallisticGame } from './game/Game';
import { MusicPreviewController } from './ui/MusicPreview';
import {
  DEFAULT_SETTINGS,
  cloneSettings,
  isBindableCode,
  loadSettings,
  saveSettings,
  type ControlBindings,
  type InputAction,
} from './settings/SettingsStore';

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
const upgradeDraft = query<HTMLElement>('#upgrade-draft');
const upgradeOptions = query<HTMLElement>('#upgrade-options');
const installedUpgrades = query<HTMLElement>('#installed-upgrades');
const resultsScreen = query<HTMLElement>('#results-screen');
const startButton = query<HTMLButtonElement>('#start-run');
const musicLibrary = query<HTMLFieldSetElement>('#music-library');
const musicCatalog = query<HTMLSelectElement>('#music-catalog');
const musicCatalogRetry = query<HTMLButtonElement>('#music-catalog-retry');
const musicCatalogError = query<HTMLElement>('#music-catalog-error');
let settings = loadSettings();
const audio = new AudioEngine();
audio.setAudioSettings(settings.audio);
let garage = loadGarage();
let selectedTrack: TrackId = 'aurora';
let selectedWeapon: WeaponId = 'pulse';
let selectedAbility: AbilityId = 'phase';
let lastRunSeed = randomSeed();
let lastConfig: RunConfig | null = null;
let toastTimer = 0;
let musicLoading = false;
let musicCatalogReady = false;
let musicCatalogEntries: MusicCatalogEntry[] = [];
let selectedMusicId = 'synthetic';

const game = new BallisticGame(query<HTMLCanvasElement>('#game-canvas'), audio, {
  onHud: updateHud,
  onToast: showToast,
  onUpgradeState: renderUpgradeState,
  onFinish: showResults,
  onCountdown: showCountdown,
  onSection: (name, index) => {
    setText('#section-label', `SECTOR 0${index} // ${name}`);
    showToast(`SECTOR 0${index}`, name, index === 3 ? 'gold' : 'cyan');
  },
}, settings);
const musicPreview = new MusicPreviewController(audio, query<HTMLElement>('#music-preview'), {
  onMusicVolumeInput: applyMusicVolume,
  onMusicVolumeCommit: commitMusicVolume,
});

function refreshCoursePreview(): void {
  game.previewTrack(selectedTrack, lastRunSeed);
  const timeline = game.getTimelinePreview();
  musicPreview.render(timeline, audio.getProfile(), TRACKS[selectedTrack].name);
  setText('#seed-label', `SEED // ${timeline.planSeed.toString(16).toUpperCase().padStart(8, '0')}`);
}

type SettingsTab = 'audio' | 'graphics' | 'controls';

interface BindingCapture {
  action: InputAction;
  slot: 0 | 1;
}

const settingsDialog = query<HTMLDialogElement>('#settings-dialog');
const settingsStatus = query<HTMLElement>('#settings-status');
let activeSettingsTab: SettingsTab = 'audio';
let bindingCapture: BindingCapture | null = null;

const CONTROL_GROUPS: Array<{ label: string; actions: Array<{ id: InputAction; name: string; detail: string }> }> = [
  {
    label: 'MOVEMENT',
    actions: [
      { id: 'left', name: 'Влево', detail: 'WALL RIDE LEFT' },
      { id: 'right', name: 'Вправо', detail: 'WALL RIDE RIGHT' },
      { id: 'boost', name: 'Ускорение', detail: 'BOOST' },
      { id: 'cool', name: 'Охлаждение', detail: 'COOL REACTOR' },
    ],
  },
  {
    label: 'COMBAT',
    actions: [
      { id: 'fire', name: 'Огонь', detail: 'FIRE WEAPON' },
      { id: 'ability', name: 'Способность', detail: 'ACTIVE MODULE' },
    ],
  },
  {
    label: 'ROGUELIKE',
    actions: [
      { id: 'upgrade1', name: 'Улучшение 1', detail: 'FIRST MODULE' },
      { id: 'upgrade2', name: 'Улучшение 2', detail: 'SECOND MODULE' },
      { id: 'upgrade3', name: 'Улучшение 3', detail: 'THIRD MODULE' },
    ],
  },
];

const KEY_LABELS: Record<string, string> = {
  Space: 'SPACE',
  Enter: 'ENTER',
  NumpadEnter: 'NUM ENTER',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ShiftLeft: 'L SHIFT',
  ShiftRight: 'R SHIFT',
  Backspace: 'BACKSPACE',
  Delete: 'DELETE',
  PageUp: 'PG UP',
  PageDown: 'PG DOWN',
};

function formatKeyCode(code: string | null): string {
  if (!code) return 'UNBOUND';
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `NUM ${code.slice(6).toUpperCase()}`;
  return code.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
}

function formatAriaKeyShortcut(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return code.slice(6);
  if (code.startsWith('Shift')) return 'Shift';
  return code;
}

function setSettingsStatus(message: string): void {
  settingsStatus.textContent = message;
}

function isCodeAllowedForAction(code: string, action: InputAction): boolean {
  const match = code.match(/^(?:Digit|Numpad)([1-3])$/);
  return !match || action === `upgrade${match[1]}`;
}

function persistSettings(message = 'SAVED // LOCAL PROFILE'): void {
  settings = saveSettings(settings);
  syncMusicVolumeUi();
  setSettingsStatus(message);
}

function normalizeVolume(volume: number): number {
  return Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0;
}

function syncMusicVolumeUi(): void {
  const volume = normalizeVolume(settings.audio.musicVolume);
  const percent = Math.round(volume * 100);
  query<HTMLInputElement>('#volume-music').value = String(percent);
  query<HTMLOutputElement>('#volume-music-value').value = `${percent}%`;
  musicPreview.setMusicVolume(volume, settings.audio.muted || settings.audio.masterVolume <= 0);
}

function applyMusicVolume(volume: number): void {
  settings.audio.musicVolume = normalizeVolume(volume);
  audio.setAudioSettings(settings.audio);
  syncMusicVolumeUi();
}

function commitMusicVolume(volume: number): void {
  applyMusicVolume(volume);
  persistSettings(`MUSIC // ${Math.round(settings.audio.musicVolume * 100)}%`);
}

function updateEffectsButton(): void {
  const button = query<HTMLButtonElement>('#effects-toggle');
  const reduced = settings.graphics.reducedFlashes;
  button.setAttribute('aria-pressed', String(reduced));
  button.classList.toggle('is-active', reduced);
  button.querySelector('span')!.textContent = reduced ? 'SAFE' : 'MAX';
}

function updateControlHints(): void {
  for (const hint of queryAll<HTMLElement>('[data-control-hint]')) {
    const action = hint.dataset.controlHint as InputAction;
    hint.textContent = formatKeyCode(settings.controls[action][0]);
  }
  const upgradeKeys = (['upgrade1', 'upgrade2', 'upgrade3'] as InputAction[])
    .map((action) => formatKeyCode(settings.controls[action][0]));
  setText('#upgrade-key-hint', upgradeKeys.join(' / '));
}

function renderControlsSettings(): void {
  const list = query<HTMLElement>('#settings-controls-list');
  list.innerHTML = CONTROL_GROUPS.map((group) => `
    <div class="settings-control-group">${group.label}</div>
    ${group.actions.map((action) => {
      const bindings = settings.controls[action.id];
      return `
        <div class="settings-control-row">
          <span><strong>${action.name}</strong><small>${action.detail}</small></span>
          ${bindings.map((code, slot) => {
            const capturing = bindingCapture?.action === action.id && bindingCapture.slot === slot;
            const label = capturing ? 'PRESS KEY' : formatKeyCode(code);
            const ariaLabel = capturing
              ? `${action.name}, нажмите новую клавишу. Escape — отмена`
              : `${action.name}, ${slot === 0 ? 'основная' : 'дополнительная'} клавиша: ${formatKeyCode(code)}`;
            return `<button class="settings-key ${capturing ? 'is-capturing' : ''} ${code ? '' : 'is-empty'}" type="button" data-binding-action="${action.id}" data-binding-slot="${slot}" aria-label="${ariaLabel}">${label}</button>`;
          }).join('')}
        </div>
      `;
    }).join('')}
  `).join('');

  for (const button of Array.from(list.querySelectorAll<HTMLButtonElement>('[data-binding-action]'))) {
    button.addEventListener('click', () => {
      bindingCapture = {
        action: button.dataset.bindingAction as InputAction,
        slot: Number(button.dataset.bindingSlot) as 0 | 1,
      };
      game.setInputCapture(true);
      setSettingsStatus('PRESS A KEY // ESC TO CANCEL');
      renderControlsSettings();
      list.querySelector<HTMLButtonElement>(`[data-binding-action="${bindingCapture.action}"][data-binding-slot="${bindingCapture.slot}"]`)?.focus();
    });
  }
}

function syncSettingsUi(): void {
  const volumeFields: Array<[keyof typeof settings.audio, string, string]> = [
    ['masterVolume', '#volume-master', '#volume-master-value'],
    ['musicVolume', '#volume-music', '#volume-music-value'],
    ['effectsVolume', '#volume-effects', '#volume-effects-value'],
  ];
  for (const [field, inputSelector, outputSelector] of volumeFields) {
    const percent = Math.round(Number(settings.audio[field]) * 100);
    query<HTMLInputElement>(inputSelector).value = String(percent);
    query<HTMLOutputElement>(outputSelector).value = `${percent}%`;
  }
  syncMusicVolumeUi();
  query<HTMLInputElement>('#audio-muted').checked = settings.audio.muted;
  query<HTMLSelectElement>('#graphics-quality').value = settings.graphics.quality;
  query<HTMLInputElement>('#graphics-bloom').checked = settings.graphics.bloom;
  query<HTMLInputElement>('#graphics-chromatic').checked = settings.graphics.chromaticAberration;
  query<HTMLInputElement>('#graphics-shake').checked = settings.graphics.cameraShake;
  query<HTMLInputElement>('#graphics-reduced').checked = settings.graphics.reducedFlashes;
  updateEffectsButton();
  updateControlHints();
  renderControlsSettings();
}

function setSettingsTab(tab: SettingsTab, focus = false): void {
  if (bindingCapture && tab !== activeSettingsTab) {
    bindingCapture = null;
    game.setInputCapture(true);
    setSettingsStatus('KEY CAPTURE CANCELLED // TAB CHANGED');
    renderControlsSettings();
  }
  activeSettingsTab = tab;
  for (const button of queryAll<HTMLButtonElement>('[data-settings-tab]')) {
    const selected = button.dataset.settingsTab === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus();
  }
  for (const panel of queryAll<HTMLElement>('[data-settings-panel]')) {
    panel.hidden = panel.dataset.settingsPanel !== tab;
  }
  query<HTMLButtonElement>('#settings-reset').textContent = tab === 'controls' ? 'RESET KEYS' : 'RESET TAB';
}

function cancelBindingCapture(message = 'KEY CAPTURE CANCELLED'): void {
  if (!bindingCapture) return;
  const cancelled = bindingCapture;
  bindingCapture = null;
  game.setInputCapture(settingsDialog.open);
  setSettingsStatus(message);
  renderControlsSettings();
  query<HTMLButtonElement>(`[data-binding-action="${cancelled.action}"][data-binding-slot="${cancelled.slot}"]`)?.focus();
}

function closeSettings(): void {
  cancelBindingCapture();
  if (settingsDialog.open) settingsDialog.close();
}

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
  setText('#ability-ready', stats.abilityCooldown <= 0
    ? `READY // ${formatKeyCode(settings.controls.ability[0])}`
    : `${stats.abilityCooldown.toFixed(1)} SEC`);
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

const UPGRADE_ICON_PATHS: Record<UpgradeId, string> = {
  'cryo-loop': '<path d="M12 2v20M4.2 6.5l15.6 11M4.2 17.5l15.6-11M9 4l3 3 3-3M9 20l3-3 3 3"/>',
  'resonant-chamber': '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/><path d="M3 12h3m12 0h3"/>',
  'kinetic-skin': '<path d="M12 2 20 6v5c0 5-3.2 8.6-8 11-4.8-2.4-8-6-8-11V6l8-4Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/>',
  'phase-battery': '<rect x="4" y="7" width="15" height="10" rx="2"/><path d="M19 10h2v4h-2M12 8l-3 5h3l-1 3 4-6h-3Z"/>',
  'redline-engine': '<path d="m14 2-8 12h6l-2 8 8-12h-6l2-8Z"/>',
  'glass-cannon': '<path d="M12 3 3 20h18L12 3Z"/><path d="M8 15h8M12 8v10"/>',
  'echo-shield': '<path d="M12 3 19 6v5c0 4.4-2.7 7.6-7 10-4.3-2.4-7-5.6-7-10V6l7-3Z"/><path d="M9 9c2-2 4-2 6 0M8 13c2.7-2.5 5.3-2.5 8 0"/>',
  afterburner: '<path d="M13 2c1 5-3 6-3 10 0 2 1 3 2 4-4 0-6-2-6-5-2 3-1 9 6 11 7-2 8-9 4-13 0 3-1 4-2 5 1-5-1-8-1-12Z"/>',
  'flux-magnet': '<path d="M5 4v9a7 7 0 0 0 14 0V4h-5v9a2 2 0 0 1-4 0V4H5Z"/><path d="M5 8h5m4 0h5"/>',
};

function upgradeIcon(id: UpgradeId): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${UPGRADE_ICON_PATHS[id]}</svg>`;
}

function renderUpgradeState(pending: UpgradeDefinition[], installed: UpgradeDefinition[]): void {
  upgradeDraft.hidden = pending.length === 0;
  upgradeOptions.innerHTML = pending.map((upgrade, index) => {
    const action = `upgrade${index + 1}` as InputAction;
    const keyLabel = formatKeyCode(settings.controls[action][0]);
    return `
    <button class="upgrade-choice upgrade-choice--${upgrade.tone}" data-upgrade-choice="${upgrade.id}" type="button" aria-keyshortcuts="${formatAriaKeyShortcut(settings.controls[action][0])}" aria-label="${keyLabel}: ${upgrade.name}. ${upgrade.description}">
      <span class="upgrade-choice__key">${keyLabel}</span>
      <span class="upgrade-choice__icon">${upgradeIcon(upgrade.id)}</span>
      <span class="upgrade-choice__copy"><strong>${upgrade.name}</strong><small>${upgrade.tag}</small></span>
      <span class="upgrade-choice__description">${upgrade.description}</span>
      <span class="upgrade-choice__tooltip" role="tooltip">${upgrade.description}</span>
    </button>
  `;
  }).join('');
  for (const button of Array.from(upgradeOptions.querySelectorAll<HTMLButtonElement>('[data-upgrade-choice]'))) {
    button.addEventListener('click', () => {
      game.chooseUpgrade(button.dataset.upgradeChoice as UpgradeId);
    });
  }
  installedUpgrades.innerHTML = installed.map((upgrade) => `
    <span class="installed-upgrade installed-upgrade--${upgrade.tone}" tabindex="0" role="img" aria-label="${upgrade.name}: ${upgrade.description}" title="${upgrade.name}: ${upgrade.description}">
      <span class="installed-upgrade__icon">${upgradeIcon(upgrade.id)}</span>
      <span class="installed-upgrade__name">${upgrade.name}</span>
    </span>
  `).join('');
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
  const config: RunConfig = replay && lastConfig
    ? { ...lastConfig, garage: { ...garage } }
    : {
      track: selectedTrack,
      weapon: selectedWeapon,
      ability: selectedAbility,
      seed: lastRunSeed,
      garage: { ...garage },
    };
  lastConfig = config;
  musicPreview.stop();
  startButton.disabled = true;
  resultsScreen.classList.remove('is-active');
  menu.classList.add('is-hidden');
  hud.classList.add('is-active');
  setText('#hud-track', TRACKS[config.track].name.toUpperCase());
  setText('#hud-weapon', WEAPONS[config.weapon].name.toUpperCase());
  setText('#hud-ability', ABILITIES[config.ability].name.toUpperCase());
  setText('#section-label', 'SECTOR 01 // IGNITION');
  try {
    await game.startRun(config);
  } catch (error) {
    console.error(error);
    game.backToMenu();
    audio.useSynthetic();
    selectedMusicId = 'synthetic';
    renderMusicCatalog();
    updateMusicUi();
    hud.classList.remove('is-active');
    menu.classList.remove('is-hidden');
    refreshCoursePreview();
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
    refreshCoursePreview();
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
  musicPreview.setLoading(loading);
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
  if (musicLoading) return;
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
    refreshCoursePreview();
    query<HTMLElement>('#music-drop').classList.remove('has-file');
    setText('#music-catalog-status', `ACTIVE // ${entry.title} // трасса выбирается отдельно в блоке 01`);
  } catch (error) {
    console.error(error);
    audio.useSynthetic();
    selectedMusicId = 'synthetic';
    renderMusicCatalog();
    updateMusicUi();
    refreshCoursePreview();
    setMusicCatalogError('Трек не удалось загрузить или декодировать. Включён синтетический режим.');
    setText('#music-catalog-status', 'SYNTHETIC MODE ONLINE');
    showToast('AUDIO ERROR', 'Серверный трек не декодирован — включён синтетический режим', 'red');
  } finally {
    setMusicLoading(false);
  }
}

const musicFile = query<HTMLInputElement>('#music-file');
async function loadMusicFile(file: File): Promise<void> {
  if (musicLoading) return;
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
    refreshCoursePreview();
    drop.classList.add('has-file');
    setText('#music-catalog-status', `ACTIVE // ${audio.getProfile().title} // LOCAL FILE`);
  } catch (error) {
    console.error(error);
    audio.useSynthetic();
    selectedMusicId = 'synthetic';
    renderMusicCatalog();
    updateMusicUi();
    refreshCoursePreview();
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
    refreshCoursePreview();
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

query<HTMLButtonElement>('#settings-open').addEventListener('click', () => {
  if (settingsDialog.open) return;
  game.setInputCapture(true);
  syncSettingsUi();
  settingsDialog.showModal();
  setSettingsTab(activeSettingsTab, true);
  setSettingsStatus('SETTINGS SAVED LOCALLY');
});

query<HTMLButtonElement>('#settings-close').addEventListener('click', closeSettings);
query<HTMLButtonElement>('#settings-done').addEventListener('click', closeSettings);

settingsDialog.addEventListener('cancel', (event) => {
  if (!bindingCapture) return;
  event.preventDefault();
  cancelBindingCapture();
});

settingsDialog.addEventListener('close', () => {
  bindingCapture = null;
  game.setInputCapture(false);
  query<HTMLButtonElement>('#settings-open').focus();
});

settingsDialog.addEventListener('pointerdown', (event) => {
  if (event.target === settingsDialog) closeSettings();
});

const settingsTabButtons = queryAll<HTMLButtonElement>('[data-settings-tab]');
for (const button of settingsTabButtons) {
  button.addEventListener('click', () => setSettingsTab(button.dataset.settingsTab as SettingsTab));
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = settingsTabButtons.indexOf(button);
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? settingsTabButtons.length - 1
        : (index + (event.key === 'ArrowLeft' ? -1 : 1) + settingsTabButtons.length) % settingsTabButtons.length;
    setSettingsTab(settingsTabButtons[next].dataset.settingsTab as SettingsTab, true);
  });
}

const volumeInputs: Array<{ selector: string; output: string; field: 'masterVolume' | 'musicVolume' | 'effectsVolume' }> = [
  { selector: '#volume-master', output: '#volume-master-value', field: 'masterVolume' },
  { selector: '#volume-music', output: '#volume-music-value', field: 'musicVolume' },
  { selector: '#volume-effects', output: '#volume-effects-value', field: 'effectsVolume' },
];
for (const binding of volumeInputs) {
  const input = query<HTMLInputElement>(binding.selector);
  input.addEventListener('input', (event) => {
    const percent = Number((event.currentTarget as HTMLInputElement).value);
    if (binding.field === 'musicVolume') applyMusicVolume(percent / 100);
    else {
      settings.audio[binding.field] = percent / 100;
      query<HTMLOutputElement>(binding.output).value = `${percent}%`;
      audio.setAudioSettings(settings.audio);
      syncMusicVolumeUi();
    }
  });
  input.addEventListener('change', () => {
    persistSettings(`AUDIO // ${Math.round(settings.audio[binding.field] * 100)}%`);
  });
}

query<HTMLInputElement>('#audio-muted').addEventListener('change', (event) => {
  settings.audio.muted = (event.currentTarget as HTMLInputElement).checked;
  persistSettings(settings.audio.muted ? 'AUDIO MUTED' : 'AUDIO ONLINE');
  audio.setAudioSettings(settings.audio);
});

query<HTMLSelectElement>('#graphics-quality').addEventListener('change', (event) => {
  settings.graphics.quality = (event.currentTarget as HTMLSelectElement).value as typeof settings.graphics.quality;
  persistSettings(`RENDER // ${settings.graphics.quality.toUpperCase()}`);
  game.setGraphicsSettings(settings.graphics);
  refreshCoursePreview();
});

const graphicsToggles: Array<{ selector: string; field: 'bloom' | 'chromaticAberration' | 'cameraShake' | 'reducedFlashes'; message: string }> = [
  { selector: '#graphics-bloom', field: 'bloom', message: 'BLOOM' },
  { selector: '#graphics-chromatic', field: 'chromaticAberration', message: 'RGB DISTORTION' },
  { selector: '#graphics-shake', field: 'cameraShake', message: 'CAMERA SHAKE' },
  { selector: '#graphics-reduced', field: 'reducedFlashes', message: 'SAFE FLASHES' },
];
for (const toggle of graphicsToggles) {
  query<HTMLInputElement>(toggle.selector).addEventListener('change', (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    settings.graphics[toggle.field] = enabled;
    persistSettings(`${toggle.message} // ${enabled ? 'ON' : 'OFF'}`);
    game.setGraphicsSettings(settings.graphics);
    updateEffectsButton();
  });
}

query<HTMLButtonElement>('#settings-reset').addEventListener('click', () => {
  if (bindingCapture) {
    bindingCapture = null;
    game.setInputCapture(true);
  }
  const defaults = cloneSettings(DEFAULT_SETTINGS);
  if (activeSettingsTab === 'audio') {
    settings.audio = { ...defaults.audio };
    audio.setAudioSettings(settings.audio);
  } else if (activeSettingsTab === 'graphics') {
    settings.graphics = { ...defaults.graphics };
    game.setGraphicsSettings(settings.graphics);
    refreshCoursePreview();
  } else {
    settings.controls = Object.fromEntries(
      Object.entries(defaults.controls).map(([action, values]) => [action, [...values]]),
    ) as ControlBindings;
    game.setControlBindings(settings.controls);
  }
  persistSettings(`RESET // ${activeSettingsTab.toUpperCase()}`);
  syncSettingsUi();
});

window.addEventListener('keydown', (event) => {
  if (!bindingCapture) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.code === 'Escape') {
    cancelBindingCapture();
    return;
  }
  if (event.code === 'Backspace' || event.code === 'Delete') {
    if (bindingCapture.slot === 0) {
      setSettingsStatus('PRIMARY KEY CANNOT BE EMPTY');
      return;
    }
    settings.controls[bindingCapture.action][1] = null;
  } else {
    if (!isBindableCode(event.code) || !isCodeAllowedForAction(event.code, bindingCapture.action)) {
      setSettingsStatus('KEY RESERVED // TRY ANOTHER');
      return;
    }
    const current = bindingCapture;
    let conflict: BindingCapture | null = null;
    for (const group of CONTROL_GROUPS) {
      for (const action of group.actions) {
        const slot = settings.controls[action.id].findIndex((code) => code === event.code);
        if (slot >= 0) conflict = { action: action.id, slot: slot as 0 | 1 };
      }
    }
    if (conflict && (conflict.action !== current.action || conflict.slot !== current.slot)) {
      setSettingsStatus(`${formatKeyCode(event.code)} USED BY ${conflict.action.toUpperCase()} // CHOOSE ANOTHER`);
      return;
    }
    settings.controls[current.action][current.slot] = event.code;
  }
  const changedBinding = bindingCapture;
  const changedAction = changedBinding.action;
  bindingCapture = null;
  persistSettings(`BOUND // ${formatKeyCode(settings.controls[changedAction][0])}`);
  game.setControlBindings(settings.controls);
  game.setInputCapture(true);
  updateControlHints();
  renderControlsSettings();
  query<HTMLButtonElement>(`[data-binding-action="${changedBinding.action}"][data-binding-slot="${changedBinding.slot}"]`)?.focus();
}, true);

window.addEventListener('blur', () => {
  if (bindingCapture) cancelBindingCapture('KEY CAPTURE CANCELLED // WINDOW BLUR');
});

query<HTMLButtonElement>('#effects-toggle').addEventListener('click', () => {
  settings.graphics.reducedFlashes = !settings.graphics.reducedFlashes;
  persistSettings(settings.graphics.reducedFlashes ? 'FX // SAFE' : 'FX // MAX');
  game.setGraphicsSettings(settings.graphics);
  syncSettingsUi();
});

startButton.addEventListener('click', () => void launchRun(false));
query<HTMLButtonElement>('#replay-run').addEventListener('click', () => void launchRun(true));
query<HTMLButtonElement>('#return-menu').addEventListener('click', () => {
  game.backToMenu();
  resultsScreen.classList.remove('is-active');
  hud.classList.remove('is-active');
  menu.classList.remove('is-hidden');
  lastRunSeed = randomSeed();
  refreshCoursePreview();
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

audio.setAudioSettings(settings.audio);
game.setGraphicsSettings(settings.graphics);
game.setControlBindings(settings.controls);
syncSettingsUi();
updateGarageUi();
selectRadio('[data-track]', selectedTrack, 'track');
selectRadio('[data-weapon]', selectedWeapon, 'weapon');
selectRadio('[data-ability]', selectedAbility, 'ability');
updateMusicUi();
refreshCoursePreview();
void loadMusicCatalog();

window.addEventListener('beforeunload', () => {
  musicPreview.dispose();
  game.dispose();
  void audio.dispose();
}, { once: true });
