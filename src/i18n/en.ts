import { uk } from './uk';

export type TranslationKey = keyof typeof uk;
export type TranslationDictionary = Record<TranslationKey, string>;

export const en: TranslationDictionary = {
	pluginName: 'LoreEngine AI',
	ribbonGreetTooltip: 'LoreEngine AI greeting',
	commandHelloName: 'Hello: check plugin status',
	helloNotice: 'Hello, world! LoreEngine AI is ready.',
	settingsHeadingGeneral: 'General settings',
	settingsLanguageName: 'Interface language',
	settingsLanguageDesc:
		'Choose the plugin interface language (Ukrainian by default).',
	settingsLanguageUk: 'Українська',
	settingsLanguageEn: 'English',
	settingsProviderName: 'LLM provider',
	settingsProviderDesc: 'Local Ollama is used by default.',
};
