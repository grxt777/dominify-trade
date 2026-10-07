import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { get, post, uploadFile, type MyRequest, type RequestView } from '../api';
import { useT } from '../i18n';
import { useTypewriter } from '../motion';
import { useSession } from '../session';
import { useSocketEvent } from '../socket';
import { cloud, haptic, setClosingConfirmation } from '../tg';
import { Icons, money, StatusPill, useToast } from '../ui';
import { AiMark } from './ai';
import { LiveStats } from './Market';

const DRAFT_KEY = 'draft_request';
const ACTIVE = ['draft', 'needs_info', 'moderation', 'submitted', 'wave_1', 'wave_2', 'has_offers'];

interface Attached {
  id: number | null;
  name: string;
  preview: string | null;
  uploading: boolean;
}

/**
 * Главная покупателя — это сама заявка. Человек пишет своими словами (или присылает фото),
 * а система разбирает, подбирает и рассылает. Каталог услуг — на второй вкладке.
 */
export function Home() {
  const t = useT();
  const nav = useNavigate();
  const toast = useToast();
  const { me } = useSession();
  const [params] = useSearchParams();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Attached[]>([]);
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const hints = useMemo(() => t('homeHints').split('|'), [t]);
  const ghostOn = !text && !focused;
  const ghost = useTypewriter(hints, ghostOn);

  const mine = useQuery({ queryKey: ['requests'], queryFn: () => get<MyRequest[]>('/v1/requests') });
  useSocketEvent('request.updated', () => mine.refetch());
  useSocketEvent('offer.created', () => mine.refetch());
  const active = (mine.data ?? []).filter((r) => ACTIVE.includes(r.status)).slice(0, 3);

  // Черновик переживает закрытие приложения: облачное хранилище Telegram.
  useEffect(() => {
    cloud.get(DRAFT_KEY).then((v) => v && setText((cur) => cur || v));
    if (params.get('focus')) setTimeout(() => area.current?.focus(), 350);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = setTimeout(() => void (text ? cloud.set(DRAFT_KEY, text) : cloud.remove(DRAFT_KEY)), 500);
    setClosingConfirmation(!!text);
    return () => clearTimeout(id);
  }, [text]);
  useEffect(() => () => setClosingConfirmation(false), []);

  const onPick = async (list: FileList | null) => {
    if (!list) return;
    for (const f of Array.from(list).slice(0, 10 - files.length)) {
      if (f.size > 20 * 1024 * 1024) {
        toast('> 20 MB', 'error');
        continue;
      }
      const entry: Attached = { id: null, name: f.name, preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null, uploading: true };
      setFiles((prev) => [...prev, entry]);
      try {
        const id = await uploadFile(f);
        setFiles((prev) => prev.map((x) => (x === entry ? { ...x, id, uploading: false } : x)));
      } catch (e) {
        setFiles((prev) => prev.filter((x) => x !== entry));
        toast((e as Error).message, 'error');
      }
    }
  };

  const pickExample = (s: string) => {
    haptic();
    setText(s);
    area.current?.focus();
  };

  const empty = !text.trim() && files.length === 0;
  const uploading = files.some((f) => f.uploading);

  const submit = async () => {
    if (empty || uploading) return;
    setBusy(true);
    haptic();
    try {
      const r = await post<RequestView>('/v1/requests/parse', { text: text.trim(), fileIds: files.filter((f) => f.id).map((f) => f.id) });
      cloud.remove(DRAFT_KEY);
      setClosingConfirmation(false);
      nav(`/requests/${r.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <>
      <div className="market-hero home-hero">
        {me.firstName && <div className="muted small">{t.f('helloTpl', me.firstName)}</div>}
        <h1 className="market-h1">{t('homeTitle')}</h1>
        <div className="muted small" style={{ marginBottom: 14 }}>{t('homeSub')}</div>

        <div className={`ask-composer ${focused ? 'focus' : ''} ${busy ? 'sending' : ''}`}>
          <div className="ask-field">
            <textarea
              ref={area}
              maxLength={4000}
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              aria-label={t('homeTitle')}
              placeholder={ghostOn ? '' : t('newRequestPlaceholder')}
            />
            {ghostOn && (
              <span className="ask-ghost" aria-hidden>
                {ghost}
                <i className="caret" />
              </span>
            )}
          </div>
          {files.length > 0 && (
            <div className="thumbs" style={{ padding: '0 12px' }}>
              {files.map((f, i) => (
                <div key={i} className="thumb">
                  {f.preview ? <img src={f.preview} alt="" /> : <span>{f.uploading ? '…' : 'PDF'}</span>}
                  {!f.uploading && (
                    <button aria-label="remove" onClick={() => setFiles((prev) => prev.filter((x) => x !== f))}>
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="ask-bar">
            <button className="ask-attach" onClick={() => picker.current?.click()} disabled={files.length >= 10}>
              {Icons.image}
              <span>{t('homePhoto')}</span>
            </button>
            <button className="btn ask-send" onClick={submit} disabled={empty || uploading || busy}>
              {busy ? <AiMark busy size={18} /> : Icons.send}
              <span>{t('homeSend')}</span>
            </button>
          </div>
          <input
            ref={picker}
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            multiple
            hidden
            onChange={(e) => {
              onPick(e.target.files);
              e.target.value = '';
            }}
          />
        </div>

        {!text && (
          <div className="ask-examples">
            <span className="muted small">{t('homeExamples')}:</span>
            {(['homeExample1', 'homeExample2', 'homeExample3'] as const).map((k, i) => (
              <button key={k} className="chip" style={{ ['--d' as string]: `${0.25 + i * 0.08}s` }} onClick={() => pickExample(t(k))}>
                {t(k)}
              </button>
            ))}
          </div>
        )}
      </div>

      <HowItWorks />

      {active.length > 0 && (
        <div className="section">
          <div className="section-title row between">
            <span>{t('homeMyRequests')}</span>
            <button className="btn ghost" style={{ padding: 0, textTransform: 'none' }} onClick={() => nav('/orders')}>
              {t('homeAllRequests')} ›
            </button>
          </div>
          {active.map((r) => (
            <div key={r.id} className="cell" onClick={() => nav(`/requests/${r.id}`)}>
              <div className="cell-main">
                <div className="cell-title">{r.title || `#${r.id}`}</div>
                <div className="cell-sub row">
                  <StatusPill status={r.status} />
                </div>
              </div>
              <div className="cell-right">
                {r.offersCount > 0 ? (
                  <>
                    <div style={{ color: 'var(--text)', fontWeight: 700 }}>{r.offersCount}</div>
                    <div>{t('offersN')}</div>
                    {r.bestPrice ? <div className="mono">{money(r.bestPrice)}</div> : null}
                  </>
                ) : ['submitted', 'wave_1', 'wave_2'].includes(r.status) ? (
                  <i className="pulse" />
                ) : (
                  <span className="chev" />
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <LiveStats />

      <button className="cta-row" onClick={() => nav('/catalog')}>
        <span className="cell-icon">{Icons.store}</span>
        <span className="cell-main">
          <b>{t('homeCatalogTitle')}</b>
          <span className="small muted" style={{ display: 'block' }}>{t('homeCatalogText')}</span>
        </span>
        <span className="chev" />
      </button>
    </>
  );
}

/** Схема в четыре узла: по линии бежит «капля» — так заявка проходит через систему. */
function HowItWorks() {
  const t = useT();
  const steps = [
    { icon: Icons.chat, label: t('howAi1') },
    { icon: Icons.bolt, label: t('howAi2') },
    { icon: Icons.search, label: t('howAi3') },
    { icon: Icons.inbox, label: t('howAi4') },
  ];
  return (
    <div className="how-ai" aria-label={t('howAiTitle')}>
      <div className="how-line" aria-hidden>
        <i />
      </div>
      {steps.map((s, i) => (
        <div key={s.label} className="how-node" style={{ ['--i' as string]: i }}>
          <span>{s.icon}</span>
          <b>{s.label}</b>
        </div>
      ))}
    </div>
  );
}
