import type { EntityState, GraphNode, SessionEvent } from '../types';
import { matchEntityName } from './entityMatcher';
import { normalizeText } from './statusRules';

function stateChangeTargetsNode(
	changeSubject: string,
	event: SessionEvent,
	node: GraphNode,
	nodeNormalizedNames: Set<string>,
): boolean {
	const normSubject = normalizeText(changeSubject);
	if (normSubject && nodeNormalizedNames.has(normSubject)) {
		return true;
	}

	if (matchEntityName(changeSubject, [node]).id === node.id) {
		return true;
	}

	if (
		event.subjectIds.includes(node.id) &&
		event.subjects.length === 1 &&
		event.stateChanges.length === 1
	) {
		return true;
	}

	return false;
}

/**
 * Resolves the effective state of a node:
 * 1. Latest verified SessionEvent (by sessionId desc, createdAt desc) with a matching stateChange.
 * 2. Node's staticState (from tags/frontmatter) if not UNKNOWN.
 * 3. Default UNKNOWN state.
 */
export function resolveEffectiveState(
	node: GraphNode,
	events: SessionEvent[],
): EntityState {
	const nodeNames = new Set(
		[node.title, ...node.aliases]
			.map((name) => normalizeText(name))
			.filter((name) => name.length > 0),
	);

	const verifiedEvents = events
		.filter(
			(event) => event.userVerified && event.stateChanges.length > 0,
		)
		.sort((a, b) => {
			if (b.sessionId !== a.sessionId) {
				return b.sessionId - a.sessionId;
			}
			if (b.createdAt !== a.createdAt) {
				return b.createdAt - a.createdAt;
			}
			return a.id.localeCompare(b.id);
		});

	for (const event of verifiedEvents) {
		for (const change of event.stateChanges) {
			if (
				stateChangeTargetsNode(change.subject, event, node, nodeNames)
			) {
				return {
					statusType: change.newStatusType,
					statusNote: change.newStatusNote,
					sessionUpdated: event.sessionId,
					source: 'EVENT',
				};
			}
		}
	}

	if (node.staticState.statusType !== 'UNKNOWN') {
		return { ...node.staticState };
	}

	return {
		statusType: 'UNKNOWN',
		statusNote: node.staticState.statusNote || '',
		sessionUpdated: null,
		source: 'DEFAULT',
	};
}

/**
 * Returns verified events referencing a node, sorted from newest session to oldest.
 */
export function getVerifiedEventsForNode(
	nodeId: string,
	events: SessionEvent[],
): SessionEvent[] {
	return events
		.filter(
			(event) =>
				event.userVerified && event.subjectIds.includes(nodeId),
		)
		.sort((a, b) => {
			if (b.sessionId !== a.sessionId) {
				return b.sessionId - a.sessionId;
			}
			if (b.createdAt !== a.createdAt) {
				return b.createdAt - a.createdAt;
			}
			return a.id.localeCompare(b.id);
		});
}
