import { TRACKS, type TrackId } from '../core/types';
import {
  ACCOUNT_LIMITS,
  type AccountLoginRequest,
  type AccountProfile,
  type AccountRecoveryRequest,
  type AccountRegisterRequest,
  type LeaderboardEntry,
  type LeaderboardResponse,
  type LeaderboardScope,
} from '../account/protocol';
import {
  applyDocumentTranslations,
  getLocaleTag,
  t,
  type TranslationKey,
} from '../i18n';

export type AccountDialogTab = 'profile' | 'rankings' | 'achievements';
export type AccountAuthMode = 'login' | 'register' | 'recover';

export type AccountDialogSnapshot =
  | { status: 'loading' }
  | { status: 'guest' }
  | { status: 'authenticated'; profile: AccountProfile };

type MaybePromise = void | Promise<void>;

/**
 * Side effects owned by the application shell. The dialog deliberately knows
 * nothing about fetch, cookies, local garage storage, or the game instance.
 */
export interface AccountDialogCallbacks {
  onLogin?: (request: AccountLoginRequest) => MaybePromise;
  onRegister?: (request: AccountRegisterRequest) => MaybePromise;
  onRecover?: (request: AccountRecoveryRequest) => MaybePromise;
  onLogout?: () => MaybePromise;
  onImportLegacy?: () => MaybePromise;
  onLoadLeaderboard?: (scope: LeaderboardScope) => MaybePromise;
  onOpenChange?: (open: boolean) => void;
  onRecoveryShardAcknowledged?: () => void;
}

interface LeaderboardViewState {
  status: 'initial' | 'loading' | 'ready' | 'error';
  message: string | null;
}

