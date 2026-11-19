import { describe, expect, it } from 'vitest';
import {
	CHAT_LORE_SYSTEM_PROMPT,
	INTENT_CLASSIFICATION_SYSTEM_PROMPT,
	MECHANICS_SYSTEM_PROMPT_DND5E,
	PING_SYSTEM_PROMPT,
	SESSION_EXTRACTION_SYSTEM_PROMPT,
} from '../src/llm/prompts';
import {
	assertCloudConsent,
	classifyHttpStatusError,
	extractAnthropicPiece,
	extractGeminiPiece,
	extractOllamaPiece,
	extractOpenAiPiece,
	formatLlmError,
	isAbortError,
	LlmProviderError,
	NdjsonStreamParser,
	readReadableStreamChunks,
	SseStreamParser,
} from '../src/llm/streaming';

function encodeUtf8(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

describe('NdjsonStreamParser & Ollama extractor', () => {
	it('parses chunked NDJSON split mid-line and mid-Cyrillic UTF-8 character', () => {
		const ndjson = [
			JSON.stringify({ message: { content: 'Барон ' }, done: false }),
			JSON.stringify({
				message: { content: 'Келд живий!' },
				done: false,
			}),
			JSON.stringify({
				message: { content: '' },
				done: true,
				prompt_eval_count: 42,
				eval_count: 15,
			}),
		].join('\n');

		const fullBytes = encodeUtf8(ndjson + '\n');
		// Find the first byte of Cyrillic 'Б' (0xD0 0x91) and slice directly between its two bytes
		const firstCyrillicIdx = fullBytes.findIndex((b) => b === 0xd0);
		expect(firstCyrillicIdx).toBeGreaterThan(0);

		const chunk1 = fullBytes.slice(0, firstCyrillicIdx + 1);
		const chunk2 = fullBytes.slice(firstCyrillicIdx + 1, firstCyrillicIdx + 35);
		const chunk3 = fullBytes.slice(firstCyrillicIdx + 35);

		const parser = new NdjsonStreamParser('ollama');
		const payloads = [
			...parser.push(chunk1),
			...parser.push(chunk2),
			...parser.push(chunk3),
			...parser.flush(),
		];

		expect(payloads).toHaveLength(3);

		let text = '';
		let inputTokens: number | undefined;
		let outputTokens: number | undefined;
		let sawDone = false;

		for (const payload of payloads) {
			const piece = extractOllamaPiece(payload);
			if (piece.token) {
				text += piece.token;
			}
			if (piece.usage) {
				inputTokens = piece.usage.input;
				outputTokens = piece.usage.output;
			}
			if (piece.done) {
				sawDone = true;
			}
		}

		expect(text).toBe('Барон Келд живий!');
		expect(sawDone).toBe(true);
		expect(inputTokens).toBe(42);
		expect(outputTokens).toBe(15);
	});
});

describe('SseStreamParser & Cloud extractors', () => {
	it('parses OpenAI SSE chunks including split CRLF, usage, and [DONE]', () => {
		const sseRaw = [
			'data: {"choices":[{"delta":{"content":"Окхейвен"}}]}\r\n\r\n',
			'data: {"choices":[{"delta":{"content":" — порт."},"finish_reason":"stop"}]}\r\n\r\n',
			'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":8}}\r\n\r\n',
			'data: [DONE]\r\n\r\n',
		].join('');

		const bytes = encodeUtf8(sseRaw);
		const splitAt = sseRaw.indexOf('\r\n\r\n') + 1; // split right between \r and \n
		const parser = new SseStreamParser();
		const events = [
			...parser.push(bytes.slice(0, splitAt)),
			...parser.push(bytes.slice(splitAt)),
			...parser.flush(),
		];

		expect(events).toHaveLength(4);

		let text = '';
		let usage: { input?: number; output?: number } | undefined;
		let done = false;

		for (const evt of events) {
			const piece = extractOpenAiPiece(evt);
			if (piece.token) {
				text += piece.token;
			}
			if (piece.usage) {
				usage = piece.usage;
			}
			if (piece.done) {
				done = true;
			}
		}

		expect(text).toBe('Окхейвен — порт.');
		expect(usage).toEqual({ input: 30, output: 8 });
		expect(done).toBe(true);
	});

	it('parses Anthropic SSE events with message_start, content_block_delta, message_delta, and message_stop', () => {
		const sseRaw = [
			'event: message_start',
			'data: {"type":"message_start","message":{"usage":{"input_tokens":55}}}',
			'',
			'event: content_block_delta',
			'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Срібна "}}',
			'',
			'event: content_block_delta',
			'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Корона"}}',
			'',
			'event: message_delta',
			'data: {"type":"message_delta","usage":{"output_tokens":12}}',
			'',
			'event: message_stop',
			'data: {"type":"message_stop"}',
			'',
		].join('\n');

		const parser = new SseStreamParser();
		const events = [...parser.push(sseRaw), ...parser.flush()];

		let text = '';
		let input: number | undefined;
		let output: number | undefined;
		let stopped = false;

		for (const evt of events) {
			const piece = extractAnthropicPiece(evt);
			if (piece.token) {
				text += piece.token;
			}
			if (piece.usage?.input !== undefined) {
				input = piece.usage.input;
			}
			if (piece.usage?.output !== undefined) {
				output = piece.usage.output;
			}
			if (piece.done) {
				stopped = true;
			}
		}

		expect(text).toBe('Срібна Корона');
		expect(input).toBe(55);
		expect(output).toBe(12);
		expect(stopped).toBe(true);
	});

	it('parses Gemini SSE fragments split mid-Cyrillic UTF-8 byte sequence', () => {
		const sseRaw =
			'data: {"candidates":[{"content":{"parts":[{"text":"Гільдія Тіней"}]}}],"usageMetadata":{"promptTokenCount":18,"candidatesTokenCount":6}}\n\n';
		const bytes = encodeUtf8(sseRaw);
		const cyrIdx = bytes.findIndex((b) => b === 0xd0 || b === 0xd1);
		expect(cyrIdx).toBeGreaterThan(0);

		const parser = new SseStreamParser();
		const events = [
			...parser.push(bytes.slice(0, cyrIdx + 1)),
			...parser.push(bytes.slice(cyrIdx + 1)),
			...parser.flush(),
		];

		expect(events).toHaveLength(1);
		const piece = extractGeminiPiece(events[0]!);
		expect(piece.token).toBe('Гільдія Тіней');
		expect(piece.usage).toEqual({ input: 18, output: 6 });
	});
});

describe('AbortSignal & error handling', () => {
	it('stops reading ReadableStream when aborted via AbortController', async () => {
		const controller = new AbortController();
		const stream = new ReadableStream<Uint8Array>({
			start(streamController) {
				streamController.enqueue(encodeUtf8('{"message":{"content":"a"}}\n'));
			},
		});

		const chunks: Uint8Array[] = [];
		const readPromise = readReadableStreamChunks(
			stream,
			controller.signal,
			'ollama',
			(chunk) => {
				chunks.push(chunk);
				controller.abort();
			},
		);

		await expect(readPromise).rejects.toSatisfy(isAbortError);
		expect(chunks).toHaveLength(1);
	});

	it('enforces cloud consent for non-local providers only', () => {
		expect(() => assertCloudConsent('ollama', false)).not.toThrow();
		expect(() => assertCloudConsent('openai', false)).toThrow(
			LlmProviderError,
		);
		expect(() => assertCloudConsent('anthropic', false)).toThrow(
			LlmProviderError,
		);
		expect(() => assertCloudConsent('gemini', false)).toThrow(
			LlmProviderError,
		);
		expect(() => assertCloudConsent('openai', true)).not.toThrow();
	});

	it('maps HTTP statuses and Ollama CORS errors to localized messages in uk, ru, and en', () => {
		const authErr = classifyHttpStatusError({
			provider: 'openai',
			status: 401,
			bodyText: '{"error":{"message":"Incorrect API key"}}',
		});
		expect(authErr.code).toBe('AUTH_ERROR');
		expect(formatLlmError(authErr, 'ru', 'openai')).toContain('401');

		const notFoundErr = classifyHttpStatusError({
			provider: 'ollama',
			status: 404,
			model: 'missing-model',
		});
		expect(notFoundErr.code).toBe('MODEL_NOT_FOUND');
		expect(formatLlmError(notFoundErr, 'uk', 'ollama')).toContain(
			'missing-model',
		);

		const rateErr = classifyHttpStatusError({
			provider: 'anthropic',
			status: 429,
			retryAfterHeader: '12',
		});
		expect(rateErr.code).toBe('RATE_LIMIT');
		expect(formatLlmError(rateErr, 'en', 'anthropic')).toContain('12');

		const ollamaCorsErr = new LlmProviderError({
			code: 'CORS_OR_NETWORK',
			provider: 'ollama',
			url: 'http://localhost:11434',
			message: 'Failed to fetch',
		});
		expect(formatLlmError(ollamaCorsErr, 'ru', 'ollama')).toContain(
			'OLLAMA_ORIGINS=app://obsidian.md*',
		);
	});

	it('defines non-empty prompt constants in Ukrainian', () => {
		for (const prompt of [
			PING_SYSTEM_PROMPT,
			CHAT_LORE_SYSTEM_PROMPT,
			MECHANICS_SYSTEM_PROMPT_DND5E,
			SESSION_EXTRACTION_SYSTEM_PROMPT,
			INTENT_CLASSIFICATION_SYSTEM_PROMPT,
		]) {
			expect(prompt.trim().length).toBeGreaterThan(20);
		}
	});
});
