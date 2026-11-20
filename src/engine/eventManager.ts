import { normalizePath, type App, type TFile } from 'obsidian';
import { resolveSubjects } from '../core/entityMatcher';
import { normalizeText } from '../core/statusRules';
import { estimateTokens } from '../core/tokenizer';
import type { ILlmProvider, LlmChatMessage } from '../llm/llmProvider';
import { getSessionExtractionSystemPrompt } from '../llm/prompts';
import { formatLlmError, isAbortError } from '../llm/streaming';
import type {
	GraphNode,
	PluginSettings,
	SessionEvent,
	StateChange,
	StatusType,
	UiLanguage,
} from '../types';

export const EVENTS_SCHEMA_VERSION = 1;
const MAX_LLM_RETRIES = 2;
const MAX_ENTITY_HINTS = 120;
const MAX_CHUNK_TOKENS = 2200;

const VALID_STATUS_TYPES = new Set<StatusType>([
	'ACTIVE',
	'INACTIVE',
	'TERMINATED',
	'UNKNOWN',
]);

const EXTRACTION_PROMPT_LABELS: Record<
	UiLanguage,
	{
		aliasesLabel: string;
		entityHintsHeader: string;
		sectionHeader: string;
		invalidJsonRetry: (error: string) => string;
	}
> = {
	uk: {
		aliasesLabel: 'аліаси',
		entityHintsHeader:
			'ВІДОМІ СУТНОСТІ КАМПАНІЇ (використовуй ці канонічні імена в називному відмінку):',
		sectionHeader: 'ТЕКСТ СЕКЦІЇ ЛОГУ СЕСІЇ',
		invalidJsonRetry: (error) =>
			`Твоя відповідь не пройшла валідацію JSON-схеми: ${error}. Поверни ТІЛЬКИ валідний JSON-масив за заданою схемою без пояснень.`,
	},
	ru: {
		aliasesLabel: 'алиасы',
		entityHintsHeader:
			'ИЗВЕСТНЫЕ СУЩНОСТИ КАМПАНИИ (используй эти каноніческие имена в именительном падеже):',
		sectionHeader: 'ТЕКСТ СЕКЦИИ ЛОГА СЕССИИ',
		invalidJsonRetry: (error) =>
			`Твой ответ не прошёл валидацию JSON-схемы: ${error}. Верни ТОЛЬКО валидный JSON-массив по заданной схеме без пояснений.`,
	},
	en: {
		aliasesLabel: 'aliases',
		entityHintsHeader:
			'KNOWN CAMPAIGN ENTITIES (use these canonical names):',
		sectionHeader: 'SESSION LOG SECTION TEXT',
		invalidJsonRetry: (error) =>
			`Your response failed JSON schema validation: ${error}. Return ONLY a valid JSON array matching the schema with no extra explanation.`,
	},
};

export interface RawExtractedEvent {
	subjects: string[];
	action: string;
	details: string;
	stateChanges: StateChange[];
}

export interface PersistedEntityStateOverride {
	statusType: StatusType;
	statusNote: string;
	updatedAt: number;
}

export interface PersistedEventsEnvelope {
	schemaVersion: number;
	updatedAt: number;
	events: SessionEvent[];
	entityStates?: Record<string, PersistedEntityStateOverride>;
}

export type SessionExtractionOutcome =
	| {
			ok: true;
			sessionId: number;
			sourceNoteId: string;
			drafts: SessionEvent[];
	  }
	| {
			ok: false;
			sessionId: number;
			sourceNoteId: string;
			error: string;
			rawOutput?: string;
			aborted?: boolean;
	  };

export function stripMarkdownJsonFences(raw: string): string {
	const trimmed = raw.trim();
	const fencedMatch = trimmed.match(
		/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i,
	);
	if (fencedMatch?.[1] !== undefined) {
		return fencedMatch[1].trim();
	}
	return trimmed;
}

/**
 * Hand-written strict schema validator for LLM session event extraction output
 * (avoids heavy runtime schema libraries like zod).
 */
