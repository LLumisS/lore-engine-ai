import { formatMessage, t } from '../i18n';
import type { LlmProviderId, UiLanguage } from '../types';

export type LlmErrorCode =
	| 'AUTH_ERROR'
	| 'MODEL_NOT_FOUND'
	| 'RATE_LIMIT'
	| 'CORS_OR_NETWORK'
	| 'CLOUD_CONSENT_REQUIRED'
	| 'CONTEXT_LENGTH_EXCEEDED'
	| 'INVALID_JSON'
	| 'PROVIDER_ERROR'
	| 'ABORTED';

export interface LlmProviderErrorOptions {
	code: LlmErrorCode;
	provider: LlmProviderId;
	message: string;
	status?: number;
	retryAfterSeconds?: number;
	model?: string;
	url?: string;
}

export class LlmProviderError extends Error {
	readonly code: LlmErrorCode;
	readonly provider: LlmProviderId;
	readonly status?: number;
	readonly retryAfterSeconds?: number;
	readonly model?: string;
	readonly url?: string;

	constructor(options: LlmProviderErrorOptions) {
		super(options.message);
		this.name = 'LlmProviderError';
		this.code = options.code;
		this.provider = options.provider;
		this.status = options.status;
		this.retryAfterSeconds = options.retryAfterSeconds;
		this.model = options.model;
		this.url = options.url;
	}
}

export function createAbortError(provider: LlmProviderId): LlmProviderError {
	return new LlmProviderError({
		code: 'ABORTED',
		provider,
		message: 'Request aborted',
	});
}

export function isAbortError(error: unknown): boolean {
	if (error instanceof LlmProviderError) {
		return error.code === 'ABORTED';
	}
	if (error instanceof Error) {
		return (
			error.name === 'AbortError' ||
			error.message.toLowerCase().includes('aborted')
		);
	}
	return false;
}

export function assertCloudConsent(
	provider: LlmProviderId,
	cloudConsentGiven: boolean,
): void {
	if (provider !== 'ollama' && !cloudConsentGiven) {
		throw new LlmProviderError({
			code: 'CLOUD_CONSENT_REQUIRED',
			provider,
			message: 'Explicit cloud consent is required before sending data.',
		});
	}
}

function parseRetryAfterSeconds(
	retryAfterHeader?: string | null,
): number | undefined {
	if (!retryAfterHeader) {
		return undefined;
	}
	const trimmed = retryAfterHeader.trim();
	const seconds = Number(trimmed);
	if (Number.isFinite(seconds) && seconds > 0) {
		return Math.ceil(seconds);
	}
	const targetTime = Date.parse(trimmed);
	if (Number.isFinite(targetTime)) {
		const diffSec = Math.ceil((targetTime - Date.now()) / 1000);
		return diffSec > 0 ? diffSec : undefined;
	}
	return undefined;
}

function extractApiErrorMessage(bodyText: string): string {
	const trimmed = bodyText.trim();
	if (!trimmed) {
		return '';
	}
	try {
		const parsed = JSON.parse(trimmed) as Record<string, unknown>;
		const errField = parsed.error;
		if (typeof errField === 'string') {
			return errField;
		}
		if (
			typeof errField === 'object' &&
			errField !== null &&
			typeof (errField as Record<string, unknown>).message === 'string'
		) {
			return (errField as Record<string, unknown>).message as string;
		}
		if (typeof parsed.message === 'string') {
			return parsed.message;
		}
	} catch {
		// Fall through to plain text slice
	}
	return trimmed.slice(0, 300);
}

