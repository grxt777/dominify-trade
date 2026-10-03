import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react';
import { haptic } from './tg';

/** Анимации без библиотек: только transform/opacity и canvas — плавно даже на слабых Android в Telegram. */

export const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);

/** Пока играет заставка, анимации приложения под ней стоят на паузе, иначе они закончатся невидимыми. */
let introOn = false;
const introQueue = new Set<() => void>();

export function setIntroHold(on: boolean) {
  introOn = on;
  document.documentElement.classList.toggle('intro-hold', on);
  if (on) return;
  const queued = [...introQueue];
  introQueue.clear();
  queued.forEach((fn) => fn());
}

export function afterIntro(fn: () => void): () => void {
  if (!introOn) {
    fn();
    return () => undefined;
  }
  introQueue.add(fn);
  return () => introQueue.delete(fn);
}

/** Число «набегает» от нуля до значения при первом показе. */
export function useCountUp(target: number, ms = 1100): number {
  const [v, setV] = useState(() => (reducedMotion() ? target : 0));
  const from = useRef(0);
  useEffect(() => {
    if (reducedMotion()) {
      setV(target);
      return;
    }
    let raf = 0;
    const cancel = afterIntro(() => {
      const start = performance.now();
      const base = from.current;
      const tick = (now: number) => {
        const k = Math.min(1, (now - start) / ms);
        setV(base + (target - base) * easeOut(k));
        if (k < 1) raf = requestAnimationFrame(tick);
        else from.current = target;
      };
      raf = requestAnimationFrame(tick);
    });
    return () => {
      cancel();
      cancelAnimationFrame(raf);
    };
  }, [target, ms]);
  return v;
}

export function CountUp({ value, format = (n) => String(Math.round(n)), ms }: { value: number; format?: (n: number) => string; ms?: number }) {
  const v = useCountUp(value, ms);
  return <>{format(v)}</>;
}

/**
 * Появление при прокрутке: всем элементам с классом .reveal добавляется .in, когда они попадают в экран.
 * Один наблюдатель на всё приложение; новые элементы (после загрузки данных) подхватываются сами.
 */
export function RevealRoot() {
  useEffect(() => {
    let stop: () => void = () => undefined;
    const cancel = afterIntro(() => {
      stop = startReveal();
    });
    return () => {
      cancel();
      stop();
    };
  }, []);
  return null;
}

function startReveal(): () => void {
  const showAll = () => document.querySelectorAll('.reveal:not(.in)').forEach((el) => el.classList.add('in'));
  if (reducedMotion() || !('IntersectionObserver' in window)) {
    showAll();
    const mo = new MutationObserver(showAll);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -6% 0px', threshold: 0.08 },
  );
  const watched = new WeakSet<Element>();
  const scan = () =>
    document.querySelectorAll('.reveal:not(.in)').forEach((el) => {
      if (watched.has(el)) return;
      watched.add(el);
      io.observe(el);
    });
  scan();
  let pending = 0;
  const mo = new MutationObserver(() => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      scan();
    });
  });
  mo.observe(document.body, { childList: true, subtree: true });
  return () => {
    mo.disconnect();
    io.disconnect();
    cancelAnimationFrame(pending);
  };
}

/** Картинка проявляется после загрузки, а не «прорисовывается» полосами. */
export function FadeImg({ className = '', ...rest }: ImgHTMLAttributes<HTMLImageElement>) {
  const ref = useRef<HTMLImageElement>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (ref.current?.complete) setLoaded(true);
  }, [rest.src]);
  return <img ref={ref} {...rest} className={`fade-img ${loaded ? 'ld' : ''} ${className}`} onLoad={() => setLoaded(true)} onError={() => setLoaded(true)} />;
}

const CMYK = ['#0098cc', '#d6007a', '#e8b400', '#1f9a63', '#43b9ea', '#ff5a8a'];

/** Брызги вокруг элемента: сердечко «в избранное». */
export function burst(el: Element, color = '#ff3b5c') {
  if (reducedMotion()) return;
  const r = el.getBoundingClientRect();
  const host = document.createElement('div');
  host.className = 'burst';
  host.style.left = `${r.left + r.width / 2}px`;
  host.style.top = `${r.top + r.height / 2}px`;
  host.style.setProperty('--c', color);
  const ring = document.createElement('i');
  ring.className = 'burst-ring';
  host.appendChild(ring);
  for (let k = 0; k < 10; k++) {
    const p = document.createElement('i');
    p.className = 'burst-dot';
    p.style.setProperty('--a', `${k * 36 + (k % 2 ? 12 : 0)}deg`);
    p.style.setProperty('--d', `${k % 2 ? 22 : 30}px`);
    if (k % 3 === 0) p.style.background = CMYK[k % CMYK.length];
    host.appendChild(p);
  }
  document.body.appendChild(host);
  setTimeout(() => host.remove(), 700);
}

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  w: number;
  h: number;
  color: string;
  shape: 0 | 1;
  wobble: number;
}

