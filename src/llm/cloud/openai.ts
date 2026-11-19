import type {
	IEmbeddingProvider,
	ILlmProvider,
	LlmCompleteRequest,
	LlmStreamRequest,
	LlmStreamResult,
	LlmUsage,
} from '../llmProvider';
import { obsidianJsonRequest } from '../llmProvider';
import {
	extractOpenAiPiece,
	LlmProviderError,
	SseStreamParser,
	streamFetchResponse,
} from '../streaming';

const OPENAI_API_BASE = 'https://api.openai.com/v1';

export interface OpenAiConfig {
	apiKey: string;
	modelName: string;
	embeddingModel: string;
}

export class OpenAiProvider implements ILlmProvider, IEmbeddingProvider {
	readonly providerId = 'openai' as const;
	readonly modelName: string;
	readonly modelId: string;
	private readonly apiKey: string;

	constructor(config: OpenAiConfig) {
		this.apiKey = config.apiKey.trim();
		this.modelName = config.modelName;
		this.modelId = config.embeddingModel;
	}

	private getHeaders(): Record<string, string> {
		if (!this.apiKey) {
			throw new LlmProviderError({
				code: 'AUTH_ERROR',
				provider: 'openai',
				status: 401,
				message: 'OpenAI API key is empty.',
			});
		}
		return {
			Authorization: `Bearer ${this.apiKey}`,
			'Content-Type': 'application/json',
		};
	}

	async stream(req: LlmStreamRequest): Promise<LlmStreamResult> {
		const headers = this.getHeaders();
		const parser = new SseStreamParser();
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
			temperature: req.temperature ?? 0.3,
			stream: true,
			stream_options: { include_usage: true },
		});

		const consumeSse = (sse: ReturnType<SseStreamParser['push']>[number]): void => {
			const piece = extractOpenAiPiece(sse);
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
				url: `${OPENAI_API_BASE}/chat/completions`,
				headers,
				body,
				provider: 'openai',
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
		const messages = [
			...(req.system.trim()
				? [{ role: 'system' as const, content: req.system }]
				: []),
			...req.messages,
		];

		const payload: Record<string, unknown> = {
			model: this.modelName,
			messages,
			temperature: req.temperature ?? 0.2,
			stream: false,
		};
		if (req.jsonMode) {
			payload.response_format = { type: 'json_object' };
		}

		const data = (await obsidianJsonRequest({
			url: `${OPENAI_API_BASE}/chat/completions`,
			method: 'POST',
			headers,
			body: JSON.stringify(payload),
			provider: 'openai',
			model: this.modelName,
			signal: req.signal,
		})) as {
			choices?: Array<{ message?: { content?: string } }>;
		};

		const content = data?.choices?.[0]?.message?.content;
		return typeof content === 'string' ? content : '';
	}

	async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
		if (texts.length === 0) {
			return [];
		}

		const headers = this.getHeaders();
		const data = (await obsidianJsonRequest({
			url: `${OPENAI_API_BASE}/embeddings`,
			method: 'POST',
			headers,
			body: JSON.stringify({
				model: this.modelId,
				input: texts,
			}),
			provider: 'openai',
			model: this.modelId,
			signal,
		})) as {
			data?: Array<{ index: number; embedding: number[] }>;
		};

		if (!Array.isArray(data?.data)) {
			throw new LlmProviderError({
				code: 'INVALID_JSON',
				provider: 'openai',
				model: this.modelId,
				message: 'OpenAI /embeddings response is missing data array.',
			});
		}

		return [...data.data]
			.sort((a, b) => a.index - b.index)
			.map((item) => item.embedding);
	}
}
