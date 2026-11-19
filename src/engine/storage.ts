import type { GraphEdge, GraphNode } from '../types';

export interface GraphCacheSnapshot {
	version: number;
	nodes: GraphNode[];
	edges: GraphEdge[];
	ignoreRaw: string;
	savedAt: number;
}

const DB_VERSION = 1;
const STORE_NAME = 'graph_cache';
const SNAPSHOT_KEY = 'snapshot';

/**
 * IndexedDB storage for rebuildable graph cache (`lore-engine-ai:<vaultName>`).
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
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					db.createObjectStore(STORE_NAME);
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
							'Failed to open IndexedDB graph cache',
					),
				);
			};
		});
	}

	async loadSnapshot(): Promise<GraphCacheSnapshot | null> {
		const db = await this.open();
		if (!db) {
			return null;
		}

		return new Promise<GraphCacheSnapshot | null>((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readonly');
			const store = tx.objectStore(STORE_NAME);
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
		if (!db) {
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
			const tx = db.transaction(STORE_NAME, 'readwrite');
			const store = tx.objectStore(STORE_NAME);
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

	async clear(): Promise<void> {
		const db = await this.open();
		if (!db) {
			return;
		}

		return new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, 'readwrite');
			const store = tx.objectStore(STORE_NAME);
			const request = store.delete(SNAPSHOT_KEY);

			request.onsuccess = () => resolve();
			request.onerror = () => {
				reject(
					new Error(
						request.error?.message ??
							'Failed to clear graph cache',
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