/**
 * Конфетти в цветах CMYK — как брызги краски в типографии. Для настоящих побед:
 * оплата прошла, сделка закрыта, заказ отправлен, услуга опубликована.
 */
export function confetti({ x, y, count = 110, withHaptic = true }: { x?: number; y?: number; count?: number; withHaptic?: boolean } = {}) {
  if (withHaptic) haptic('success');
  if (reducedMotion()) return;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    return;
  }
  ctx.scale(dpr, dpr);
  const ox = x ?? W / 2;
  const oy = y ?? H * 0.35;
  const pieces: Piece[] = Array.from({ length: count }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;
    const speed = 7 + Math.random() * 9;
    return {
      x: ox,
      y: oy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 2,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.35,
      w: 6 + Math.random() * 6,
      h: 4 + Math.random() * 5,
      color: CMYK[Math.floor(Math.random() * CMYK.length)],
      shape: Math.random() < 0.3 ? 1 : 0,
      wobble: Math.random() * 10,
    };
  });
  const start = performance.now();
  let last = start;
  const frame = (now: number) => {
    const dt = Math.min(2.5, (now - last) / 16.7);
    last = now;
    const age = now - start;
    ctx.clearRect(0, 0, W, H);
    let alive = 0;
    for (const p of pieces) {
      p.vy += 0.32 * dt;
      p.vx *= Math.pow(0.985, dt);
      p.vy *= Math.pow(0.985, dt);
      p.x += (p.vx + Math.sin((age / 180) + p.wobble) * 0.6) * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.y > H + 20) continue;
      alive++;
      ctx.save();
      ctx.globalAlpha = age > 2200 ? Math.max(0, 1 - (age - 2200) / 600) : 1;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === 1) {
        ctx.beginPath();
        ctx.arc(0, 0, p.h / 2 + 1, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // «Плоскость» листка сжимается по синусу — кажется, что он кувыркается.
        ctx.scale(1, Math.cos(p.rot * 2));
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      ctx.restore();
    }
    if (alive && age < 2800) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

/** Конфетти из-под элемента (кнопки, карточки). */
export function confettiFrom(el: Element | null, count?: number) {
  if (!el) return confetti({ count });
  const r = el.getBoundingClientRect();
  confetti({ x: r.left + r.width / 2, y: r.top + r.height / 2, count });
}

/** Подсказка-«печатная машинка» в пустом поле поиска: показывает, что можно искать. */
export function useTypewriter(lines: string[], active: boolean): string {
  const [text, setText] = useState('');
  useEffect(() => {
    if (!active || !lines.length) return;
    if (reducedMotion()) {
      setText(lines[0]);
      return;
    }
    let line = 0;
    let pos = 0;
    let deleting = false;
    let timer = 0;
    const step = () => {
      const full = lines[line];
      if (!deleting) {
        pos++;
        setText(full.slice(0, pos));
        if (pos >= full.length) {
          deleting = true;
          timer = window.setTimeout(step, 1700);
          return;
        }
        timer = window.setTimeout(step, 55 + Math.random() * 40);
      } else {
        pos--;
        setText(full.slice(0, pos));
        if (pos <= 0) {
          deleting = false;
          line = (line + 1) % lines.length;
          timer = window.setTimeout(step, 350);
          return;
        }
        timer = window.setTimeout(step, 24);
      }
    };
    timer = window.setTimeout(step, 600);
    return () => clearTimeout(timer);
  }, [active, lines]);
  return text;
}

/** Галочка, которая «рисуется» — подтверждение оплаты и успешных действий. */
export function SuccessMark({ size = 44 }: { size?: number }) {
  return (
    <svg className="success-mark" width={size} height={size} viewBox="0 0 52 52" aria-hidden>
      <circle className="sm-circle" cx="26" cy="26" r="23" fill="none" pathLength={1} />
      <path className="sm-check" d="M15 27l7 7 15-16" fill="none" pathLength={1} />
    </svg>
  );
}
