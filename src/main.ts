import './styles.css';
import { AudioEngine, AudioImportError, type CatalogAudioTrack } from './audio/AudioEngine';
import { ABILITIES, TRACKS, WEAPONS, type AbilityId, type GarageState, type RemoteRacerState, type RunConfig, type RunResult, type RunStats, type TrackId, type UpgradeDefinition, type UpgradeId, type WeaponId } from './core/types';
import { BallisticGame } from './game/Game';
import { TouchInputRouter, type TouchInputAction } from './input/TouchInputRouter';
import { MusicPreviewController } from './ui/MusicPreview';
import { RaceTimelineController } from './ui/RaceTimeline';
import { createBrowserMusicLibrary, type MusicLibrarySnapshot } from './music/MusicLibrary';
import {
  LobbyClient,
  defaultLobbyUrl,
  type AuthoritativeRaceConfig,
  type OnlineRoomSnapshot,
  type OnlineRoomSummary,
  type ServerRaceState,
} from './online';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
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
const mobileControls = query<HTMLElement>('#mobile-controls');
const damageFlash = query<HTMLElement>('#damage-flash');
const upgradeDraft = query<HTMLElement>('#upgrade-draft');
const upgradeOptions = query<HTMLElement>('#upgrade-options');
const installedUpgrades = query<HTMLElement>('#installed-upgrades');
const resultsScreen = query<HTMLElement>('#results-screen');
const raceTimeline = new RaceTimelineController(query<HTMLElement>('#race-course-markers'));
const startButton = query<HTMLButtonElement>('#start-run');
const musicLibrary = query<HTMLFieldSetElement>('#music-library');
const musicCatalog = query<HTMLSelectElement>('#music-catalog');
const musicCatalogRetry = query<HTMLButtonElement>('#music-catalog-retry');
const musicCatalogError = query<HTMLElement>('#music-catalog-error');
const playlistSelect = query<HTMLSelectElement>('#playlist-select');
const playlistTrackSelect = query<HTMLSelectElement>('#playlist-track-select');
const localMusicLibrary = createBrowserMusicLibrary();
const onlineNameInput = query<HTMLInputElement>('#online-name');
const hasTouchInput = navigator.maxTouchPoints > 0 || window.matchMedia('(hover: none) and (pointer: coarse)').matches;
app.classList.toggle('has-touch', hasTouchInput);
let settings = loadSettings();
try {
  if (hasTouchInput && localStorage.getItem(SETTINGS_KEY) === null) {
    settings.graphics.quality = 'balanced';
    settings = saveSettings(settings);
  }
} catch {
  // Storage can be unavailable; the in-memory defaults remain usable.
}
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
let musicCatalogLoadFailed = false;
let musicCatalogEntries: MusicCatalogEntry[] = [];
let selectedMusicId = 'synthetic';
let musicUiEpoch = 0;
let damageFlashAnimation: Animation | null = null;
let activeLibraryTrackId: string | null = null;
let lobbyClient: LobbyClient | null = null;
let lobbyIdentity = '';
let onlineRoom: OnlineRoomSnapshot | null = null;
let onlineRooms: OnlineRoomSummary[] = [];
let onlineMatch: AuthoritativeRaceConfig | null = null;
let currentRunIsOnline = false;
let onlineStartTimer = 0;
const remoteRaceStates = new Map<string, ServerRaceState>();

const game = new BallisticGame(query<HTMLCanvasElement>('#game-canvas'), audio, {
  onHud: updateHud,
  onTimeline: (timeline) => raceTimeline.render(timeline),
  onToast: showToast,
  onUpgradeState: renderUpgradeState,
  onFinish: showResults,
  onCountdown: showCountdown,
  onImpact: showImpactFlash,
  onSection: (name, index) => {
    setText('#section-label', `SECTOR 0${index} // ${name}`);
    showToast(`SECTOR 0${index}`, name, index === 3 ? 'gold' : 'cyan');
  },
}, settings);
const mobileHoldButtons = queryAll<HTMLButtonElement>('[data-control]');
const mobileAbilityButton = query<HTMLButtonElement>('[data-action="ability"]');
const mobileFireButton = query<HTMLButtonElement>('[data-control="fire"]');
const mobileFireState = query<HTMLElement>('#mobile-fire-state');
const mobileAbilityName = query<HTMLElement>('#mobile-ability-name');
const mobileAbilityState = query<HTMLElement>('#mobile-ability-state');
const mobileAbilityPointers = new Set<number>();
const touchInputRouter = new TouchInputRouter((action, active) => {
  game.setMobileControl(action, active);
  for (const button of mobileHoldButtons) {
    if (button.dataset.control !== action) continue;
    button.classList.toggle('is-pressed', active);
    button.setAttribute('aria-pressed', String(active));
  }
});

function pulseHaptic(duration = 8): void {
  if (!hasTouchInput) return;
  try {
    navigator.vibrate?.(duration);
  } catch {
    // Haptics are optional and may be blocked by the browser.
  }
}

function releaseTouchControls(): void {
  touchInputRouter.releaseAll();
  mobileAbilityPointers.clear();
  mobileAbilityButton.classList.remove('is-pressed');
  mobileAbilityButton.setAttribute('aria-pressed', 'false');
}

