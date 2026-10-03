import { pickLang } from '@dominify/shared';
import { useEffect, useLayoutEffect, useState, type CSSProperties } from 'react';
import { reducedMotion, setIntroHold } from './motion';
import { haptic, tg } from './tg';

/**
 * Заставка при входе: четыре капли краски CMYK падают и печатаются внахлёст, расходятся в логотип,
 * затем лист поднимается, а за ним цветные «прогоны» C, M, Y открывают приложение.
 * Первый запуск — полная версия, дальше — короткая, чтобы не задерживать.
 */

const SEEN_KEY = 'dm_intro_v1';
const WORD = 'Dominify';
const TAGLINE = {
  ru: 'Печать, дизайн и реклама — в одном месте',
  uz: 'Bosma, dizayn va reklama — bir joyda',
  uzc: 'Босма, дизайн ва реклама — бир жойда',
};
const FULL_MS = 2000;
const QUICK_MS = 900;
const RELEASE_MS = 300;
const EXIT_MS = 1050;

export const introEnabled = () => !reducedMotion();

const wasSeen = () => {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
};

export function Intro({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const [quick] = useState(wasSeen);
  const [minDone, setMinDone] = useState(false);
  const [phase, setPhase] = useState<'play' | 'wait' | 'exit'>('play');
  const lang = pickLang(tg?.initDataUnsafe.user?.language_code ?? navigator.language);

  useLayoutEffect(() => {
    setIntroHold(true);
    return () => setIntroHold(false);
  }, []);

  useEffect(() => {
    const timers = [window.setTimeout(() => setMinDone(true), quick ? QUICK_MS : FULL_MS)];
    // Лёгкий отклик на каждую «приземлившуюся» каплю.
    const landings = quick ? [200] : [0, 1, 2, 3].map((i) => 455 + i * 90);
    for (const ms of landings) timers.push(window.setTimeout(() => haptic(), ms));
    return () => timers.forEach(clearTimeout);
  }, [quick]);

  useEffect(() => {
    if (!minDone || phase === 'exit') return;
    if (!ready) {
      setPhase('wait');
      return;
    }
    setPhase('exit');
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* приватный режим */
    }
  }, [minDone, ready, phase]);

  useEffect(() => {
    if (phase !== 'exit') return;
    const release = window.setTimeout(() => setIntroHold(false), RELEASE_MS);
    const done = window.setTimeout(onDone, EXIT_MS);
    return () => {
      clearTimeout(release);
      clearTimeout(done);
    };
  }, [phase, onDone]);

  return (
    <div className={`intro ${quick ? 'quick' : ''} ${phase}`} onPointerDown={() => ready && setMinDone(true)} aria-hidden="true">
      <div className="intro-band y" />
      <div className="intro-band m" />
      <div className="intro-band c" />
      <div className="intro-sheet">
        <div className="intro-halftone" />
        <div className="intro-stage">
          <svg className="intro-crop" viewBox="0 0 320 210" preserveAspectRatio="none">
            <path pathLength={1} d="M2 26V2h24" />
            <path pathLength={1} d="M294 2h24v24" />
            <path pathLength={1} d="M318 184v24h-24" />
            <path pathLength={1} d="M26 208H2v-24" />
          </svg>
          <div className="intro-dots">
            {[0, 1, 2, 3].map((i) => (
              <i key={i} style={{ '--i': i } as CSSProperties} />
            ))}
          </div>
          <div className="intro-word">
            {[...WORD].map((ch, i) => (
              <span key={i} style={{ '--i': i } as CSSProperties}>
                {ch}
              </span>
            ))}
          </div>
          <div className="intro-bar">
            <i /><i /><i /><i />
          </div>
          <p className="intro-tag">{TAGLINE[lang]}</p>
        </div>
      </div>
    </div>
  );
}
