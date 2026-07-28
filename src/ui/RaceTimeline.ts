import { clamp } from '../core/math';
import type { TimelineHazardKind, TrackTimeline } from '../game/timeline';

export interface RaceCourseMarker {
  readonly id: string;
  readonly kind: TimelineHazardKind;
  readonly startProgress: number;
  readonly endProgress: number;
  readonly strength: number;
  readonly count: number;
  readonly lane: number;
  readonly label: string;
}

interface RaceCourseMarkerView {
  readonly marker: RaceCourseMarker;
  readonly element: HTMLElement;
}

const MARKER_LANES = 3;
const MINIMUM_LANE_GAP = 0.022;

const HAZARD_LABELS: Record<TimelineHazardKind, string> = {
  gate: 'ворота',
  halfwall: 'полустена',
  blade: 'лопасти',
  cross: 'крестовина',
  bastion: 'бронебастион',
};

export function createRaceCourseMarkers(timeline: TrackTimeline): readonly Readonly<RaceCourseMarker>[] {
  const duration = Math.max(0.001, timeline.duration);
  const laneEnds = new Array<number>(MARKER_LANES).fill(Number.NEGATIVE_INFINITY);
  const markers: RaceCourseMarker[] = [];
  const patterns = timeline.patterns
    .filter((pattern) => pattern.category === 'hazard')
    .sort((left, right) => left.startTime - right.startTime || left.patternId - right.patternId);

  for (const pattern of patterns) {
    const startProgress = clamp(pattern.startTime / duration, 0, 1);
    const endProgress = clamp(pattern.endTime / duration, startProgress, 1);
    let lane = laneEnds.findIndex((lastProgress) => startProgress - lastProgress >= MINIMUM_LANE_GAP);
    if (lane < 0) {
      lane = laneEnds.reduce(
        (oldestLane, lastProgress, index) => lastProgress < laneEnds[oldestLane] ? index : oldestLane,
        0,
      );
    }
    laneEnds[lane] = endProgress;
    const countLabel = pattern.count > 1 ? `, серия из ${pattern.count}` : '';
    markers.push(Object.freeze({
      id: pattern.id,
      kind: pattern.kind as TimelineHazardKind,
      startProgress,
      endProgress,
      strength: clamp(pattern.strength, 0, 1),
      count: pattern.count,
      lane,
      label: `${HAZARD_LABELS[pattern.kind as TimelineHazardKind]}${countLabel}`,
    }));
  }

  return Object.freeze(markers);
}

export class RaceTimelineController {
  private readonly root: HTMLElement;
  private views: RaceCourseMarkerView[] = [];
  private lastProgress = 0;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  render(timeline: TrackTimeline): void {
    const markers = createRaceCourseMarkers(timeline);
    const fragment = document.createDocumentFragment();
    this.views = markers.map((marker) => {
      const element = document.createElement('i');
      element.className = 'race-course-marker';
      element.dataset.markerId = marker.id;
      element.dataset.kind = marker.kind;
      element.dataset.count = String(marker.count);
      element.dataset.state = 'upcoming';
      element.title = marker.label;
      element.style.setProperty('--course-position', `${marker.startProgress * 100}%`);
      element.style.setProperty('--course-span', `${Math.max(0, marker.endProgress - marker.startProgress) * 100}%`);
      element.style.setProperty('--marker-top', `${6 + marker.lane * 7}px`);
      element.style.setProperty('--marker-scale', (0.72 + marker.strength * 0.38).toFixed(3));
      element.style.setProperty('--marker-opacity', (0.48 + marker.strength * 0.5).toFixed(3));
      const span = document.createElement('b');
      span.className = 'race-course-marker__span';
      element.append(span);
      fragment.append(element);
      return { marker, element };
    });
    this.root.replaceChildren(fragment);
    this.root.dataset.count = String(markers.length);
    this.root.parentElement?.setAttribute(
      'aria-label',
      `Прогресс трассы и карта препятствий: ${markers.length}`,
    );
    this.lastProgress = 0;
    this.update(0);
  }

  update(progress: number): void {
    const safeProgress = clamp(progress, 0, 1);
    if (safeProgress + 0.0001 < this.lastProgress) {
      for (const view of this.views) view.element.dataset.state = 'upcoming';
    }
    let nextAssigned = false;
    for (const { marker, element } of this.views) {
      const state = safeProgress > marker.endProgress
        ? 'passed'
        : safeProgress >= marker.startProgress
          ? 'active'
          : !nextAssigned
            ? 'next'
            : 'upcoming';
      if (state === 'next') nextAssigned = true;
      if (element.dataset.state !== state) element.dataset.state = state;
    }
    this.root.parentElement?.setAttribute('aria-valuenow', String(Math.round(safeProgress * 100)));
    this.lastProgress = safeProgress;
  }

  clear(): void {
    this.views = [];
    this.root.replaceChildren();
    this.root.dataset.count = '0';
    this.lastProgress = 0;
  }
}