function setRunUiActive(active: boolean): void {
  app.classList.toggle('is-run-active', active);
  document.documentElement.classList.toggle('is-run-active', active);
  mobileControls.hidden = !active || !hasTouchInput;
  mobileControls.setAttribute('aria-hidden', String(!active || !hasTouchInput));
  if (!active) releaseTouchControls();
}
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
  setText('#upgrade-key-hint', hasTouchInput ? 'TAP' : upgradeKeys.join(' / '));
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
  const bloomPercent = Math.round(settings.graphics.bloomIntensity * 100);
  query<HTMLInputElement>('#graphics-bloom-intensity').value = String(bloomPercent);
  query<HTMLOutputElement>('#graphics-bloom-intensity-value').value = `${bloomPercent}%`;
  const brightnessPercent = Math.round(settings.graphics.brightness * 100);
  query<HTMLInputElement>('#graphics-brightness').value = String(brightnessPercent);
  query<HTMLOutputElement>('#graphics-brightness-value').value = `${brightnessPercent}%`;
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
  raceTimeline.update(stats.progress);
  query<HTMLElement>('#heat-fill').style.height = `${stats.heat}%`;
  query<HTMLElement>('#flux-fill').style.height = `${stats.flux}%`;
  query<HTMLElement>('#rhythm-ring').style.setProperty('--pulse', String(stats.rhythmPulse));
  query<HTMLElement>('#weapon-ready').style.setProperty('--cooldown', String(Math.min(1, stats.weaponCooldown * 2)));
  const mobileFireCooldown = Math.min(1, stats.weaponCooldown * WEAPONS[selectedWeapon].fireRate);
  mobileFireButton.style.setProperty('--cooldown', String(mobileFireCooldown));
  mobileFireButton.classList.toggle('is-cooling-down', mobileFireCooldown > 0);
  mobileFireState.textContent = mobileFireCooldown > 0 ? 'WAIT' : 'READY';
  const abilityCooldown = Math.min(1, stats.abilityCooldown / ABILITIES[selectedAbility].cooldown);
  mobileAbilityButton.style.setProperty('--cooldown', String(abilityCooldown));
  mobileAbilityButton.classList.toggle('is-cooling-down', abilityCooldown > 0);
  mobileAbilityState.textContent = stats.abilityCooldown <= 0 ? 'READY' : stats.abilityCooldown.toFixed(1);
  setText('#ability-ready', stats.abilityCooldown <= 0
    ? `READY // ${formatKeyCode(settings.controls.ability[0])}`
    : `${stats.abilityCooldown.toFixed(1)} SEC`);
  app.classList.toggle('is-overheated', stats.overheated);
  app.classList.toggle('is-phasing', stats.phaseActive);
  app.classList.toggle('is-low-shield', stats.shield <= 1);
  const pips = query<HTMLElement>('#shield-pips');
  pips.innerHTML = Array.from({ length: stats.maxShield }, (_, index) => `<i class="${index < stats.shield ? 'is-active' : ''}"></i>`).join('');
  if (currentRunIsOnline) broadcastLocalRaceState();
}

function showImpactFlash(direction: -1 | 1): void {
  damageFlashAnimation?.cancel();
  const peakOpacity = settings.graphics.reducedFlashes ? 0.15 : 0.46;
  const contactSide = direction > 0 ? 'right' : 'left';
  damageFlash.style.background = `linear-gradient(to ${contactSide}, transparent 34%, rgba(255, 55, 36, 0.18) 72%, rgba(255, 220, 142, 0.52) 100%)`;
  const animation = damageFlash.animate(
    [
      { opacity: peakOpacity },
      { opacity: peakOpacity * 0.32, offset: 0.34 },
      { opacity: 0 },
    ],
    { duration: settings.graphics.reducedFlashes ? 200 : 300, easing: 'cubic-bezier(.16,.84,.26,1)' },
  );
  damageFlashAnimation = animation;
  animation.addEventListener('finish', () => {
    if (damageFlashAnimation !== animation) return;
    damageFlashAnimation = null;
    damageFlash.style.removeProperty('background');
  }, { once: true });
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
  if (currentRunIsOnline) broadcastLocalRaceState();
  const wasBest = result.score > garage.bestScore;
  garage.credits += result.credits;
  garage.runs += 1;
  garage.bestScore = Math.max(garage.bestScore, result.score);
  saveGarage(garage);
  updateGarageUi();
  setRunUiActive(false);
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

async function startConfiguredRun(config: RunConfig, online = false): Promise<void> {
  lastConfig = config;
  currentRunIsOnline = online;
  musicPreview.stop();
  startButton.disabled = true;
  resultsScreen.classList.remove('is-active');
  query<HTMLButtonElement>('#replay-run').hidden = online;
  menu.classList.add('is-hidden');
  hud.classList.add('is-active');
  setRunUiActive(true);
  setText('#rank-total', `/ ${1 + (config.aiOpponents ?? 3) + (onlineMatch?.humans.length ? onlineMatch.humans.length - 1 : 0)}`);
  setText('#hud-track', TRACKS[config.track].name.toUpperCase());
  setText('#hud-weapon', WEAPONS[config.weapon].name.toUpperCase());
  setText('#hud-ability', ABILITIES[config.ability].name.toUpperCase());
  mobileAbilityName.textContent = ABILITIES[config.ability].name.split(' ')[0].toUpperCase();
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
    setRunUiActive(false);
    hud.classList.remove('is-active');
    menu.classList.remove('is-hidden');
    refreshCoursePreview();
    setMusicCatalogError('Не удалось начать воспроизведение. Включён синтетический режим.');
    setText('#music-catalog-status', 'SYNTHETIC MODE ONLINE');
    showToast('AUDIO START ERROR', 'Включён синтетический режим — запустите заезд ещё раз', 'red');
  } finally {
    startButton.disabled = musicLoading || Boolean(onlineRoom);
  }
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
  onlineMatch = null;
  remoteRaceStates.clear();
  game.setRemoteRacers([]);
  await startConfiguredRun(config, false);
}

type MobileMenuPane = 'race' | 'loadout' | 'garage' | 'online';

const mobileMenuTabs = queryAll<HTMLButtonElement>('[data-menu-tab]');

