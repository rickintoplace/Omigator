import { type FocusEvent, type PointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DatasetResult } from '../core';

/** Touch has no hover: a touch on the list holds the order this long. */
const TOUCH_HOLD_MS = 4000;

/**
 * Live ranking moves rows while the user reaches for them. During a run, rows keep their places
 * while the user works in the list (pointer over it, keyboard focus in it, a recent touch, or a
 * row open); when they leave, the rows slide to their ranks. Rows carry `data-gse`.
 */
export function useHeldOrder(results: DatasetResult[], running: boolean, rowOpen: boolean) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [pointer, setPointer] = useState(false);
  const [focus, setFocus] = useState(false);
  const [touch, setTouch] = useState(false);
  const touchTimer = useRef<number>(undefined);
  useEffect(() => () => clearTimeout(touchTimer.current), []);

  // A hold that began during the run lasts until the user leaves, even if the run ends meanwhile.
  const frozen = useRef<Map<string, number> | undefined>(undefined);
  const held = (pointer || focus || touch || (running && rowOpen)) && (running || frozen.current !== undefined);
  if (!held) frozen.current = undefined;
  else frozen.current ??= new Map(results.map((r, i) => [r.gse, i]));
  const at = frozen.current;
  // Datasets that arrive during the hold go below the held ones, in live order.
  const order = at
    ? results
        .map((r, i) => ({ r, k: at.get(r.gse) ?? at.size + i }))
        .sort((a, b) => a.k - b.k)
        .map(({ r }) => r)
    : results;

  // FLIP: remember where rows sat while held, and animate them from there once released.
  const tops = useRef(new Map<string, number>());
  const wasHeld = useRef(false);
  useLayoutEffect(() => {
    if (!held && !wasHeld.current) return;
    const rows = [...(listRef.current?.children ?? [])] as HTMLElement[];
    if (held) tops.current = new Map(rows.map((el) => [el.dataset.gse!, el.offsetTop]));
    else if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const el of rows) {
        const dy = (tops.current.get(el.dataset.gse!) ?? el.offsetTop) - el.offsetTop;
        if (dy) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 350, easing: 'cubic-bezier(.2,.7,.3,1)' });
      }
    }
    wasHeld.current = held;
  });

  // The list unmounts on a tab switch without a pointerleave or blur.
  const ref = useCallback((el: HTMLDivElement | null) => {
    listRef.current = el;
    if (el) return;
    setPointer(false);
    setFocus(false);
  }, []);

  const listProps = {
    ref,
    onPointerEnter: (e: PointerEvent) => e.pointerType !== 'touch' && setPointer(true),
    onPointerLeave: (e: PointerEvent) => e.pointerType !== 'touch' && setPointer(false),
    // Only keyboard focus holds; a clicked button keeps focus after the pointer has left.
    onFocus: (e: FocusEvent) => setFocus(e.target.matches(':focus-visible')),
    onBlur: (e: FocusEvent) => !e.currentTarget.contains(e.relatedTarget) && setFocus(false),
    onTouchStart: () => {
      setTouch(true);
      clearTimeout(touchTimer.current);
      touchTimer.current = window.setTimeout(() => setTouch(false), TOUCH_HOLD_MS);
    },
  };

  return { order, held, listProps };
}