export function classifyHttpStatusError(params: {
	provider: LlmProviderId;
	status: number;
	bodyText?: string;
	retryAfterHeader?: string | null;
	model?: string;
}): LlmProviderError {
	const details = extractApiErrorMessage(params.bodyText ?? '');
	const lower = details.toLowerCase();

	if (params.status === 401 || params.status === 403) {
		return new LlmProviderError({
			code: 'AUTH_ERROR',
			provider: params.provider,
			status: params.status,
			message: details || `HTTP ${params.status}`,
		});
	}

	if (params.status === 404) {
		return new LlmProviderError({
			code: 'MODEL_NOT_FOUND',
			provider: params.provider,
			status: params.status,
			model: params.model,
			message: details || 'Model not found',
		});
	}

	if (params.status === 429) {
		return new LlmProviderError({
			code: 'RATE_LIMIT',
			provider: params.provider,
			status: params.status,
			retryAfterSeconds: parseRetryAfterSeconds(params.retryAfterHeader),
			message: details || 'Rate limit exceeded',
		});
	}

	if (
		(params.status === 400 || params.status === 413) &&
		(lower.includes('context_length') ||
			lower.includes('context length') ||
			lower.includes('maximum context') ||
			lower.includes('too many tokens') ||
			lower.includes('token limit'))
	) {
		return new LlmProviderError({
			code: 'CONTEXT_LENGTH_EXCEEDED',
			provider: params.provider,
			status: params.status,
			message: details || 'Context length exceeded',
		});
	}

	return new LlmProviderError({
		code: 'PROVIDER_ERROR',
		provider: params.provider,
		status: params.status,
		model: params.model,
		message: details || `HTTP ${params.status}`,
	});
}

export function formatLlmError(
	error: unknown,
	lang: UiLanguage,
	fallbackProvider: LlmProviderId,
	context?: { model?: string; ollamaUrl?: string },
): string {
	if (isAbortError(error)) {
		return t(lang, 'pingStatusAborted');
	}

	if (error instanceof LlmProviderError) {
		switch (error.code) {
			case 'CLOUD_CONSENT_REQUIRED':
				return t(lang, 'llmErrorCloudConsent');
			case 'AUTH_ERROR':
				return formatMessage(t(lang, 'llmErrorAuth'), {
					provider: error.provider,
					status: error.status ?? 401,
				});
			case 'MODEL_NOT_FOUND':
				return formatMessage(t(lang, 'llmErrorModelNotFound'), {
					provider: error.provider,
					model: error.model ?? context?.model ?? '?',
				});
			case 'RATE_LIMIT': {
				const retryHint =
					error.retryAfterSeconds !== undefined
						? formatMessage(t(lang, 'llmErrorRetryAfter'), {
								seconds: error.retryAfterSeconds,
							})
						: '';
				return formatMessage(t(lang, 'llmErrorRateLimit'), {
					provider: error.provider,
					retryHint,
				}).trim();
			}
			case 'CORS_OR_NETWORK':
				if (error.provider === 'ollama') {
					return formatMessage(t(lang, 'llmErrorOllamaCors'), {
						url:
							error.url ??
							context?.ollamaUrl ??
							'http://localhost:11434',
					});
				}
				return formatMessage(t(lang, 'llmErrorNetwork'), {
					provider: error.provider,
					details: error.message,
				});
			case 'CONTEXT_LENGTH_EXCEEDED':
				return formatMessage(t(lang, 'llmErrorContextLength'), {
					provider: error.provider,
					details: error.message,
				});
			case 'INVALID_JSON':
				return formatMessage(t(lang, 'llmErrorInvalidJson'), {
					provider: error.provider,
					details: error.message,
				});
			case 'PROVIDER_ERROR':
				return formatMessage(t(lang, 'llmErrorGeneric'), {
					provider: error.provider,
					details: error.message,
				});
			case 'ABORTED':
				return t(lang, 'pingStatusAborted');
		}
	}

	const message = error instanceof Error ? error.message : String(error);
	return formatMessage(t(lang, 'llmErrorGeneric'), {
		provider: fallbackProvider,
		details: message,
	});
}

function parseJsonStrict(raw: string, provider: LlmProviderId): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch (error) {
		const details = error instanceof Error ? error.message : String(error);
		throw new LlmProviderError({
			code: 'INVALID_JSON',
			provider,
			message: details,
		});
	}
}

