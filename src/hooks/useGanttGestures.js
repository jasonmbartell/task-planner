import { useEffect, useRef } from 'react';

const ZOOM_LEVELS = ['month', 'week', 'day'];
const PINCH_IN_THRESHOLD = 0.67;
const PINCH_OUT_THRESHOLD = 1.5;

function getDistance(t1, t2) {
  const dx = t1.clientX - t2.clientX;
  const dy = t1.clientY - t2.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function getMidpoint(t1, t2) {
  return {
    x: (t1.clientX + t2.clientX) / 2,
    y: (t1.clientY + t2.clientY) / 2,
  };
}

export default function useGanttGestures(scrollRef, zoom, setZoom) {
  const initialDistance = useRef(null);
  const isPinching = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const handleTouchStart = (e) => {
      if (e.touches.length === 2) {
        isPinching.current = true;
        initialDistance.current = getDistance(e.touches[0], e.touches[1]);
      }
    };

    const handleTouchMove = (e) => {
      if (e.touches.length !== 2 || !isPinching.current || !initialDistance.current) return;

      e.preventDefault();

      const currentDistance = getDistance(e.touches[0], e.touches[1]);
      const ratio = currentDistance / initialDistance.current;

      const idx = ZOOM_LEVELS.indexOf(zoom);

      if (ratio > PINCH_OUT_THRESHOLD && idx < ZOOM_LEVELS.length - 1) {
        // Pinch out = zoom in (more detail)
        const midpoint = getMidpoint(e.touches[0], e.touches[1]);
        const rect = el.getBoundingClientRect();
        const relativeX = midpoint.x - rect.left + el.scrollLeft;
        const fraction = relativeX / (el.scrollWidth || 1);

        setZoom(ZOOM_LEVELS[idx + 1]);
        initialDistance.current = currentDistance;

        // Re-center on pinch midpoint after zoom
        requestAnimationFrame(() => {
          const newScrollX = fraction * el.scrollWidth - (midpoint.x - rect.left);
          el.scrollLeft = Math.max(0, newScrollX);
        });
      } else if (ratio < PINCH_IN_THRESHOLD && idx > 0) {
        // Pinch in = zoom out (less detail)
        const midpoint = getMidpoint(e.touches[0], e.touches[1]);
        const rect = el.getBoundingClientRect();
        const relativeX = midpoint.x - rect.left + el.scrollLeft;
        const fraction = relativeX / (el.scrollWidth || 1);

        setZoom(ZOOM_LEVELS[idx - 1]);
        initialDistance.current = currentDistance;

        requestAnimationFrame(() => {
          const newScrollX = fraction * el.scrollWidth - (midpoint.x - rect.left);
          el.scrollLeft = Math.max(0, newScrollX);
        });
      }
    };

    const handleTouchEnd = (e) => {
      if (e.touches.length < 2) {
        isPinching.current = false;
        initialDistance.current = null;
      }
    };

    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchmove', handleTouchMove, { passive: false });
    el.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', handleTouchEnd);
    };
  }, [scrollRef, zoom, setZoom]);
}
