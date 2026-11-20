import type { TranslationDictionary } from './en';

export const ru: TranslationDictionary = {
	pluginName: 'LoreEngine AI',
	ribbonGreetTooltip: 'Приветствие LoreEngine AI',
	commandHelloName: 'Hello: проверить работу плагина',
	helloNotice: 'Hello, world! LoreEngine AI готов к работе.',
	settingsHeadingGeneral: 'Общие настройки',
	settingsLanguageName: 'Язык интерфейса',
	settingsLanguageDesc:
		'Выберите язык интерфейса плагина.',
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
		'Выберите папку с отчётами сессий через проводник или подсказки.',
	onboardingBrowseFolderBtn: 'Обзор...',
	folderPickerModalTitle: 'Выберите папку хранилища',
	folderPickerSearchPlaceholder: 'Фильтр папок...',
	folderPickerEmpty: 'Папки не найдены.',
	onboardingTypeMappingsName: 'Правила классификации сущностей',
	onboardingTypeMappingsDesc:
		'Сопоставьте папки или теги хранилища с классами сущностей (доступно автодополнение).',
	onboardingAddRuleBtn: '+ Добавить правило',
	onboardingRuleKindFolder: 'Папка',
	onboardingRuleKindTag: 'Тег',
	onboardingRuleFolderPlaceholder: 'Путь к папке (напр. World/NPC/)',
	onboardingRuleTagPlaceholder: 'Тег (напр. #npc)',
	onboardingRuleDeleteBtn: 'Удалить',
	onboardingActiveTagsName:
		'Значения тегов состояния ACTIVE (живой / активный / в процессе)',
	onboardingActiveTagsDesc:
		'Укажите только значимую часть тега (напр. живой, активный, в_процессе) без префикса #x/.',
	onboardingTerminatedTagsName:
		'Значения тегов состояния TERMINATED (погиб / завершено / разрушено)',
	onboardingTerminatedTagsDesc:
		'Укажите только значимую часть тега (напр. мертвый, погиб, разрушено, завершено).',
	onboardingInactiveTagsName:
		'Значения тегов состояния INACTIVE (пропал / не найдено / не начато)',
	onboardingInactiveTagsDesc:
		'Укажите только значимую часть тега (напр. не_найдено, зник, пропал) — сработает для любого #x/не_найдено.',
	onboardingTagInputPlaceholder:
		'Введите часть тега (напр. не_найдено) или выберите из подсказок',
	onboardingAddTagBtn: '+ Добавить',
	onboardingEditBulkBtn: 'Текст списком',
	noteBarTitle: 'LoreEngine',
	noteBarClassLabel: 'Класс:',
	noteBarStatusLabel: 'Статус:',
	noteBarNotePlaceholder: 'Примечание статуса...',
	noteBarAutoPrefix: 'Авто',
	noteBarSavedNotice: 'Обновлено в графе: {title} ({type} / {status})',
	commandToggleNoteBarName: 'Показать/скрыть панель класса и статуса заметки',
	ribbonToggleNoteBarTooltip: 'Панель класса и статуса заметки',
	settingsShowNoteBarName: 'Показывать панель класса и статуса в заметке',
	settingsShowNoteBarDesc:
		'Отображать компактную панель LoreEngine над текстом каждой открытой заметки.',
	onboardingSaveButton: 'Подтвердить и синхронизировать',
	onboardingCancelButton: 'Отмена',
	onboardingSavedNotice: 'Настройки сохранены, граф синхронизирован.',
	commandPingLlmName: 'Проверить LLM',
	pingModalTitle: 'Проверка подключения к LLM',
	pingProviderInfo: 'Провайдер: {provider} | Модель: {model}',
	pingEmbeddingInfo: 'Эмбеддинги: {provider} | Модель: {model}',
	pingPromptLabel: 'Тестовый запрос',
	pingDefaultPrompt:
		'Привет! Дай короткий ответ одним предложением для проверки связи с LoreEngine AI.',
	pingStartButton: 'Отправить',
	pingEmbeddingButton: 'Проверить эмбеддинги',
	pingAbortButton: 'Остановить',
	pingStatusIdle: 'Готово к проверке.',
	pingStatusStreaming: 'Получение потокового ответа...',
	pingStatusEmbedding: 'Проверка модели эмбеддингов...',
	pingStatusEmbeddingDone:
		'Эмбеддинги готовы: размерность вектора {dim} ({ms} мс).',
	pingEmbeddingUnsupported:
		'Выбранный провайдер эмбеддингов не поддерживает векторизацию.',
	pingStatusDone: 'Завершено. Токены (вход/вихід): {input} / {output}',
	pingStatusAborted: 'Генерация остановлена пользователем.',
	settingsHeadingLlm: 'Настройки LLM и эмбеддингов',
	settingsHeadingPrivacy: 'Приватность и облачные провайдеры',
	settingsHeadingVault: 'Структура хранилища',
	settingsPrivacyNotice:
		'По умолчанию плагин работает локально через Ollama. API-ключи хранятся открытым текстом в локальном файле data.json хранилища. Локальные логи трассировки (traces.jsonl) могут содержать фрагменты заметок.',
	settingsCloudConsentName: 'Согласие на передачу контекста облачным LLM',
	settingsCloudConsentDesc:
		'Разрешить отправку собранных фрагментов заметок и запросов в выбранный облачный API (OpenAI, Anthropic, Gemini).',
	settingsOllamaUrlName: 'URL локального сервера Ollama',
	settingsOllamaUrlDesc: 'По умолчанию: http://localhost:11434',
	settingsRefreshModelsBtn: 'Обновить список моделей Ollama',
	settingsModelsLoadedNotice: 'Найдено моделей Ollama: {count}',
	settingsModelName: 'Модель чата',
	settingsModelDesc:
		'Название модели для генерации ответов и извлечения событий (напр. llama3.1:8b, gpt-4o-mini, claude-3-5-sonnet-latest, gemini-2.5-flash).',
	settingsEmbeddingProviderName: 'Провайдер эмбеддингов',
	settingsEmbeddingProviderDesc:
		'Выберите провайдера векторных эмбеддингов.',
	settingsEmbeddingModelName: 'Модель эмбеддингов',
	settingsEmbeddingModelDesc:
		'Например: nomic-embed-text, text-embedding-3-small, text-embedding-004.',
	settingsApiKeyName: 'API-ключ',
	settingsApiKeyDesc:
		'Ключ доступа для выбранного облачного провайдера ({provider}).',
	settingsApiKeyOpenAiName: 'API-ключ OpenAI',
	settingsApiKeyAnthropicName: 'API-ключ Anthropic',
	settingsApiKeyGeminiName: 'API-ключ Google Gemini',
	settingsApiKeyPlaceholder: 'Введите ключ API...',
	settingsTestLlmName: 'Проверка связи с LLM',
	settingsTestLlmDesc:
		'Открыть окно тестового потокового запроса к текущему провайдеру.',
	settingsOpenOnboardingName: 'Мастер настройки хранилища',
	settingsOpenOnboardingDesc:
		'Повторно запустить автоопределение папок сессий, классов сущностей и тегов.',
	consentModalTitle: 'Согласие на использование облачного LLM-провайдера',
	consentModalBody:
		'Вы выбираете облачного провайдера ({provider}). При запросах плагин будет отправлять собранные фрагменты релевантных заметок вашего хранилища и текст запроса на серверы этого провайдера. Скрытой телеметрии нет. Вы можете в любой момент отозвать согласие в настройках.',
	consentAcceptButton: 'Дать согласие',
	consentDeclineButton: 'Оставить локальную Ollama',
	llmErrorCloudConsent:
		'Облачные вызовы заблокированы: дайте явное согласие на передачу контекста в настройках LoreEngine AI.',
	llmErrorAuth:
		'Ошибка авторизации ({provider}, HTTP {status}): проверьте правильность API-ключа в настройках.',
	llmErrorModelNotFound:
		'Модель «{model}» не найдена у провайдера {provider} (HTTP 404). Проверьте название модели.',
	llmErrorRateLimit:
		'Превышен лимит запросов ({provider}, HTTP 429). {retryHint}',
	llmErrorRetryAfter: 'Попробуйте повторить через {seconds} с.',
	llmErrorOllamaCors:
		'Не удалось подключиться к Ollama ({url}). Убедитесь, что сервер Ollama запущен, а при ошибке CORS задайте переменную окружения OLLAMA_ORIGINS=app://obsidian.md* перед запуском Ollama.',
	llmErrorNetwork:
		'Ошибка сети или CORS при обращении к {provider}: {details}',
	llmErrorContextLength:
		'Превышен максимальный размер контекстного окна модели ({provider}): {details}',
	llmErrorInvalidJson:
		'Провайдер {provider} вернул некорректный JSON: {details}',
	llmErrorGeneric: 'Ошибка провайдера {provider}: {details}',
};
