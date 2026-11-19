import type { UiLanguage } from '../types';
import { en, type TranslationDictionary, type TranslationKey } from './en';
import { uk } from './uk';

const DICTIONARIES: Record<UiLanguage, TranslationDictionary> = {
	uk,
	en,
};

export function getTranslations(lang: UiLanguage): TranslationDictionary {
	return DICTIONARIES[lang] ?? uk;
}

export function t(lang: UiLanguage, key: TranslationKey): string {
	const dict = getTranslations(lang);
	return dict[key] ?? uk[key];
}

export type { TranslationDictionary, TranslationKey };
