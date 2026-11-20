import type { GraphEdge, GraphNode } from '../types';

export interface GraphCacheSnapshot {
	version: number;
	nodes: GraphNode[];
	edges: GraphEdge[];
	ignoreRaw: string;
	savedAt: number;
}

export interface CachedNodeVector {
	nodeId: string;
	mtime: number;
	contentHash: string;
	vector: Float32Array;
}

export interface VectorCacheSnapshot {
	version: number;
	modelId: string;
	savedAt: number;
	entries: CachedNodeVector[];
}

const DB_VERSION = 2;
const GRAPH_STORE_NAME = 'graph_cache';
const VECTOR_STORE_NAME = 'vector_cache';
const SNAPSHOT_KEY = 'snapshot';

/**
 * IndexedDB storage for rebuildable graph & vector caches (`lore-engine-ai:<vaultName>`).
 * Persistent user data (settings, events.json) is never stored here.
 */
export class GraphStorage {
	private readonly dbName: string;
	private db: IDBDatabase | null = null;

	constructor(vaultName: string) {
		this.dbName = `lore-engine-ai:${vaultName}`;
	}

	private async open(): Promise<IDBDatabase | null> {
		if (typeof indexedDB === 'undefined') {
			return null;
		}
		if (this.db) {
			return this.db;
		}

		return new Promise<IDBDatabase | null>((resolve, reject) => {
			const request = indexedDB.open(this.dbName, DB_VERSION);

			request.onupgradeneeded = () => {
				const db = request.result;
				// Preserve existing v1 graph_cache store while adding v2 vector_cache store.
				if (!db.objectStoreNames.contains(GRAPH_STORE_NAME)) {
					db.createObjectStore(GRAPH_STORE_NAME);
				}
				if (!db.objectStoreNames.contains(VECTOR_STORE_NAME)) {
					db.createObjectStore(VECTOR_STORE_NAME);
				}
			};

			request.onsuccess = () => {
				const db = request.result;
				db.onversionchange = () => {
					db.close();
					if (this.db === db) {
						this.db = null;
					}
				};
				this.db = db;
				resolve(db);
			};

			request.onerror = () => {
				reject(
					new Error(
						request.error?.message ??
							'Failed to open IndexedDB cache',
					),
				);
			};
		});
	}

	async loadSnapshot(): Promise<GraphCacheSnapshot | null> {
		const db = await this.open();
		if (!db || !db.objectStoreNames.contains(GRAPH_STORE_NAME)) {
			return null;
		}

		return new Promise<GraphCacheSnapshot | null>((resolve, reject) => {
			const tx = db.transaction(GRAPH_STORE_NAME, 'readonly');
			const store = tx.objectStore(GRAPH_STORE_NAME);
			const request = store.get(SNAPSHOT_KEY);

			request.onsuccess = () => {
				const value = request.result as GraphCacheSnapshot | undefined;
				if (
					value &&
					typeof value === 'object' &&
					Array.isArray(value.nodes) &&
					Array.isArray(value.edges)
				) {
					resolve(value);
					return;
				}
				resolve(null);
			};

			request.onerror = () => {
				reject(
					new Error(
						request.error?.message ??
							'Failed to read graph cache snapshot',
					),
				);
			};
		});
	}

	async saveSnapshot(
		nodes: GraphNode[],
		edges: GraphEdge[],
		ignoreRaw: string,
	): Promise<void> {
		const db = await this.open();
		if (!db || !db.objectStoreNames.contains(GRAPH_STORE_NAME)) {
			return;
		}

		const snapshot: GraphCacheSnapshot = {
			version: DB_VERSION,
			nodes,
			edges,
			ignoreRaw,
			savedAt: Date.now(),
		};

		return new Promise<void>((resolve, reject) => {
			const tx = db.transaction(GRAPH_STORE_NAME, 'readwrite');
			const store = tx.objectStore(GRAPH_STORE_NAME);
			const request = store.put(snapshot, SNAPSHOT_KEY);

			request.onsuccess = () => resolve();
			request.onerror = () => {
				reject(
					new Error(
						request.error?.message ??
							'Failed to write graph cache snapshot',
					),
				);
			};
		});
	}