const TRACK_IDS = Object.keys(TRACKS) as TrackId[];
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{3,20}$/;

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing account UI element: ${selector}`);
  return element;
}

function formatNumber(value: number): string {
  return Math.max(0, Number.isFinite(value) ? Math.round(value) : 0).toLocaleString(getLocaleTag());
}

function formatDate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat(getLocaleTag(), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : t('account.actionFailed');
}

function setText(element: Element, text: string): void {
  element.textContent = text;
}

/**
 * Accessible account/profile modal controller.
 *
 * Public methods are render inputs only: the app passes snapshots and API
 * results in, while callbacks carry user intent out. This keeps networking,
 * session persistence, legacy-save merging, and game input capture outside the
 * view and makes the controller safe to wire to any AccountClient.
 */
export class AccountDialogController {
  private readonly callbacks: AccountDialogCallbacks;
  private readonly root: Document;
  private readonly events = new AbortController();
  private readonly dialog: HTMLDialogElement;
  private readonly openButton: HTMLButtonElement;
  private readonly openLabel: HTMLElement;
  private readonly status: HTMLElement;
  private readonly guest: HTMLElement;
  private readonly profile: HTMLElement;
  private readonly authError: HTMLElement;
  private readonly achievementGuest: HTMLElement;
  private readonly achievementList: HTMLElement;
  private readonly leaderboardList: HTMLElement;
  private readonly leaderboardStatus: HTMLElement;
  private readonly leaderboardOwnRank: HTMLElement;
  private readonly leaderboardScope: HTMLSelectElement;
  private readonly recoveryShard: HTMLElement;
  private readonly recoveryCodeInput: HTMLInputElement;
  private readonly leaderboardCache = new Map<LeaderboardScope, LeaderboardResponse>();
  private readonly shownRecoveryCodes = new Set<string>();

  private snapshot: AccountDialogSnapshot = { status: 'loading' };
  private activeTab: AccountDialogTab = 'profile';
  private activeAuthMode: AccountAuthMode = 'login';
  private leaderboardState: LeaderboardViewState = { status: 'initial', message: null };
  private recoveryCode: string | null = null;
  private busy = false;
  private openNotified = false;
  private actionEpoch = 0;

  constructor(callbacks: AccountDialogCallbacks = {}, root: Document = document) {
    this.callbacks = callbacks;
    this.root = root;
    this.dialog = required<HTMLDialogElement>(root, '#account-dialog');
    this.openButton = required<HTMLButtonElement>(root, '#account-open');
    this.openLabel = required<HTMLElement>(root, '#account-open-label');
    this.status = required<HTMLElement>(this.dialog, '#account-status');
    this.guest = required<HTMLElement>(this.dialog, '#account-guest');
    this.profile = required<HTMLElement>(this.dialog, '#account-profile');
    this.authError = required<HTMLElement>(this.dialog, '#account-auth-error');
    this.achievementGuest = required<HTMLElement>(this.dialog, '#achievement-guest');
    this.achievementList = required<HTMLElement>(this.dialog, '#achievement-list');
    this.leaderboardList = required<HTMLElement>(this.dialog, '#leaderboard-list');
    this.leaderboardStatus = required<HTMLElement>(this.dialog, '#leaderboard-status');
    this.leaderboardOwnRank = required<HTMLElement>(this.dialog, '#leaderboard-own-rank');
    this.leaderboardScope = required<HTMLSelectElement>(this.dialog, '#leaderboard-scope');
    this.recoveryShard = required<HTMLElement>(this.dialog, '#account-recovery-shard');
    this.recoveryCodeInput = required<HTMLInputElement>(this.dialog, '#account-recovery-code');

    this.bindEvents();
    this.setAuthMode('login');
    this.setTab('profile');
    this.setSnapshot({ status: 'loading' });
  }

  /** Opens the modal on a permanent account tab. */
  open(tab: AccountDialogTab = this.activeTab): void {
    this.setTab(tab);
    if (!this.dialog.open) {
      // Give the shell a synchronous chance to close another native modal
      // (for example CFG) before showModal() runs.
      this.notifyOpenChange(true);
      try {
        this.dialog.showModal();
      } catch (error) {
        this.notifyOpenChange(false);
        throw error;
      }
    } else {
      this.notifyOpenChange(true);
    }
    queueMicrotask(() => {
      required<HTMLButtonElement>(this.dialog, `[data-account-tab="${this.activeTab}"]`).focus();
    });
    if (tab === 'rankings') void this.requestLeaderboard();
  }

  /** Closes the dialog. The native close event restores trigger focus. */
  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  /** Removes every listener installed by this controller. */
  destroy(): void {
    this.events.abort();
    if (this.dialog.open) this.dialog.close();
    this.notifyOpenChange(false);
  }

  /** Renders loading, guest, or authenticated profile state. */
  setSnapshot(snapshot: AccountDialogSnapshot): void {
    const previousAccountId = this.snapshot.status === 'authenticated' ? this.snapshot.profile.accountId : null;
    const nextAccountId = snapshot.status === 'authenticated' ? snapshot.profile.accountId : null;
    if (snapshot.status === 'guest' || (previousAccountId && nextAccountId !== previousAccountId)) {
      this.clearRecoveryShard();
    }
    this.snapshot = snapshot;
    this.setAuthError(null);
    if (snapshot.status === 'loading') {
      this.guest.hidden = false;
      this.profile.hidden = true;
      this.openButton.classList.remove('is-authenticated');
      this.openButton.setAttribute('aria-busy', 'true');
      setText(this.openLabel, '…');
      this.setBusy(true);
      this.setStatus(t('account.loading'));
      this.renderAchievements(null);
      return;
    }

    this.openButton.removeAttribute('aria-busy');
    this.setBusy(false);
    const authenticated = snapshot.status === 'authenticated';
    this.guest.hidden = authenticated;
    this.profile.hidden = !authenticated;
    this.openButton.classList.toggle('is-authenticated', authenticated);
    setText(this.openLabel, authenticated ? `@${snapshot.profile.handle}` : t('account.signIn'));

    if (authenticated) {
      this.renderProfile(snapshot.profile);
      this.renderAchievements(snapshot.profile);
      this.setStatus(t('account.authenticatedStatus', { handle: snapshot.profile.handle }));
      this.clearSensitiveForms();
    } else {
      this.renderAchievements(null);
      this.setStatus(t('account.guestStatus'));
    }
  }

  /** Renders and caches one public leaderboard response. */
  setLeaderboard(response: LeaderboardResponse): void {
    this.leaderboardCache.set(response.scope, response);
    if (response.scope !== this.getLeaderboardScope()) return;
    this.leaderboardState = { status: 'ready', message: null };
    this.renderLeaderboard(response);
  }

  /** Clears stale rows and exposes an aria-live loading state. */
  setLeaderboardLoading(scope: LeaderboardScope = this.getLeaderboardScope()): void {
    this.leaderboardScope.value = scope;
    this.leaderboardState = { status: 'loading', message: null };
    this.leaderboardList.replaceChildren();
    this.leaderboardOwnRank.hidden = true;
    this.leaderboardStatus.hidden = false;
    setText(this.leaderboardStatus, t('leaderboard.loading'));
    this.dialog.setAttribute('aria-busy', 'true');
    this.updateRankingHint();
  }

  /** Exposes a recoverable leaderboard error without touching auth state. */
  setLeaderboardError(message = t('leaderboard.error')): void {
    this.leaderboardState = { status: 'error', message };
    this.leaderboardList.replaceChildren();
    this.leaderboardOwnRank.hidden = true;
    this.leaderboardStatus.hidden = false;
    setText(this.leaderboardStatus, message);
    this.dialog.removeAttribute('aria-busy');
  }

  /** Sets or clears the visible authentication error. */
  setAuthError(message: string | null): void {
    this.authError.hidden = !message;
    setText(this.authError, message ?? '');
  }

  /** Updates the account dialog's polite status line. */
  setStatus(message: string): void {
    setText(this.status, message);
  }

  /**
   * Displays a sensitive recovery code once per controller lifetime. The code
   * remains visible across close/reopen until the pilot explicitly confirms it.
   */
  showRecoveryShard(code: string): void {
    const normalized = code.trim();
    if (!normalized || this.shownRecoveryCodes.has(normalized)) return;
    this.shownRecoveryCodes.add(normalized);
    this.recoveryCode = normalized;
    this.recoveryCodeInput.value = normalized;
    this.recoveryShard.hidden = false;
    this.open('profile');
    queueMicrotask(() => {
      this.recoveryCodeInput.focus();
      this.recoveryCodeInput.select();
    });
  }

  /** Removes a displayed recovery secret, for logout and shared-device safety. */
  clearRecoveryShard(): void {
    this.recoveryCode = null;
    this.recoveryCodeInput.value = '';
    this.recoveryShard.hidden = true;
  }

  /** Re-applies static translations and rebuilds all localized dynamic rows. */
  refreshTranslations(): void {
    applyDocumentTranslations(this.dialog);
    this.setAuthMode(this.activeAuthMode);
    if (this.snapshot.status === 'authenticated') {
      setText(this.openLabel, `@${this.snapshot.profile.handle}`);
      this.renderProfile(this.snapshot.profile);
      this.renderAchievements(this.snapshot.profile);
      this.setStatus(t('account.authenticatedStatus', { handle: this.snapshot.profile.handle }));
    } else if (this.snapshot.status === 'guest') {
      setText(this.openLabel, t('account.signIn'));
      this.renderAchievements(null);
      this.setStatus(t('account.guestStatus'));
    } else {
      setText(this.openLabel, '…');
      this.setStatus(t('account.loading'));
    }

    const cached = this.leaderboardCache.get(this.getLeaderboardScope());
    if (this.leaderboardState.status === 'ready' && cached) this.renderLeaderboard(cached);
    else if (this.leaderboardState.status === 'loading') setText(this.leaderboardStatus, t('leaderboard.loading'));
    else if (this.leaderboardState.status === 'error') setText(this.leaderboardStatus, this.leaderboardState.message ?? t('leaderboard.error'));
    else setText(this.leaderboardStatus, t('leaderboard.initial'));
    this.updateRankingHint();
  }

  /** Returns the board currently selected by the pilot. */
  getLeaderboardScope(): LeaderboardScope {
    const value = this.leaderboardScope.value;
    return value === 'global' || TRACK_IDS.includes(value as TrackId) ? value as LeaderboardScope : 'global';
  }

  private bindEvents(): void {
    const signal = this.events.signal;
    this.openButton.addEventListener('click', () => this.open(), { signal });
    required<HTMLButtonElement>(this.dialog, '#account-close').addEventListener('click', () => this.close(), { signal });
    required<HTMLButtonElement>(this.dialog, '#account-done').addEventListener('click', () => this.close(), { signal });
    this.dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.close();
    }, { signal });
    this.dialog.addEventListener('close', () => {
      this.clearSensitiveForms();
      this.notifyOpenChange(false);
      this.openButton.focus();
    }, { signal });
    this.dialog.addEventListener('pointerdown', (event) => {
      if (event.target === this.dialog) this.close();
    }, { signal });

    const tabButtons = Array.from(this.dialog.querySelectorAll<HTMLButtonElement>('[data-account-tab]'));
    for (const button of tabButtons) {
      button.addEventListener('click', () => {
        const tab = button.dataset.accountTab as AccountDialogTab;
        this.setTab(tab);
        if (tab === 'rankings') void this.requestLeaderboard();
      }, { signal });
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const current = tabButtons.indexOf(button);
        const next = event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabButtons.length - 1
            : (current + (event.key === 'ArrowLeft' ? -1 : 1) + tabButtons.length) % tabButtons.length;
        const tab = tabButtons[next].dataset.accountTab as AccountDialogTab;
        this.setTab(tab, true);
        if (tab === 'rankings') void this.requestLeaderboard();
      }, { signal });
    }

    for (const button of Array.from(this.dialog.querySelectorAll<HTMLButtonElement>('[data-account-auth-mode]'))) {
      button.addEventListener('click', () => this.setAuthMode(button.dataset.accountAuthMode as AccountAuthMode, true), { signal });
    }

    required<HTMLFormElement>(this.dialog, '#account-login-form').addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.busy) return;
      const handle = required<HTMLInputElement>(this.dialog, '#account-login-handle').value.trim();
      const password = required<HTMLInputElement>(this.dialog, '#account-login-password').value;
      if (!this.validateHandle(handle)) return;
      void this.runAction(() => this.callbacks.onLogin?.({ handle, password }), t('account.loggingIn'), true);
    }, { signal });

    required<HTMLFormElement>(this.dialog, '#account-register-form').addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.busy) return;
      const handle = required<HTMLInputElement>(this.dialog, '#account-register-handle').value.trim();
      const password = required<HTMLInputElement>(this.dialog, '#account-register-password').value;
      const confirmation = required<HTMLInputElement>(this.dialog, '#account-register-confirm').value;
      if (!this.validateHandle(handle)) return;
      if (password !== confirmation) {
        this.setAuthError(t('account.error.passwordMismatch'));
        required<HTMLInputElement>(this.dialog, '#account-register-confirm').focus();
        return;
      }
      void this.runAction(() => this.callbacks.onRegister?.({ handle, password }), t('account.registering'), true);
    }, { signal });

    required<HTMLFormElement>(this.dialog, '#account-recover-form').addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.busy) return;
      const handle = required<HTMLInputElement>(this.dialog, '#account-recover-handle').value.trim();
      const recoveryCode = required<HTMLInputElement>(this.dialog, '#account-recover-code-input').value.trim();
      const newPassword = required<HTMLInputElement>(this.dialog, '#account-recover-password').value;
      const confirmation = required<HTMLInputElement>(this.dialog, '#account-recover-confirm').value;
      if (!this.validateHandle(handle)) return;
      if (newPassword !== confirmation) {
        this.setAuthError(t('account.error.passwordMismatch'));
        required<HTMLInputElement>(this.dialog, '#account-recover-confirm').focus();
        return;
      }
      void this.runAction(
        () => this.callbacks.onRecover?.({ handle, recoveryCode, newPassword }),
        t('account.recovering'),
        true,
      );
    }, { signal });

    required<HTMLButtonElement>(this.dialog, '#account-logout').addEventListener('click', () => {
      if (!this.busy) void this.runAction(() => this.callbacks.onLogout?.(), t('account.loggingOut'));
    }, { signal });
    required<HTMLButtonElement>(this.dialog, '#account-import-legacy').addEventListener('click', () => {
      if (!this.busy) void this.runAction(() => this.callbacks.onImportLegacy?.(), t('account.importing'));
    }, { signal });

    this.leaderboardScope.addEventListener('change', () => void this.requestLeaderboard(), { signal });
    required<HTMLButtonElement>(this.dialog, '#achievement-sign-in').addEventListener('click', () => {
      this.setTab('profile');
      this.setAuthMode('login', true);
    }, { signal });
    required<HTMLButtonElement>(this.dialog, '#account-recovery-copy').addEventListener('click', () => {
      void this.copyRecoveryCode();
    }, { signal });
    required<HTMLButtonElement>(this.dialog, '#account-recovery-ack').addEventListener('click', () => {
      this.acknowledgeRecoveryCode();
    }, { signal });
    this.recoveryCodeInput.addEventListener('focus', () => this.recoveryCodeInput.select(), { signal });
  }

  private setTab(tab: AccountDialogTab, focus = false): void {
    this.activeTab = tab;
    for (const button of Array.from(this.dialog.querySelectorAll<HTMLButtonElement>('[data-account-tab]'))) {
      const selected = button.dataset.accountTab === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    }
    for (const panel of Array.from(this.dialog.querySelectorAll<HTMLElement>('[data-account-panel]'))) {
      panel.hidden = panel.dataset.accountPanel !== tab;
    }
    if (tab === 'rankings') this.updateRankingHint();
  }

  private setAuthMode(mode: AccountAuthMode, focus = false): void {
    this.activeAuthMode = mode;
    this.setAuthError(null);
    for (const button of Array.from(this.dialog.querySelectorAll<HTMLButtonElement>('[data-account-auth-mode]'))) {
      const selected = button.dataset.accountAuthMode === mode;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    for (const panel of Array.from(this.dialog.querySelectorAll<HTMLElement>('[data-account-auth-panel]'))) {
      panel.hidden = panel.dataset.accountAuthPanel !== mode;
    }
    if (focus) queueMicrotask(() => {
      this.dialog.querySelector<HTMLInputElement>(`[data-account-auth-panel="${mode}"] input`)?.focus();
    });
  }

  private validateHandle(handle: string): boolean {
    if (HANDLE_PATTERN.test(handle)
      && handle.length >= ACCOUNT_LIMITS.handleMin
      && handle.length <= ACCOUNT_LIMITS.handleMax) {
      this.setAuthError(null);
      return true;
    }
    this.setAuthError(t('account.error.invalidHandle'));
    return false;
  }

  private async runAction(action: () => MaybePromise, status: string, authError = false): Promise<void> {
    const epoch = ++this.actionEpoch;
    let failed = false;
    this.setAuthError(null);
    this.setBusy(true);
    this.setStatus(status);
    try {
      await action();
    } catch (error) {
      if (epoch !== this.actionEpoch) return;
      failed = true;
      const message = errorMessage(error);
      if (authError) this.setAuthError(message);
      this.setStatus(message);
    } finally {
      if (epoch !== this.actionEpoch) return;
      this.setBusy(false);
      if (failed) return;
      if (this.snapshot.status === 'authenticated') {
        this.setStatus(t('account.authenticatedStatus', { handle: this.snapshot.profile.handle }));
      } else if (this.snapshot.status === 'guest') {
        this.setStatus(t('account.guestStatus'));
      }
    }
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.dialog.toggleAttribute('aria-busy', busy);
    const controls = this.dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      '.account-auth-form input, .account-auth-form button, #account-logout, #account-import-legacy',
    );
    for (const control of Array.from(controls)) control.disabled = busy;
  }

  private renderProfile(profile: AccountProfile): void {
    const initials = profile.handle.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || 'BE';
    setText(required(this.dialog, '#account-profile-avatar'), initials);
    setText(required(this.dialog, '#account-profile-handle'), profile.handle);
    setText(required(this.dialog, '#account-profile-since'), t('account.joined', { date: formatDate(profile.createdAt) }));
    setText(required(this.dialog, '#account-profile-rank'), profile.globalRank ? `#${formatNumber(profile.globalRank)}` : '—');

    const trackRuns = profile.tracks.reduce((total, track) => total + Math.max(0, track.runs), 0);
    setText(required(this.dialog, '#account-stat-runs'), formatNumber(Math.max(profile.garage.runs, trackRuns)));
    setText(required(this.dialog, '#account-stat-finishes'), formatNumber(profile.totalFinishes));
    setText(required(this.dialog, '#account-stat-victories'), formatNumber(profile.victories));
    setText(required(this.dialog, '#account-stat-score'), formatNumber(profile.totalScore));
    setText(required(this.dialog, '#account-stat-speed'), `${formatNumber(profile.maxSpeed)} KM/H`);
    const unlocked = profile.achievements.filter((achievement) => achievement.unlockedAt !== null).length;
    setText(required(this.dialog, '#account-stat-achievements'), `${unlocked} / ${profile.achievements.length}`);
    setText(required(this.dialog, '#account-profile-credits'), formatNumber(profile.garage.credits));

    for (const module of ['engine', 'cooling', 'shield', 'weapon'] as const) {
      setText(required(this.dialog, `[data-account-garage-level="${module}"]`), `LV.${profile.garage[module]}`);
    }

    const progress = new Map(profile.tracks.map((track) => [track.trackId, track]));
    const routeList = required<HTMLElement>(this.dialog, '#account-route-best-list');
    routeList.replaceChildren(...TRACK_IDS.map((trackId) => {
      const track = progress.get(trackId);
      const score = track?.bestRankedScore ?? 0;
      const card = this.root.createElement('div');
      card.className = 'account-route-card';
      const name = this.root.createElement('strong');
      name.textContent = TRACKS[trackId].name.toUpperCase();
      const rank = this.root.createElement('small');
      rank.textContent = track?.rank
        ? t('account.routeRank', { rank: formatNumber(track.rank) })
        : t('account.routeUnranked');
      const value = this.root.createElement('b');
      value.textContent = score > 0 ? formatNumber(score) : t('account.noScore');
      card.append(name, rank, value);
      return card;
    }));

    const legacy = required<HTMLElement>(this.dialog, '.account-legacy');
    const importButton = required<HTMLButtonElement>(this.dialog, '#account-import-legacy');
    legacy.classList.toggle('is-imported', profile.legacyImported);
    importButton.disabled = profile.legacyImported || this.busy;
    setText(
      required(this.dialog, '#account-legacy-hint'),
      t(profile.legacyImported ? 'account.legacyImported' : 'account.legacyHint'),
    );
  }

  private renderAchievements(profile: AccountProfile | null): void {
    this.achievementGuest.hidden = profile !== null;
    this.achievementList.replaceChildren();
    if (!profile) {
      setText(required(this.dialog, '#achievement-summary'), t('achievement.guestSummary'));
      return;
    }

    const unlockedCount = profile.achievements.filter((achievement) => achievement.unlockedAt !== null).length;
    setText(
      required(this.dialog, '#achievement-summary'),
      t('achievement.summary', { unlocked: unlockedCount, total: profile.achievements.length }),
    );

    const cards = profile.achievements.map((achievement) => {
      const card = this.root.createElement('article');
      card.className = `account-achievement ${achievement.unlockedAt === null ? 'is-locked' : 'is-unlocked'}`;
      card.dataset.tone = achievement.tone;
      const trackName = achievement.trackId ? TRACKS[achievement.trackId].name : '';
      const values = { track: trackName };
      const name = t(`achievement.${achievement.id}.name` as TranslationKey, values);
      const description = t(`achievement.${achievement.id}.description` as TranslationKey, values);
      const progress = Math.max(0, achievement.progress);
      const target = Math.max(1, achievement.target);
      const ratio = Math.min(1, progress / target);
      card.style.setProperty('--achievement-progress', `${ratio * 100}%`);
      card.setAttribute('aria-label', `${name}. ${description}. ${t('achievement.progress', {
        progress: formatNumber(progress),
        target: formatNumber(target),
      })}`);

      const icon = this.root.createElement('span');
      icon.className = 'account-achievement__icon';
      icon.textContent = achievement.icon;
      icon.setAttribute('aria-hidden', 'true');
      const title = this.root.createElement('strong');
      title.textContent = name;
      const state = this.root.createElement('span');
      state.className = 'account-achievement__state';
      state.textContent = t(achievement.unlockedAt === null ? 'achievement.lockedState' : 'achievement.unlockedState');
      const copy = this.root.createElement('p');
      copy.textContent = description;
      const meter = this.root.createElement('span');
      meter.className = 'account-achievement__progress';
      meter.setAttribute('role', 'progressbar');
      meter.setAttribute('aria-valuemin', '0');
      meter.setAttribute('aria-valuemax', String(target));
      meter.setAttribute('aria-valuenow', String(Math.min(progress, target)));
      const fill = this.root.createElement('i');
      fill.setAttribute('aria-hidden', 'true');
      meter.append(fill);
      card.append(icon, title, state, copy, meter);
      return card;
    });
    this.achievementList.replaceChildren(...cards);
  }

  private renderLeaderboard(response: LeaderboardResponse): void {
    this.dialog.removeAttribute('aria-busy');
    this.leaderboardList.replaceChildren(...response.entries.map((entry) => this.createLeaderboardRow(entry)));
    const own = response.ownEntry;
    this.leaderboardOwnRank.hidden = !own;
    if (own) {
      setText(this.leaderboardOwnRank, t('leaderboard.ownRank', {
        rank: formatNumber(own.rank),
        score: formatNumber(own.score),
      }));
    }
    this.leaderboardStatus.hidden = response.entries.length > 0;
    setText(this.leaderboardStatus, response.entries.length > 0 ? '' : t('leaderboard.empty'));
    this.updateRankingHint();
  }

  private createLeaderboardRow(entry: LeaderboardEntry): HTMLElement {
    const row = this.root.createElement('div');
    row.className = `account-leaderboard__row${entry.isCurrentPlayer ? ' is-current' : ''}`;
    row.setAttribute('role', 'row');
    const cells: Array<[string, string]> = [
      ['account-leaderboard__rank', `#${formatNumber(entry.rank)}`],
      ['account-leaderboard__pilot', entry.handle],
      ['account-leaderboard__runs', formatNumber(entry.runs)],
      ['account-leaderboard__score', formatNumber(entry.score)],
      ['account-leaderboard__date', formatDate(entry.achievedAt)],
    ];
    for (const [className, value] of cells) {
      const cell = this.root.createElement('span');
      cell.className = className;
      cell.setAttribute('role', 'cell');
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }

  private async requestLeaderboard(): Promise<void> {
    const scope = this.getLeaderboardScope();
    this.setLeaderboardLoading(scope);
    if (!this.callbacks.onLoadLeaderboard) {
      const cached = this.leaderboardCache.get(scope);
      if (cached) this.setLeaderboard(cached);
      else {
        this.leaderboardState = { status: 'initial', message: null };
        this.dialog.removeAttribute('aria-busy');
        setText(this.leaderboardStatus, t('leaderboard.initial'));
      }
      return;
    }
    try {
      await this.callbacks.onLoadLeaderboard(scope);
    } catch (error) {
      this.setLeaderboardError(errorMessage(error));
    }
  }

  private updateRankingHint(): void {
    const key = this.getLeaderboardScope() === 'global' ? 'leaderboard.globalHint' : 'leaderboard.trackHint';
    setText(required(this.dialog, '.account-ranking-note'), t(key));
  }

  private async copyRecoveryCode(): Promise<void> {
    if (!this.recoveryCode) return;
    this.recoveryCodeInput.focus();
    this.recoveryCodeInput.select();
    this.recoveryCodeInput.setSelectionRange(0, this.recoveryCodeInput.value.length);
    try {
      if (this.root.defaultView?.navigator.clipboard) {
        await this.root.defaultView.navigator.clipboard.writeText(this.recoveryCode);
      } else {
        this.root.execCommand('copy');
      }
      this.setStatus(t('account.recoveryCopied'));
    } catch {
      // The selected readonly input remains copy-friendly when clipboard access
      // is blocked by a WebView or browser permission policy.
      this.setStatus(t('account.copyCode'));
    }
  }

  private acknowledgeRecoveryCode(): void {
    if (!this.recoveryCode) return;
    this.recoveryCode = null;
    this.recoveryCodeInput.value = '';
    this.recoveryShard.hidden = true;
    this.setStatus(t('account.recoveryDismissed'));
    this.callbacks.onRecoveryShardAcknowledged?.();
  }

  private clearSensitiveForms(): void {
    for (const input of Array.from(this.dialog.querySelectorAll<HTMLInputElement>('input[type="password"]'))) {
      input.value = '';
    }
    required<HTMLInputElement>(this.dialog, '#account-recover-code-input').value = '';
  }

  private notifyOpenChange(open: boolean): void {
    if (this.openNotified === open) return;
    this.openNotified = open;
    this.callbacks.onOpenChange?.(open);
  }
}