/**
 * Stateful NDJSON line parser supporting chunked Uint8Array inputs
 * and multibyte UTF-8 characters (e.g. Cyrillic) split across chunks.
 */
export class NdjsonStreamParser {
	private readonly decoder = new TextDecoder('utf-8');
	private readonly provider: LlmProviderId;
	private buffer = '';

	constructor(provider: LlmProviderId = 'ollama') {
		this.provider = provider;
	}

	push(chunk: Uint8Array | string): unknown[] {
		const decoded =
			typeof chunk === 'string'
				? chunk
				: this.decoder.decode(chunk, { stream: true });
		this.buffer += decoded;

		const results: unknown[] = [];
		let newlineIdx = this.buffer.indexOf('\n');
		while (newlineIdx !== -1) {
			const line = this.buffer.slice(0, newlineIdx).trim();
			this.buffer = this.buffer.slice(newlineIdx + 1);
			if (line.length > 0) {
				results.push(parseJsonStrict(line, this.provider));
			}
			newlineIdx = this.buffer.indexOf('\n');
		}
		return results;
	}

	flush(): unknown[] {
		const tail = this.decoder.decode();
		const remaining = (this.buffer + tail).trim();
		this.buffer = '';
		if (!remaining) {
			return [];
		}
		return [parseJsonStrict(remaining, this.provider)];
	}
}

export interface SseEventMessage {
	event: string;
	data: string;
}

/**
 * Stateful SSE parser supporting split lines, CRLF boundaries across chunks,
 * multi-line data fields, and multibyte UTF-8 Cyrillic characters split mid-sequence.
 */
export class SseStreamParser {
	private readonly decoder = new TextDecoder('utf-8');
	private buffer = '';
	private currentEvent = 'message';
	private dataLines: string[] = [];

	private processLine(rawLine: string, out: SseEventMessage[]): void {
		const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
		if (line === '') {
			if (this.dataLines.length > 0) {
				out.push({
					event: this.currentEvent,
					data: this.dataLines.join('\n'),
				});
			}
			this.currentEvent = 'message';
			this.dataLines = [];
			return;
		}

		if (line.startsWith(':')) {
			return;
		}

		const colonIdx = line.indexOf(':');
		const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
		const rawValue = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
		const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

		if (field === 'event') {
			this.currentEvent = value || 'message';
		} else if (field === 'data') {
			this.dataLines.push(value);
		}
	}

	push(chunk: Uint8Array | string): SseEventMessage[] {
		const decoded =
			typeof chunk === 'string'
				? chunk
				: this.decoder.decode(chunk, { stream: true });
		this.buffer += decoded;

		const events: SseEventMessage[] = [];
		let newlineIdx = this.buffer.indexOf('\n');
		while (newlineIdx !== -1) {
			const line = this.buffer.slice(0, newlineIdx);
			this.buffer = this.buffer.slice(newlineIdx + 1);
			this.processLine(line, events);
			newlineIdx = this.buffer.indexOf('\n');
		}
		return events;
	}

	flush(): SseEventMessage[] {
		const tail = this.decoder.decode();
		if (tail) {
			this.buffer += tail;
		}

		const events: SseEventMessage[] = [];
		if (this.buffer.length > 0) {
			const finalLine = this.buffer;
			this.buffer = '';
			this.processLine(finalLine, events);
		}
		if (this.dataLines.length > 0) {
			events.push({
				event: this.currentEvent,
				data: this.dataLines.join('\n'),
			});
			this.currentEvent = 'message';
			this.dataLines = [];
		}
		return events;
	}
}

export interface ParsedStreamPiece {
	token?: string;
	done?: boolean;
	usage?: {
		input?: number;
		output?: number;
	};
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)
		: null;
}