function selectMobileMenuPane(pane: MobileMenuPane, scrollToTop = false): void {
  menu.dataset.activePane = pane;
  for (const button of mobileMenuTabs) {
    const selected = button.dataset.menuTab === pane;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  if (scrollToTop && window.matchMedia('(max-width: 960px)').matches) {
    menu.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

for (const button of mobileMenuTabs) {
  button.addEventListener('click', () => {
    selectMobileMenuPane(button.dataset.menuTab as MobileMenuPane, true);
  });
}
selectMobileMenuPane('race');

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
    mobileAbilityName.textContent = ABILITIES[selectedAbility].name.split(' ')[0].toUpperCase();
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

function renderPlaylistUi(snapshot: MusicLibrarySnapshot = localMusicLibrary.getSnapshot()): void {
  const previousPlaylist = playlistSelect.value;
  playlistSelect.replaceChildren(...snapshot.playlists.map((playlist) => new Option(
    `${playlist.name} · ${playlist.trackIds.length}`,
    playlist.id,
  )));
  playlistSelect.value = snapshot.activePlaylistId ?? snapshot.playlists[0]?.id ?? '';
  if (!playlistSelect.value && previousPlaylist) playlistSelect.value = previousPlaylist;

  const activePlaylist = snapshot.playlists.find((playlist) => playlist.id === playlistSelect.value);
  const tracks = (activePlaylist?.trackIds ?? [])
    .map((trackId) => snapshot.tracks.find((track) => track.id === trackId))
    .filter((track): track is NonNullable<typeof track> => Boolean(track));
  playlistTrackSelect.replaceChildren(
    tracks.length === 0
      ? new Option('НЕТ СОХРАНЁННЫХ ТРЕКОВ', '')
      : document.createDocumentFragment(),
  );
  if (tracks.length > 0) {
    playlistTrackSelect.replaceChildren(...tracks.map((track) => new Option(
      `${track.title}${track.bpm ? ` // ${Math.round(track.bpm)} BPM` : ''} · ${formatFileSize(track.bytes)}`,
      track.id,
    )));
    playlistTrackSelect.value = snapshot.activeTrackId && tracks.some((track) => track.id === snapshot.activeTrackId)
      ? snapshot.activeTrackId
      : tracks[0].id;
  }
  const hasPlaylist = Boolean(activePlaylist);
  const hasTrack = Boolean(playlistTrackSelect.value);
  query<HTMLButtonElement>('#playlist-rename').disabled = !hasPlaylist;
  query<HTMLButtonElement>('#playlist-delete').disabled = !hasPlaylist;
  query<HTMLButtonElement>('#playlist-track-load').disabled = !hasTrack;
  query<HTMLButtonElement>('#playlist-track-remove').disabled = !hasTrack;
  playlistTrackSelect.disabled = !hasTrack || musicLoading;
}

function setPlaylistStatus(message: string): void {
  setText('#playlist-status', message);
}

async function loadStoredTrack(trackId: string): Promise<void> {
  if (!trackId || musicLoading) return;
  try {
    const file = await localMusicLibrary.getTrackFile(trackId);
    await loadMusicFile(file, trackId);
  } catch (error) {
    console.error(error);
    setPlaylistStatus('Не удалось открыть сохранённый трек. Добавьте файл заново.');
    showToast('LOCAL LIBRARY ERROR', 'Аудиоданные трека недоступны', 'red');
  }
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
  startButton.disabled = loading || Boolean(onlineRoom);
  musicPreview.setLoading(loading);
  musicLibrary.setAttribute('aria-busy', String(loading));
  musicCatalog.disabled = loading || !musicCatalogReady;
  query<HTMLInputElement>('#music-file').disabled = loading;
  playlistSelect.disabled = loading;
  playlistTrackSelect.disabled = loading || !playlistTrackSelect.value;
  for (const selector of ['#playlist-create', '#playlist-rename', '#playlist-delete', '#playlist-track-load', '#playlist-track-remove']) {
    query<HTMLButtonElement>(selector).disabled = loading;
  }
  if (!loading) renderPlaylistUi();
  query<HTMLElement>('#music-drop').classList.toggle('is-loading', loading);
}

function setMusicCatalogError(message: string | null, allowRetry = false): void {
  musicLibrary.classList.toggle('has-error', Boolean(message));
  musicCatalogError.hidden = !message;
  musicCatalogError.textContent = message || '';
  musicCatalogRetry.hidden = !(allowRetry || musicCatalogLoadFailed);
}

function describeAudioImportError(error: unknown): string {
  if (!(error instanceof AudioImportError)) {
    return 'Не удалось прочитать аудиофайл. Попробуйте MP3, WAV, OGG, M4A или FLAC.';
  }
  switch (error.code) {
    case 'empty':
      return 'Файл пустой или браузер потерял к нему доступ. Выберите файл ещё раз.';
    case 'too-large':
      return 'Файл больше 48 МБ. Выберите более компактную версию трека.';
    case 'too-long':
      return 'Трек длиннее 12 минут. Выберите более короткую композицию.';
    case 'read':
      return 'Браузер потерял доступ к файлу. Выберите его ещё раз.';
    case 'network':
      return 'Серверный трек не удалось скачать. Проверьте соединение и попробуйте снова.';
    case 'decode':
      return 'Браузер не смог прочитать кодек этого файла. Попробуйте MP3, WAV, OGG, M4A или FLAC.';
    case 'invalid':
      return 'В аудиофайле нет корректной звуковой дорожки.';
  }
}

function isAudioFileCandidate(file: File): boolean {
  return file.type.startsWith('audio/') || /\.(?:mp3|wav|ogg|oga|opus|m4a|aac|flac|webm)$/i.test(file.name);
}

function restoreMusicUiAfterError(message: string): void {
  renderMusicCatalog();
  updateMusicUi();
  refreshCoursePreview();
  query<HTMLElement>('#music-drop').classList.toggle('has-file', audio.getSourceKind() === 'local');
  setMusicCatalogError(message);
  setText(
    '#music-catalog-status',
    audio.getSourceKind() === 'synthetic'
      ? 'SYNTHETIC MODE ONLINE'
      : `ACTIVE // ${audio.getProfile().title} // предыдущий трек сохранён`,
  );
}

async function loadMusicCatalog(): Promise<void> {
  const uiEpoch = musicUiEpoch;
  musicCatalogLoadFailed = false;
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
    musicCatalogLoadFailed = false;
    renderMusicCatalog();
    if (uiEpoch === musicUiEpoch) {
      setText('#music-catalog-status', `${musicCatalogEntries.length} SERVER TRACK${musicCatalogEntries.length === 1 ? '' : 'S'} ONLINE // трасса выбирается отдельно`);
    }
  } catch (error) {
    console.error(error);
    musicCatalogEntries = [];
    musicCatalogReady = true;
    musicCatalogLoadFailed = true;
    renderMusicCatalog();
    if (uiEpoch === musicUiEpoch) {
      setText('#music-catalog-status', 'SYNTHETIC MODE ONLINE');
      setMusicCatalogError('Каталог музыки недоступен. Можно играть с синтезатором или загрузить свой файл.', true);
    }
  } finally {
    if (uiEpoch === musicUiEpoch && !musicLoading) musicLibrary.setAttribute('aria-busy', 'false');
    musicCatalog.disabled = musicLoading || !musicCatalogReady;
  }
}

async function loadCatalogTrack(entry: MusicCatalogEntry): Promise<void> {
  if (musicLoading) return;
  musicUiEpoch += 1;
  setMusicLoading(true);
  setMusicCatalogError(null);
  setText('#music-title', 'LOADING SERVER TRACK…');
  setText('#music-meta', `${entry.format} · ${formatFileSize(entry.bytes)} · анализируем BPM и спектр`);
  setText('#music-action', 'WAIT');
  setText('#music-catalog-status', `ANALYZING // ${entry.title}`);
  try {
    let preparationFailed = false;
    let preparationError: unknown;
    try {
      await audio.prepareCatalogTrack(entry);
    } catch (error) {
      preparationFailed = true;
      preparationError = error;
    }
    if (preparationFailed) {
      console.error(preparationError);
      const message = describeAudioImportError(preparationError);
      restoreMusicUiAfterError(message);
      showToast('AUDIO ERROR', message, 'red');
      return;
    }
    selectedMusicId = entry.id;
    renderMusicCatalog();
    updateMusicUi();
    refreshCoursePreview();
    query<HTMLElement>('#music-drop').classList.remove('has-file');
    setText('#music-catalog-status', `ACTIVE // ${entry.title} // трасса выбирается отдельно в блоке 01`);
  } finally {
    setMusicLoading(false);
  }
}

const musicFile = query<HTMLInputElement>('#music-file');
async function loadMusicFile(file: File, libraryTrackId: string | null = null): Promise<void> {
  if (musicLoading) return;
  musicUiEpoch += 1;
  const drop = query<HTMLElement>('#music-drop');
  setMusicLoading(true);
  setMusicCatalogError(null);
  setText('#music-title', 'ANALYZING SPECTRUM…');
  setText('#music-meta', 'Строим energy map, ищем BPM и транзиенты');
  setText('#music-action', 'WAIT');
  try {
    let preparationFailed = false;
    let preparationError: unknown;
    try {
      await audio.prepareFile(file);
    } catch (error) {
      preparationFailed = true;
      preparationError = error;
    }
    if (preparationFailed) {
      console.error(preparationError);
      const message = describeAudioImportError(preparationError);
      restoreMusicUiAfterError(message);
      showToast('AUDIO ERROR', message, 'red');
      return;
    }
    selectedMusicId = 'local';
    const profile = audio.getProfile();
    try {
      if (libraryTrackId) {
        activeLibraryTrackId = libraryTrackId;
        localMusicLibrary.setActiveTrack(libraryTrackId);
        localMusicLibrary.updateTrack(libraryTrackId, {
          title: profile.title,
          duration: profile.duration,
          bpm: profile.bpm,
        });
        setPlaylistStatus(`ACTIVE // ${profile.title} // сохранён в локальной коллекции`);
      } else {
        const savedTrack = await localMusicLibrary.addTrack(file, {
          playlistId: localMusicLibrary.getSnapshot().activePlaylistId,
          title: profile.title,
          duration: profile.duration,
          bpm: profile.bpm,
        });
        activeLibraryTrackId = savedTrack.id;
        setPlaylistStatus(`SAVED // ${profile.title} // ${formatFileSize(file.size)}`);
      }
      const persistence = localMusicLibrary.getPersistenceStatus();
      if (persistence.degraded) {
        setPlaylistStatus(`TEMPORARY // ${profile.title} // CURRENT TAB ONLY`);
        showToast('TEMPORARY LIBRARY', 'Browser storage is unavailable; this track stays in the current tab only.', 'gold');
      }
    } catch (error) {
      console.warn('Local music library write failed', error);
      setPlaylistStatus('Трек играет, но браузер не разрешил сохранить его на этом устройстве.');
      showToast('LIBRARY STORAGE FULL', 'Музыка загружена только для текущей вкладки', 'gold');
    }
    renderMusicCatalog();
    updateMusicUi();
    refreshCoursePreview();
    drop.classList.add('has-file');
    setText('#music-catalog-status', `ACTIVE // ${audio.getProfile().title} // LOCAL FILE`);
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
  if (!file) return;
  if (musicLoading) {
    showToast('AUDIO BUSY', 'Дождитесь завершения текущего анализа', 'cyan');
    return;
  }
  if (isAudioFileCandidate(file)) {
    void loadMusicFile(file);
    return;
  }
  setMusicCatalogError('Это не аудиофайл. Выберите MP3, WAV, OGG, M4A, AAC, FLAC или WebM.');
});

musicCatalog.addEventListener('change', () => {
  const value = musicCatalog.value;
  if (value === 'synthetic') {
    musicUiEpoch += 1;
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

playlistSelect.addEventListener('change', () => {
  localMusicLibrary.setActivePlaylist(playlistSelect.value || null);
  activeLibraryTrackId = null;
  renderPlaylistUi();
  const snapshot = localMusicLibrary.getSnapshot();
  const playlist = snapshot.playlists.find((candidate) => candidate.id === snapshot.activePlaylistId);
  setPlaylistStatus(playlist
    ? `ACTIVE LIST // ${playlist.name} // ${playlist.trackIds.length} TRACK${playlist.trackIds.length === 1 ? '' : 'S'}`
    : 'Выберите или создайте список.');
});

playlistTrackSelect.addEventListener('change', () => {
  const trackId = playlistTrackSelect.value;
  if (!trackId) return;
  localMusicLibrary.setActiveTrack(trackId, playlistSelect.value);
  void loadStoredTrack(trackId);
});

query<HTMLButtonElement>('#playlist-track-load').addEventListener('click', () => {
  const trackId = playlistTrackSelect.value;
  if (!trackId) return;
  localMusicLibrary.setActiveTrack(trackId, playlistSelect.value);
  void loadStoredTrack(trackId);
});

query<HTMLButtonElement>('#playlist-create').addEventListener('click', () => {
  const requested = window.prompt('Название нового плейлиста', `Плейлист ${localMusicLibrary.getSnapshot().playlists.length + 1}`);
  if (requested === null) return;
  try {
    const playlist = localMusicLibrary.createPlaylist(requested);
    renderPlaylistUi();
    setPlaylistStatus(`CREATED // ${playlist.name} // загружайте треки через LOAD FILE`);
  } catch {
    setPlaylistStatus('Название плейлиста не может быть пустым.');
  }
});

query<HTMLButtonElement>('#playlist-rename').addEventListener('click', () => {
  const snapshot = localMusicLibrary.getSnapshot();
  const playlist = snapshot.playlists.find((candidate) => candidate.id === snapshot.activePlaylistId);
  if (!playlist) return;
  const requested = window.prompt('Новое название плейлиста', playlist.name);
  if (requested === null) return;
  try {
    const renamed = localMusicLibrary.renamePlaylist(playlist.id, requested);
    setPlaylistStatus(`RENAMED // ${renamed.name}`);
  } catch {
    setPlaylistStatus('Название плейлиста не может быть пустым.');
  }
});

query<HTMLButtonElement>('#playlist-delete').addEventListener('click', () => {
  const snapshot = localMusicLibrary.getSnapshot();
  const playlist = snapshot.playlists.find((candidate) => candidate.id === snapshot.activePlaylistId);
  if (!playlist || !window.confirm(`Удалить плейлист «${playlist.name}»? Уникальные треки этого списка тоже удалятся с устройства.`)) return;
  const removedTrackIds = [...playlist.trackIds];
  localMusicLibrary.deletePlaylist(playlist.id);
  activeLibraryTrackId = null;
  renderPlaylistUi();
  setPlaylistStatus(`DELETED // ${playlist.name}`);
  const remaining = localMusicLibrary.getSnapshot();
  const retainedIds = new Set(remaining.playlists.flatMap((candidate) => candidate.trackIds));
  void Promise.all(removedTrackIds
    .filter((trackId) => !retainedIds.has(trackId))
    .map((trackId) => localMusicLibrary.deleteTrack(trackId)))
    .catch((error) => console.warn('Orphaned playlist tracks could not be removed', error));
});

query<HTMLButtonElement>('#playlist-track-remove').addEventListener('click', () => {
  const playlistId = playlistSelect.value;
  const trackId = playlistTrackSelect.value;
  if (!playlistId || !trackId) return;
  const snapshot = localMusicLibrary.getSnapshot();
  const track = snapshot.tracks.find((candidate) => candidate.id === trackId);
  localMusicLibrary.removeTrackFromPlaylist(trackId, playlistId);
  if (activeLibraryTrackId === trackId) activeLibraryTrackId = null;
  renderPlaylistUi();
  const stillUsed = localMusicLibrary.getSnapshot().playlists.some((playlist) => playlist.trackIds.includes(trackId));
  if (!stillUsed) void localMusicLibrary.deleteTrack(trackId).catch((error) => console.warn('Track blob could not be removed', error));
  setPlaylistStatus(`REMOVED // ${track?.title ?? 'TRACK'}${stillUsed ? ' // сохранён в другом списке' : ' // удалён с устройства'}`);
});

localMusicLibrary.subscribe((snapshot) => renderPlaylistUi(snapshot), true);
void Promise.all([
  localMusicLibrary.pruneMissingTracks(),
  localMusicLibrary.pruneOrphanedBlobs(),
]).then(([missing]) => {
  if (missing.length > 0) setPlaylistStatus(`LIBRARY REPAIRED // удалено потерянных треков: ${missing.length}`);
  renderPlaylistUi();
}).catch((error) => console.warn('Music library maintenance failed', error));

const ONLINE_NAME_KEY = 'ballistic-edge-pilot-name-v1';

function normalizePilotName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 24) || 'PILOT';
}

function readPilotName(): string {
  try {
    return normalizePilotName(localStorage.getItem(ONLINE_NAME_KEY) || 'PILOT');
  } catch {
    return 'PILOT';
  }
}

function savePilotName(name: string): void {
  try {
    localStorage.setItem(ONLINE_NAME_KEY, name);
  } catch {
    // Online remains usable for the current page even if storage is blocked.
  }
}

function setOnlineConnection(state: 'ready' | 'connecting' | 'online' | 'offline', label: string): void {
  const element = query<HTMLElement>('#online-connection');
  element.dataset.state = state;
  element.textContent = label;
}

function setOnlineStatus(message: string): void {
  setText('#online-status', message);
  setText('#online-entry-status', message);
}

function currentOnlineSettings() {
  return {
    track: query<HTMLSelectElement>('#online-track').value as TrackId,
    aiOpponents: Number(query<HTMLInputElement>('#online-ai').value),
    playerSlots: Number(query<HTMLInputElement>('#online-slots').value),
  };
}

function currentLobbyIdentity(): string {
  return JSON.stringify({
    name: normalizePilotName(onlineNameInput.value),
    weapon: selectedWeapon,
    ability: selectedAbility,
    garage,
  });
}

function lobbyAction(action: (client: LobbyClient) => void): boolean {
  const client = lobbyClient;
  if (!client || client.connectionState !== 'online') {
    setOnlineStatus('NETWORK // соединение восстанавливается, попробуйте ещё раз');
    return false;
  }
  try {
    action(client);
    return true;
  } catch (error) {
    setOnlineStatus(`NETWORK ERROR // ${error instanceof Error ? error.message : 'command failed'}`);
    return false;
  }
}

function renderOnlineRooms(): void {
  const container = query<HTMLElement>('#online-room-list');
  container.replaceChildren();
  const joinable = onlineRooms.filter((room) => room.phase === 'lobby' && room.humans < room.playerSlots).slice(0, 6);
  if (joinable.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'online-empty';
    empty.textContent = !lobbyClient
      ? 'Нажми REFRESH, чтобы увидеть открытые комнаты.'
      : lobbyClient.connectionState === 'online'
      ? 'Открытых комнат пока нет — создай первую.'
      : 'Подключаемся к сетевому узлу…';
    container.append(empty);
    return;
  }
  for (const room of joinable) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'online-room-card';
    const title = document.createElement('strong');
    title.textContent = `${room.code} // ${room.hostName}`;
    const meta = document.createElement('small');
    meta.textContent = `${TRACKS[room.track].name.toUpperCase()} · AI ${room.aiOpponents}`;
    const count = document.createElement('b');
    count.textContent = `${room.humans}/${room.playerSlots}`;
    button.append(title, meta, count);
    button.addEventListener('click', () => void joinOnlineRoom(room.code));
    container.append(button);
  }
}

function renderOnlineChat(room: OnlineRoomSnapshot): void {
  const log = query<HTMLElement>('#online-chat-log');
  const wasNearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  log.replaceChildren();
  for (const message of room.chat) {
    const line = document.createElement('p');
    line.className = 'online-chat__message';
    const author = document.createElement('strong');
    author.textContent = `${message.playerName}:`;
    line.append(author, document.createTextNode(message.text));
    log.append(line);
  }
  if (wasNearBottom || room.chat.length <= 2) log.scrollTop = log.scrollHeight;
}

function setLoadoutLocked(locked: boolean): void {
  for (const button of [...trackButtons, ...weaponButtons, ...abilityButtons]) button.disabled = locked;
  for (const button of queryAll<HTMLButtonElement>('.garage-module')) button.disabled = locked;
  if (!locked) updateGarageUi();
  app.classList.toggle('is-online-lobby', locked);
}

function renderOnlineRoom(room: OnlineRoomSnapshot): void {
  onlineRoom = room;
  query<HTMLElement>('#online-entry').hidden = true;
  query<HTMLElement>('#online-lobby').hidden = false;
  setLoadoutLocked(true);
  startButton.disabled = true;
  setText('#online-room-code', room.code);
  setText('#online-room-status', room.phase === 'lobby' ? 'WAITING' : 'RACING');
  setText('#online-player-count', `${room.players.length} / ${room.settings.playerSlots}`);

  if (selectedTrack !== room.settings.track && room.phase === 'lobby') {
    selectedTrack = room.settings.track;
    selectRadio('[data-track]', selectedTrack, 'track');
    refreshCoursePreview();
  }

  const players = query<HTMLElement>('#online-players');
  players.replaceChildren();
  for (const player of room.players) {
    const row = document.createElement('div');
    row.className = 'online-player';
    const signal = document.createElement('i');
    const name = document.createElement('strong');
    name.textContent = player.name;
    const state = document.createElement('span');
    state.textContent = player.isHost ? 'HOST' : player.ready ? 'READY' : 'SYNC';
    row.append(signal, name, state);
    players.append(row);
  }

  const clientId = lobbyClient?.playerId;
  const me = room.players.find((player) => player.id === clientId);
  const isHost = room.hostId === clientId;
  const controls = query<HTMLElement>('.online-host-controls');
  controls.classList.toggle('is-locked', !isHost || room.phase !== 'lobby');
  const trackSelect = query<HTMLSelectElement>('#online-track');
  const aiInput = query<HTMLInputElement>('#online-ai');
  const slotsInput = query<HTMLInputElement>('#online-slots');
  trackSelect.value = room.settings.track;
  aiInput.value = String(room.settings.aiOpponents);
  slotsInput.min = String(Math.max(2, room.players.length));
  slotsInput.value = String(room.settings.playerSlots);
  setText('#online-ai-value', String(room.settings.aiOpponents));
  setText('#online-slots-value', String(room.settings.playerSlots));
  trackSelect.disabled = !isHost || room.phase !== 'lobby';
  aiInput.disabled = !isHost || room.phase !== 'lobby';
  slotsInput.disabled = !isHost || room.phase !== 'lobby';

  const ready = query<HTMLButtonElement>('#online-ready');
  ready.hidden = isHost;
  ready.textContent = me?.ready ? 'NOT READY' : 'READY';
  ready.disabled = room.phase !== 'lobby';
  const start = query<HTMLButtonElement>('#online-start');
  start.hidden = !isHost;
  start.disabled = room.phase !== 'lobby' || room.players.length < 2;
  setOnlineStatus(room.phase === 'racing'
    ? 'RACE IN PROGRESS // после финиша комната вернётся в лобби'
    : room.players.length < 2
      ? 'Для старта нужен ещё один живой пилот.'
      : isHost
        ? 'Все системы готовы. Хост может запустить заезд в любой момент.'
        : 'Ожидаем команду хоста. READY показывает твою готовность команде.');
  renderOnlineChat(room);
}

function leaveOnlineRoomUi(): void {
  onlineRoom = null;
  onlineMatch = null;
  currentRunIsOnline = false;
  remoteRaceStates.clear();
  game.setRemoteRacers([]);
  window.clearTimeout(onlineStartTimer);
  query<HTMLElement>('#online-entry').hidden = false;
  query<HTMLElement>('#online-lobby').hidden = true;
  setLoadoutLocked(false);
  startButton.disabled = musicLoading;
  query<HTMLButtonElement>('#replay-run').hidden = false;
  lobbyAction((client) => client.listRooms());
}

function syncRemoteRacers(): void {
  if (!onlineMatch || !lobbyClient?.playerId || !currentRunIsOnline) return;
  const currentMembers = new Set(onlineRoom?.players.map((player) => player.id) ?? []);
  const racers: RemoteRacerState[] = onlineMatch.humans
    .filter((human) => human.id !== lobbyClient?.playerId && currentMembers.has(human.id))
    .map((human) => {
      const state = remoteRaceStates.get(human.id);
      return {
        id: human.id,
        name: human.name,
        progress: state?.progress ?? 0,
        angle: state?.angle ?? 0,
        speed: state?.speed ?? 0,
        shield: state?.shield ?? 3,
        active: state ? !state.destroyed && !state.finished : true,
        destroyed: state?.destroyed ?? false,
        finished: state?.finished ?? false,
      };
    });
  game.setRemoteRacers(racers);
}

function broadcastLocalRaceState(): void {
  if (!onlineMatch || !lobbyClient || lobbyClient.connectionState !== 'online') return;
  const state = game.getLocalRaceSnapshot();
  if (!state.active && !state.finished) return;
  try {
    lobbyClient.sendRaceState({
      matchId: onlineMatch.id,
      angle: state.angle,
      progress: state.progress,
      speed: state.speed,
      shield: state.shield,
      heat: state.heat,
      flux: state.flux,
      score: state.score,
      rank: state.rank,
      section: state.section,
      destroyed: state.destroyed,
      finished: state.finished,
    });
  } catch (error) {
    console.warn('Race state was not sent', error);
  }
}

async function handleOnlineRaceStart(config: AuthoritativeRaceConfig): Promise<void> {
  if (!lobbyClient?.playerId) return;
  const mine = config.humans.find((human) => human.id === lobbyClient?.playerId);
  if (!mine) return;
  onlineMatch = config;
  remoteRaceStates.clear();
  audio.useSynthetic();
  selectedMusicId = 'synthetic';
  renderMusicCatalog();
  updateMusicUi();
  selectedTrack = config.track;
  selectRadio('[data-track]', selectedTrack, 'track');
  refreshCoursePreview();
  const delay = lobbyClient.delayUntil(config.startsAt);
  setOnlineStatus(`SYNC START // ${Math.max(0, delay / 1000).toFixed(1)} SEC // EDGE SIGNAL LOCKED FOR ALL PILOTS`);
  window.clearTimeout(onlineStartTimer);
  onlineStartTimer = window.setTimeout(() => {
    const runConfig: RunConfig = { ...mine.runConfig, aiOpponents: config.aiOpponents };
    void startConfiguredRun(runConfig, true).then(syncRemoteRacers);
  }, delay);
}

function bindLobbyClient(client: LobbyClient): void {
  const isCurrent = (): boolean => lobbyClient === client;
  client.on('connection', ({ state, reason }) => {
    if (!isCurrent()) return;
    if (state === 'online') {
      setOnlineConnection('online', 'ONLINE');
      client.listRooms();
    } else if (state === 'closed') {
      setOnlineConnection('offline', 'OFFLINE');
      if (!onlineRoom) renderOnlineRooms();
    } else {
      setOnlineConnection('connecting', state === 'reconnecting' ? 'RECONNECTING' : 'CONNECTING');
      if (reason) setOnlineStatus(`NETWORK // ${reason}`);
    }
  });
  client.on('rooms', ({ rooms }) => {
    if (!isCurrent()) return;
    onlineRooms = rooms;
    renderOnlineRooms();
  });
  client.on('room', ({ room }) => {
    if (!isCurrent()) return;
    renderOnlineRoom(room);
    if (onlineMatch) {
      const memberIds = new Set(room.players.map((player) => player.id));
      for (const playerId of remoteRaceStates.keys()) if (!memberIds.has(playerId)) remoteRaceStates.delete(playerId);
      syncRemoteRacers();
    }
  });
  client.on('roomLeft', () => {
    if (!isCurrent()) return;
    leaveOnlineRoomUi();
  });
  client.on('chat', ({ roomId, message }) => {
    if (!isCurrent() || !onlineRoom || onlineRoom.id !== roomId) return;
    if (!onlineRoom.chat.some((candidate) => candidate.id === message.id)) onlineRoom.chat.push(message);
    renderOnlineChat(onlineRoom);
  });
  client.on('raceStarted', ({ config }) => {
    if (!isCurrent()) return;
    void handleOnlineRaceStart(config);
  });
  client.on('raceState', ({ state }) => {
    if (!isCurrent() || !onlineMatch || state.matchId !== onlineMatch.id || state.playerId === client.playerId) return;
    remoteRaceStates.set(state.playerId, state);
    syncRemoteRacers();
  });
  client.on('rejoinFailed', () => {
    if (!isCurrent()) return;
    leaveOnlineRoomUi();
  });
  client.on('serverError', ({ code, message }) => {
    if (!isCurrent()) return;
    const labels: Partial<Record<typeof code, string>> = {
      NOT_ENOUGH_PLAYERS: 'Для старта нужны минимум два игрока.',
      ROOM_NOT_FOUND: 'Комната не найдена — проверь код.',
      ROOM_FULL: 'В комнате уже заняты все слоты.',
      ROOM_RUNNING: 'Заезд уже начался.',
      HOST_ONLY: 'Эта настройка доступна только хосту.',
      INVALID_SETTINGS: 'Проверь количество слотов и настройки комнаты.',
      RATE_LIMITED: 'Слишком быстро — подожди секунду.',
    };
    const text = labels[code] ?? message;
    setOnlineStatus(`ERROR // ${text}`);
    showToast(`ONLINE ${code}`, text, 'red');
  });
  client.on('protocolError', ({ message }) => {
    if (!isCurrent()) return;
    setOnlineStatus(`PROTOCOL ERROR // ${message}`);
  });
}

async function ensureLobbyClient(): Promise<LobbyClient> {
  const name = normalizePilotName(onlineNameInput.value);
  onlineNameInput.value = name;
  savePilotName(name);
  const identity = currentLobbyIdentity();
  if (lobbyClient && lobbyIdentity === identity) {
    await lobbyClient.connect();
    return lobbyClient;
  }
  lobbyClient?.disconnect();
  const client = new LobbyClient({
    url: defaultLobbyUrl(),
    name,
    loadout: { weapon: selectedWeapon, ability: selectedAbility, garage: { ...garage } },
  });
  lobbyClient = client;
  lobbyIdentity = identity;
  bindLobbyClient(client);
  await client.connect();
  return client;
}

async function joinOnlineRoom(code: string): Promise<void> {
  const normalized = code.replace(/[^a-z0-9-]/gi, '').toUpperCase().slice(0, 8);
  if (normalized.length < 4) {
    setOnlineStatus('Введите код комнаты — минимум четыре символа.');
    return;
  }
  void audio.unlock().catch(() => undefined);
  try {
    const client = await ensureLobbyClient();
    client.joinRoom(normalized);
    setOnlineStatus(`JOINING // ${normalized}`);
  } catch (error) {
    setOnlineConnection('offline', 'OFFLINE');
    setOnlineStatus(`NETWORK ERROR // ${error instanceof Error ? error.message : 'connection failed'}`);
  }
}

onlineNameInput.value = readPilotName();
onlineNameInput.addEventListener('change', () => {
  onlineNameInput.value = normalizePilotName(onlineNameInput.value);
  savePilotName(onlineNameInput.value);
});
query<HTMLInputElement>('#online-code').addEventListener('input', (event) => {
  const input = event.currentTarget as HTMLInputElement;
  input.value = input.value.replace(/[^a-z0-9-]/gi, '').toUpperCase();
});
query<HTMLButtonElement>('#online-create').addEventListener('click', () => {
  void audio.unlock().catch(() => undefined);
  void ensureLobbyClient().then((client) => {
    client.createRoom(currentOnlineSettings());
    setOnlineStatus('CREATING ROOM // резервируем сетевой туннель…');
  }).catch((error) => setOnlineStatus(`NETWORK ERROR // ${error instanceof Error ? error.message : 'connection failed'}`));
});
query<HTMLButtonElement>('#online-join').addEventListener('click', () => {
  void joinOnlineRoom(query<HTMLInputElement>('#online-code').value);
});
query<HTMLButtonElement>('#online-refresh').addEventListener('click', () => {
  void ensureLobbyClient().then((client) => client.listRooms()).catch(() => undefined);
});
query<HTMLButtonElement>('#online-copy-code').addEventListener('click', () => {
  const code = onlineRoom?.code;
  if (!code) return;
  void navigator.clipboard?.writeText(code).then(
    () => setOnlineStatus(`COPIED // ${code}`),
    () => setOnlineStatus(`ROOM CODE // ${code}`),
  );
});

for (const selector of ['#online-ai', '#online-slots']) {
  const input = query<HTMLInputElement>(selector);
  input.addEventListener('input', () => {
    setText(`${selector}-value`, input.value);
  });
  input.addEventListener('change', () => {
    if (onlineRoom?.hostId === lobbyClient?.playerId) lobbyAction((client) => client.updateRoomSettings(currentOnlineSettings()));
  });
}
query<HTMLSelectElement>('#online-track').addEventListener('change', () => {
  if (onlineRoom?.hostId === lobbyClient?.playerId) lobbyAction((client) => client.updateRoomSettings(currentOnlineSettings()));
});
query<HTMLButtonElement>('#online-ready').addEventListener('click', () => {
  const me = onlineRoom?.players.find((player) => player.id === lobbyClient?.playerId);
  if (me) lobbyAction((client) => client.setReady(!me.ready));
});
query<HTMLButtonElement>('#online-start').addEventListener('click', () => {
  void audio.unlock().catch(() => undefined);
  if (lobbyAction((client) => client.startRace())) setOnlineStatus('HOST START // синхронизируем часы всех пилотов…');
});
query<HTMLButtonElement>('#online-leave').addEventListener('click', () => {
  lobbyClient?.cancelRoomRejoin();
  if (!lobbyAction((client) => client.leaveRoom())) leaveOnlineRoomUi();
});
query<HTMLFormElement>('#online-chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = query<HTMLInputElement>('#online-chat-input');
  const message = input.value.replace(/\s+/g, ' ').trim();
  if (!message) return;
  if (lobbyAction((client) => client.sendChat(message))) input.value = '';
});

window.setInterval(() => {
  if (lobbyClient?.connectionState === 'online') lobbyClient.ping();
}, 10_000);
renderOnlineRooms();
setOnlineConnection('ready', 'READY');

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

const graphicsRanges: Array<{
  selector: string;
  output: string;
  field: 'bloomIntensity' | 'brightness';
  label: string;
}> = [
  { selector: '#graphics-bloom-intensity', output: '#graphics-bloom-intensity-value', field: 'bloomIntensity', label: 'BLOOM' },
  { selector: '#graphics-brightness', output: '#graphics-brightness-value', field: 'brightness', label: 'BRIGHTNESS' },
];
for (const binding of graphicsRanges) {
  const input = query<HTMLInputElement>(binding.selector);
  input.addEventListener('input', (event) => {
    const percent = Number((event.currentTarget as HTMLInputElement).value);
    settings.graphics[binding.field] = Math.max(0, Math.min(1, percent / 100));
    query<HTMLOutputElement>(binding.output).value = `${percent}%`;
    if (binding.field === 'bloomIntensity') game.setBloomIntensity(settings.graphics.bloomIntensity);
    else game.setBrightness(settings.graphics.brightness);
  });
  input.addEventListener('change', () => {
    persistSettings(`${binding.label} // ${Math.round(settings.graphics[binding.field] * 100)}%`);
  });
}

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
  setRunUiActive(false);
  currentRunIsOnline = false;
  onlineMatch = null;
  remoteRaceStates.clear();
  resultsScreen.classList.remove('is-active');
  hud.classList.remove('is-active');
  menu.classList.remove('is-hidden');
  menu.scrollTo({ top: 0 });
  query<HTMLButtonElement>('#replay-run').hidden = false;
  if (onlineRoom) renderOnlineRoom(onlineRoom);
  lastRunSeed = randomSeed();
  refreshCoursePreview();
});

