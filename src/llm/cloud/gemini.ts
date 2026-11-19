import type {
	IEmbeddingProvider,
	ILlmProvider,
	LlmChatMessage,
	LlmCompleteRequest,
	LlmStreamRequest,
	LlmStreamResult,
	LlmUsage,
} from '../llmProvider';
import { obsidianJsonRequest } from '../llmProvider';
import {
	extractGeminiPiece,
	LlmProviderError,
	SseStreamParser,
	streamFetchResponse,
} from '../streaming';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiConfig {
	apiKey: string;
	modelName: string;
	embeddingModel: string;
}

function toGeminiContents(
	messages: LlmChatMessage[],
): Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> {
	return messages.map((msg) => ({
		role: msg.role === 'assistant' ? 'model' : 'user',
		parts: [{ text: msg.content }],
	}));
}

export class GeminiProvider implements ILlmProvider, IEmbeddingProvider {
	readonly providerId = 'gemini' as const;
	readonly modelName: string;
	readonly modelId: string;
	private readonly apiKey: string;

	constructor(config: GeminiConfig) {
		this.apiKey = config.apiKey.trim();
		this.modelName = config.modelName;
		this.modelId = config.embeddingModel;
	}

	private getHeaders(): Record<string, string> {
		if (!this.apiKey) {
			throw new LlmProviderError({
				code: 'AUTH_ERROR',
				provider: 'gemini',
				status: 401,
				message: 'Gemini API key is empty.',
			});
		}
		return {
			'x-goog-api-key': this.apiKey,
			'content-type': 'application/json',
		};
	}

	async stream(req: LlmStreamRequest): Promise<LlmStreamResult> {
		const headers = this.getHeaders();
		const parser = new SseStreamParser();
		let fullText = '';
		let usage: LlmUsage | undefined;

		const payload: Record<string, unknown> = {
			contents: toGeminiContents(req.messages),
			generationConfig: {
				temperature: req.temperature ?? 0.3,
			},
		};
		if (req.system.trim()) {
			payload.systemInstruction = {
				parts: [{ text: req.system }],
			};
		}

		const encodedModel = encodeURIComponent(this.modelName);
		const url = `${GEMINI_API_BASE}/models/${encodedModel}:streamGenerateContent?alt=sse`;

		const consumeSse = (sse: ReturnType<SseStreamParser['push']>[number]): void => {
			const piece = extractGeminiPiece(sse);
			if (piece.token) {
				fullText += piece.token;
				req.onToken(piece.token);
			}
			if (piece.usage) {
				usage = {
					input: piece.usage.input ?? usage?.input,
					output: piece.usage.output ?? usage?.output,
				};
			}
		};

		try {
			await streamFetchResponse({
				url,
				headers,
				body: JSON.stringify(payload),
				provider: 'gemini',
				model: this.modelName,
				signal: req.signal,
				onChunk: (chunk) => {
					for (const sse of parser.push(chunk)) {
						consumeSse(sse);
					}
				},
			});

			for (const sse of parser.flush()) {
				consumeSse(sse);
			}

			return { text: fullText, usage };
		} catch (error) {
			if (
				error instanceof LlmProviderError &&
				error.code === 'CORS_OR_NETWORK' &&
				!req.signal.aborted
			) {
				const fallbackText = await this.complete({
					system: req.system,
					messages: req.messages,
					temperature: req.temperature,
					signal: req.signal,
				});
				if (fallbackText) {
					req.onToken(fallbackText);
				}
				return { text: fallbackText };
			}
			throw error;
		}
	}

	async complete(req: LlmCompleteRequest): Promise<string> {
		const headers = this.getHeaders();

		const generationConfig: Record<string, unknown> = {
			temperature: req.temperature ?? 0.2,
		};
		if (req.jsonMode) {
			generationConfig.responseMimeType = 'application/json';
		}

		const payload: Record<string, unknown> = {
			contents: toGeminiContents(req.messages),
			generationConfig,
		};
		if (req.system.trim()) {
			payload.systemInstruction = {
				parts: [{ text: req.system }],
			};
		}

		const encodedModel = encodeURIComponent(this.modelName);
		const url = `${GEMINI_API_BASE}/models/${encodedModel}:generateContent`;

		const data = (await obsidianJsonRequest({
			url,
			method: 'POST',
			headers,
			body: JSON.stringify(payload),
			provider: 'gemini',
			model: this.modelName,
			signal: req.signal,
		})) as {
			candidates?: Array<{
				content?: { parts?: Array<{ text?: string }> };
			}>;
		};

		const parts = data?.candidates?.[0]?.content?.parts;
		if (!Array.isArray(parts)) {
			return '';
		}

		return parts
			.filter((part) => typeof part.text === 'string')
			.map((part) => part.text ?? '')
			.join('');
	}

	async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
		if (texts.length === 0) {
			return [];
		}

		const headers = this.getHeaders();
		const modelPath = this.modelId.startsWith('models/')
			? this.modelId
			: `models/${this.modelId}`;
		const url = `${GEMINI_API_BASE}/${modelPath}:batchEmbedContents`;

		const data = (await obsidianJsonRequest({
			url,
			method: 'POST',
			headers,
			body: JSON.stringify({
				requests: texts.map((text) => ({
					model: modelPath,
					content: {
						parts: [{ text }],
					},
				})),
			}),
			provider: 'gemini',
			model: this.modelId,
			signal,
		})) as {
			embeddings?: Array<{ values?: number[] }>;
		};

		if (!Array.isArray(data?.embeddings)) {
			throw new LlmProviderError({
				code: 'INVALID_JSON',
				provider: 'gemini',
				model: this.modelId,
				message: 'Gemini :batchEmbedContents response is missing embeddings.',
			});
		}

		return data.embeddings.map((entry) => entry.values ?? []);
	}
}
