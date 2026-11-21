import { useRef, type DOMAttributes, type PointerEvent } from 'react';

const DRAG_THRESHOLD = 6;

interface DragGesture {
  pointerId: number;
  scrollTarget: Element;
  startPosition: number;
  startOffset: number;
  active: boolean;
}

export const dragScrollClass = 'select-none cursor-grab [&_button]:cursor-grab data-[dragging=true]:cursor-grabbing data-[dragging=true]:[&_button]:cursor-grabbing';

export function useDragScroll(axis: 'horizontal' | 'vertical'): DOMAttributes<HTMLDivElement> {
  const drag = useRef<DragGesture | null>(null);
  const suppressClick = useRef(false);
  const horizontal = axis === 'horizontal';
  const position = (event: PointerEvent<HTMLDivElement>) => horizontal ? event.clientX : event.clientY;

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    delete event.currentTarget.dataset.dragging;
  };

  return {
    onPointerDown(event) {
      suppressClick.current = false;
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      const surface = event.currentTarget;
      const scrollTarget = horizontal ? surface : surface.ownerDocument.scrollingElement;
      if (!scrollTarget) return;
      const canScroll = horizontal ? scrollTarget.scrollWidth > scrollTarget.clientWidth : scrollTarget.scrollHeight > scrollTarget.clientHeight;
      if (!canScroll) return;
      drag.current = {
        pointerId: event.pointerId,
        scrollTarget,
        startPosition: position(event),
        startOffset: horizontal ? scrollTarget.scrollLeft : scrollTarget.scrollTop,
        active: false,
      };
    },
    onPointerMove(event) {
      const gesture = drag.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const delta = position(event) - gesture.startPosition;
      if (!gesture.active) {
        if (Math.abs(delta) < DRAG_THRESHOLD) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.dragging = 'true';
        gesture.active = true;
        suppressClick.current = true;
      }
      const offset = gesture.startOffset - delta;
      if (horizontal) gesture.scrollTarget.scrollLeft = offset;
      else gesture.scrollTarget.scrollTop = offset;
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture: endDrag,
    onPointerLeave(event) {
      if (!drag.current?.active) endDrag(event);
    },
    onDragStart(event) {
      event.preventDefault();
    },
    onClickCapture(event) {
      if (!suppressClick.current || event.detail === 0) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