	async loadVectorSnapshot(): Promise<VectorCacheSnapshot | null> {
		const db = await this.open();
		if (!db || !db.objectStoreNames.contains(VECTOR_STORE_NAME)) {
			return null;
		}

		return new Promise<VectorCacheSnapshot | null>((resolve, reject) => {
			const tx = db.transaction(VECTOR_STORE_NAME, 'readonly');
			const store = tx.objectStore(VECTOR_STORE_NAME);
			const request = store.get(SNAPSHOT_KEY);

			request.onsuccess = () => {
				const raw = request.result as
					| {
							version?: number;
							modelId?: string;
							savedAt?: number;
							entries?: Array<{
								nodeId?: string;
								mtime?: number;
								contentHash?: string;
								vector?: Float32Array | number[];
							}>;
					  }
					| undefined;
				if (
					!raw ||
					typeof raw !== 'object' ||
					typeof raw.modelId !== 'string' ||
					!Array.isArray(raw.entries)
				) {
					resolve(null);
					return;
				}

				const entries: CachedNodeVector[] = [];
				for (const item of raw.entries) {
					if (
						typeof item.nodeId === 'string' &&
						typeof item.mtime === 'number' &&
						typeof item.contentHash === 'string' &&
						item.vector
					) {
						const vector =
							item.vector instanceof Float32Array
								? item.vector
								: new Float32Array(item.vector);
						entries.push({
							nodeId: item.nodeId,
							mtime: item.mtime,
							contentHash: item.contentHash,
							vector,
						});
					}
				}

				resolve({
					version: raw.version ?? DB_VERSION,
					modelId: raw.modelId,
					savedAt: raw.savedAt ?? Date.now(),
					entries,
				});
			};

			request.onerror = () => {
				reject(
					new Error(
						request.error?.message ??
							'Failed to read vector cache snapshot',
					),
				);
			};
		});
	}

	async saveVectorSnapshot(
		modelId: string,
		entries: CachedNodeVector[],
	): Promise<void> {
		const db = await this.open();
		if (!db || !db.objectStoreNames.contains(VECTOR_STORE_NAME)) {
			return;
		}

		const snapshot: VectorCacheSnapshot = {
			version: DB_VERSION,
			modelId,
			savedAt: Date.now(),
			entries,
		};

		return new Promise<void>((resolve, reject) => {
			const tx = db.transaction(VECTOR_STORE_NAME, 'readwrite');
			const store = tx.objectStore(VECTOR_STORE_NAME);
			const request = store.put(snapshot, SNAPSHOT_KEY);

			request.onsuccess = () => resolve();
			request.onerror = () => {
				reject(
					new Error(
						request.error?.message ??
							'Failed to write vector cache snapshot',
					),
				);
			};
		});
	}

	async clearVectorCache(): Promise<void> {
		const db = await this.open();
		if (!db || !db.objectStoreNames.contains(VECTOR_STORE_NAME)) {
			return;
		}

		return new Promise<void>((resolve, reject) => {
			const tx = db.transaction(VECTOR_STORE_NAME, 'readwrite');
			const store = tx.objectStore(VECTOR_STORE_NAME);
			const request = store.delete(SNAPSHOT_KEY);

			request.onsuccess = () => resolve();
			request.onerror = () => {
				reject(
					new Error(
						request.error?.message ??
							'Failed to clear vector cache',
					),
				);
			};
		});
	}

	async clear(): Promise<void> {
		const db = await this.open();
		if (!db) {
			return;
		}

		const storesToClear = [GRAPH_STORE_NAME, VECTOR_STORE_NAME].filter(
			(name) => db.objectStoreNames.contains(name),
		);
		if (storesToClear.length === 0) {
			return;
		}

		return new Promise<void>((resolve, reject) => {
			const tx = db.transaction(storesToClear, 'readwrite');
			for (const storeName of storesToClear) {
				tx.objectStore(storeName).delete(SNAPSHOT_KEY);
			}

			tx.oncomplete = () => resolve();
			tx.onerror = () => {
				reject(
					new Error(
						tx.error?.message ?? 'Failed to clear IndexedDB caches',
					),
				);
			};
		});
	}

	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}
}
