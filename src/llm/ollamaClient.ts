import type {
	IEmbeddingProvider,
	ILlmProvider,
	LlmCompleteRequest,
	LlmStreamRequest,
	LlmStreamResult,
	LlmUsage,
} from './llmProvider';
import { obsidianJsonRequest } from './llmProvider';
import {
	extractOllamaPiece,
	LlmProviderError,
	NdjsonStreamParser,
	streamFetchResponse,
} from './streaming';

export interface OllamaClientConfig {
	baseUrl: string;
	modelName: string;
	embeddingModel: string;
}

function normalizeOllamaBaseUrl(url: string): string {
	const trimmed = url.trim().replace(/\/+$/, '');
	return trimmed || 'http://localhost:11434';
}

export async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
	const cleanUrl = normalizeOllamaBaseUrl(baseUrl);
	const data = (await obsidianJsonRequest({
		url: `${cleanUrl}/api/tags`,
		method: 'GET',
		provider: 'ollama',
	})) as { models?: Array<{ name?: string }> };

	if (!Array.isArray(data?.models)) {
		return [];
	}

	return data.models
		.map((m) => (typeof m.name === 'string' ? m.name.trim() : ''))
		.filter((name) => name.length > 0);
}

export class OllamaClient implements ILlmProvider, IEmbeddingProvider {
	readonly providerId = 'ollama' as const;
	readonly modelName: string;
	readonly modelId: string;
	private readonly baseUrl: string;

	constructor(config: OllamaClientConfig) {
		this.baseUrl = normalizeOllamaBaseUrl(config.baseUrl);
		this.modelName = config.modelName;
		this.modelId = config.embeddingModel;
	}

	async stream(req: LlmStreamRequest): Promise<LlmStreamResult> {
		const parser = new NdjsonStreamParser('ollama');
		let fullText = '';
		let usage: LlmUsage | undefined;

		const messages = [
			...(req.system.trim()
				? [{ role: 'system' as const, content: req.system }]
				: []),
			...req.messages,
		];

		const body = JSON.stringify({
			model: this.modelName,
			messages,
			stream: true,
			options: {
				temperature: req.temperature ?? 0.3,
			},
		});

		const consumePayload = (payload: unknown): void => {
			const piece = extractOllamaPiece(payload);
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
				url: `${this.baseUrl}/api/chat`,
				headers: { 'Content-Type': 'application/json' },
				body,
				provider: 'ollama',
				model: this.modelName,
				signal: req.signal,
				onChunk: (chunk) => {
					for (const obj of parser.push(chunk)) {
						consumePayload(obj);
					}
				},
			});

			for (const obj of parser.flush()) {
				consumePayload(obj);
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
		const messages = [
			...(req.system.trim()
				? [{ role: 'system' as const, content: req.system }]
				: []),
			...req.messages,
		];

		const payload: Record<string, unknown> = {
			model: this.modelName,
			messages,
			stream: false,
			options: {
				temperature: req.temperature ?? 0.2,
			},
		};
		if (req.jsonMode) {
			payload.format = 'json';
		}

		const data = (await obsidianJsonRequest({
			url: `${this.baseUrl}/api/chat`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			provider: 'ollama',
			model: this.modelName,
			signal: req.signal,
		})) as {
			message?: { content?: string };
			error?: string;
		};

		if (typeof data?.error === 'string' && data.error.length > 0) {
			throw new LlmProviderError({
				code: 'PROVIDER_ERROR',
				provider: 'ollama',
				model: this.modelName,
				message: data.error,
			});
		}

		return typeof data?.message?.content === 'string'
			? data.message.content
			: '';
	}

	async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
		if (texts.length === 0) {
			return [];
		}

		const data = (await obsidianJsonRequest({
			url: `${this.baseUrl}/api/embed`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: this.modelId,
				input: texts,
			}),
			provider: 'ollama',
			model: this.modelId,
			signal,
		})) as { embeddings?: number[][] };

		if (!Array.isArray(data?.embeddings)) {
			throw new LlmProviderError({
				code: 'INVALID_JSON',
				provider: 'ollama',
				model: this.modelId,
				message: 'Ollama /api/embed response is missing embeddings array.',
			});
		}

		return data.embeddings;
	}
}
