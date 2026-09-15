import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)');
const ease = 'cubic-bezier(0.32, 0, 0.2, 1)';

// Decorative movement only. Source events, citation data and navigation remain authoritative.
export function useReaderMotion(surface, page, stopped) {
  useEffect(() => {
    const root = surface.current;
    if (!root || stopped) return;
    const lines = root.querySelector('.HPAG-reader-page-lines');
    const bank = root.querySelector('.HPAG-reader-line-bank');
    const lens = root.querySelector('.HPAG-reader-focus-lens');
    const light = root.querySelector('.HPAG-reader-reading-light');
    const media = reducedMotion();
    let seed = [...(page || 'atlas')].reduce((n, c) => ((n * 31) + c.charCodeAt(0)) >>> 0, 17);
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    let frame, last = 0, elapsed = 0, nextPause = 0, offset = 0, speed = 8;
    let targetSpeed = 8, x = 0.16, y = 0.18, targetX = x, targetY = y, pass = 0;
    let visible = true;
    let width = root.clientWidth, height = root.clientHeight, bankHeight = bank.offsetHeight;
    let lensSize = lens.offsetWidth;
    const measure = new ResizeObserver(() => {
      width = root.clientWidth;
      height = root.clientHeight;
      bankHeight = bank.offsetHeight;
      lensSize = lens.offsetWidth;
    });
    measure.observe(root);
    const visibility = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
    visibility.observe(root);
    const tick = time => {
      const dt = last ? Math.min(time - last, 48) : 0;
      last = time;
      // Preserve the last position as the old scene dissolves into the answer.
      if (visible && !document.hidden && !root.closest('[data-reader-leaving]')) {
        elapsed += dt;
        if (elapsed >= nextPause) {
          pass += 1;
          targetX = pass % 2 ? 0.52 + random() * 0.23 : 0.1 + random() * 0.23;
          targetY = 0.12 + random() * 0.48;
          targetSpeed = pass % 3 === 0 ? 1.5 : 8 + random() * 12;
          nextPause = elapsed + 1800 + random() * 2400;
        }
        const follow = 1 - Math.exp(-dt / 780);
        x += (targetX - x) * follow;
        y += (targetY - y) * follow;
        speed += (targetSpeed - speed) * (1 - Math.exp(-dt / 1100));
        offset += speed * dt / 1000;
        // Identical adjoining banks wrap off-screen, without fading or jumping backwards.
        const travel = bankHeight > 0 ? offset % bankHeight : 0;
        lines.style.transform = `translate3d(0, ${-travel}px, 0)`;
        const px = x * Math.max(0, width - lensSize - 14);
        const py = y * Math.max(0, height - lensSize - 14);
        lens.style.transform = `translate3d(${px}px, ${py}px, 0)`;
        light.style.transform = `translate3d(0, ${py + lensSize / 2 - 13}px, 0)`;
      }
      frame = requestAnimationFrame(tick);
    };
    const update = () => {
      cancelAnimationFrame(frame);
      last = 0;
      if (!media.matches) frame = requestAnimationFrame(tick);
    };
    update();
    media.addEventListener('change', update);
    return () => {
      cancelAnimationFrame(frame);
      media.removeEventListener('change', update);
      measure.disconnect();
      visibility.disconnect();
    };
  }, [surface, page, stopped]);
}

// Keep the same outgoing DOM alive while measuring and revealing its replacement.
// The shell has no clipping mask; its height follows the two actual content heights.
export function ReaderTransition({ viewKey, children, id, duration = 720 }) {
  const [views, setViews] = useState({ current: viewKey, previous: null });
  const snapshot = useRef(children);
  const host = useRef(null);
  const active = useRef(null);
  const leaving = useRef(null);
  const motion = useRef([]);
  const cleanup = useRef(null);
  if (views.current !== viewKey) {
    setViews({ current: viewKey, previous: { key: views.current, children: snapshot.current } });
  }
  useLayoutEffect(() => { snapshot.current = children; }, [children]);
  useLayoutEffect(() => {
    const shell = host.current;
    const next = active.current;
    const old = leaving.current;
    if (!shell || !next || !old) return;
    const from = motion.current.length ? shell.getBoundingClientRect().height : old.offsetHeight;
    const oldOpacity = getComputedStyle(old).opacity;
    motion.current.forEach(animation => animation.cancel());
    clearTimeout(cleanup.current);
    const media = reducedMotion();
    const finish = () => {
      motion.current.forEach(animation => animation.cancel());
      motion.current = [];
      shell.style.height = '';
      setViews(view => view.current === viewKey ? { ...view, previous: null } : view);
    };
    if (media.matches) { finish(); return; }
    const startHeight = from;
    const targetHeight = next.offsetHeight;
    shell.style.height = `${targetHeight}px`;
    old.getAnimations({ subtree: true }).forEach(animation => animation.pause());
    motion.current = [
      shell.animate([{ height: `${startHeight}px` }, { height: `${targetHeight}px` }], { duration, easing: ease }),
      old.animate([{ opacity: oldOpacity }, { opacity: 0 }], { duration: duration * 0.36, easing: 'ease-out', fill: 'forwards' }),
      next.animate([{ opacity: 0, transform: 'translateY(7px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: duration * 0.61, delay: duration * 0.22, easing: ease, fill: 'both' }),
    ];
    cleanup.current = setTimeout(finish, duration + 30);
    const change = () => { if (media.matches) { clearTimeout(cleanup.current); finish(); } };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, [viewKey, duration]);
  useEffect(() => () => {
    clearTimeout(cleanup.current);
    motion.current.forEach(animation => animation.cancel());
  }, []);
  return <div className="HPAG-reader-transition" ref={host} id={id}>
    {views.previous && <div key={views.previous.key} ref={leaving} className="HPAG-reader-view is-leaving" data-reader-leaving="true" aria-hidden="true" inert>{views.previous.children}</div>}
    <div key={views.current} ref={active} className="HPAG-reader-view is-current">{children}</div>
  </div>;
}
