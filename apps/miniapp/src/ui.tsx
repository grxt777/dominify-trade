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

export function BackButton({ to }: { to?: string }) {
  const nav = useNavigate();
  const go = useCallback(() => (to ? nav(to) : nav(-1)), [nav, to]);
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

export const Spinner = () => <div className="spinner" role="status" aria-label="loading" />;
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

export function fmtDate(iso: string | null | undefined, lang: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'uz-UZ', { day: 'numeric', month: 'short' });
}

export function fmtTime(iso: string, lang: string): string {
  return new Date(iso).toLocaleTimeString(lang === 'ru' ? 'ru-RU' : 'uz-UZ', { hour: '2-digit', minute: '2-digit' });
}

/* ───────── Иконки вкладок ───────── */

const path = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
export const Icons = {
  list: path('M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01'),
  inbox: path('M4 13l2.5-7h11L20 13M4 13v5a2 2 0 002 2h12a2 2 0 002-2v-5M4 13h4l1.5 2.5h5L16 13h4'),
  send: path('M4 12l16-8-6 16-2.5-6.5L4 12z'),
  handshake: path('M3 11l4-4 4 3 3-3 7 5-3 3M7 7l-4 4 6 6 2-2M14 16l2 2M11 13l2 2'),
  chat: path('M4 5h16v11H9l-5 4V5z'),
  user: path('M12 12a4 4 0 100-8 4 4 0 000 8zM4 20c0-3.3 3.6-6 8-6s8 2.7 8 6'),
};
