import { formatUzs, REGIONS, type I18nText } from '@dominify/shared';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useT, type Key } from './i18n';
import { haptic, tg } from './tg';

/* ───────── Главная и системная кнопки Telegram (в браузере — обычные кнопки) ───────── */

export function MainButton({ text, onClick, disabled, loading }: { text: string; onClick: () => void; disabled?: boolean; loading?: boolean }) {
  const cb = useRef(onClick);
  cb.current = onClick;
  useEffect(() => {
    if (!tg) return;
    const handler = () => cb.current();
    tg.MainButton.onClick(handler);
    tg.MainButton.show();
    return () => {
      tg!.MainButton.offClick(handler);
      tg!.MainButton.hide();
      tg!.MainButton.hideProgress();
    };
  }, []);
  useEffect(() => {
    if (!tg) return;
    tg.MainButton.setText(text);
    if (disabled) tg.MainButton.disable();
    else tg.MainButton.enable();
    if (loading) tg.MainButton.showProgress(false);
    else tg.MainButton.hideProgress();
  }, [text, disabled, loading]);
  if (tg) return null;
  return (
    <div className="mainbtn">
      <button className="btn" disabled={disabled || loading} onClick={onClick}>
        {loading ? '…' : text}
      </button>
    </div>
  );
}

export function BackButton({ to, onClick }: { to?: string; onClick?: () => void }) {
  const nav = useNavigate();
  const cb = useRef(onClick);
  cb.current = onClick;
  const go = useCallback(() => (cb.current ? cb.current() : to ? nav(to) : nav(-1)), [nav, to]);
  useEffect(() => {
    if (!tg) return;
    tg.BackButton.onClick(go);
    tg.BackButton.show();
    return () => {
      tg!.BackButton.offClick(go);
      tg!.BackButton.hide();
    };
  }, [go]);
  const t = useT();
  if (tg) return null;
  return (
    <button className="btn ghost" onClick={go} style={{ marginBottom: 4 }}>
      ‹ {t('back')}
    </button>
  );
}

/* ───────── Уведомления внутри приложения ───────── */

type ToastState = { text: string; kind: 'ok' | 'error' } | null;
const ToastCtx = createContext<(text: string, kind?: 'ok' | 'error') => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState>(null);
  const show = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    setToast({ text, kind });
    haptic(kind === 'error' ? 'error' : 'success');
    setTimeout(() => setToast(null), 3000);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && <div className={`toast ${toast.kind === 'error' ? 'error' : ''}`}>{toast.text}</div>}
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/* ───────── Мелкие блоки ───────── */

export function Section({ title, children, body = true }: { title?: string; children: ReactNode; body?: boolean }) {
  return (
    <section className="section">
      {title && <div className="section-title">{title}</div>}
      {body ? <div className="section-body">{children}</div> : children}
    </section>
  );
}

export const Spinner = () => (
  <div className="loader" role="status" aria-label="loading">
    <i /><i /><i /><i />
  </div>
);

/** Первый экран, пока идёт вход: фирменные точки CMYK. */
export const Splash = () => (
  <div className="splash" role="status" aria-label="loading">
    <div className="splash-dots"><i /><i /><i /><i /></div>
    <b>Dominify</b>
  </div>
);
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

const STATUS_COLORS: Record<string, string> = {
  draft: '',
  needs_info: 'yellow',
  moderation: 'yellow',
  submitted: 'cyan',
  wave_1: 'cyan',
  wave_2: 'cyan',
  has_offers: 'magenta',
  supplier_chosen: 'good',
  completed: 'good',
  reviewed: 'good',
  cancelled: '',
  expired: '',
  rejected: 'danger',
};

export function StatusPill({ status }: { status: string }) {
  const t = useT();
  const key = `st_${status}` as Key;
  return <span className={`pill ${STATUS_COLORS[status] ?? ''}`}>{t(key)}</span>;
}

export function TrustBadge({ level }: { level: number }) {
  const t = useT();
  if (level <= 0) return null;
  const key = (['trustL0', 'trustL1', 'trustL2', 'trustL3'] as const)[Math.min(level, 3)];
  return <span className={`pill ${level >= 2 ? 'good' : 'cyan'}`}>✓ {t(key)}</span>;
}

export function Stars({ value, count }: { value: number | null; count?: number }) {
  const t = useT();
  if (!value || !count) return <span className="muted small">{t('noReviews')}</span>;
  const full = Math.round(value);
  return (
    <span className="small">
      <span className="stars">{'★'.repeat(full)}{'☆'.repeat(5 - full)}</span> {value.toFixed(1)} · {count}
    </span>
  );
}

