import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, post, type Deal, type PaymentStatus } from '../api';
import { useT } from '../i18n';
import { confetti, confettiFrom, SuccessMark } from '../motion';
import { useSession } from '../session';
import { confirm, haptic, openLink, openTelegramLink } from '../tg';
import { BackButton, Empty, fmtDate, Icons, money, Section, Spinner, StarInput, TrustBadge, useToast, VerifiedMark } from '../ui';

interface DealRow {
  id: number;
  status: string;
  paymentStatus: PaymentStatus;
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
            {['held', 'payout_due', 'paid_out'].includes(d.paymentStatus) && (
              <div className="cell-sub good-text">{Icons.shield} {t(`ps_${d.paymentStatus}` as 'ps_held')}</div>
            )}
          </div>
          <div className="cell-right">
            <span className={`pill ${d.status === 'completed' ? 'good' : d.status === 'disputed' ? 'yellow' : d.status === 'cancelled' ? '' : 'cyan'}`}>
              {t(`dl_${d.status}` as 'dl_active')}
            </span>
          </div>
        </div>
      ))}
    </Section>
  );
}

const PS_PILL: Partial<Record<PaymentStatus, string>> = {
  awaiting: 'yellow',
  held: 'good',
  payout_due: 'cyan',
  paid_out: 'good',
  refund_due: 'yellow',
  refunded: '',
};

