import type { UiLanguage } from '../types';
import { en, type TranslationDictionary, type TranslationKey } from './en';
import { ru } from './ru';
import { uk } from './uk';

const DICTIONARIES: Record<UiLanguage, TranslationDictionary> = {
	uk,
	ru,
	en,
};

export function getTranslations(lang: UiLanguage): TranslationDictionary {
	return DICTIONARIES[lang] ?? uk;
}

export function t(lang: UiLanguage, key: TranslationKey): string {
	const dict = getTranslations(lang);
	return dict[key] ?? uk[key];
}

export function formatMessage(
	template: string,
	params: Record<string, string | number>,
): string {
	let result = template;
	for (const [key, value] of Object.entries(params)) {
		result = result.split(`{${key}}`).join(String(value));
	}
	return result;
}

export type { TranslationDictionary, TranslationKey };