export function StarInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="star-input" role="radiogroup">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" className={n <= value ? 'on' : ''} aria-label={`${n}`} onClick={() => { haptic(); onChange(n); }}>
          ★
        </button>
      ))}
    </div>
  );
}

/* ───────── Форматирование ───────── */

export const money = (v: number | null | undefined) => (v === null || v === undefined ? '—' : formatUzs(v));

export function useI18nText() {
  const t = useT();
  return (x: I18nText | null | undefined) => (x ? x[t.lang] : '');
}

export function regionName(code: string | null | undefined, lang: 'ru' | 'uz' | 'uzc'): string {
  if (!code) return '';
  return REGIONS.find((r) => r.code === code)?.name[lang] ?? code;
}

// Для uz-UZ браузеры часто отдают «M09 29», поэтому месяцы по-узбекски — свои.
const UZ_MONTHS = ['yan', 'fev', 'mar', 'apr', 'may', 'iyun', 'iyul', 'avg', 'sen', 'okt', 'noy', 'dek'];
const UZC_MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

export function fmtDate(iso: string | null | undefined, lang: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (lang === 'ru') return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  return `${d.getDate()} ${(lang === 'uzc' ? UZC_MONTHS : UZ_MONTHS)[d.getMonth()]}`;
}

export function fmtTime(iso: string, lang: string): string {
  return new Date(iso).toLocaleTimeString(lang === 'ru' ? 'ru-RU' : 'uz-UZ', { hour: '2-digit', minute: '2-digit' });
}

/* ───────── Иконки вкладок ───────── */

const path = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} pathLength={1} />
  </svg>
);
export const Icons = {
  store: path('M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3s3-1.3 3-3c0 1.7 1.3 3 3 3M10 20v-5h4v5'),
  home: path('M3 11l9-7 9 7M5 9.5V20h5v-6h4v6h5V9.5'),
  search: path('M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4'),
  clock: path('M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2'),
  refresh: path('M20 11a8 8 0 00-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0014.5 4.5L20 16M20 20v-4h-4'),
  check: path('M5 12.5l4.5 4.5L19 7.5'),
  list: path('M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01'),
  inbox: path('M4 13l2.5-7h11L20 13M4 13v5a2 2 0 002 2h12a2 2 0 002-2v-5M4 13h4l1.5 2.5h5L16 13h4'),
  send: path('M4 12l16-8-6 16-2.5-6.5L4 12z'),
  handshake: path('M3 11l4-4 4 3 3-3 7 5-3 3M7 7l-4 4 6 6 2-2M14 16l2 2M11 13l2 2'),
  chat: path('M4 5h16v11H9l-5 4V5z'),
  user: path('M12 12a4 4 0 100-8 4 4 0 000 8zM4 20c0-3.3 3.6-6 8-6s8 2.7 8 6'),
  heart: path('M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.6-7 10-7 10z'),
  shield: path('M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3zM9 12l2 2 4-4'),
  gift: path('M4 11h16v9H4zM3 7h18v4H3zM12 7v13M12 7c-1.5-3-5-3-5-1s3 1 5 1zM12 7c1.5-3 5-3 5-1s-3 1-5 1z'),
  undo: path('M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3'),
  bolt: path('M13 3L5 13h6l-1 8 8-10h-6l1-8z'),
};

/** Отметка «Проверенный исполнитель»: ИНН подтверждён модератором. */
export function VerifiedMark({ withText = false }: { withText?: boolean }) {
  const t = useT();
  return (
    <span className={`verified ${withText ? 'with-text' : ''}`} title={t('verifiedHint')} aria-label={t('verified')}>
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M12 2l2.4 1.8 3-.2.9 2.9 2.5 1.7-.9 2.9.9 2.9-2.5 1.7-.9 2.9-3-.2L12 22l-2.4-1.8-3 .2-.9-2.9-2.5-1.7.9-2.9-.9-2.9 2.5-1.7.9-2.9 3 .2z" />
        <path d="M8 12.2l2.6 2.6L16 9.4" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {withText && t('verified')}
    </span>
  );
}

/** «3 часа назад» без библиотек: минуты, часы, дни. */
export function useAgo() {
  const t = useT();
  return (iso: string) => {
    const min = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
    if (min < 60) return t.f('agoMinTpl', min);
    if (min < 24 * 60) return t.f('agoHourTpl', Math.round(min / 60));
    return t.f('agoDayTpl', Math.round(min / 1440));
  };
}