export function extractOllamaPiece(payload: unknown): ParsedStreamPiece {
	const obj = asRecord(payload);
	if (!obj) {
		return {};
	}

	if (typeof obj.error === 'string' && obj.error.length > 0) {
		throw new LlmProviderError({
			code: 'PROVIDER_ERROR',
			provider: 'ollama',
			message: obj.error,
		});
	}

	const message = asRecord(obj.message);
	const token =
		message && typeof message.content === 'string'
			? message.content
			: undefined;
	const done = obj.done === true;

	const input =
		typeof obj.prompt_eval_count === 'number'
			? obj.prompt_eval_count
			: undefined;
	const output =
		typeof obj.eval_count === 'number' ? obj.eval_count : undefined;
	const usage =
		input !== undefined || output !== undefined
			? { input, output }
			: undefined;

	return { token, done, usage };
}

export function extractOpenAiPiece(sse: SseEventMessage): ParsedStreamPiece {
	const data = sse.data.trim();
	if (!data) {
		return {};
	}
	if (data === '[DONE]') {
		return { done: true };
	}

	const obj = asRecord(parseJsonStrict(data, 'openai'));
	if (!obj) {
		return {};
	}

	const errObj = asRecord(obj.error);
	if (errObj) {
		const msg =
			typeof errObj.message === 'string'
				? errObj.message
				: 'OpenAI streaming error';
		throw new LlmProviderError({
			code: 'PROVIDER_ERROR',
			provider: 'openai',
			message: msg,
		});
	}

	let token: string | undefined;
	const choices = Array.isArray(obj.choices) ? obj.choices : [];
	const firstChoice = asRecord(choices[0]);
	if (firstChoice) {
		const delta = asRecord(firstChoice.delta);
		if (delta && typeof delta.content === 'string') {
			token = delta.content;
		}
	}

	const usageObj = asRecord(obj.usage);
	let usage: ParsedStreamPiece['usage'];
	if (usageObj) {
		usage = {
			input:
				typeof usageObj.prompt_tokens === 'number'
					? usageObj.prompt_tokens
					: undefined,
			output:
				typeof usageObj.completion_tokens === 'number'
					? usageObj.completion_tokens
					: undefined,
		};
	}

	return { token, done: false, usage };
}

export function extractAnthropicPiece(sse: SseEventMessage): ParsedStreamPiece {
	if (sse.event === 'ping') {
		return {};
	}
	if (sse.event === 'message_stop') {
		return { done: true };
	}

	const data = sse.data.trim();
	if (!data) {
		return {};
	}

	const obj = asRecord(parseJsonStrict(data, 'anthropic'));
	if (!obj) {
		return {};
	}

	if (sse.event === 'error' || obj.type === 'error') {
		const errObj = asRecord(obj.error);
		const msg =
			errObj && typeof errObj.message === 'string'
				? errObj.message
				: 'Anthropic streaming error';
		throw new LlmProviderError({
			code: 'PROVIDER_ERROR',
			provider: 'anthropic',
			message: msg,
		});
	}

	if (obj.type === 'message_start') {
		const msgObj = asRecord(obj.message);
		const usageObj = asRecord(msgObj?.usage);
		if (usageObj && typeof usageObj.input_tokens === 'number') {
			return { usage: { input: usageObj.input_tokens } };
		}
		return {};
	}

	if (obj.type === 'content_block_delta') {
		const delta = asRecord(obj.delta);
		if (
			delta &&
			delta.type === 'text_delta' &&
			typeof delta.text === 'string'
		) {
			return { token: delta.text };
		}
	}

	if (obj.type === 'message_delta') {
		const usageObj = asRecord(obj.usage);
		if (usageObj && typeof usageObj.output_tokens === 'number') {
			return { usage: { output: usageObj.output_tokens } };
		}
	}

	return {};
}

