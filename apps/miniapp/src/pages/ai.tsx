import type { FieldDef } from '@dominify/shared';
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { post, type Funnel, type RequestView } from '../api';
import { translate, useT } from '../i18n';
import { CountUp, reducedMotion } from '../motion';
import { haptic } from '../tg';
import type { MapPoint } from './MapPicker';
import { fmtTime, money, regionName, useToast } from '../ui';

/**
 * «Мозг» заявки на экране: как ИИ разбирает текст, что понял, что уточняет и как подбирает исполнителей.
 * Все цифры — с сервера; анимация только показывает реальные шаги, ничего не придумывает.
 */

/** Логотип-«мозг»: четыре капли CMYK, которые пульсируют, пока система работает. */
export function AiMark({ busy = false, size = 28 }: { busy?: boolean; size?: number }) {
  return (
    <span className={`ai-mark ${busy ? 'busy' : ''}`} style={{ width: size, height: size }} aria-hidden>
      <i /><i /><i /><i />
    </span>
  );
}

/** Текст печатается по буквам один раз — так звучит «живой» ответ ИИ. */
function useTypeOnce(text: string, speed = 18): string {
  const [n, setN] = useState(() => (reducedMotion() ? text.length : 0));
  useEffect(() => {
    if (reducedMotion()) {
      setN(text.length);
      return;
    }
    setN(0);
    let i = 0;
    const id = setInterval(() => {
      i += 2;
      setN(Math.min(i, text.length));
      if (i >= text.length) clearInterval(id);
    }, speed);
    return () => clearInterval(id);
  }, [text, speed]);
  return text.slice(0, n);
}

/* ───────── ИИ разбирает заявку ───────── */

