import type {
	ILlmProvider,
	LlmCompleteRequest,
	LlmStreamRequest,
	LlmStreamResult,
	LlmUsage,
} from '../llmProvider';
import { obsidianJsonRequest } from '../llmProvider';
import {
	extractAnthropicPiece,
	LlmProviderError,
	SseStreamParser,
	streamFetchResponse,
} from '../streaming';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicConfig {
	apiKey: string;
	modelName: string;
}

export class AnthropicProvider implements ILlmProvider {
	readonly providerId = 'anthropic' as const;
	readonly modelName: string;
	private readonly apiKey: string;

	constructor(config: AnthropicConfig) {
		this.apiKey = config.apiKey.trim();
		this.modelName = config.modelName;
	}

	private getHeaders(): Record<string, string> {
		if (!this.apiKey) {
			throw new LlmProviderError({
				code: 'AUTH_ERROR',
				provider: 'anthropic',
				status: 401,
				message: 'Anthropic API key is empty.',
			});
		}
		return {
			'x-api-key': this.apiKey,
			'anthropic-version': ANTHROPIC_VERSION,
			'anthropic-dangerous-direct-browser-access': 'true',
			'content-type': 'application/json',
		};
	}

	async stream(req: LlmStreamRequest): Promise<LlmStreamResult> {
		const headers = this.getHeaders();
		const parser = new SseStreamParser();
		let fullText = '';
		let usage: LlmUsage | undefined;

		const body = JSON.stringify({
			model: this.modelName,
			max_tokens: DEFAULT_MAX_TOKENS,
			system: req.system,
			messages: req.messages,
			temperature: req.temperature ?? 0.3,
			stream: true,
		});

		const consumeSse = (sse: ReturnType<SseStreamParser['push']>[number]): void => {
			const piece = extractAnthropicPiece(sse);
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
				url: ANTHROPIC_API_URL,
				headers,
				body,
				provider: 'anthropic',
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

		const body = JSON.stringify({
			model: this.modelName,
			max_tokens: DEFAULT_MAX_TOKENS,
			system: req.system,
			messages: req.messages,
			temperature: req.temperature ?? 0.2,
			stream: false,
		});

		const data = (await obsidianJsonRequest({
			url: ANTHROPIC_API_URL,
			method: 'POST',
			headers,
			body,
			provider: 'anthropic',
			model: this.modelName,
			signal: req.signal,
		})) as {
			content?: Array<{ type?: string; text?: string }>;
		};

		if (!Array.isArray(data?.content)) {
			return '';
		}

		return data.content
			.filter((block) => block.type === 'text' && typeof block.text === 'string')
			.map((block) => block.text ?? '')
			.join('');
	}
}