export function extractGeminiPiece(sse: SseEventMessage): ParsedStreamPiece {
	const data = sse.data.trim();
	if (!data) {
		return {};
	}
	if (data === '[DONE]') {
		return { done: true };
	}

	const obj = asRecord(parseJsonStrict(data, 'gemini'));
	if (!obj) {
		return {};
	}

	const errObj = asRecord(obj.error);
	if (errObj) {
		const msg =
			typeof errObj.message === 'string'
				? errObj.message
				: 'Gemini streaming error';
		throw new LlmProviderError({
			code: 'PROVIDER_ERROR',
			provider: 'gemini',
			message: msg,
		});
	}

	let token = '';
	const candidates = Array.isArray(obj.candidates) ? obj.candidates : [];
	const firstCandidate = asRecord(candidates[0]);
	const content = asRecord(firstCandidate?.content);
	const parts = Array.isArray(content?.parts) ? content.parts : [];

	for (const rawPart of parts) {
		const part = asRecord(rawPart);
		if (part && typeof part.text === 'string') {
			token += part.text;
		}
	}

	const usageMeta = asRecord(obj.usageMetadata);
	const usage = usageMeta
		? {
				input:
					typeof usageMeta.promptTokenCount === 'number'
						? usageMeta.promptTokenCount
						: undefined,
				output:
					typeof usageMeta.candidatesTokenCount === 'number'
						? usageMeta.candidatesTokenCount
						: undefined,
			}
		: undefined;

	return {
		token: token.length > 0 ? token : undefined,
		done: false,
		usage,
	};
}

export async function readReadableStreamChunks(
	stream: ReadableStream<Uint8Array>,
	signal: AbortSignal | undefined,
	provider: LlmProviderId,
	onChunk: (chunk: Uint8Array) => void,
): Promise<void> {
	if (signal?.aborted) {
		throw createAbortError(provider);
	}

	const reader = stream.getReader();
	const onAbort = (): void => {
		void reader.cancel().catch(() => undefined);
	};

	signal?.addEventListener('abort', onAbort, { once: true });

	try {
		while (true) {
			if (signal?.aborted) {
				throw createAbortError(provider);
			}
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (value && value.byteLength > 0) {
				onChunk(value);
			}
		}
	} catch (error) {
		if (signal?.aborted || isAbortError(error)) {
			throw createAbortError(provider);
		}
		throw error;
	} finally {
		signal?.removeEventListener('abort', onAbort);
		reader.releaseLock();
	}
}

export async function streamFetchResponse(params: {
	url: string;
	method?: string;
	headers: Record<string, string>;
	body: string;
	provider: LlmProviderId;
	model?: string;
	signal: AbortSignal;
	onChunk: (chunk: Uint8Array) => void;
}): Promise<void> {
	if (params.signal.aborted) {
		throw createAbortError(params.provider);
	}

	let response: Response;
	try {
		// fetch is required for ReadableStream token streaming; Obsidian's requestUrl does not support streaming.
		response = await fetch(params.url, {
			method: params.method ?? 'POST',
			headers: params.headers,
			body: params.body,
			signal: params.signal,
		});
	} catch (error) {
		if (params.signal.aborted || isAbortError(error)) {
			throw createAbortError(params.provider);
		}
		throw new LlmProviderError({
			code: 'CORS_OR_NETWORK',
			provider: params.provider,
			url: params.url,
			message: error instanceof Error ? error.message : String(error),
		});
	}

	if (!response.ok) {
		const bodyText = await response.text().catch(() => '');
		throw classifyHttpStatusError({
			provider: params.provider,
			status: response.status,
			bodyText,
			retryAfterHeader: response.headers.get('retry-after'),
			model: params.model,
		});
	}

	if (!response.body) {
		throw new LlmProviderError({
			code: 'CORS_OR_NETWORK',
			provider: params.provider,
			url: params.url,
			message: 'Streaming response body is unavailable.',
		});
	}

	await readReadableStreamChunks(
		response.body,
		params.signal,
		params.provider,
		params.onChunk,
	);
}