/** Безопасная оплата: покупатель платит Dominify, исполнитель видит, что деньги уже ждут его. */
function PaymentCard({ d, onChanged }: { d: Deal; onChanged: () => void }) {
  const t = useT();
  const toast = useToast();
  const { me } = useSession();
  const [busy, setBusy] = useState(false);
  const p = d.payment;
  const status = p.status !== 'none' ? <span className={`pill ${PS_PILL[p.status] ?? ''}`}>{t(`ps_${p.status}` as 'ps_held')}</span> : null;

  if (d.side === 'supplier') {
    if (d.status === 'cancelled' && p.status === 'none') return null;
    const payout = t.f('payoutTpl', money(p.payoutUzs ?? 0), p.feePercent);
    return (
      <Section title={t('payTitle')}>
        <div className="stack">
          {status}
          {p.status === 'held' && (
            <div className="pay-ok">
              <SuccessMark size={36} />
              <span className="small">{t('heldSupplierText')}</span>
            </div>
          )}
          {(p.status === 'none' || p.status === 'awaiting') && d.status === 'active' && <span className="small warn-text">{t('supplierNotPaid')}</span>}
          {['none', 'awaiting', 'held', 'payout_due', 'paid_out'].includes(p.status) && <span className="muted small">{payout}</span>}
        </div>
      </Section>
    );
  }

  const pay = async () => {
    setBusy(true);
    try {
      const r = await post<{ payUrl: string }>(`/v1/deals/${d.id}/pay`);
      openLink(r.payUrl);
      onChanged();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (p.status === 'none') {
    if (d.status !== 'active' || !p.quote) return null;
    const qt = p.quote;
    return (
      <Section title={t('payTitle')}>
        <div className="pay-card">
          <dl className="kv">
            <dt>{t('payAmount')}</dt>
            <dd className="mono">{money(d.amountUzs)} {t('sum')}</dd>
            {qt.discountUzs > 0 && (
              <>
                <dt>{t('payDiscount')}</dt>
                <dd className="mono good-text">−{money(qt.discountUzs)}</dd>
              </>
            )}
            {qt.bonusUzs > 0 && (
              <>
                <dt>{t('payBonus')}</dt>
                <dd className="mono good-text">−{money(qt.bonusUzs)}</dd>
              </>
            )}
            <dt><b>{t('payTotal')}</b></dt>
            <dd className="mono"><b>{money(qt.payUzs)} {t('sum')}</b></dd>
          </dl>
          {!qt.firstOrder && qt.phoneNeeded && me.firstOrder && <div className="small warn-text">{t('payPhoneHint')}</div>}
          <button className="btn block" disabled={busy} onClick={pay}>
            {Icons.shield} {t('payNow')} · {money(qt.payUzs)} {t('sum')}
          </button>
          <div className="muted small">{t('payExplain')}</div>
        </div>
      </Section>
    );
  }

  return (
    <Section title={t('payTitle')}>
      <div className="stack">
        {status}
        {p.status === 'awaiting' && p.payUrl && (
          <>
            <button className="btn block pay-cta" onClick={() => openLink(p.payUrl!)}>
              {Icons.shield} {t('payContinue')} · {money(p.paidUzs ?? d.amountUzs)} {t('sum')}
            </button>
            <button className="btn ghost block" onClick={onChanged}>{t('payRefresh')}</button>
          </>
        )}
        {p.status === 'held' && (
          <div className="pay-ok">
            <SuccessMark size={36} />
            <span className="small">{t('heldBuyerText')}</span>
          </div>
        )}
        {p.paidUzs !== null && p.paidUzs !== undefined && p.status !== 'awaiting' && (
          <span className="muted small">
            {t('payTotal')}: {money(p.paidUzs)} {t('sum')}
            {p.discountUzs ? ` · ${t('payDiscount')} −${money(p.discountUzs)}` : ''}
            {p.bonusUzs ? ` · ${t('payBonus')} −${money(p.bonusUzs)}` : ''}
          </span>
        )}
      </div>
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
  const q = useQuery({
    queryKey: ['deal', dealId],
    queryFn: () => get<Deal>(`/v1/deals/${dealId}`),
    // Пока человек платит на странице Payme/Click, статус оплаты подтягивается сам.
    refetchInterval: (query) => (query.state.data?.payment.status === 'awaiting' ? 5000 : false),
  });
  const [stars, setStars] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  // Праздник только в момент перемены: оплата дошла или сделка закрыта, а не при каждом открытии.
  const prev = useRef<{ pay?: PaymentStatus; status?: string }>({});
  const payStatus = q.data?.payment.status;
  const dealStatus = q.data?.status;
  useEffect(() => {
    if (!payStatus || !dealStatus) return;
    const was = prev.current;
    if (was.pay === 'awaiting' && payStatus === 'held') confetti();
    else if (was.status === 'active' && dealStatus === 'completed') confetti();
    prev.current = { pay: payStatus, status: dealStatus };
  }, [payStatus, dealStatus]);

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

  const sendReview = async (e: MouseEvent<HTMLButtonElement>) => {
    const btn = e.currentTarget;
    setBusy(true);
    try {
      const upd = await post<Deal>(`/v1/deals/${dealId}/review`, { stars, text: text || undefined });
      if (stars >= 4) confettiFrom(btn, 70);
      qc.setQueryData(['deal', dealId], upd);
      toast(t('thanksReview'));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const closeWith = async (kind: 'cancel' | 'dispute') => {
    const reason = window.prompt(t(kind === 'cancel' ? 'cancelDealPrompt' : 'disputePrompt'));
    if (reason === null) return;
    if (reason.trim().length < 3) {
      toast(t('reasonTooShort'), 'error');
      return;
    }
    setBusy(true);
    try {
      const upd = await post<Deal>(`/v1/deals/${dealId}/${kind}`, { reason: reason.trim() });
      qc.setQueryData(['deal', dealId], upd);
      qc.invalidateQueries({ queryKey: ['deals'] });
      qc.invalidateQueries({ queryKey: ['request', d.request.id] });
      if (kind === 'dispute') toast(t('disputeOpened'));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const otherConfirmed = d.side === 'buyer' ? d.supplierConfirmed : d.buyerConfirmed;

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
            {d.supplier.name} {d.supplier.innVerified && <VerifiedMark />} <TrustBadge level={d.supplier.trustLevel} />
          </dd>
          {d.comment && (
            <>
              <dt>{t('comment')}</dt>
              <dd>{d.comment}</dd>
            </>
          )}
        </dl>
      </Section>

      <PaymentCard d={d} onChanged={() => void q.refetch()} />

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
          <div className="stack">
            {iConfirmed ? (
              <>
                <span className="pill good">✓ {t('youConfirmed')}</span>
                <span className="muted small">{t('waitOtherSide')}</span>
              </>
            ) : (
              <button className="btn block" disabled={busy} onClick={doConfirm}>
                {t('confirmDone')}
              </button>
            )}
            {!iConfirmed && otherConfirmed && <span className="muted small">{t('otherConfirmedHint')}</span>}
            {d.canCancel && (
              <button className="btn secondary block" disabled={busy} onClick={() => closeWith('cancel')}>
                {t('cancelDeal')}
              </button>
            )}
            {d.side === 'buyer' && d.payment.status === 'held' && !otherConfirmed && <span className="muted small">{t('paidUseDispute')}</span>}
            {d.canDispute && (
              <button className="btn ghost block" disabled={busy} onClick={() => closeWith('dispute')}>
                {t('openDispute')}
              </button>
            )}
          </div>
        </Section>
      )}

      {(d.status === 'cancelled' || d.status === 'disputed') && (
        <Section>
          <div className="stack">
            <span className={`pill ${d.status === 'disputed' ? 'yellow' : ''}`}>
              {d.status === 'disputed' ? t('disputeOpened') : t('dealCancelledBy')}
            </span>
            {d.closeReason && (
              <span className="small">
                {t('reasonLabel')}: {d.closeReason}
              </span>
            )}
          </div>
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

      {d.status === 'completed' && d.side === 'buyer' && (
        <div className="reorder">
          <div className="small">{t('reorderHint')}</div>
          <button className="btn block" onClick={() => nav(d.request.gigId ? `/gigs/${d.request.gigId}` : '/new')}>
            {Icons.refresh} {t('reorder')}
          </button>
        </div>
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
