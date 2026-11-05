import { useEffect, useRef, useState } from 'react';
import { api } from './api';

/**
 * The search box text: filters as you type, saved to the view settings a
 * moment after typing stops. An import that replaces the saved text replaces
 * the box too. Kept by the window (App.tsx), not by the board, so the yellow
 * bars are judged on the text in effect even while the settings page is up
 * (the board is unmounted then) — GitHub#153.
 */
export function useQuery(saved: string): [string, (q: string) => void] {
  const [text, setText] = useState(saved);
  const lastSent = useRef(saved);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (saved !== lastSent.current) {
      lastSent.current = saved;
      setText(saved);
    }
  }, [saved]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const update = (q: string) => {
    setText(q);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      lastSent.current = q;
      void api().setView({ query: q });
    }, 300);
  };
  return [text, update];
}