/** Шаги разбора идут по очереди; последний «крутится», пока не придёт результат. */
export function AiThinking({ text, hasFiles, compact = false }: { text?: string; hasFiles?: boolean; compact?: boolean }) {
  const t = useT();
  const steps = useMemo(
    () => [t('aiReading'), ...(hasFiles ? [t('aiPhotos')] : []), t('aiCategory'), t('aiFields'), t('aiCheck')],
    [t, hasFiles],
  );
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setStep((s) => Math.min(s + 1, steps.length - 1)), 850);
    return () => clearInterval(id);
  }, [steps.length]);

  if (compact) {
    return (
      <div className="ai-bubble-row">
        <AiMark busy />
        <div className="ai-bubble thinking">{t('aiThinkingAgain')}</div>
      </div>
    );
  }
  return (
    <div className="ai-think">
      {text && (
        <div className="ai-source">
          <div className="ai-scan" aria-hidden />
          {text}
        </div>
      )}
      <ul className="ai-steps">
        {steps.map((s, i) => (
          <li key={s} className={i < step ? 'done' : i === step ? 'now' : ''} style={{ ['--d' as string]: `${i * 0.06}s` }}>
            <span className="ai-step-ic" />
            {s}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ───────── Что понял ИИ ───────── */

type Chip = { k: string; label: string; tone?: 'cyan' | 'magenta' | 'yellow' };

function fieldValue(d: FieldDef, v: unknown, lang: 'ru' | 'uz' | 'uzc'): string {
  if (d.type === 'boolean') return d.label[lang];
  if (d.type === 'select') return d.options?.find((o) => o.value === v)?.label[lang] ?? String(v);
  return d.unit ? `${v} ${d.unit}` : String(v);
}

export function understoodChips(r: RequestView, lang: 'ru' | 'uz' | 'uzc'): Chip[] {
  const out: Chip[] = [];
  if (r.category) out.push({ k: 'cat', label: r.category.name[lang], tone: 'cyan' });
  for (const d of r.fieldDefs) {
    const v = r.fields[d.key];
    if (v === undefined || v === null || v === '' || v === false) continue;
    const shown = fieldValue(d, v, lang);
    out.push({ k: d.key, label: d.type === 'number' || d.type === 'text' ? `${d.label[lang]}: ${shown}` : shown });
  }
  if (r.regionCode) out.push({ k: 'region', label: regionName(r.regionCode, lang), tone: 'magenta' });
  if (r.deadline) out.push({ k: 'deadline', label: `→ ${r.deadline.split('-').reverse().slice(0, 2).join('.')}`, tone: 'yellow' });
  if (r.budgetUzs) out.push({ k: 'budget', label: `≤ ${money(r.budgetUzs)}` });
  if (r.delivery?.needed) out.push({ k: 'delivery', label: `🚚 ${r.delivery.address ?? translate(lang, 'deliveryLabel')}` });
  else if (r.delivery?.needed === false) out.push({ k: 'delivery', label: translate(lang, 'pickupLabel') });
  return out;
}

/** Карточка «Вот как я понял заявку»: чипы появляются по одному, как будто ИИ выписывает их из текста. */
export function Understood({ r }: { r: RequestView }) {
  const t = useT();
  const chips = understoodChips(r, t.lang);
  const conf = r.confidence ?? null;
  return (
    <div className="ai-card">
      <div className="row between" style={{ marginBottom: 10 }}>
        <div className="row" style={{ gap: 8 }}>
          <AiMark />
          <b>{t('aiUnderstood')}</b>
        </div>
        {conf !== null && (
          <span className="ai-conf" title={t('aiConfidence')}>
            <i style={{ ['--p' as string]: `${Math.round(conf * 100)}%` }} />
            <CountUp value={Math.round(conf * 100)} format={(n) => `${Math.round(n)}%`} ms={900} />
          </span>
        )}
      </div>
      <div className="ai-chips">
        {chips.length === 0 && <span className="ai-chip">{t('noCategoryYet')}</span>}
        {chips.map((c, i) => (
          <span key={c.k} className={`ai-chip ${c.tone ?? ''}`} style={{ ['--d' as string]: `${0.15 + i * 0.09}s` }}>
            {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ───────── Уточнения: ИИ спрашивает то, что важно для цены и срока ───────── */

const MapPicker = lazy(() => import('./MapPicker').then((m) => ({ default: m.MapPicker })));

type AnswerBody = { answer: string; field?: string; value?: string | number | boolean | MapPoint; skip?: boolean };

export function AiQuestion({ r, onAnswered, onThinking }: { r: RequestView; onAnswered: () => void; onThinking: () => void }) {
  const t = useT();
  const toast = useToast();
  const ask = r.ask!;
  const typed = useTypeOnce(ask.text);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [map, setMap] = useState(false);
  const asked = r.answers?.length ?? 0;

  useEffect(() => setText(''), [ask.key, ask.text]);

  const send = async (body: AnswerBody, key: string) => {
    setBusy(key);
    haptic();
    try {
      if (body.field === undefined) onThinking();
      await post(`/v1/requests/${r.id}/answer`, body);
      onAnswered();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const field = ask.kind === 'free' ? undefined : ask.key;
  const sendText = () => {
    const v = text.trim();
    if (!v) return;
    if (ask.input === 'number' && field) {
      const n = Number(v.replace(/[\s ]/g, '').replace(',', '.'));
      if (Number.isFinite(n) && n > 0) return send({ answer: ask.unit ? `${v} ${ask.unit}` : v, field, value: n }, 'text');
    }
    if (ask.input === 'date' && field && /^\d{4}-\d{2}-\d{2}$/.test(v)) return send({ answer: v, field, value: v }, 'text');
    // Свободный текст понимает ИИ: «к пятнице», «примерно миллион» — тоже ответ.
    return send({ answer: v }, 'text');
  };

  return (
    <div className="ai-ask" key={ask.key}>
      <div className="ai-bubble-row">
        <AiMark />
        <div className="ai-bubble">
          <div className="ai-bubble-head">{asked === 0 ? t('aiAsk') : t.f('aiAskNTpl', asked + 1)}</div>
          {typed}
          {typed.length < ask.text.length && <i className="caret" />}
        </div>
      </div>

      {(ask.options.length > 0 || ask.input === 'map' || ask.optional) && (
        <div className="ai-options">
          {ask.options.map((o, i) => (
            <button
              key={String(o.value)}
              className="chip"
              style={{ ['--d' as string]: `${0.2 + i * 0.05}s` }}
              disabled={!!busy}
              onClick={() => send({ answer: o.label, field, value: o.value }, String(o.value))}
            >
              {busy === String(o.value) ? '…' : o.label}
            </button>
          ))}
          {ask.input === 'map' && (
            <button className="chip map-chip" style={{ ['--d' as string]: '0.2s' }} disabled={!!busy} onClick={() => setMap(true)}>
              📍 {t('mapPick')}
            </button>
          )}
          {ask.optional && (
            <button
              className="chip ghost"
              style={{ ['--d' as string]: `${0.25 + ask.options.length * 0.05}s` }}
              disabled={!!busy}
              onClick={() => send({ answer: '', field: ask.key, skip: true }, 'skip')}
            >
              {busy === 'skip' ? '…' : t('aiSkip')}
            </button>
          )}
        </div>
      )}

      {ask.input && ask.input !== 'map' && (
        <div className="ai-answer">
          <input
            className="input"
            type={ask.input === 'date' ? 'date' : 'text'}
            inputMode={ask.input === 'number' ? 'decimal' : undefined}
            placeholder={ask.options.length ? t('aiOwnAnswer') : t('answerPlaceholder')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendText()}
          />
          {ask.unit && <span className="ai-unit">{ask.unit}</span>}
          <button className="btn" onClick={sendText} disabled={!!busy || !text.trim()} aria-label={t('answer')}>
            {busy === 'text' ? '…' : '↑'}
          </button>
        </div>
      )}

      {map && (
        <Suspense fallback={null}>
          <MapPicker
            initial={r.delivery.lat != null && r.delivery.lng != null ? { lat: r.delivery.lat, lng: r.delivery.lng, address: r.delivery.address ?? undefined } : null}
            onClose={() => setMap(false)}
            onPick={(p) => {
              setMap(false);
              void send({ answer: p.address ?? '', field: 'location', value: p }, 'map');
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

/* ───────── Подбор исполнителей: радар и воронка ───────── */

const MAX_NODES = 22;

type NodeState = 'out' | 'region' | 'sent' | 'seen' | 'offer' | 'scan';

/** Сколько точек нарисовать из count при масштабе total → drawn; ненулевое не превращается в ноль. */
function scaled(count: number, total: number, drawn: number): number {
  if (!count || !total) return 0;
  if (total <= drawn) return count;
  return Math.max(1, Math.round((count / total) * drawn));
}

function radarNodes(f: Funnel | null, seen: number, offers: number): NodeState[] {
  if (!f) return Array.from({ length: 16 }, () => 'scan');
  const n = Math.min(f.pool, MAX_NODES);
  const region = scaled(f.region, f.pool, n);
  const sent = Math.min(region || n, scaled(f.sent, f.pool, n));
  const seenN = Math.min(sent, scaled(seen, f.sent, sent));
  const offerN = Math.min(sent, scaled(offers, f.sent, sent));
  return Array.from({ length: n }, (_, i) => {
    if (i < offerN) return 'offer';
    if (i < seenN) return 'seen';
    if (i < sent) return 'sent';
    if (i < region) return 'region';
    return 'out';
  });
}

/** Радар: в центре заявка, вокруг — исполнители категории. Выбранные соединяются линией, открывшие — светятся. */
export function Radar({ funnel, seen, offers, scanning }: { funnel: Funnel | null; seen: number; offers: number; scanning: boolean }) {
  const nodes = radarNodes(funnel, seen, offers);
  const W = 320;
  const H = 190;
  const cx = W / 2;
  const cy = H / 2;
  // Ближе к центру — лучшие кандидаты: выбранные ложатся на внутренние кольца.
  const pos = nodes.map((_, i) => {
    const ring = i < 6 ? 0 : i < 13 ? 1 : 2;
    const r = 44 + ring * 26 + ((i * 7) % 5);
    const a = i * 2.399963 + ring * 0.6;
    return { x: cx + Math.cos(a) * r * 1.55, y: cy + Math.sin(a) * r * 0.78 };
  });
  return (
    <div className={`radar ${scanning ? 'scanning' : ''}`}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-hidden>
        <defs>
          <radialGradient id="rg-sweep" cx="0" cy="0" r="1">
            <stop offset="0" stopColor="var(--cyan)" stopOpacity="0.35" />
            <stop offset="1" stopColor="var(--cyan)" stopOpacity="0" />
          </radialGradient>
        </defs>
        {[44, 70, 96].map((r) => (
          <ellipse key={r} className="radar-ring" cx={cx} cy={cy} rx={r * 1.55} ry={r * 0.78} />
        ))}
        <g className="radar-sweep" style={{ transformOrigin: `${cx}px ${cy}px` }}>
          <path d={`M${cx} ${cy} L${cx + 150} ${cy - 46} A150 80 0 0 1 ${cx + 150} ${cy + 46} Z`} fill="url(#rg-sweep)" />
        </g>
        {nodes.map((s, i) =>
          s === 'sent' || s === 'seen' || s === 'offer' ? (
            <line
              key={`l${i}`}
              className={`radar-link ${s}`}
              x1={cx}
              y1={cy}
              x2={pos[i].x}
              y2={pos[i].y}
              pathLength={1}
              style={{ ['--d' as string]: `${0.5 + i * 0.12}s` }}
            />
          ) : null,
        )}
        {nodes.map((s, i) => (
          <circle
            key={`n${i}`}
            className={`radar-node ${s}`}
            cx={pos[i].x}
            cy={pos[i].y}
            r={s === 'offer' ? 7 : s === 'out' || s === 'scan' ? 3.5 : 5}
            style={{ ['--d' as string]: `${i * 0.035}s` }}
          />
        ))}
        <g className="radar-core">
          <circle cx={cx} cy={cy} r={17} />
          <circle cx={cx - 5} cy={cy - 5} r={3.6} fill="var(--cyan)" />
          <circle cx={cx + 5} cy={cy - 5} r={3.6} fill="var(--magenta)" />
          <circle cx={cx - 5} cy={cy + 5} r={3.6} fill="var(--yellow)" />
          <circle cx={cx + 5} cy={cy + 5} r={3.6} fill="var(--text)" />
        </g>
      </svg>
    </div>
  );
}

/** Сжатая воронка одной строкой: проверено → в регионе → отправлено → смотрят → предложений. */
export function FunnelBar({ r }: { r: RequestView }) {
  const t = useT();
  const p = r.progress;
  if (!p?.funnel) return null;
  const f = mergeFunnels(p.funnel, p.funnel2);
  const items = [
    { v: f.pool, l: t('pipeChecked') },
    { v: f.region, l: t('pipeInRegion') },
    { v: p.delivered, l: t('pipeSentShort') },
    { v: p.seen, l: t('pipeSeenShort') },
    { v: p.offers, l: t('pipeOffersShort'), hot: true },
  ];
  return (
    <div className="funnel-bar">
      {items.map((it, i) => (
        <div key={it.l} className={it.hot ? 'hot' : ''} style={{ ['--d' as string]: `${i * 0.08}s` }}>
          <b><CountUp value={it.v} ms={900} /></b>
          <span>{it.l}</span>
        </div>
      ))}
    </div>
  );
}

function mergeFunnels(a: Funnel, b: Funnel | null): Funnel {
  if (!b) return a;
  return { pool: Math.max(a.pool, b.pool), region: Math.max(a.region, b.region), ready: a.ready + b.ready, sent: a.sent + b.sent };
}

type StageState = 'done' | 'now' | 'wait' | 'warn';

function Stage({ state, title, children, d }: { state: StageState; title: string; children?: ReactNode; d: number }) {
  return (
    <li className={`pipe-stage ${state}`} style={{ ['--d' as string]: `${d}s` }}>
      <span className="pipe-dot" />
      <div className="pipe-body">
        <div className="pipe-title">{title}</div>
        {children && <div className="pipe-sub">{children}</div>}
      </div>
    </li>
  );
}

/** Экран ожидания после отправки: что система уже сделала и что делает прямо сейчас. */
export function MatchPipeline({ r }: { r: RequestView }) {
  const t = useT();
  const p = r.progress;
  const moderation = r.status === 'moderation';
  const f = p?.funnel ? mergeFunnels(p.funnel, p.funnel2) : null;
  const matched = !!f;
  const none = matched && p!.delivered === 0;
  const delivered = p?.delivered ?? 0;
  const seen = p?.seen ?? 0;
  const offers = p?.offers ?? 0;
  const chips = understoodChips(r, t.lang);

  return (
    <div className="pipeline">
      <Radar funnel={f} seen={seen} offers={offers} scanning={!moderation && (!matched || offers === 0)} />
      <ol className="pipe">
        <Stage state="done" title={t('pipeParsed')} d={0}>
          <span className="pipe-chips">
            {chips.slice(0, 4).map((c) => (
              <span key={c.k} className={`ai-chip tiny ${c.tone ?? ''}`}>{c.label}</span>
            ))}
          </span>
        </Stage>

        {moderation ? (
          <Stage state="now" title={t('pipeMatched')} d={0.15}>{t('pipeModeration')}</Stage>
        ) : !f ? (
          <Stage state="now" title={t('pipeMatching')} d={0.15} />
        ) : (
          <Stage state={none ? 'warn' : 'done'} title={t('pipeMatched')} d={0.15}>
            <span className="pipe-funnel">
              <span style={{ ['--d' as string]: '0.3s' }}><b><CountUp value={f.pool} /></b> {t('pipePool')}</span>
              <span style={{ ['--d' as string]: '0.55s' }}><b><CountUp value={f.region} /></b> {t('pipeRegion')}</span>
              <span style={{ ['--d' as string]: '0.8s' }}><b><CountUp value={f.sent} /></b> {t('pipeBest')}</span>
            </span>
            {none && <div className="warn-text" style={{ marginTop: 6 }}>{t('pipeNone')}</div>}
          </Stage>
        )}

        {matched && !none && (
          <Stage state="done" title={`${t('pipeSent')} · ${delivered}`} d={0.3}>
            {p!.nextNotifyAt && p!.notified < delivered ? t.f('pipeSoonTpl', p!.notified) : null}
          </Stage>
        )}

        {matched && !none && (
          <Stage state={seen > 0 ? 'done' : 'now'} title={t('pipeSeen')} d={0.45}>
            <span className="pipe-live">
              <i className="pulse" />
              <b className="swap" key={seen}><CountUp value={seen} ms={600} /></b> / {delivered}
            </span>
          </Stage>
        )}

        {matched && !none && (
          <Stage state={offers > 0 ? 'done' : 'wait'} title={offers > 0 ? `${t('pipeOffers')} · ${offers}` : t('pipeWaiting')} d={0.6}>
            {offers === 0 && (
              <>
                {p!.typicalResponseMin ? <div>{t.f('pipeTypicalTpl', p!.typicalResponseMin)}</div> : null}
                {p!.secondWaveAt ? <div>{t.f('pipeWave2Tpl', fmtTime(p!.secondWaveAt, t.lang))}</div> : null}
              </>
            )}
          </Stage>
        )}
      </ol>
    </div>
  );
}
