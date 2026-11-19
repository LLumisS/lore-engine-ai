import type { TranslationDictionary } from './en';

export const ru: TranslationDictionary = {
	pluginName: 'LoreEngine AI',
	ribbonGreetTooltip: 'Приветствие LoreEngine AI',
	commandHelloName: 'Hello: проверить работу плагина',
	helloNotice: 'Hello, world! LoreEngine AI готов к работе.',
	settingsHeadingGeneral: 'Общие настройки',
	settingsLanguageName: 'Язык интерфейса',
	settingsLanguageDesc:
		'Выберите язык интерфейса плагина (по умолчанию украинский).',
	settingsLanguageUk: 'Українська',
	settingsLanguageRu: 'Русский',
	settingsLanguageEn: 'English',
	settingsProviderName: 'Провайдер LLM',
	settingsProviderDesc: 'По умолчанию используется локальная Ollama.',
	commandSyncGraphName: 'Синхронизировать базу',
	commandGraphStatsName: 'Показать статистику графа',
	commandOnboardingName: 'Запустить мастер настройки хранилища',
	statusBarSynced: 'LoreEngine: синхронизировано',
	statusBarDirty: '⚡ LoreEngine: не синхронизировано ({count})',
	statusBarTooltip: 'Нажмите, чтобы синхронизировать граф LoreEngine AI',
	syncCompletedNotice:
		'Граф синхронизирован: узлов {nodes}, рёбер {edges} (обновлено: {updated}).',
	syncErrorNotice: 'Ошибка синхронизации графа: {error}',
	statsModalTitle: 'Статистика графа LoreEngine AI',
	statsTotalNodes: 'Всего узлов (заметок)',
	statsTotalEdges: 'Всего рёбер (связей)',
	statsDirtyNodes: 'Ожидают синхронизации (dirty)',
	statsByTypeHeading: 'Распределение по классам сущностей',
	statsByStatusHeading: 'Распределение по статическому состоянию',
	statsByEdgeKindHeading: 'Распределение рёбер по типу',
	statsSyncNowButton: '⚡ Синхронизировать базу',
	onboardingTitle: 'Мастер настройки LoreEngine AI',
	onboardingSubtitle:
		'Настройте папки сессий, классы сущностей и теги состояний для вашего хранилища.',
	onboardingAutoDetectBtn: 'Автоопределить структуру хранилища',
	onboardingAutoDetectedNotice: 'Структура хранилища проанализирована.',
	onboardingSessionFolderName: 'Папка логов сессий',
	onboardingSessionFolderDesc:
		'Путь к папке с отчётами сессий (например: Sessions, Сесії, Сессии).',
	onboardingTypeMappingsName: 'Правила классификации сущностей',
	onboardingTypeMappingsDesc:
		'По одному правилу на строку: folder:Путь=TYPE или tag:#тег=TYPE',
	onboardingTerminatedTagsName:
		'Теги состояния TERMINATED (погиб / завершено / разрушено)',
	onboardingTerminatedTagsDesc: 'Список тегов через запятую',
	onboardingInactiveTagsName:
		'Теги состояния INACTIVE (пропал / не начато)',
	onboardingInactiveTagsDesc: 'Список тегов через запятую',
	onboardingSaveButton: 'Подтвердить и синхронизировать',
	onboardingCancelButton: 'Отмена',
	onboardingSavedNotice: 'Настройки сохранены, граф синхронизирован.',
};
