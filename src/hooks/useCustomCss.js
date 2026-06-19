import { useEffect } from 'react';
import useStore from '../store/useStore';

const STYLE_ATTR = 'data-custom-css-snippet';

export default function useCustomCss() {
  const snippets = useStore((s) => s.customCssConfig?.snippets) || [];

  useEffect(() => {
    const head = document.head;
    const existing = new Map();
    head.querySelectorAll(`style[${STYLE_ATTR}]`).forEach((el) => {
      existing.set(el.getAttribute(STYLE_ATTR), el);
    });

    const wanted = new Set();
    for (const snippet of snippets) {
      if (!snippet?.enabled || typeof snippet.css !== 'string' || !snippet.css.trim()) continue;
      wanted.add(snippet.id);
      const el = existing.get(snippet.id);
      if (el) {
        if (el.textContent !== snippet.css) el.textContent = snippet.css;
      } else {
        const style = document.createElement('style');
        style.setAttribute(STYLE_ATTR, snippet.id);
        style.textContent = snippet.css;
        head.appendChild(style);
      }
    }

    for (const [id, el] of existing) {
      if (!wanted.has(id)) el.remove();
    }
  }, [snippets]);
}
