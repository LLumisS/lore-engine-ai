export const uk = {
	pluginName: 'LoreEngine AI',
	ribbonGreetTooltip: 'Привітання LoreEngine AI',
	commandHelloName: 'Hello: перевірити роботу плагіна',
	helloNotice: 'Hello, world! LoreEngine AI готовий до роботи.',
	settingsHeadingGeneral: 'Загальні налаштування',
	settingsLanguageName: 'Мова інтерфейсу',
	settingsLanguageDesc:
		'Оберіть мову інтерфейсу плагіна (українська за замовчуванням).',
	settingsLanguageUk: 'Українська',
	settingsLanguageRu: 'Русский',
	settingsLanguageEn: 'English',
	settingsProviderName: 'Провайдер LLM',
	settingsProviderDesc: 'За замовчуванням використовується локальна Ollama.',
	commandSyncGraphName: 'Синхронізувати базу',
	commandGraphStatsName: 'Показати статистику графа',
	commandOnboardingName: 'Запустити майстер налаштування сховища',
	statusBarSynced: 'LoreEngine: синхронізовано',
	statusBarDirty: '⚡ LoreEngine: несинхронізовано ({count})',
	statusBarTooltip: 'Натисніть, щоб синхронізувати граф LoreEngine AI',
	syncCompletedNotice:
		'Граф синхронізовано: вузлів {nodes}, ребер {edges} (оновлено: {updated}).',
	syncErrorNotice: 'Помилка синхронізації графа: {error}',
	statsModalTitle: 'Статистика графа LoreEngine AI',
	statsTotalNodes: 'Усього вузлів (нотаток)',
	statsTotalEdges: 'Усього ребер (зв’язків)',
	statsDirtyNodes: 'Очікують синхронізації (dirty)',
	statsByTypeHeading: 'Розподіл за класами сутностей',
	statsByStatusHeading: 'Розподіл за статичним станом',
	statsByEdgeKindHeading: 'Розподіл ребер за типом',
	statsSyncNowButton: '⚡ Синхронізувати базу',
	onboardingTitle: 'Майстер налаштування LoreEngine AI',
	onboardingSubtitle:
		'Налаштуйте папки сесій, класи сутностей та теги станів для вашого сховища.',
	onboardingAutoDetectBtn: 'Автовизначити структуру сховища',
	onboardingAutoDetectedNotice: 'Структуру сховища проаналізовано.',
	onboardingSessionFolderName: 'Папка логів сесій',
	onboardingSessionFolderDesc:
		'Шлях до папки зі звітами сесій (наприклад: Sessions, Сесії, Сессии).',
	onboardingTypeMappingsName: 'Правила класифікації сутностей',
	onboardingTypeMappingsDesc:
		'По одному правилу на рядок: folder:Шлях=TYPE або tag:#тег=TYPE',
	onboardingTerminatedTagsName:
		'Теги стану TERMINATED (загинув / завершено / зруйновано)',
	onboardingTerminatedTagsDesc: 'Перелік тегів через кому',
	onboardingInactiveTagsName: 'Теги стану INACTIVE (зник / не розпочато)',
	onboardingInactiveTagsDesc: 'Перелік тегів через кому',
	onboardingSaveButton: 'Підтвердити та синхронізувати',
	onboardingCancelButton: 'Скасувати',
	onboardingSavedNotice: 'Налаштування збережено, граф синхронізовано.',
	commandPingLlmName: 'Перевірити LLM',
	pingModalTitle: 'Перевірка підключення до LLM',
	pingProviderInfo: 'Провайдер: {provider} | Модель: {model}',
	pingEmbeddingInfo: 'Ембедінги: {provider} | Модель: {model}',
	pingPromptLabel: 'Тестовий запит',
	pingDefaultPrompt:
		'Привіт! Дай коротку відповідь одним реченням для перевірки зв’язку з LoreEngine AI.',
	pingStartButton: 'Надіслати (стримінг)',
	pingEmbeddingButton: 'Перевірити ембедінги',
	pingAbortButton: 'Зупинити',
	pingStatusIdle: 'Готово до перевірки.',
	pingStatusStreaming: 'Отримання потокової відповіді...',
	pingStatusEmbedding: 'Перевірка моделі ембедінгів...',
	pingStatusEmbeddingDone:
		'Ембедінги готові: розмірність вектора {dim} ({ms} мс).',
	pingEmbeddingUnsupported:
		'Обраний провайдер ембедінгів не підтримує векторизацію.',
	pingStatusDone: 'Завершено. Токени (вхід/вихід): {input} / {output}',
	pingStatusAborted: 'Генерацію зупинено користувачем.',
	settingsHeadingLlm: 'Налаштування LLM та ембедінгів',
	settingsHeadingPrivacy: 'Приватність та хмарні провайдери',
	settingsHeadingVault: 'Структура сховища',
	settingsPrivacyNotice:
		'За замовчуванням плагін працює локально через Ollama. API-ключі зберігаються відкритим текстом у локальному файлі data.json сховища. Локальні логи трасування (traces.jsonl) можуть містити фрагменти нотаток.',
	settingsCloudConsentName: 'Згода на передачу контексту хмарним LLM',
	settingsCloudConsentDesc:
		'Дозволити відправку зібраних фрагментів нотаток і запитів до обраного хмарного API (OpenAI, Anthropic, Gemini).',
	settingsOllamaUrlName: 'URL локального сервера Ollama',
	settingsOllamaUrlDesc: 'За замовчуванням: http://localhost:11434',
	settingsRefreshModelsBtn: 'Оновити список моделей Ollama',
	settingsModelsLoadedNotice: 'Знайдено моделей Ollama: {count}',
	settingsModelName: 'Модель чату',
	settingsModelDesc:
		'Назва моделі для генерації відповідей та витягнення подій (напр. llama3.1:8b, gpt-4o-mini, claude-3-5-sonnet-latest, gemini-2.5-flash).',
	settingsEmbeddingProviderName: 'Провайдер ембедінгів',
	settingsEmbeddingProviderDesc:
		'Оберіть провайдера векторних ембедінгів.',
	settingsEmbeddingModelName: 'Модель ембедінгів',
	settingsEmbeddingModelDesc:
		'Наприклад: nomic-embed-text, text-embedding-3-small, text-embedding-004.',
	settingsApiKeyName: 'API-ключ',
	settingsApiKeyDesc:
		'Ключ доступу для обраного хмарного провайдера ({provider}).',
	settingsApiKeyOpenAiName: 'API-ключ OpenAI',
	settingsApiKeyAnthropicName: 'API-ключ Anthropic',
	settingsApiKeyGeminiName: 'API-ключ Google Gemini',
	settingsApiKeyPlaceholder: 'Введіть ключ API...',
	settingsTestLlmName: 'Перевірка зв’язку з LLM',
	settingsTestLlmDesc:
		'Відкрити вікно тестового потокового запиту до поточного провайдера.',
	settingsOpenOnboardingName: 'Майстер налаштування сховища',
	settingsOpenOnboardingDesc:
		'Повторно запустити автовизначення папок сесій, класів сутностей і тегів.',
	consentModalTitle: 'Згода на використання хмарного LLM-провайдера',
	consentModalBody:
		'Ви обираєте хмарного провайдера ({provider}). Під час запитів плагін відправлятиме зібрані фрагменти релевантних нотаток вашого сховища та текст запиту на сервери цього провайдера. Жодної прихованої телеметрії немає. Ви можете будь-коли відкликати згоду в налаштуваннях.',
	consentAcceptButton: 'Надати згоду',
	consentDeclineButton: 'Залишити локальну Ollama',
	llmErrorCloudConsent:
		'Хмарні виклики заблоковано: надайте явну згоду на передачу контексту в налаштуваннях LoreEngine AI.',
	llmErrorAuth:
		'Помилка авторизації ({provider}, HTTP {status}): перевірте правильність API-ключа в налаштуваннях.',
	llmErrorModelNotFound:
		'Модель «{model}» не знайдено у провайдера {provider} (HTTP 404). Перевірте назву моделі.',
	llmErrorRateLimit:
		'Перевищено ліміт запитів ({provider}, HTTP 429). {retryHint}',
	llmErrorRetryAfter: 'Спробуйте повторити через {seconds} с.',
	llmErrorOllamaCors:
		'Не вдалося підключитися до Ollama ({url}). Переконайтеся, що сервер Ollama запущено, а при помилці CORS задайте змінну середовища OLLAMA_ORIGINS=app://obsidian.md* перед запуском Ollama.',
	llmErrorNetwork:
		'Помилка мережі або CORS під час звернення до {provider}: {details}',
	llmErrorContextLength:
		'Перевищено максимальний розмір контекстного вікна моделі ({provider}): {details}',
	llmErrorInvalidJson:
		'Провайдер {provider} повернув некоректний JSON: {details}',
	llmErrorGeneric: 'Помилка провайдера {provider}: {details}',
} as const;
