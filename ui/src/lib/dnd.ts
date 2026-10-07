import {
	draggable,
	dropTargetForElements,
	monitorForElements,
	type ElementEventBasePayload
} from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
import { attachClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/attach-closest-edge';
import { extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/extract-closest-edge';
import {
	autoScrollForElements,
	autoScrollWindowForElements
} from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';

type Column = { room: string; columnId: string };
type Card = Column & { cardId: string };
export type Destination = { columnId: string; beforeId?: string };

function accepts(data: Record<string, unknown>, room: string) {
	return data.type === 'retro-card' && data.room === room && typeof data.cardId === 'string';
}

// Keep current parameters in closures: edits must not unregister targets mid-drag.
export function cardDrag(element: HTMLElement, initial: Card) {
	let params = initial;
	const handle = element.querySelector<HTMLElement>('.drag-handle')!;
	// A draggable ancestor can intercept native caret placement and text selection.
	const stopDrag = draggable({
		element: handle,
		getInitialData: () => ({ type: 'retro-card', ...params }),
		onGenerateDragPreview({ nativeSetDragImage, location }) {
			const bounds = element.getBoundingClientRect();
			nativeSetDragImage?.(
				element,
				location.current.input.clientX - bounds.left,
				location.current.input.clientY - bounds.top
			);
		}
	});
	const stopDrop = dropTargetForElements({
		element,
		canDrop: ({ source }) => accepts(source.data, params.room),
		getData: ({ input }) =>
			attachClosestEdge(
				{ type: 'card', ...params },
				{ element, input, allowedEdges: ['top', 'bottom'] }
			)
	});
	return {
		update(next: Card) {
			params = next;
		},
		destroy() {
			stopDrag();
			stopDrop();
		}
	};
}

export function columnDrop(element: HTMLElement, initial: Column) {
	let params = initial;
	const stop = dropTargetForElements({
		element,
		canDrop: ({ source }) => accepts(source.data, params.room),
		getData: () => ({ type: 'column', ...params })
	});
	return {
		update(next: Column) {
			params = next;
		},
		destroy: stop
	};
}

export function boardScroll(element: HTMLElement) {
	const canScroll = ({ source }: { source: { data: Record<string, unknown> } }) =>
		source.data.type === 'retro-card';
	const stopElement = autoScrollForElements({
		element,
		canScroll,
		getAllowedAxis: () => 'horizontal'
	});
	const stopWindow = autoScrollWindowForElements({ canScroll });
	return {
		destroy() {
			stopElement();
			stopWindow();
		}
	};
}

export function watchCards(options: {
	room: () => string | undefined;
	cards: (columnId: string) => { id: string }[];
	preview: (cardId: string, target: Destination | null) => void;
	drop: (cardId: string, target: Destination) => void;
}) {
	function destination({ source, location }: ElementEventBasePayload): Destination | null {
		const target = location.current.dropTargets[0];
		if (!target || typeof target.data.columnId !== 'string') return null;
		const columnId = target.data.columnId;
		const cards = options.cards(columnId);
		if (target.data.type !== 'card') return { columnId };
		const index = cards.findIndex((card) => card.id === target.data.cardId);
		if (index === -1) return null;
		const bottom = extractClosestEdge(target.data) === 'bottom';
		// Remove the dragged card from the insertion calculation, including self-hover.
		const next = cards
			.slice(index + (bottom ? 1 : 0))
			.find((card) => card.id !== source.data.cardId);
		return { columnId, beforeId: next?.id };
	}
	const preview = (event: ElementEventBasePayload) =>
		options.preview(event.source.data.cardId as string, destination(event));
	return monitorForElements({
		canMonitor: ({ source }) => accepts(source.data, options.room() ?? ''),
		onDragStart: preview,
		onDrag: preview,
		onDropTargetChange: preview,
		onDrop(event) {
			const target = destination(event);
			options.preview('', null);
			if (target) options.drop(event.source.data.cardId as string, target);
		}
	});
}
