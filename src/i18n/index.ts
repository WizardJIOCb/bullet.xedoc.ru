import type { AbilityId, TrackId, UpgradeId, WeaponId } from '../core/types';
import { en } from './locales/en';
import { ru } from './locales/ru';

export type Language = 'en' | 'ru';
export type TranslationKey = keyof typeof en;
export type TranslationValues = Readonly<Record<string, string | number>>;

const messages = { en, ru } as const;
let language: Language = 'en';

export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'ru';
}

export function getLanguage(): Language {
  return language;
}

export function getLocaleTag(): string {
  return language === 'ru' ? 'ru-RU' : 'en-US';
}

export function setLanguage(next: Language): void {
  language = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
}

export function t(key: TranslationKey, values: TranslationValues = {}): string {
  const template = messages[language][key] ?? en[key];
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (token, name: string) => (
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : token
  ));
}

export function applyDocumentTranslations(root: ParentNode = document): void {
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('[data-i18n]'))) {
    element.textContent = t(element.dataset.i18n as TranslationKey);
  }
  const translatedAttributes = [
    ['data-i18n-aria-label', 'aria-label'],
    ['data-i18n-title', 'title'],
    ['data-i18n-placeholder', 'placeholder'],
    ['data-i18n-content', 'content'],
  ] as const;
  for (const [dataAttribute, attribute] of translatedAttributes) {
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(`[${dataAttribute}]`))) {
      const key = element.getAttribute(dataAttribute) as TranslationKey | null;
      if (key) element.setAttribute(attribute, t(key));
    }
  }
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('[data-i18n-selected-label]'))) {
    const key = element.dataset.i18nSelectedLabel as TranslationKey;
    element.dataset.selectedLabel = t(key);
  }
  if (typeof document !== 'undefined') document.documentElement.lang = language;
}

export function trackDescription(id: TrackId): string {
  return t(`track.${id}.description` as TranslationKey);
}

export function weaponDescription(id: WeaponId): string {
  return t(`weapon.${id}.description` as TranslationKey);
}

export function abilityDescription(id: AbilityId): string {
  return t(`ability.${id}.description` as TranslationKey);
}

export function upgradeDescription(id: UpgradeId): string {
  return t(`upgrade.${id}.description` as TranslationKey);
}
