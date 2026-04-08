import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

type DragStart = { panX: number; panY: number; cx: number; cy: number };

/** Pan (drag) RGB preview when zoom > 1; resets on zoom ≤ 1 or when `resetKey` changes. */
export function useRgbPreviewPan(
  zoom: number,
  resetKey: string | number | null | undefined,
  extraClassName = ""
) {
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<DragStart | null>(null);
  const resetKeyRef = useRef(resetKey);

  useEffect(() => {
    if (zoom <= 1) setPan({ x: 0, y: 0 });
  }, [zoom]);

  useEffect(() => {
    if (resetKey !== resetKeyRef.current) {
      resetKeyRef.current = resetKey;
      setPan({ x: 0, y: 0 });
    }
  }, [resetKey]);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (zoom <= 1) return;
      if (e.button !== 0) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setDragging(true);
      dragStartRef.current = {
        panX: pan.x,
        panY: pan.y,
        cx: e.clientX,
        cy: e.clientY,
      };
    },
    [zoom, pan.x, pan.y]
  );

  const onPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const s = dragStartRef.current;
    if (!s) return;
    setPan({
      x: s.panX + (e.clientX - s.cx),
      y: s.panY + (e.clientY - s.cy),
    });
  }, []);

  const endDrag = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return;
    dragStartRef.current = null;
    setDragging(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* released */
    }
  }, []);

  const onLostPointerCapture = useCallback(() => {
    dragStartRef.current = null;
    setDragging(false);
  }, []);

  const grab =
    zoom > 1 ? (dragging ? "cursor-grabbing select-none" : "cursor-grab select-none") : "";

  return {
    className: `relative inline-block${grab ? ` ${grab}` : ""}${extraClassName ? ` ${extraClassName}` : ""}`,
    style: {
      transform: `translate(${pan.x}px, ${pan.y}px)`,
      ...(zoom > 1 ? { touchAction: "none" as const } : {}),
    },
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture,
  };
}
