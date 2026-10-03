import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { get, type FeedItem, type MyGig } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useSocketEvent } from '../socket';
import { Empty, fmtDate, money, regionName, Section, Spinner } from '../ui';
import { useLeafCategories } from './fields';

export function Feed() {
  const t = useT();
  const nav = useNavigate();
  const { supplierCompanyId } = useSession();
  const { leaves } = useLeafCategories();
  const q = useQuery({
    queryKey: ['feed', supplierCompanyId],
    queryFn: () => get<FeedItem[]>(`/v1/feed?companyId=${supplierCompanyId}`),
    refetchInterval: 60_000,
  });
  useSocketEvent('feed.updated', () => q.refetch());
  const plan = useQuery({ queryKey: ['plan', supplierCompanyId], queryFn: () => get<{ notifyDelayMin: number }>(`/v1/billing/plan?companyId=${supplierCompanyId}`) });

  const catName = (id: number | null) => leaves.find((c) => c.id === id)?.name[t.lang] ?? '';

  const myGigs = useQuery({ queryKey: ['my-gigs', supplierCompanyId], queryFn: () => get<MyGig[]>(`/v1/gigs/mine?companyId=${supplierCompanyId}`) });

  return (
    <>
      <FeedSwitch />
      {myGigs.data?.length === 0 && (
        <div className="cta-card">
          <h2>{t('gigsEmptyTitle')}</h2>
          <div className="small">{t('gigsEmptyText')}</div>
          <button className="btn block" onClick={() => nav('/my-gigs/new')}>+ {t('newGig')}</button>
        </div>
      )}
      {plan.data && plan.data.notifyDelayMin > 0 && (
        <div className="section" style={{ padding: '12px 16px' }} onClick={() => nav('/plan')}>
          <div className="row between">
            <span className="small">
              {t('notifyDelay')}: {plan.data.notifyDelayMin} {t('minutes')}
            </span>
            <span className="chev" />
          </div>
        </div>
      )}
      <Section title={t('tabFeed')} body={false}>
        {q.isLoading && <Spinner />}
        {q.data?.length === 0 && <Empty>{t('feedEmpty')}</Empty>}
        {q.data?.map((r) => (
          <div key={r.id} className="cell" onClick={() => nav(`/requests/${r.id}`)} style={{ opacity: r.isOpen ? 1 : 0.55 }}>
            <div className="cell-main">
              <div className="cell-title">
                {r.isNew && r.isOpen && <span className="pill magenta" style={{ marginRight: 6 }}>{t('newBadge')}</span>}
                {r.title || catName(r.categoryId)}
              </div>
              <div className="cell-sub">
                {[catName(r.categoryId), regionName(r.regionCode, t.lang), r.deadline ? `${t('deadline')} ${r.deadline}` : null].filter(Boolean).join(' · ')}
              </div>
            </div>
            <div className="cell-right">
              {r.myOfferStatus ? (
                <span className={`pill ${r.myOfferStatus === 'chosen' ? 'good' : 'cyan'}`}>{t(`of_${r.myOfferStatus}` as 'of_sent')}</span>
              ) : r.isOpen ? (
                <div>{fmtDate(r.createdAt, t.lang)}</div>
              ) : (
                <span className="pill">{t('closed')}</span>
              )}
              {r.budgetUzs ? <div className="mono">≤ {money(r.budgetUzs)}</div> : null}
            </div>
          </div>
        ))}
      </Section>
    </>
  );
}

interface MyOffer {
  id: number;
  requestId: number;
  title: string | null;
  requestStatus: string;
  priceUzs: number;
  leadTimeDays: number;
  status: string;
  createdAt: string;
}

export function MyOffers() {
  const t = useT();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['my-offers'], queryFn: () => get<MyOffer[]>('/v1/offers') });
  return (
    <>
    <FeedSwitch />
    <Section title={t('tabOffers')} body={false}>
      {q.isLoading && <Spinner />}
      {q.data?.length === 0 && <Empty>{t('noOffers')}</Empty>}
      {q.data?.map((o) => (
        <div key={o.id} className="cell" onClick={() => nav(`/requests/${o.requestId}`)}>
          <div className="cell-main">
            <div className="cell-title">{o.title || `#${o.requestId}`}</div>
            <div className="cell-sub">
              {money(o.priceUzs)} {t('sum')} · {o.leadTimeDays} {t('days')} · {fmtDate(o.createdAt, t.lang)}
            </div>
          </div>
          <div className="cell-right">
            <span className={`pill ${o.status === 'chosen' ? 'good' : o.status === 'sent' ? 'cyan' : ''}`}>{t(`of_${o.status}` as 'of_sent')}</span>
          </div>
        </div>
      ))}
    </Section>
    </>
  );
}

/** Лента и свои отклики — одна вкладка: в нижней панели место занимают «Услуги». */
function FeedSwitch() {
  const t = useT();
  const nav = useNavigate();
  const loc = useLocation();
  return (
    <div className="seg wide" role="group" style={{ marginBottom: 12 }}>
      <button aria-pressed={loc.pathname === '/feed'} onClick={() => nav('/feed', { replace: true })}>{t('feedNew')}</button>
      <button aria-pressed={loc.pathname === '/offers'} onClick={() => nav('/offers', { replace: true })}>{t('tabOffers')}</button>
    </div>
  );
}
