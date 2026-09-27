import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, post, type Deal } from '../api';
import { useT } from '../i18n';
import { confirm, haptic, openTelegramLink } from '../tg';
import { BackButton, Empty, fmtDate, money, Section, Spinner, StarInput, TrustBadge, useToast } from '../ui';

interface DealRow {
  id: number;
  status: string;
  amountUzs: number;
  requestId: number;
  title: string | null;
  supplierName: string;
  side: 'buyer' | 'supplier';
  createdAt: string;
}

export function DealsList() {
  const t = useT();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['deals'], queryFn: () => get<DealRow[]>('/v1/deals') });
  return (
    <Section title={t('tabDeals')} body={false}>
      {q.isLoading && <Spinner />}
      {q.data?.length === 0 && <Empty>{t('noDeals')}</Empty>}
      {q.data?.map((d) => (
        <div key={d.id} className="cell" onClick={() => nav(`/deals/${d.id}`)}>
          <div className="cell-main">
            <div className="cell-title">{d.title || `#${d.requestId}`}</div>
            <div className="cell-sub">
              {d.side === 'buyer' ? d.supplierName : t('buyer')} · {money(d.amountUzs)} {t('sum')} · {fmtDate(d.createdAt, t.lang)}
            </div>
          </div>
          <div className="cell-right">
            <span className={`pill ${d.status === 'completed' ? 'good' : 'cyan'}`}>{t(`dl_${d.status}` as 'dl_active')}</span>
          </div>
        </div>
      ))}
    </Section>
  );
}

export function DealPage() {
  const { id } = useParams();
  const dealId = Number(id);
  const t = useT();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['deal', dealId], queryFn: () => get<Deal>(`/v1/deals/${dealId}`) });
  const [stars, setStars] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  if (q.isLoading) return <><BackButton /><Spinner /></>;
  if (!q.data) return <><BackButton /><Empty>{(q.error as Error)?.message}</Empty></>;
  const d = q.data;
  const iConfirmed = d.side === 'buyer' ? d.buyerConfirmed : d.supplierConfirmed;

  const doConfirm = async () => {
    if (!(await confirm(t('confirmDoneAsk')))) return;
    setBusy(true);
    try {
      const upd = await post<Deal>(`/v1/deals/${dealId}/confirm`);
      qc.setQueryData(['deal', dealId], upd);
      haptic('success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const sendReview = async () => {
    setBusy(true);
    try {
      const upd = await post<Deal>(`/v1/deals/${dealId}/review`, { stars, text: text || undefined });
      qc.setQueryData(['deal', dealId], upd);
      toast(t('thanksReview'));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const report = async () => {
    const reason = window.prompt(t('reportPrompt'));
    if (!reason || reason.trim().length < 3) return;
    await post('/v1/complaints', { targetType: 'company', targetId: d.supplier.id, reason: `Сделка #${d.id}: ${reason.trim()}` });
    toast(t('reportSent'));
  };

  return (
    <>
      <BackButton />
      <h1>{t('deal')} #{d.id}</h1>
      <Section>
        <dl className="kv">
          <dt>{t('request')}</dt>
          <dd>
            <a onClick={() => nav(`/requests/${d.request.id}`)}>{d.request.title || `#${d.request.id}`}</a>
          </dd>
          <dt>{t('amount')}</dt>
          <dd className="mono">{money(d.amountUzs)} {t('sum')}</dd>
          {d.leadTimeDays !== undefined && (
            <>
              <dt>{t('deadline')}</dt>
              <dd>{d.leadTimeDays} {t('days')}</dd>
            </>
          )}
          <dt>{t('supplier')}</dt>
          <dd>
            {d.supplier.name} <TrustBadge level={d.supplier.trustLevel} />
          </dd>
          {d.comment && (
            <>
              <dt>{t('comment')}</dt>
              <dd>{d.comment}</dd>
            </>
          )}
        </dl>
      </Section>

      {d.side === 'supplier' && d.buyer && (
        <Section title={t('contact')}>
          <div className="stack">
            <div style={{ fontWeight: 600 }}>{d.buyer.name}</div>
            {d.buyer.phone && <a href={`tel:${d.buyer.phone}`}>{d.buyer.phone}</a>}
            {d.buyer.username && (
              <button className="btn secondary" onClick={() => openTelegramLink(`https://t.me/${d.buyer!.username}`)}>
                @{d.buyer.username}
              </button>
            )}
          </div>
        </Section>
      )}

      {d.status === 'active' && (
        <Section>
          {iConfirmed ? (
            <div className="stack">
              <span className="pill good">✓ {t('youConfirmed')}</span>
              <span className="muted small">{t('waitOtherSide')}</span>
            </div>
          ) : (
            <button className="btn block" disabled={busy} onClick={doConfirm}>
              {t('confirmDone')}
            </button>
          )}
        </Section>
      )}

      {d.status === 'completed' && (
        <Section title={t('rate')}>
          {d.myReview ? (
            <div className="stack">
              <span className="stars" style={{ fontSize: 22 }}>{'★'.repeat(d.myReview.stars)}</span>
              {d.myReview.text && <div>{d.myReview.text}</div>}
              <span className="muted small">{t('thanksReview')}</span>
            </div>
          ) : (
            <div className="stack">
              <StarInput value={stars} onChange={setStars} />
              <textarea className="input" style={{ minHeight: 80 }} placeholder={t('reviewPlaceholder')} value={text} onChange={(e) => setText(e.target.value)} />
              <button className="btn block" disabled={!stars || busy} onClick={sendReview}>
                {t('sendReview')}
              </button>
            </div>
          )}
        </Section>
      )}

      {d.side === 'buyer' && (
        <button className="btn ghost" onClick={report}>
          {t('report')}
        </button>
      )}
      <p className="muted small" style={{ padding: '0 4px' }}>
        {fmtDate(d.createdAt, t.lang)}
      </p>
    </>
  );
}
