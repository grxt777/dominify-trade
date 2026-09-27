import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { get, type MyRequest } from '../api';
import { useT } from '../i18n';
import { useSocketEvent } from '../socket';
import { Empty, fmtDate, money, Section, Spinner, StatusPill } from '../ui';

export function BuyerHome() {
  const t = useT();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['requests'], queryFn: () => get<MyRequest[]>('/v1/requests') });
  useSocketEvent('offer.created', () => q.refetch());
  useSocketEvent('request.updated', () => q.refetch());

  return (
    <>
      <div className="hero-card">
        <h2>{t('newRequest')}</h2>
        <div className="muted small">{t('newRequestHint')}</div>
        <button className="btn block" onClick={() => nav('/new')}>
          + {t('newRequest')}
        </button>
      </div>
      <Section title={t('myRequests')} body={false}>
        {q.isLoading && <Spinner />}
        {q.data?.length === 0 && <Empty>{t('noRequests')}</Empty>}
        {q.data?.map((r) => (
          <div key={r.id} className="cell" onClick={() => nav(`/requests/${r.id}`)}>
            <div className="cell-main">
              <div className="cell-title">{r.title || `#${r.id}`}</div>
              <div className="cell-sub row">
                <StatusPill status={r.status} />
                <span>#{r.id} · {fmtDate(r.createdAt, t.lang)}</span>
              </div>
            </div>
            <div className="cell-right">
              {r.offersCount > 0 ? (
                <>
                  <div style={{ color: 'var(--text)', fontWeight: 700 }}>{r.offersCount}</div>
                  <div>{t('offersN')}</div>
                  {r.bestPrice ? <div className="mono">{money(r.bestPrice)}</div> : null}
                </>
              ) : (
                <span className="chev" />
              )}
            </div>
          </div>
        ))}
      </Section>
    </>
  );
}
