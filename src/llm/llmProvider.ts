import { requestUrl } from 'obsidian';
import { calibrateTokenizer, estimateTokens } from '../core/tokenizer';
import type { LlmProviderId, PluginSettings } from '../types';
import { AnthropicProvider } from './cloud/anthropic';
import { GeminiProvider } from './cloud/gemini';
import { OpenAiProvider } from './cloud/openai';
import { OllamaClient } from './ollamaClient';
import {
	assertCloudConsent,
	classifyHttpStatusError,
	createAbortError,
	LlmProviderError,
} from './streaming';

export interface LlmChatMessage {
	role: 'user' | 'assistant';
	content: string;
}

export interface LlmUsage {
	input?: number;
	output?: number;
}

export interface LlmStreamRequest {
	system: string;
	messages: LlmChatMessage[];
	temperature?: number;
	signal: AbortSignal;
	onToken: (token: string) => void;
}

export interface LlmCompleteRequest {
	system: string;
	messages: LlmChatMessage[];
	temperature?: number;
	jsonMode?: boolean;
	signal?: AbortSignal;
}

export interface LlmStreamResult {
	text: string;
	usage?: LlmUsage;
}

export interface ILlmProvider {
	readonly providerId: LlmProviderId;
	readonly modelName: string;
	stream(req: LlmStreamRequest): Promise<LlmStreamResult>;
	complete(req: LlmCompleteRequest): Promise<string>;
}

export interface IEmbeddingProvider {
	readonly providerId: LlmProviderId;
	readonly modelId: string;
	embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

function getHeaderCaseInsensitive(
	headers: Record<string, string>,
	target: string,
): string | null {
	const lowerTarget = target.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerTarget) {
			return value;
		}
	}
	return null;
}

/**
 * Executes a non-streaming JSON HTTP request via Obsidian's `requestUrl`
 * (bypasses browser CORS) and maps errors to typed `LlmProviderError`.
 */
export async function obsidianJsonRequest(params: {
	url: string;
	method?: 'GET' | 'POST';
	headers?: Record<string, string>;
	body?: string;
	provider: LlmProviderId;
	model?: string;
	signal?: AbortSignal;
}): Promise<unknown> {
	if (params.signal?.aborted) {
		throw createAbortError(params.provider);
	}

	let response;
	try {
		response = await requestUrl({
			url: params.url,
			method: params.method ?? 'POST',
			headers: params.headers,
			body: params.body,
			throw: false,
		});
	} catch (error) {
		if (params.signal?.aborted) {
			throw createAbortError(params.provider);
		}
		throw new LlmProviderError({
			code: 'CORS_OR_NETWORK',
			provider: params.provider,
			url: params.url,
			message: error instanceof Error ? error.message : String(error),
		});
	}

	if (params.signal?.aborted) {
		throw createAbortError(params.provider);
	}

	if (response.status < 200 || response.status >= 300) {
		throw classifyHttpStatusError({
			provider: params.provider,
			status: response.status,
			bodyText: response.text,
			retryAfterHeader: getHeaderCaseInsensitive(
				response.headers,
				'retry-after',
			),
			model: params.model,
		});
	}

	try {
		return JSON.parse(response.text) as unknown;
	} catch (error) {
		throw new LlmProviderError({
			code: 'INVALID_JSON',
			provider: params.provider,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

function buildRawLlmProvider(settings: PluginSettings): ILlmProvider {
	switch (settings.llmProvider) {
		case 'ollama':
			return new OllamaClient({
				baseUrl: settings.ollamaUrl,
				modelName: settings.modelName,
				embeddingModel: settings.embeddingModel,
			});
		case 'openai':
			return new OpenAiProvider({
				apiKey: settings.apiKeys.openai ?? '',
				modelName: settings.modelName,
				embeddingModel: settings.embeddingModel,
			});
		case 'anthropic':
			return new AnthropicProvider({
				apiKey: settings.apiKeys.anthropic ?? '',
				modelName: settings.modelName,
			});
		case 'gemini':
			return new GeminiProvider({
				apiKey: settings.apiKeys.gemini ?? '',
				modelName: settings.modelName,
				embeddingModel: settings.embeddingModel,
			});
	}
}

function estimatePromptTokens(req: LlmStreamRequest, modelName: string): number {
	const fullPrompt = [
		req.system,
		...req.messages.map((m) => m.content),
	].join('\n');
	return estimateTokens(fullPrompt, modelName);
}

/**
 * Creates a consent-checked and tokenizer-calibrated ILlmProvider for the active settings.
 */
export function createLlmProvider(settings: PluginSettings): ILlmProvider {
	const inner = buildRawLlmProvider(settings);

	return {
		providerId: inner.providerId,
		modelName: inner.modelName,
		async stream(req: LlmStreamRequest): Promise<LlmStreamResult> {
			assertCloudConsent(settings.llmProvider, settings.cloudConsentGiven);
			const result = await inner.stream(req);

			if (result.usage?.input !== undefined && result.usage.input > 0) {
				const estimated = estimatePromptTokens(req, inner.modelName);
				if (estimated > 0) {
					calibrateTokenizer(
						result.usage.input,
						estimated,
						inner.modelName,
					);
				}
			}

			return result;
		},
		async complete(req: LlmCompleteRequest): Promise<string> {
			assertCloudConsent(settings.llmProvider, settings.cloudConsentGiven);
			return inner.complete(req);
		},
	};
}

/**
 * Creates a consent-checked IEmbeddingProvider for the active settings.
 * Returns null if `embeddingProvider` is set to `'anthropic'` (unsupported).
 */
export function createEmbeddingProvider(
	settings: PluginSettings,
): IEmbeddingProvider | null {
	if (settings.embeddingProvider === 'anthropic') {
		return null;
	}

	let inner: IEmbeddingProvider;
	switch (settings.embeddingProvider) {
		case 'ollama':
			inner = new OllamaClient({
				baseUrl: settings.ollamaUrl,
				modelName: settings.modelName,
				embeddingModel: settings.embeddingModel,
			});
			break;
		case 'openai':
			inner = new OpenAiProvider({
				apiKey: settings.apiKeys.openai ?? '',
				modelName: settings.modelName,
				embeddingModel: settings.embeddingModel,
			});
			break;
		case 'gemini':
			inner = new GeminiProvider({
				apiKey: settings.apiKeys.gemini ?? '',
				modelName: settings.modelName,
				embeddingModel: settings.embeddingModel,
			});
			break;
	}

	return {
		providerId: inner.providerId,
		modelId: inner.modelId,
		async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
			assertCloudConsent(
				settings.embeddingProvider,
				settings.cloudConsentGiven,
			);
			return inner.embed(texts, signal);
		},
	};
}
