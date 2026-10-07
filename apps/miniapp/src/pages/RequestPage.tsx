import type { FieldDef } from '@dominify/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError, get, imgSrc, post, type Offer, type RequestView } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useSocketEvent } from '../socket';
import { confetti } from '../motion';
import { confirm, openLink } from '../tg';
import { BackButton, Empty, fmtDate, Icons, MainButton, money, regionName, Section, Spinner, Stars, StatusPill, TrustBadge, useToast } from '../ui';
import { CategorySelect, FieldInput, RegionSelect, useLeafCategories } from './fields';
import { AiThinking, AiQuestion, FunnelBar, MatchPipeline, Understood } from './ai';

const WAITING = ['submitted', 'wave_1', 'wave_2', 'moderation'];

export function RequestPage() {
  const { id } = useParams();
  const reqId = Number(id);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['request', reqId],
    queryFn: () => get<RequestView>(`/v1/requests/${reqId}`),
    // Пока воркер разбирает заявку, опрашиваем раз в полторы секунды (на случай, если сокет не подключён).
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d || d.role !== 'author') return false;
      if (d.status === 'draft' && d.confidence == null) return 1500;
      // Ждём откликов: сокет приносит события сразу, опрос — запасной путь (и для отложенной рассылки по тарифам).
      if (WAITING.includes(d.status)) return 20_000;
      return false;
    },
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['request', reqId] });
  useSocketEvent('request.updated', refresh, `request:${reqId}`);
  useSocketEvent('offer.created', refresh, `request:${reqId}`);
  useSocketEvent('offer.updated', refresh, `request:${reqId}`);
  useSocketEvent('request.progress', refresh, `request:${reqId}`);

  if (q.isLoading) return <><BackButton /><Spinner /></>;
  if (q.error || !q.data) return <><BackButton /><Empty>{(q.error as Error)?.message}</Empty></>;
  const r = q.data;
  if (r.role === 'supplier') return <SupplierView r={r} onChange={refresh} />;
  if (['draft', 'needs_info'].includes(r.status)) return <DraftView r={r} onChange={refresh} />;
  return <AuthorView r={r} onChange={refresh} />;
}

function Files({ files }: { files: RequestView['files'] }) {
  if (!files.length) return null;
  const open = async (fid: number) => {
    const { url } = await get<{ url: string }>(`/v1/files/${fid}/url`);
    openLink(url);
  };
  return (
    <div className="thumbs" style={{ marginTop: 10 }}>
      {files.map((f) => (
        <button key={f.id} className="thumb" onClick={() => open(f.id)}>
          {f.mime.startsWith('image/') ? '🖼' : f.mime === 'audio/ogg' ? '🎙' : 'PDF'}
        </button>
      ))}
    </div>
  );
}

