import {
	cosineSimilarity,
	DEFAULT_ANCHOR_EXCLUDED_TYPES,
	fuseHybridRankings,
	searchBm25,
	type HybridAnchorMatch,
} from '../core/bm25';
import type { IEmbeddingProvider } from '../llm/llmProvider';
import { isAbortError } from '../llm/streaming';
import type { EntityType, GraphNode } from '../types';
import type { CachedNodeVector, GraphStorage } from './storage';

const EMBED_BATCH_SIZE = 16;
const MAX_EMBED_CHARS = 2400;

export interface EmbeddingSyncResult {
	updated: number;
	totalPending: number;
	skipped: boolean;
	aborted?: boolean;
	error?: string;
}

export interface AnchorSearchOutput {
	results: HybridAnchorMatch[];
	usedVectors: boolean;
	fallbackReason?: string;
}

/**
 * Deterministic 32-bit FNV-1a hex hash for fast note content change detection.
 */
export function hashNodeContent(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}

/**
 * Builds a bounded embedding input string (truncating long notes safely).
 */
export function buildEmbeddingText(node: GraphNode): string {
	const headerParts: string[] = [node.title];
	if (node.aliases.length > 0) {
		headerParts.push(`Aliases: ${node.aliases.join(', ')}`);
	}
	if (node.tags.length > 0) {
		headerParts.push(`Tags: ${node.tags.join(' ')}`);
	}
	const header = headerParts.join('\n');
	const remainingBudget = Math.max(200, MAX_EMBED_CHARS - header.length - 2);
	const body =
		node.content.length > remainingBudget
			? node.content.slice(0, remainingBudget)
			: node.content;
	return `${header}\n\n${body}`.trim();
}

function getFullModelId(provider: IEmbeddingProvider): string {
	return `${provider.providerId}:${provider.modelId}`;
}

export class VectorIndex {
	private readonly storage: GraphStorage;
	private modelId = '';
	private vectors = new Map<string, CachedNodeVector>();

	constructor(storage: GraphStorage) {
		this.storage = storage;
	}

	async initialize(): Promise<void> {
		try {
			const snapshot = await this.storage.loadVectorSnapshot();
			if (!snapshot) {
				return;
			}
			this.modelId = snapshot.modelId;
			this.vectors.clear();
			for (const entry of snapshot.entries) {
				this.vectors.set(entry.nodeId, entry);
			}
		} catch {
			this.vectors.clear();
		}
	}

	getCachedVectorCount(): number {
		return this.vectors.size;
	}

	getModelId(): string {
		return this.modelId;
	}