export function validateExtractedEventsJson(
	rawText: string,
): { ok: true; events: RawExtractedEvent[] } | { ok: false; error: string } {
	const cleaned = stripMarkdownJsonFences(rawText);
	if (!cleaned) {
		return { ok: false, error: 'Empty response instead of JSON array.' };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned) as unknown;
	} catch (error) {
		return {
			ok: false,
			error: `Invalid JSON syntax: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}

	// Some models wrap an array in `{ "events": [...] }` when jsonMode forces object output
	let rawArray: unknown = parsed;
	if (
		typeof parsed === 'object' &&
		parsed !== null &&
		!Array.isArray(parsed)
	) {
		const record = parsed as Record<string, unknown>;
		if (Array.isArray(record.events)) {
			rawArray = record.events;
		}
	}

	if (!Array.isArray(rawArray)) {
		return {
			ok: false,
			error: 'Root JSON value must be an array of session events.',
		};
	}

	const items: unknown[] = rawArray;
	const events: RawExtractedEvent[] = [];

	for (let idx = 0; idx < items.length; idx++) {
		const item = items[idx];
		if (typeof item !== 'object' || item === null || Array.isArray(item)) {
			return {
				ok: false,
				error: `Event[${idx}] must be an object.`,
			};
		}

		const obj = item as Record<string, unknown>;

		if (!Array.isArray(obj.subjects)) {
			return {
				ok: false,
				error: `Event[${idx}].subjects must be an array of strings.`,
			};
		}
		const subjects: string[] = [];
		for (const rawSubj of obj.subjects) {
			if (typeof rawSubj !== 'string' || rawSubj.trim().length === 0) {
				return {
					ok: false,
					error: `Event[${idx}].subjects entries must be non-empty strings.`,
				};
			}
			subjects.push(rawSubj.trim());
		}
		if (subjects.length === 0) {
			return {
				ok: false,
				error: `Event[${idx}].subjects must contain at least one subject.`,
			};
		}

		if (typeof obj.action !== 'string' || obj.action.trim().length === 0) {
			return {
				ok: false,
				error: `Event[${idx}].action must be a non-empty string.`,
			};
		}
		if (typeof obj.details !== 'string' || obj.details.trim().length === 0) {
			return {
				ok: false,
				error: `Event[${idx}].details must be a non-empty string.`,
			};
		}

		const stateChanges: StateChange[] = [];
		if (obj.stateChanges !== undefined) {
			if (!Array.isArray(obj.stateChanges)) {
				return {
					ok: false,
					error: `Event[${idx}].stateChanges must be an array.`,
				};
			}

			const rawScItems: unknown[] = obj.stateChanges;
			for (let scIdx = 0; scIdx < rawScItems.length; scIdx++) {
				const rawSc = rawScItems[scIdx];
				if (
					typeof rawSc !== 'object' ||
					rawSc === null ||
					Array.isArray(rawSc)
				) {
					return {
						ok: false,
						error: `Event[${idx}].stateChanges[${scIdx}] must be an object.`,
					};
				}
				const sc = rawSc as Record<string, unknown>;
				if (
					typeof sc.subject !== 'string' ||
					sc.subject.trim().length === 0
				) {
					return {
						ok: false,
						error: `Event[${idx}].stateChanges[${scIdx}].subject must be a non-empty string.`,
					};
				}
				const rawStatus =
					typeof sc.newStatusType === 'string'
						? (sc.newStatusType.trim().toUpperCase() as StatusType)
						: null;
				if (!rawStatus || !VALID_STATUS_TYPES.has(rawStatus)) {
					return {
						ok: false,
						error: `Event[${idx}].stateChanges[${scIdx}].newStatusType must be ACTIVE|INACTIVE|TERMINATED|UNKNOWN.`,
					};
				}
				const note =
					typeof sc.newStatusNote === 'string'
						? sc.newStatusNote.trim()
						: '';

				stateChanges.push({
					subject: sc.subject.trim(),
					newStatusType: rawStatus,
					newStatusNote: note,
				});
			}
		}

		events.push({
			subjects,
			action: obj.action.trim(),
			details: obj.details.trim(),
			stateChanges,
		});
	}

	return { ok: true, events };
}

export function determineSessionId(params: {
	frontmatter?: Record<string, unknown> | null;
	title: string;
	sessionNumberPattern: string;
	existingEvents: SessionEvent[];
}): number {
	const rawSession = params.frontmatter?.session;
	if (typeof rawSession === 'number' && Number.isFinite(rawSession)) {
		return Math.max(1, Math.trunc(rawSession));
	}
	if (typeof rawSession === 'string') {
		const match = rawSession.match(/\d+/);
		if (match) {
			const parsed = Number.parseInt(match[0], 10);
			if (Number.isFinite(parsed) && parsed > 0) {
				return parsed;
			}
		}
	}

	if (params.sessionNumberPattern.trim()) {
		try {
			const regex = new RegExp(params.sessionNumberPattern, 'i');
			const match = regex.exec(params.title);
			const group = match?.[1] ?? match?.[0];
			if (group) {
				const numMatch = group.match(/\d+/);
				if (numMatch) {
					const parsed = Number.parseInt(numMatch[0], 10);
					if (Number.isFinite(parsed) && parsed > 0) {
						return parsed;
					}
				}
			}
		} catch {
			// Ignore invalid user regex and fall back
		}
	}

	const titleFallback = params.title.match(/\d+/);
	if (titleFallback) {
		const parsed = Number.parseInt(titleFallback[0], 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}

	let maxSession = 0;
	for (const evt of params.existingEvents) {
		if (evt.sessionId > maxSession) {
			maxSession = evt.sessionId;
		}
	}
	return maxSession + 1;
}

/**
 * Splits a session log by `##` headings, and splits oversized sections by
 * paragraphs with 1-paragraph overlap so each chunk fits the model window.
 */
export function splitSessionLogIntoChunks(
	bodyText: string,
	maxChunkTokens = MAX_CHUNK_TOKENS,
): string[] {
	const trimmed = bodyText.trim();
	if (!trimmed) {
		return [];
	}

	const h2Sections = trimmed
		.split(/\n(?=##\s)/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);

	const chunks: string[] = [];

	for (const section of h2Sections) {
		if (estimateTokens(section) <= maxChunkTokens) {
			chunks.push(section);
			continue;
		}

		const paragraphs = section
			.split(/\n\s*\n/)
			.map((p) => p.trim())
			.filter((p) => p.length > 0);

		let current: string[] = [];
		for (const para of paragraphs) {
			const candidate = [...current, para].join('\n\n');
			if (
				current.length > 0 &&
				estimateTokens(candidate) > maxChunkTokens
			) {
				chunks.push(current.join('\n\n'));
				const overlap = current[current.length - 1];
				current = overlap ? [overlap, para] : [para];
			} else {
				current.push(para);
			}
		}
		if (current.length > 0) {
			chunks.push(current.join('\n\n'));
		}
	}

	return chunks;
}

function makeEventId(sessionId: number, index: number): string {
	const rand = Math.random().toString(36).slice(2, 8);
	return `evt-s${sessionId}-${Date.now()}-${index}-${rand}`;
}

/**
 * Idempotently replaces all events from `sourceNoteId`, preserving `id`,
 * `createdAt`, and `userVerified` for previously verified events with identical text.
 */
export function mergeReparsedSessionEvents(params: {
	existingEvents: SessionEvent[];
	sourceNoteId: string;
	sessionId: number;
	newDrafts: SessionEvent[];
	nodes: GraphNode[];
}): SessionEvent[] {
	const priorFromSameNote = params.existingEvents.filter(
		(e) => e.sourceNoteId === params.sourceNoteId,
	);
	const remaining = params.existingEvents.filter(
		(e) => e.sourceNoteId !== params.sourceNoteId,
	);

	const usedPriorIds = new Set<string>();
	const mergedForNote = params.newDrafts.map((draft, idx) => {
		const allSubjectNames = [
			...draft.subjects,
			...draft.stateChanges.map((sc) => sc.subject),
		];
		const resolved = resolveSubjects(allSubjectNames, params.nodes);

		const normAction = normalizeText(draft.action);
		const normDetails = normalizeText(draft.details);
		const matchingVerified = priorFromSameNote.find(
			(prev) =>
				!usedPriorIds.has(prev.id) &&
				prev.userVerified &&
				normalizeText(prev.action) === normAction &&
				normalizeText(prev.details) === normDetails,
		);
		if (matchingVerified) {
			usedPriorIds.add(matchingVerified.id);
		}

		return {
			...draft,
			id: matchingVerified?.id ?? draft.id ?? makeEventId(params.sessionId, idx),
			sessionId: params.sessionId,
			sourceNoteId: params.sourceNoteId,
			subjectIds: resolved.subjectIds,
			userVerified: matchingVerified ? true : draft.userVerified,
			createdAt: matchingVerified?.createdAt ?? draft.createdAt,
		};
	});

	return [...remaining, ...mergedForNote];
}

function isPersistedSessionEvent(value: unknown): value is SessionEvent {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const obj = value as Record<string, unknown>;
	return (
		typeof obj.id === 'string' &&
		typeof obj.sessionId === 'number' &&
		typeof obj.sourceNoteId === 'string' &&
		Array.isArray(obj.subjects) &&
		Array.isArray(obj.subjectIds) &&
		typeof obj.action === 'string' &&
		typeof obj.details === 'string' &&
		Array.isArray(obj.stateChanges) &&
		typeof obj.userVerified === 'boolean' &&
		typeof obj.createdAt === 'number'
	);
}

function isPersistedEntityState(
	value: unknown,
): value is PersistedEntityStateOverride {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const obj = value as Record<string, unknown>;
	return (
		typeof obj.statusType === 'string' &&
		VALID_STATUS_TYPES.has(obj.statusType as StatusType) &&
		typeof obj.statusNote === 'string' &&
		typeof obj.updatedAt === 'number'
	);
}

export function parsePersistedEventsFile(rawText: string): {
	ok: boolean;
	events: SessionEvent[];
	entityStates: Record<string, PersistedEntityStateOverride>;
} {
	if (!rawText.trim()) {
		return { ok: true, events: [], entityStates: {} };
	}

	try {
		const parsed = JSON.parse(rawText) as unknown;
		let candidateArray: unknown[] | null = null;
		const parsedStates: Record<string, PersistedEntityStateOverride> = {};

		if (Array.isArray(parsed)) {
			candidateArray = parsed;
		} else if (typeof parsed === 'object' && parsed !== null) {
			const record = parsed as Record<string, unknown>;
			if (
				typeof record.schemaVersion === 'number' &&
				Array.isArray(record.events)
			) {
				candidateArray = record.events;
				if (
					typeof record.entityStates === 'object' &&
					record.entityStates !== null &&
					!Array.isArray(record.entityStates)
				) {
					for (const [nodeId, stateVal] of Object.entries(
						record.entityStates as Record<string, unknown>,
					)) {
						if (isPersistedEntityState(stateVal)) {
							parsedStates[nodeId] = { ...stateVal };
						}
					}
				}
			}
		}

		if (!candidateArray) {
			return { ok: false, events: [], entityStates: {} };
		}

		const validEvents: SessionEvent[] = [];
		for (const item of candidateArray) {
			if (!isPersistedSessionEvent(item)) {
				return { ok: false, events: [], entityStates: {} };
			}
			validEvents.push(item);
		}

		return { ok: true, events: validEvents, entityStates: parsedStates };
	} catch {
		return { ok: false, events: [], entityStates: {} };
	}
}

export class EventManager {
	private readonly app: App;
	private readonly eventsPath: string;
	private readonly tmpPath: string;
	private readonly bakPath: string;
	private events: SessionEvent[] = [];
	private entityStates: Record<string, PersistedEntityStateOverride> = {};

	constructor(app: App, pluginDir: string) {
		this.app = app;
		const cleanDir = normalizePath(pluginDir);
		this.eventsPath = normalizePath(`${cleanDir}/events.json`);
		this.tmpPath = normalizePath(`${cleanDir}/events.json.tmp`);
		this.bakPath = normalizePath(`${cleanDir}/events.json.bak`);
	}

	async initialize(): Promise<{ corruptedBackupCreated: boolean }> {
		const adapter = this.app.vault.adapter;
		const exists = await adapter.exists(this.eventsPath);
		if (!exists) {
			this.events = [];
			this.entityStates = {};
			return { corruptedBackupCreated: false };
		}

		const raw = await adapter.read(this.eventsPath);
		const parsed = parsePersistedEventsFile(raw);
		if (!parsed.ok) {
			await adapter.write(this.bakPath, raw);
			this.events = [];
			this.entityStates = {};
			await this.saveEvents();
			return { corruptedBackupCreated: true };
		}

		this.events = parsed.events;
		this.entityStates = parsed.entityStates;
		return { corruptedBackupCreated: false };
	}

	getEvents(): SessionEvent[] {
		return this.events.map((evt) => ({
			...evt,
			subjects: [...evt.subjects],
			subjectIds: [...evt.subjectIds],
			stateChanges: evt.stateChanges.map((sc) => ({ ...sc })),
		}));
	}

	getEntityStateOverride(
		nodeId: string,
	): PersistedEntityStateOverride | undefined {
		const state = this.entityStates[nodeId];
		return state ? { ...state } : undefined;
	}

	getEntityStateOverrides(): Record<string, PersistedEntityStateOverride> {
		const copy: Record<string, PersistedEntityStateOverride> = {};
		for (const [nodeId, state] of Object.entries(this.entityStates)) {
			copy[nodeId] = { ...state };
		}
		return copy;
	}

	async setEntityStateOverrides(
		updates: Record<string, PersistedEntityStateOverride>,
	): Promise<void> {
		const entries = Object.entries(updates);
		if (entries.length === 0) {
			return;
		}
		for (const [nodeId, state] of entries) {
			this.entityStates[nodeId] = { ...state };
		}
		await this.saveEvents();
	}

	async clearEntityStateOverride(nodeId: string): Promise<void> {
		if (!(nodeId in this.entityStates)) {
			return;
		}
		delete this.entityStates[nodeId];
		await this.saveEvents();
	}

	private async saveEvents(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const envelope: PersistedEventsEnvelope = {
			schemaVersion: EVENTS_SCHEMA_VERSION,
			updatedAt: Date.now(),
			events: this.events,
			entityStates: this.entityStates,
		};
		const serialized = JSON.stringify(envelope, null, 2);

		await adapter.write(this.tmpPath, serialized);
		await adapter.write(this.eventsPath, serialized);
		if (await adapter.exists(this.tmpPath)) {
			await adapter.remove(this.tmpPath);
		}
	}

	/**
	 * Updates `sourceNoteId` and `subjectIds` when a vault note is renamed.
	 */
	async handleNoteRename(oldPath: string, newPath: string): Promise<void> {
		let changed = false;
		this.events = this.events.map((evt) => {
			let updated = evt;
			if (evt.sourceNoteId === oldPath) {
				updated = { ...updated, sourceNoteId: newPath };
				changed = true;
			}
			if (evt.subjectIds.includes(oldPath)) {
				updated = {
					...updated,
					subjectIds: evt.subjectIds.map((id) =>
						id === oldPath ? newPath : id,
					),
				};
				changed = true;
			}
			return updated;
		});

		if (oldPath in this.entityStates) {
			const existingState = this.entityStates[oldPath];
			delete this.entityStates[oldPath];
			if (existingState) {
				this.entityStates[newPath] = existingState;
			}
			changed = true;
		}

		if (changed) {
			await this.saveEvents();
		}
	}

	/**
	 * When a note is deleted, NEVER delete stored events: detach its path from
	 * `subjectIds` so affected subjects become unresolved for GM review.
	 */
	async handleNoteDelete(deletedPath: string): Promise<void> {
		let changed = false;
		if (deletedPath in this.entityStates) {
			delete this.entityStates[deletedPath];
			changed = true;
		}
		this.events = this.events.map((evt) => {
			if (evt.subjectIds.includes(deletedPath)) {
				changed = true;
				return {
					...evt,
					subjectIds: evt.subjectIds.filter(
						(id) => id !== deletedPath,
					),
				};
			}
			return evt;
		});

		if (changed) {
			await this.saveEvents();
		}
	}

	async applySessionEventsForNote(params: {
		sourceNoteId: string;
		sessionId: number;
		drafts: SessionEvent[];
		nodes: GraphNode[];
	}): Promise<SessionEvent[]> {
		this.events = mergeReparsedSessionEvents({
			existingEvents: this.events,
			sourceNoteId: params.sourceNoteId,
			sessionId: params.sessionId,
			newDrafts: params.drafts,
			nodes: params.nodes,
		});
		await this.saveEvents();
		return this.getEvents();
	}

	private buildEntityHintText(nodes: GraphNode[], lang: UiLanguage): string {
		const labels = EXTRACTION_PROMPT_LABELS[lang] ?? EXTRACTION_PROMPT_LABELS.uk;
		const relevant = nodes
			.filter((n) => n.type !== 'SESSION_LOG' && n.type !== 'META')
			.slice(0, MAX_ENTITY_HINTS);
		if (relevant.length === 0) {
			return '';
		}
		const lines = relevant.map((node) => {
			const aliases =
				node.aliases.length > 0
					? ` (${labels.aliasesLabel}: ${node.aliases.join(', ')})`
					: '';
			return `- ${node.title}${aliases} [${node.type}]`;
		});
		return `${labels.entityHintsHeader}\n${lines.join('\n')}`;
	}

	async extractSessionEventsFromFile(params: {
		file: TFile;
		nodes: GraphNode[];
		llmProvider: ILlmProvider;
		settings: PluginSettings;
		signal?: AbortSignal;
	}): Promise<SessionExtractionOutcome> {
		const { file, nodes, llmProvider, settings, signal } = params;
		const lang = settings.uiLanguage;
		const labels = EXTRACTION_PROMPT_LABELS[lang] ?? EXTRACTION_PROMPT_LABELS.uk;
		const systemPrompt = getSessionExtractionSystemPrompt(lang);
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter: Record<string, unknown> | undefined =
			cache?.frontmatter;

		const sessionId = determineSessionId({
			frontmatter,
			title: file.basename,
			sessionNumberPattern: settings.sessionNumberPattern,
			existingEvents: this.events,
		});

		const rawText = await this.app.vault.cachedRead(file);
		const bodyStart = cache?.frontmatterPosition?.end.offset ?? 0;
		const bodyText = rawText.slice(bodyStart).trim();

		const chunks = splitSessionLogIntoChunks(bodyText);
		if (chunks.length === 0) {
			return {
				ok: true,
				sessionId,
				sourceNoteId: file.path,
				drafts: [],
			};
		}

		const entityHints = this.buildEntityHintText(nodes, lang);
		const collectedRaw: RawExtractedEvent[] = [];

		for (const chunk of chunks) {
			const userPrompt = [
				entityHints,
				`${labels.sectionHeader} (${file.basename}):`,
				chunk,
			]
				.filter((part) => part.length > 0)
				.join('\n\n');

			const messages: LlmChatMessage[] = [
				{ role: 'user', content: userPrompt },
			];

			let lastRawOutput = '';
			let lastError = 'Unknown validation error';
			let chunkEvents: RawExtractedEvent[] | null = null;

			for (let attempt = 0; attempt <= MAX_LLM_RETRIES; attempt++) {
				if (signal?.aborted) {
					return {
						ok: false,
						sessionId,
						sourceNoteId: file.path,
						error: '',
						rawOutput: lastRawOutput,
						aborted: true,
					};
				}

				try {
					lastRawOutput = await llmProvider.complete({
						system: systemPrompt,
						messages,
						temperature: 0.1,
						jsonMode: true,
						signal,
					});
				} catch (error) {
					if (isAbortError(error) || signal?.aborted) {
						return {
							ok: false,
							sessionId,
							sourceNoteId: file.path,
							error: '',
							rawOutput: lastRawOutput,
							aborted: true,
						};
					}
					return {
						ok: false,
						sessionId,
						sourceNoteId: file.path,
						error: formatLlmError(error, lang, settings.llmProvider, {
							model: settings.modelName,
							ollamaUrl: settings.ollamaUrl,
						}),
						rawOutput: lastRawOutput,
					};
				}

				const validation = validateExtractedEventsJson(lastRawOutput);
				if (validation.ok) {
					chunkEvents = validation.events;
					break;
				}

				lastError = validation.error;
				messages.push({ role: 'assistant', content: lastRawOutput });
				messages.push({
					role: 'user',
					content: labels.invalidJsonRetry(lastError),
				});
			}

			if (!chunkEvents) {
				return {
					ok: false,
					sessionId,
					sourceNoteId: file.path,
					error: lastError,
					rawOutput: lastRawOutput,
				};
			}

			collectedRaw.push(...chunkEvents);
		}

		const now = Date.now();
		const drafts: SessionEvent[] = collectedRaw.map((raw, idx) => {
			const allNames = [
				...raw.subjects,
				...raw.stateChanges.map((sc) => sc.subject),
			];
			const resolved = resolveSubjects(allNames, nodes);
			return {
				id: makeEventId(sessionId, idx),
				sessionId,
				sourceNoteId: file.path,
				subjects: raw.subjects,
				subjectIds: resolved.subjectIds,
				action: raw.action,
				details: raw.details,
				stateChanges: raw.stateChanges,
				userVerified: false,
				createdAt: now,
			};
		});

		return {
			ok: true,
			sessionId,
			sourceNoteId: file.path,
			drafts,
		};
	}
}