/** Заказ с витрины: какую услугу и пакет выбрал покупатель. */
function OrderCard({ r }: { r: RequestView }) {
  const t = useT();
  const nav = useNavigate();
  const o = r.order;
  if (!o) return null;
  return (
    <Section title={r.role === 'supplier' ? t('orderViaGig') : t('yourOrder')}>
      <div className="order-card" onClick={() => r.role !== 'supplier' && nav(`/gigs/${o.gigId}`)}>
        {o.cover && <img src={imgSrc(o.cover)} alt="" />}
        <div className="cell-main">
          <div className="small muted">{o.companyName}</div>
          <div style={{ fontWeight: 600 }}>{o.title}</div>
          {o.package && (
            <div className="row small" style={{ marginTop: 4 }}>
              <span className="pill cyan">{t('packageLabel')}: {o.package.name}</span>
              <b>{money(o.package.priceUzs)} {t('sum')}</b>
              <span className="muted">{t.f('daysTpl', o.package.days)}</span>
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}

/** Сводка полей заявки для просмотра. */
function Details({ r }: { r: RequestView }) {
  const t = useT();
  const shown = r.fieldDefs.filter((d) => r.fields[d.key] !== undefined && r.fields[d.key] !== null && r.fields[d.key] !== '' && r.fields[d.key] !== false);
  const val = (d: FieldDef) => {
    const v = r.fields[d.key];
    if (d.type === 'boolean') return t('yes');
    if (d.type === 'select') return d.options?.find((o) => o.value === v)?.label[t.lang] ?? String(v);
    return String(v);
  };
  return (
    <dl className="kv">
      {r.category && (
        <>
          <dt>{t('category')}</dt>
          <dd>{r.category.name[t.lang]}</dd>
        </>
      )}
      {shown.map((d) => (
        <FragmentKV key={d.key} k={d.label[t.lang]} v={val(d)} />
      ))}
      {r.regionCode && <FragmentKV k={t('region')} v={regionName(r.regionCode, t.lang)} />}
      {r.deadline && <FragmentKV k={t('deadline')} v={r.deadline} />}
      {r.budgetUzs ? <FragmentKV k={t('budget')} v={money(r.budgetUzs)} /> : null}
    </dl>
  );
}

const FragmentKV = ({ k, v }: { k: string; v: string }) => (
  <>
    <dt>{k}</dt>
    <dd>{v}</dd>
  </>
);

/* ───────── Черновик: проверка и отправка ───────── */

function DraftView({ r, onChange }: { r: RequestView; onChange: () => void }) {
  const t = useT();
  const toast = useToast();
  const nav = useNavigate();
  const { leaves } = useLeafCategories();
  const parsing = r.status === 'draft' && r.confidence == null;

  const [categoryId, setCategoryId] = useState<number | null>(r.category?.id ?? null);
  const [fields, setFields] = useState<Record<string, unknown>>(r.fields);
  const [regionCode, setRegionCode] = useState<string>(r.regionCode ?? 'tashkent');
  const [deadline, setDeadline] = useState<string>(r.deadline ?? '');
  const [budget, setBudget] = useState<string>(r.budgetUzs ? String(r.budgetUzs) : '');
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const answered = r.answers?.length ?? 0;
  useEffect(() => setThinking(false), [answered, r.confidence]);

  // После нового разбора подтягиваем то, что нашла модель.
  useEffect(() => {
    setCategoryId(r.category?.id ?? null);
    setFields(r.fields);
    if (r.regionCode) setRegionCode(r.regionCode);
    if (r.deadline) setDeadline(r.deadline);
    if (r.budgetUzs) setBudget(String(r.budgetUzs));
  }, [r.confidence, r.category?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const defs: FieldDef[] = useMemo(() => {
    const leaf = leaves.find((c) => c.id === categoryId);
    if (!leaf) return r.fieldDefs;
    const seen = new Set<string>();
    return [...leaf.fields, ...(leaf.root.fields ?? [])].filter((f) => (seen.has(f.key) ? false : (seen.add(f.key), true)));
  }, [leaves, categoryId, r.fieldDefs]);

  const missing = defs.filter((d) => d.required && (fields[d.key] === undefined || fields[d.key] === null || fields[d.key] === ''));

  const submit = async () => {
    setBusy(true);
    try {
      await post(`/v1/requests`, {
        requestId: r.id,
        categoryId: categoryId ?? undefined,
        fields,
        regionCode,
        deadline: deadline || null,
        budgetUzs: budget ? Number(budget) : null,
      });
      confetti({ count: 90 });
      onChange();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  // Первый разбор — на весь экран: видно, как ИИ читает заявку и что именно делает.
  if (parsing && answered === 0) {
    return (
      <>
        <BackButton to="/" />
        <h1>{t('parsing')}</h1>
        <OrderCard r={r} />
        <AiThinking text={r.rawText} hasFiles={r.files.length > 0} />
      </>
    );
  }

  // Вопросы закончились, а обязательные поля не заполнены — форма открыта сразу.
  const formOpen = showForm || (!r.question && !parsing && (missing.length > 0 || !categoryId));

  return (
    <>
      <BackButton to="/" />
      <h1>{t('checkAndSend')}</h1>
      <OrderCard r={r} />
      {r.duplicateOf && (
        <Section>
          <div className="row between">
            <span className="pill yellow">{t('duplicateWarn')}</span>
            <button className="btn ghost" onClick={() => nav(`/requests/${r.duplicateOf}`)}>#{r.duplicateOf} ›</button>
          </div>
        </Section>
      )}
      <Understood r={r} />
      {parsing || thinking ? (
        <AiThinking compact />
      ) : r.question ? (
        <AiQuestion r={r} onAnswered={onChange} onThinking={() => setThinking(true)} />
      ) : (
        <div className={`ai-ready ${missing.length || !categoryId ? 'warn' : ''}`}>
          {missing.length || !categoryId ? t('aiFillRest') : <>{Icons.check} {t('aiReady')}</>}
        </div>
      )}
      {formOpen ? (
        <Section>
          <div className="stack">
            <CategorySelect value={categoryId} onChange={setCategoryId} />
            {defs.map((d) => (
              <FieldInput key={d.key} def={d} value={fields[d.key]} onChange={(v) => setFields((f) => ({ ...f, [d.key]: v }))} />
            ))}
            <RegionSelect value={regionCode} onChange={setRegionCode} />
            <label className="field">
              <span>{t('deadline')}</span>
              <input className="input" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('budget')}</span>
              <input className="input" type="number" inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} />
            </label>
          </div>
          <Files files={r.files} />
        </Section>
      ) : (
        <button className="cta-row" onClick={() => setShowForm(true)}>
          <span className="cell-main">{t('editDetails')}</span>
          <span className="chev" />
        </button>
      )}
      {r.rawText && (
        <Section>
          <div className="muted small" style={{ whiteSpace: 'pre-wrap' }}>{r.rawText}</div>
        </Section>
      )}
      <MainButton text={r.order ? t('sendOrder') : t('sendToSuppliers')} onClick={submit} loading={busy} disabled={!categoryId || missing.length > 0 || parsing || thinking} />
    </>
  );
}

/* ───────── Автор после отправки: отклики и выбор ───────── */

function AuthorView({ r, onChange }: { r: RequestView; onChange: () => void }) {
  const t = useT();
  const nav = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);
  const offers = r.offers ?? [];
  const open = ['submitted', 'wave_1', 'wave_2', 'has_offers'].includes(r.status);

  const choose = async (o: Offer) => {
    if (!(await confirm(t('chooseConfirm')))) return;
    setBusy(o.id);
    try {
      const deal = await post<{ id: number }>(`/v1/offers/${o.id}/choose`);
      confetti();
      nav(`/deals/${deal.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const writeTo = async (o: Offer) => {
    const chats = await get<{ id: number; requestId: number; supplierCompanyId: number }[]>('/v1/chats');
    const chat = chats.find((c) => c.requestId === r.id && c.supplierCompanyId === o.supplier.id);
    if (chat) nav(`/chats/${chat.id}`);
  };

  const cancel = async () => {
    if (!(await confirm(t('cancelConfirm')))) return;
    await post(`/v1/requests/${r.id}/cancel`);
    onChange();
  };

  return (
    <>
      <BackButton to="/" />
      <h1>{r.title || `#${r.id}`}</h1>
      <OrderCard r={r} />
      {(open || r.status === 'moderation') && (offers.length === 0 ? <MatchPipeline r={r} /> : <FunnelBar r={r} />)}
      <Section>
        <div className="row between" style={{ marginBottom: 10 }}>
          <StatusPill status={r.status} />
          <span className="muted small">#{r.id} · {fmtDate(r.submittedAt ?? r.createdAt, t.lang)}</span>
        </div>
        <Details r={r} />
        <Files files={r.files} />
      </Section>

      {r.dealId && (
        <button className="btn block" style={{ marginBottom: 12 }} onClick={() => nav(`/deals/${r.dealId}`)}>
          {t('openDeal')}
        </button>
      )}

      {offers.length > 0 && (
        <Section title={`${t('offers')} · ${offers.length}`} body={false}>
          {offers.map((o, i) => (
            <div key={o.id} className={`offer ${i === 0 && offers.length > 1 ? 'best' : ''}`}>
              {o.supplier.id === r.order?.companyId && <span className="pill magenta">{t('chosenSeller')}</span>}
              <div className="row between">
                <div style={{ fontWeight: 600 }}>{o.supplier.name}</div>
                <div className="price">
                  {money(o.priceUzs)} <span className="small muted">{t('sum')}</span>
                </div>
              </div>
              <div className="row small muted">
                <Stars value={o.supplier.ratingAvg} count={o.supplier.ratingCount} />
                <span>· {t('deals')}: {o.supplier.dealsClosed}</span>
                <span>· {o.leadTimeDays} {t('days')}</span>
                <TrustBadge level={o.supplier.trustLevel} />
              </div>
              {o.comment && <div className="small">{o.comment}</div>}
              {o.status === 'sent' && open && (
                <div className="row">
                  <button className="btn" disabled={busy === o.id} onClick={() => choose(o)}>
                    {t('choose')}
                  </button>
                  <button className="btn secondary" onClick={() => writeTo(o)}>
                    {t('write')}
                  </button>
                </div>
              )}
              {o.status !== 'sent' && <span className={`pill ${o.status === 'chosen' ? 'good' : ''}`}>{t(`of_${o.status}` as 'of_sent')}</span>}
            </div>
          ))}
        </Section>
      )}

      {open && (
        <button className="btn danger block" onClick={cancel}>
          {t('cancelRequest')}
        </button>
      )}
    </>
  );
}

/* ───────── Поставщик: заявка и отклик ───────── */

function SupplierView({ r, onChange }: { r: RequestView; onChange: () => void }) {
  const t = useT();
  const nav = useNavigate();
  const toast = useToast();
  const mine = r.myOffer;
  const [price, setPrice] = useState(mine ? String(mine.priceUzs) : '');
  const [days, setDays] = useState(mine ? String(mine.leadTimeDays) : '');
  const [comment, setComment] = useState(mine?.comment ?? '');
  const [busy, setBusy] = useState(false);
  const { me } = useSession();
  const editable = r.isOpen && (!mine || mine.status === 'sent' || mine.status === 'withdrawn');

  const send = async () => {
    setBusy(true);
    try {
      await post(`/v1/requests/${r.id}/offers`, { priceUzs: Number(price), leadTimeDays: Number(days), comment: comment || undefined });
      toast(t('offerSent'));
      onChange();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'phone_required') nav('/profile');
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    if (!mine) return;
    await post(`/v1/offers/${mine.id}/withdraw`);
    onChange();
  };

  return (
    <>
      <BackButton to="/feed" />
      <h1>{r.title || `#${r.id}`}</h1>
      <OrderCard r={r} />
      <Section>
        <div className="row between" style={{ marginBottom: 10 }}>
          {r.isOpen ? <span className="pill cyan">{t('st_wave_1')}</span> : <span className="pill">{t('closed')}</span>}
          <span className="muted small">#{r.id} · {fmtDate(r.submittedAt ?? r.createdAt, t.lang)}</span>
        </div>
        <Details r={r} />
        <Files files={r.files} />
        {r.buyer && (
          <div className="row small" style={{ marginTop: 10 }}>
            <span className="muted">{t('buyer')}:</span> <b>{r.buyer.name}</b> <TrustBadge level={r.buyer.trustLevel} />
          </div>
        )}
      </Section>

      {r.dealId && (
        <button className="btn block" style={{ marginBottom: 12 }} onClick={() => nav(`/deals/${r.dealId}`)}>
          {t('openDeal')}
        </button>
      )}

      <Section title={t('yourOffer')}>
        {editable ? (
          <div className="stack">
            {!me.phoneVerified && (
              <div className="stack">
                <b className="small">{t('phoneRequired')}</b>
                <span className="muted small">{t('phoneRequiredHint')}</span>
                <button className="btn secondary" onClick={() => nav('/profile')}>
                  {t('confirmPhone')}
                </button>
              </div>
            )}
            <label className="field">
              <span>{t('price')} *</span>
              <input className="input" type="number" inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('leadTime')} *</span>
              <input className="input" type="number" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('comment')}</span>
              <textarea className="input" style={{ minHeight: 80 }} placeholder={t('commentPlaceholder')} value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
            {mine?.status === 'sent' && (
              <button className="btn danger" onClick={withdraw}>
                {t('withdraw')}
              </button>
            )}
          </div>
        ) : mine ? (
          <div className="stack">
            <div className="price">{money(mine.priceUzs)} {t('sum')}</div>
            <div className="muted small">{mine.leadTimeDays} {t('days')}</div>
            <span className={`pill ${mine.status === 'chosen' ? 'good' : ''}`}>{t(`of_${mine.status}` as 'of_sent')}</span>
          </div>
        ) : (
          <div className="muted">{t('closed')}</div>
        )}
      </Section>
      {editable && (
        <MainButton text={mine?.status === 'sent' ? t('updateOffer') : t('sendOffer')} onClick={send} loading={busy} disabled={!(Number(price) > 0) || days === '' || Number(days) < 0} />
      )}
    </>
  );
}