	/**
	 * Incrementally embeds dirty/changed nodes in batches with progress and cancellation.
	 * Embedding failures never throw out of sync: partial progress is persisted and
	 * reported in `result.error`.
	 */
	async syncEmbeddings(options: {
		nodes: GraphNode[];
		provider: IEmbeddingProvider | null;
		signal?: AbortSignal;
		onProgress?: (done: number, total: number) => void;
	}): Promise<EmbeddingSyncResult> {
		const { nodes, provider, signal, onProgress } = options;

		if (!provider) {
			return { updated: 0, totalPending: 0, skipped: true };
		}

		const fullModelId = getFullModelId(provider);
		if (this.modelId && this.modelId !== fullModelId) {
			this.vectors.clear();
		}
		this.modelId = fullModelId;

		const validIds = new Set(nodes.map((node) => node.id));
		for (const cachedId of Array.from(this.vectors.keys())) {
			if (!validIds.has(cachedId)) {
				this.vectors.delete(cachedId);
			}
		}

		const toEmbed: Array<{
			node: GraphNode;
			text: string;
			contentHash: string;
		}> = [];

		for (const node of nodes) {
			const text = buildEmbeddingText(node);
			if (!text) {
				continue;
			}
			const contentHash = hashNodeContent(text);
			const cached = this.vectors.get(node.id);
			if (
				!cached ||
				cached.mtime !== node.mtime ||
				cached.contentHash !== contentHash
			) {
				toEmbed.push({ node, text, contentHash });
			}
		}

		if (toEmbed.length === 0) {
			await this.storage.saveVectorSnapshot(
				this.modelId,
				Array.from(this.vectors.values()),
			);
			return { updated: 0, totalPending: 0, skipped: false };
		}

		let updated = 0;
		const total = toEmbed.length;

		try {
			for (let offset = 0; offset < total; offset += EMBED_BATCH_SIZE) {
				if (signal?.aborted) {
					return {
						updated,
						totalPending: total,
						skipped: false,
						aborted: true,
					};
				}

				const batch = toEmbed.slice(offset, offset + EMBED_BATCH_SIZE);
				const batchVectors = await provider.embed(
					batch.map((item) => item.text),
					signal,
				);

				for (let i = 0; i < batch.length; i++) {
					const item = batch[i];
					const rawVec = batchVectors[i];
					if (!item || !rawVec || rawVec.length === 0) {
						continue;
					}
					this.vectors.set(item.node.id, {
						nodeId: item.node.id,
						mtime: item.node.mtime,
						contentHash: item.contentHash,
						vector: new Float32Array(rawVec),
					});
					updated += 1;
				}

				onProgress?.(Math.min(offset + batch.length, total), total);
			}

			return { updated, totalPending: total, skipped: false };
		} catch (error) {
			if (isAbortError(error) || signal?.aborted) {
				return {
					updated,
					totalPending: total,
					skipped: false,
					aborted: true,
				};
			}
			return {
				updated,
				totalPending: total,
				skipped: false,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			try {
				await this.storage.saveVectorSnapshot(
					this.modelId,
					Array.from(this.vectors.values()),
				);
			} catch {
				// Ignore secondary cache persistence failures
			}
		}
	}

	/**
	 * Performs hybrid anchor search (BM25 + vector cosine similarity),
	 * degrading gracefully to BM25-only if embeddings are missing or fail.
	 */
	async searchAnchors(params: {
		query: string;
		nodes: GraphNode[];
		topK?: number;
		provider: IEmbeddingProvider | null;
		signal?: AbortSignal;
		excludeTypes?: readonly EntityType[];
	}): Promise<AnchorSearchOutput> {
		const topK = params.topK ?? 5;
		const excludeTypes =
			params.excludeTypes ?? DEFAULT_ANCHOR_EXCLUDED_TYPES;
		const excluded = new Set<EntityType>(excludeTypes);
		const eligibleNodes = params.nodes.filter(
			(node) => !excluded.has(node.type),
		);
		const lexical = searchBm25(eligibleNodes, params.query, topK * 4, {
			excludeTypes,
		});

		if (!params.provider) {
			return {
				results: fuseHybridRankings(lexical, [], topK),
				usedVectors: false,
				fallbackReason: 'no_provider',
			};
		}

		const fullModelId = getFullModelId(params.provider);
		if (this.modelId !== fullModelId || this.vectors.size === 0) {
			return {
				results: fuseHybridRankings(lexical, [], topK),
				usedVectors: false,
				fallbackReason: 'vectors_not_indexed',
			};
		}

		try {
			const queryEmbeddings = await params.provider.embed(
				[params.query],
				params.signal,
			);
			const rawQueryVec = queryEmbeddings[0];
			if (!rawQueryVec || rawQueryVec.length === 0) {
				return {
					results: fuseHybridRankings(lexical, [], topK),
					usedVectors: false,
					fallbackReason: 'empty_query_vector',
				};
			}

			const queryVec = new Float32Array(rawQueryVec);
			const vectorScores: Array<{ nodeId: string; score: number }> = [];

			for (const node of eligibleNodes) {
				const cached = this.vectors.get(node.id);
				if (!cached) {
					continue;
				}
				const sim = cosineSimilarity(queryVec, cached.vector);
				if (sim > 0) {
					vectorScores.push({
						nodeId: node.id,
						score: Number(sim.toFixed(6)),
					});
				}
			}

			return {
				results: fuseHybridRankings(lexical, vectorScores, topK),
				usedVectors: true,
			};
		} catch (error) {
			return {
				results: fuseHybridRankings(lexical, [], topK),
				usedVectors: false,
				fallbackReason:
					error instanceof Error ? error.message : String(error),
			};
		}
	}
}