for (const button of mobileHoldButtons) {
  const control = button.dataset.control as TouchInputAction;
  const down = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    const wasActive = touchInputRouter.isActive(control);
    touchInputRouter.press(event.pointerId, control);
    if (!wasActive) pulseHaptic(control === 'boost' ? 12 : 7);
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort on older mobile WebViews.
    }
  };
  const up = (event: PointerEvent) => {
    event.preventDefault();
    touchInputRouter.release(event.pointerId);
  };
  button.addEventListener('pointerdown', down);
  button.addEventListener('pointerup', up);
  button.addEventListener('pointercancel', up);
  button.addEventListener('lostpointercapture', up);
}

const pressAbility = (event: PointerEvent): void => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  event.preventDefault();
  mobileAbilityPointers.add(event.pointerId);
  mobileAbilityButton.classList.add('is-pressed');
  mobileAbilityButton.setAttribute('aria-pressed', 'true');
  try {
    mobileAbilityButton.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture is best-effort on older mobile WebViews.
  }
  pulseHaptic(14);
  game.activateAbility();
};
const releaseAbility = (event: PointerEvent): void => {
  event.preventDefault();
  mobileAbilityPointers.delete(event.pointerId);
  if (mobileAbilityPointers.size > 0) return;
  mobileAbilityButton.classList.remove('is-pressed');
  mobileAbilityButton.setAttribute('aria-pressed', 'false');
};
mobileAbilityButton.addEventListener('pointerdown', pressAbility);
mobileAbilityButton.addEventListener('pointerup', releaseAbility);
mobileAbilityButton.addEventListener('pointercancel', releaseAbility);
mobileAbilityButton.addEventListener('lostpointercapture', releaseAbility);
mobileControls.addEventListener('contextmenu', (event) => event.preventDefault());
window.addEventListener('blur', releaseTouchControls);
window.addEventListener('orientationchange', releaseTouchControls);
window.addEventListener('pagehide', releaseTouchControls);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) releaseTouchControls();
});

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
  window.clearTimeout(onlineStartTimer);
  lobbyClient?.disconnect();
  musicPreview.dispose();
  game.dispose();
  void audio.dispose();
}, { once: true });
