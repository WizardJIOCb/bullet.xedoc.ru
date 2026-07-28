import type { AudioEngine } from '../audio/AudioEngine';
import type { MusicProfile } from '../core/types';
import type {
  TimelinePatternMarker,
  TimelineTransitionMarker,
  TrackTimeline,
} from '../game/timeline';

type TimelineMarker = TimelinePatternMarker | TimelineTransitionMarker;
type TimelineMarkerLane = 'kick' | 'hit' | 'beat' | 'shift-hit' | 'reward' | 'transition';

interface TimelineSummary {
  kickCount: number;
  hitCount: number;
  transitionCount: number;
  hazardCount: number;
}

interface MusicPreviewCallbacks {
  onMusicVolumeInput: (volume: number) => void;
  onMusicVolumeCommit: (volume: number) => void;
}

const KIND_LABELS: Record<TimelinePatternMarker['kind'], string> = {
  gate: 'ВОРОТА',
  halfwall: 'ПОЛУСТЕНА',
  blade: 'ЛОПАСТИ',
  cross: 'КРЕСТОВИНЫ',
  bastion: 'БРОНЕБАСТИОН',
  boost: 'УСКОРИТЕЛЬ',
  coolant: 'ОХЛАЖДЕНИЕ',
};

const TRANSITION_LABELS: Record<TimelineTransitionMarker['kind'], string> = {
  build: 'BUILD',
  drop: 'DROP',
  break: 'BREAK',
  fill: 'FILL',
};

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing music preview element: ${selector}`);
  return element;
}

function formatTime(seconds: number, precise = false): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  if (precise) return `${minutes.toString().padStart(2, '0')}:${remainder.toFixed(2).padStart(5, '0')}`;
  return `${minutes.toString().padStart(2, '0')}:${Math.floor(remainder).toString().padStart(2, '0')}`;
}

function markerTime(marker: TimelineMarker): number {
  return marker.musicTime;
}

function markerLane(marker: TimelineMarker): TimelineMarkerLane {
  if (marker.type === 'transition') return 'transition';
  if (marker.category === 'reward') return 'reward';
  if (
    marker.cue === 'transition'
    || marker.trigger === 'build'
    || marker.trigger === 'drop'
    || marker.trigger === 'break'
    || marker.trigger === 'fill'
  ) return 'shift-hit';
  if (marker.cue === 'kick' || marker.trigger === 'kick') return 'kick';
  if (marker.cue === 'transient' || marker.trigger === 'transient') return 'hit';
  return 'beat';
}

function timelineSummary(timeline: TrackTimeline): TimelineSummary {
  let kickCount = 0;
  let hitCount = 0;
  let hazardCount = 0;
  for (const marker of timeline.patterns) {
    if (marker.category === 'hazard') hazardCount += marker.count;
    if (marker.cue === 'kick' || marker.trigger === 'kick') kickCount += marker.count;
    if (marker.cue === 'transient' || marker.trigger === 'transient') hitCount += marker.count;
  }
  return {
    kickCount,
    hitCount,
    transitionCount: timeline.transitions.length,
    hazardCount,
  };
}

export class MusicPreviewController {
  private readonly playButton: HTMLButtonElement;
  private readonly currentOutput: HTMLElement;
  private readonly durationOutput: HTMLElement;
  private readonly bpmOutput: HTMLOutputElement;
  private readonly volumeInput: HTMLInputElement;
  private readonly volumeOutput: HTMLOutputElement;
  private readonly courseOutput: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly markerLayer: HTMLElement;
  private readonly playhead: HTMLElement;
  private readonly seek: HTMLInputElement;
  private readonly detail: HTMLElement;
  private readonly status: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private dprQuery: MediaQueryList | null = null;
  private timeline: TrackTimeline | null = null;
  private markerButtons: HTMLButtonElement[] = [];
  private animationFrame = 0;
  private scrubbing = false;
  private resumeAfterScrub = false;
  private loading = false;

  constructor(
    private readonly audio: AudioEngine,
    private readonly root: HTMLElement,
    private readonly callbacks: MusicPreviewCallbacks,
  ) {
    this.playButton = required(root, '#music-preview-play');
    this.currentOutput = required(root, '#music-preview-current');
    this.durationOutput = required(root, '#music-preview-duration');
    this.bpmOutput = required(root, '#music-preview-bpm');
    this.volumeInput = required(root, '#music-preview-volume');
    this.volumeOutput = required(root, '#music-preview-volume-value');
    this.courseOutput = required(root, '#music-preview-course');
    this.canvas = required(root, '#music-preview-waveform');
    this.markerLayer = required(root, '#music-preview-markers');
    this.playhead = required(root, '#music-preview-playhead');
    this.seek = required(root, '#music-preview-seek');
    this.detail = required(root, '#music-preview-detail');
    this.status = required(root, '#music-preview-status');
    this.resizeObserver = new ResizeObserver(this.handleResize);
    this.resizeObserver.observe(this.canvas);
    this.watchDevicePixelRatio();

    this.playButton.addEventListener('click', this.togglePlayback);
    this.seek.addEventListener('pointerdown', this.beginScrub);
    this.seek.addEventListener('pointerup', this.finishScrub);
    this.seek.addEventListener('pointercancel', this.finishScrub);
    this.seek.addEventListener('input', this.handleSeek);
    this.volumeInput.addEventListener('input', this.handleVolumeInput);
    this.volumeInput.addEventListener('change', this.handleVolumeCommit);
    this.markerLayer.addEventListener('keydown', this.handleMarkerKeys);
    window.addEventListener('resize', this.handleResize);
  }

  setLoading(loading: boolean): void {
    this.loading = loading;
    this.root.setAttribute('aria-busy', String(loading));
    this.playButton.disabled = loading;
    this.seek.disabled = loading;
    if (loading) {
      this.audio.stopPreview();
      this.stopAnimation();
      this.setTransportUi(0, false);
      this.status.textContent = 'Анализируем музыку и строим карту трассы.';
    }
  }

  render(timeline: TrackTimeline, profile: MusicProfile, trackName: string): void {
    this.timeline = timeline;
    const playback = this.audio.getPreviewPlaybackState();
    const summary = timelineSummary(timeline);
    const seed = (timeline.planSeed >>> 0).toString(16).padStart(8, '0').toUpperCase();
    this.root.hidden = !playback.available;
    this.root.setAttribute('aria-busy', 'false');
    this.playButton.disabled = !playback.available || this.loading;
    this.seek.disabled = !playback.available || this.loading;
    this.seek.max = String(timeline.duration);
    this.durationOutput.textContent = formatTime(timeline.duration);
    this.bpmOutput.value = `${timeline.bpm} BPM`;
    this.courseOutput.textContent = `${timeline.patterns.length}P // K${summary.kickCount} · H${summary.hitCount} · T${summary.transitionCount}`;
    this.courseOutput.title = `${trackName.toUpperCase()} // ${seed} // ${profile.title}: ${summary.hazardCount} препятствий, ${summary.kickCount} под кик, ${summary.hitCount} под удар, ${summary.transitionCount} музыкальных переходов`;
    this.status.textContent = `Карта трассы для ${profile.title} готова: ${timeline.patterns.length} паттернов и ${summary.hazardCount} препятствий; под кик — ${summary.kickCount}, под удар — ${summary.hitCount}, музыкальных переходов — ${summary.transitionCount}; длительность ${formatTime(timeline.duration)}.`;
    this.detail.textContent = `COURSE ${formatTime(timeline.duration)} / TRACK ${formatTime(profile.duration)} · выберите препятствие`;
    this.renderMarkers();
    this.setTransportUi(playback.currentTime, playback.playing);
    requestAnimationFrame(() => this.drawTimeline());
    if (playback.playing) this.startAnimation();
  }

  stop(reset = true): void {
    this.audio.stopPreview(reset);
    this.stopAnimation();
    this.setTransportUi(this.audio.getPreviewPlaybackState().currentTime, false);
  }

  setMusicVolume(volume: number, silent = false): void {
    const safeVolume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0;
    const percent = Math.round(safeVolume * 100);
    this.volumeInput.value = String(percent);
    this.volumeInput.style.setProperty('--volume-level', `${percent}%`);
    this.volumeInput.setAttribute('aria-valuetext', `${percent} процентов`);
    this.volumeOutput.value = `${percent}%`;
    this.root.classList.toggle('has-silent-music', silent || percent === 0);
  }

  dispose(): void {
    this.stop();
    this.playButton.removeEventListener('click', this.togglePlayback);
    this.seek.removeEventListener('pointerdown', this.beginScrub);
    this.seek.removeEventListener('pointerup', this.finishScrub);
    this.seek.removeEventListener('pointercancel', this.finishScrub);
    this.seek.removeEventListener('input', this.handleSeek);
    this.volumeInput.removeEventListener('input', this.handleVolumeInput);
    this.volumeInput.removeEventListener('change', this.handleVolumeCommit);
    this.markerLayer.removeEventListener('keydown', this.handleMarkerKeys);
    window.removeEventListener('resize', this.handleResize);
    this.resizeObserver.disconnect();
    this.dprQuery?.removeEventListener('change', this.handleDprChange);
  }

  private togglePlayback = async (): Promise<void> => {
    if (this.loading) return;
    const state = this.audio.getPreviewPlaybackState();
    if (!state.available) return;
    if (state.playing) {
      this.audio.pausePreview();
      this.stopAnimation();
      this.setTransportUi(this.audio.getPreviewPlaybackState().currentTime, false);
      return;
    }
    try {
      await this.audio.playPreview();
      const next = this.audio.getPreviewPlaybackState();
      this.setTransportUi(next.currentTime, next.playing);
      if (next.playing) this.startAnimation();
    } catch (error) {
      console.error(error);
      this.status.textContent = 'Браузер не разрешил воспроизведение. Нажмите Play ещё раз.';
    }
  };

  private beginScrub = (event: PointerEvent): void => {
    const state = this.audio.getPreviewPlaybackState();
    this.scrubbing = true;
    this.resumeAfterScrub = state.playing;
    this.seek.setPointerCapture(event.pointerId);
    if (state.playing) this.audio.pausePreview();
  };

  private finishScrub = (event: PointerEvent): void => {
    if (!this.scrubbing) return;
    if (this.seek.hasPointerCapture(event.pointerId)) this.seek.releasePointerCapture(event.pointerId);
    this.scrubbing = false;
    if (this.resumeAfterScrub) {
      this.resumeAfterScrub = false;
      void this.audio.playPreview().then(() => this.startAnimation()).catch((error) => {
        console.error(error);
        this.status.textContent = 'Не удалось продолжить предпрослушивание.';
      });
    }
  };

  private handleSeek = (): void => {
    const value = Number(this.seek.value);
    this.audio.seekPreview(value);
    this.setTransportUi(value, this.audio.getPreviewPlaybackState().playing);
  };

  private handleVolumeInput = (): void => {
    this.callbacks.onMusicVolumeInput(Number(this.volumeInput.value) / 100);
  };

  private handleVolumeCommit = (): void => {
    this.callbacks.onMusicVolumeCommit(Number(this.volumeInput.value) / 100);
  };

  private handleMarkerKeys = (event: KeyboardEvent): void => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('.music-preview__marker');
    if (!target || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = this.markerButtons.indexOf(target);
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? this.markerButtons.length - 1
        : (current + (event.key === 'ArrowLeft' ? -1 : 1) + this.markerButtons.length) % this.markerButtons.length;
    for (const [index, button] of this.markerButtons.entries()) button.tabIndex = index === next ? 0 : -1;
    this.markerButtons[next]?.focus();
  };

  private renderMarkers(): void {
    if (!this.timeline) return;
    this.markerLayer.replaceChildren();
    const duration = Math.max(0.001, this.timeline.duration);
    const markers: TimelineMarker[] = [...this.timeline.patterns, ...this.timeline.transitions]
      .sort((left, right) => markerTime(left) - markerTime(right) || left.id.localeCompare(right.id));
    this.markerButtons = markers.map((marker, index) => {
      const button = document.createElement('button');
      const position = (markerTime(marker) / duration) * 100;
      const strength = Math.max(0, Math.min(1, marker.strength));
      button.type = 'button';
      button.className = 'music-preview__marker';
      button.dataset.markerId = marker.id;
      button.dataset.lane = markerLane(marker);
      button.style.setProperty('--marker-position', `${position}%`);
      button.style.setProperty('--marker-opacity', (0.42 + strength * 0.58).toFixed(3));
      button.style.setProperty('--marker-scale', (0.76 + strength * 0.48).toFixed(3));
      button.tabIndex = index === 0 ? 0 : -1;
      if (marker.type === 'pattern') {
        button.dataset.kind = marker.kind;
        button.dataset.cue = marker.cue;
        button.dataset.trigger = marker.trigger;
        button.setAttribute('aria-label', this.patternAriaLabel(marker));
        button.title = this.patternDetail(marker);
      } else {
        button.dataset.kind = 'transition';
        button.dataset.transition = marker.kind;
        button.setAttribute('aria-label', `${formatTime(marker.musicTime, true)}, музыкальный переход ${TRANSITION_LABELS[marker.kind]}`);
        button.title = `${formatTime(marker.musicTime, true)} · ${TRANSITION_LABELS[marker.kind]} · сила ${Math.round(marker.strength * 100)}%`;
      }
      button.addEventListener('click', () => this.selectMarker(marker, button));
      this.markerLayer.append(button);
      return button;
    });
  }

  private selectMarker(marker: TimelineMarker, button: HTMLButtonElement): void {
    for (const candidate of this.markerButtons) {
      const selected = candidate === button;
      candidate.classList.toggle('is-selected', selected);
      candidate.tabIndex = selected ? 0 : -1;
    }
    this.audio.seekPreview(markerTime(marker));
    this.setTransportUi(markerTime(marker), this.audio.getPreviewPlaybackState().playing);
    const text = marker.type === 'pattern' ? this.patternDetail(marker) : button.title;
    this.detail.textContent = text;
    this.status.textContent = `Выбрано: ${text}`;
  }

  private patternDetail(marker: TimelinePatternMarker): string {
    const label = KIND_LABELS[marker.kind];
    const pattern = marker.count > 1 ? ` · ПАТТЕРН ×${marker.count}` : '';
    const reason = this.markerReason(marker);
    const times = marker.eventTimes.map((time) => formatTime(time, true)).join(' / ');
    return `${times} · ${label}${pattern} · ${reason} ${Math.round(marker.strength * 100)}%`;
  }

  private patternAriaLabel(marker: TimelinePatternMarker): string {
    const count = marker.count > 1 ? `, объектов ${marker.count}` : '';
    const times = marker.eventTimes.map((time) => formatTime(time, true)).join(', ');
    return `${KIND_LABELS[marker.kind]}${count}, время ${times}, ${this.markerReason(marker)}`;
  }

  private markerReason(marker: TimelinePatternMarker): string {
    if (marker.trigger === 'build' || marker.trigger === 'drop' || marker.trigger === 'break' || marker.trigger === 'fill') {
      return TRANSITION_LABELS[marker.trigger];
    }
    if (marker.trigger === 'kick') return 'KICK';
    if (marker.trigger === 'transient') return 'TRANSIENT';
    if (marker.trigger === 'transition') return 'TRANSITION';
    return marker.strength >= 0.74 ? 'PEAK' : 'BEAT';
  }

  private setTransportUi(time: number, playing: boolean): void {
    const duration = this.timeline?.duration ?? this.audio.getPreviewPlaybackState().duration;
    const safeTime = Math.max(0, Math.min(duration, time));
    const progress = duration > 0 ? safeTime / duration : 0;
    if (!this.scrubbing) this.seek.value = String(safeTime);
    this.currentOutput.textContent = formatTime(safeTime);
    this.seek.setAttribute('aria-valuetext', `${formatTime(safeTime)} из ${formatTime(duration)}`);
    this.playhead.style.setProperty('--playhead-position', `${progress * 100}%`);
    this.playButton.setAttribute('aria-pressed', String(playing));
    this.playButton.setAttribute('aria-label', playing ? 'Приостановить предпросмотр музыки' : 'Воспроизвести предпросмотр музыки');
  }

  private startAnimation(): void {
    if (this.animationFrame) return;
    const frame = (): void => {
      const state = this.audio.getPreviewPlaybackState();
      this.setTransportUi(state.currentTime, state.playing);
      if (state.playing) this.animationFrame = requestAnimationFrame(frame);
      else this.animationFrame = 0;
    };
    this.animationFrame = requestAnimationFrame(frame);
  }

  private stopAnimation(): void {
    if (!this.animationFrame) return;
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
  }

  private drawTimeline(): void {
    if (!this.timeline || this.root.hidden) return;
    const bounds = this.canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(bounds.width * scale);
    this.canvas.height = Math.round(bounds.height * scale);
    const context = this.canvas.getContext('2d');
    if (!context) return;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, bounds.width, bounds.height);

    const samples = this.timeline.samples;
    if (samples.length > 1) {
      const middle = bounds.height * 0.47;
      const gradient = context.createLinearGradient(0, 0, bounds.width, 0);
      gradient.addColorStop(0, 'rgba(58, 245, 255, 0.16)');
      gradient.addColorStop(0.55, 'rgba(91, 221, 255, 0.42)');
      gradient.addColorStop(1, 'rgba(178, 92, 255, 0.32)');
      context.beginPath();
      context.moveTo(0, middle);
      for (let index = 0; index < samples.length; index += 1) {
        const x = (index / (samples.length - 1)) * bounds.width;
        const amplitude = samples[index].energy * bounds.height * 0.43;
        context.lineTo(x, middle - amplitude);
      }
      for (let index = samples.length - 1; index >= 0; index -= 1) {
        const x = (index / (samples.length - 1)) * bounds.width;
        const amplitude = samples[index].energy * bounds.height * 0.43;
        context.lineTo(x, middle + amplitude);
      }
      context.closePath();
      context.fillStyle = gradient;
      context.fill();

      context.beginPath();
      for (let index = 0; index < samples.length; index += 1) {
        const x = (index / (samples.length - 1)) * bounds.width;
        const y = bounds.height - 2 - samples[index].bass * bounds.height * 0.18;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.strokeStyle = 'rgba(83, 255, 211, 0.68)';
      context.lineWidth = 1;
      context.stroke();
    }

    for (let index = 0; index < this.timeline.samples.length; index += 1) {
      const sample = this.timeline.samples[index];
      const accent = Math.max(sample.onset, sample.kick, sample.transient);
      const previousAccent = index > 0
        ? Math.max(
          this.timeline.samples[index - 1].onset,
          this.timeline.samples[index - 1].kick,
          this.timeline.samples[index - 1].transient,
        )
        : 0;
      const nextAccent = index + 1 < this.timeline.samples.length
        ? Math.max(
          this.timeline.samples[index + 1].onset,
          this.timeline.samples[index + 1].kick,
          this.timeline.samples[index + 1].transient,
        )
        : 0;
      if (accent < 0.28 || accent < previousAccent || accent <= nextAccent) continue;
      const x = (sample.musicTime / this.timeline.duration) * bounds.width;
      const height = (0.025 + accent * 0.145) * bounds.height;
      const kickDominant = sample.kick >= sample.transient;
      context.beginPath();
      context.moveTo(x, bounds.height - 2);
      context.lineTo(x, bounds.height - 2 - height);
      context.strokeStyle = kickDominant
        ? `rgba(255, 212, 94, ${0.18 + accent * 0.42})`
        : `rgba(187, 111, 255, ${0.16 + accent * 0.4})`;
      context.lineWidth = accent > 0.78 ? 1.4 : 1;
      context.stroke();
    }

    for (const beat of this.timeline.downbeats) {
      const x = (beat.musicTime / this.timeline.duration) * bounds.width;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, bounds.height);
      context.strokeStyle = `rgba(106, 239, 255, ${0.1 + beat.strength * 0.18})`;
      context.lineWidth = 1;
      context.stroke();
    }
  }

  private handleResize = (): void => {
    if (!this.root.hidden) this.drawTimeline();
  };

  private handleDprChange = (): void => {
    this.watchDevicePixelRatio();
    this.handleResize();
  };

  private watchDevicePixelRatio(): void {
    this.dprQuery?.removeEventListener('change', this.handleDprChange);
    this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.dprQuery.addEventListener('change', this.handleDprChange, { once: true });
  }
}
