import { formatUzs, PLANS, REGIONS, type CategoryNode, type PlanCode } from '@dominify/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { del, get, patch, post } from './api';

/* ───────── Общее ───────── */

const STATUS: Record<string, [string, string]> = {
  draft: ['Черновик', ''],
  needs_info: ['Уточнение', 'yellow'],
  moderation: ['Модерация', 'yellow'],
  submitted: ['Отправлена', 'cyan'],
  wave_1: ['Волна 1', 'cyan'],
  wave_2: ['Волна 2', 'cyan'],
  has_offers: ['Есть отклики', 'magenta'],
  supplier_chosen: ['Выбран исполнитель', 'good'],
  completed: ['Выполнена', 'good'],
  reviewed: ['Оценена', 'good'],
  cancelled: ['Отменена', ''],
  expired: ['Истекла', ''],
  rejected: ['Отклонена', ''],
};
const Status = ({ s }: { s: string }) => <span className={`pill ${STATUS[s]?.[1] ?? ''}`}>{STATUS[s]?.[0] ?? s}</span>;
const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : formatUzs(n));
const dt = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const region = (c: string | null) => REGIONS.find((r) => r.code === c)?.name.ru ?? c ?? '—';

function useCategories() {
  const q = useQuery({ queryKey: ['categories'], queryFn: () => get<CategoryNode[]>('/v1/categories'), staleTime: 3_600_000 });
  const flat = (q.data ?? []).flatMap((r) => [r, ...(r.children ?? [])]);
  return { tree: q.data ?? [], name: (id: number | null) => flat.find((c) => c.id === id)?.name.ru ?? '—' };
}

function Loading({ q, children }: { q: { isLoading: boolean; error: unknown }; children: ReactNode }) {
  if (q.isLoading) return <p className="muted">Загрузка…</p>;
  if (q.error) return <p className="err">{(q.error as Error).message}</p>;
  return <>{children}</>;
}

/** Действие с подтверждением, блокировкой кнопки и перезагрузкой данных. */
function useAction() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  return {
    busy,
    run: async (fn: () => Promise<unknown>, confirmText?: string) => {
      if (confirmText && !window.confirm(confirmText)) return;
      setBusy(true);
      try {
        await fn();
        await qc.invalidateQueries();
      } catch (e) {
        window.alert((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
  };
}

/* ───────── Метрики ───────── */

interface Stats {
  liquidity: { total: number; good: number; share: number | null };
  medianFirstOfferMin: number | null;
  counts: Record<string, number>;
  ai24h: { calls: number; failed: number; input: number; output: number };
  byStatus: { status: string; c: number }[];
}

export function Dashboard() {
  const q = useQuery({ queryKey: ['stats'], queryFn: () => get<Stats>('/admin/stats'), refetchInterval: 30_000 });
  const s = q.data;
  return (
    <>
      <h1>Метрики</h1>
      <Loading q={q}>
        {s && (
          <>
            <div className="card">
              <div className="row between">
                <h2 style={{ margin: 0 }}>Главная метрика: заявки с 3+ откликами за 60 минут</h2>
                <span className="muted small">за 30 дней, цель 80%</span>
              </div>
              <div className="stat" style={{ margin: '10px 0' }}>
                <div className="n">{s.liquidity.share === null ? '—' : `${Math.round(s.liquidity.share * 100)}%`}</div>
                <div className="d">
                  {s.liquidity.good} из {s.liquidity.total} отправленных заявок · медиана до первого отклика{' '}
                  {s.medianFirstOfferMin === null ? '—' : `${Math.round(s.medianFirstOfferMin)} мин`}
                </div>
              </div>
              <div className="bar"><i style={{ width: `${Math.round((s.liquidity.share ?? 0) * 100)}%` }} /></div>
            </div>
            <div className="grid g4" style={{ marginBottom: 16 }}>
              {[
                ['Заявок за 24 ч', s.counts.requests_24h],
                ['Отправлено за 7 дней', s.counts.submitted_7d],
                ['Откликов за 7 дней', s.counts.offers_7d],
                ['Сделок за 30 дней', s.counts.deals_30d],
                ['Поставщиков', s.counts.suppliers],
                ['Платящих', s.counts.paying],
                ['Пользователей', s.counts.users],
                ['Открытых задач модерации', s.counts.moderation_open],
              ].map(([label, n]) => (
                <div key={label as string} className="card stat" style={{ margin: 0 }}>
                  <div className="n">{n}</div>
                  <div className="d">{label}</div>
                </div>
              ))}
            </div>
            <div className="grid g2">
              <div className="card">
                <h2>Заявки по статусам, 30 дней</h2>
                <table>
                  <tbody>
                    {s.byStatus.map((r) => (
                      <tr key={r.status}>
                        <td><Status s={r.status} /></td>
                        <td className="num">{r.c}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="card">
                <h2>ИИ за 24 часа</h2>
                <dl className="kv">
                  <dt>Вызовов</dt><dd>{s.ai24h.calls}</dd>
                  <dt>С ошибкой</dt><dd>{s.ai24h.failed}</dd>
                  <dt>Токенов на вход</dt><dd>{s.ai24h.input.toLocaleString('ru-RU')}</dd>
                  <dt>Токенов на выход</dt><dd>{s.ai24h.output.toLocaleString('ru-RU')}</dd>
                </dl>
              </div>
            </div>
          </>
        )}
      </Loading>
    </>
  );
}

/* ───────── Модерация ───────── */

interface ModItem {
  id: number;
  kind: string;
  refType: string;
  refId: number;
  note: string | null;
  status: string;
  createdAt: string;
}

const KIND: Record<string, string> = {
  request_low_confidence: 'Низкая уверенность разбора',
  request_no_suppliers: 'Нет подходящих поставщиков',
  request_no_offers: 'Нет откликов после двух волн',
  billing_contact: 'Просят связаться по тарифу',
  complaint: 'Жалоба',
};

export function Moderation() {
  const [status, setStatus] = useState('open');
  const q = useQuery({ queryKey: ['moderation', status], queryFn: () => get<ModItem[]>(`/admin/moderation?status=${status}`) });
  const a = useAction();
  const nav = useNavigate();
  const target = (m: ModItem) => (m.refType === 'request' ? `/requests/${m.refId}` : m.refType === 'company' ? `/companies/${m.refId}` : null);
  return (
    <>
      <h1>Модерация</h1>
      <div className="filters">
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">Открытые</option>
          <option value="resolved">Закрытые</option>
        </select>
      </div>
      <div className="card">
        <Loading q={q}>
          {q.data?.length === 0 && <p className="muted">Очередь пуста.</p>}
          <table>
            <tbody>
              {q.data?.map((m) => (
                <tr key={m.id}>
                  <td style={{ width: 130 }} className="muted small">{dt(m.createdAt)}</td>
                  <td>
                    <b>{KIND[m.kind] ?? m.kind}</b>
                    <div className="small muted">{m.note}</div>
                  </td>
                  <td>
                    {target(m) ? <a onClick={() => nav(target(m)!)} style={{ cursor: 'pointer' }}>{m.refType} #{m.refId}</a> : `${m.refType} #${m.refId}`}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {m.status === 'open' && (
                      <button className="btn sec" disabled={a.busy} onClick={() => a.run(() => post(`/admin/moderation/${m.id}/resolve`, { resolution: 'done' }))}>
                        Закрыть
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Loading>
      </div>
    </>
  );
}

/* ───────── Заявки ───────── */

interface ReqRow {
  id: number;
  title: string | null;
  status: string;
  source: string;
  categoryId: number | null;
  regionCode: string | null;
  confidence: number | null;
  wave: number;
  createdAt: string;
  author: string | null;
  offersCount: number;
  deliveries: number;
}

export function Requests() {
  const [status, setStatus] = useState('');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const q = useQuery({
    queryKey: ['requests', status, query],
    queryFn: () => get<ReqRow[]>(`/admin/requests?${new URLSearchParams({ ...(status ? { status } : {}), ...(query ? { q: query } : {}) })}`),
  });
  const { name } = useCategories();
  const nav = useNavigate();
  return (
    <>
      <h1>Заявки</h1>
      <div className="filters">
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Все статусы</option>
          {Object.entries(STATUS).map(([k, [label]]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </select>
        <input className="input" placeholder="Поиск по тексту" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setQuery(text)} />
      </div>
      <div className="card">
        <Loading q={q}>
          <table>
            <thead>
              <tr><th>#</th><th>Заявка</th><th>Статус</th><th>Район</th><th className="num">Рассылок</th><th className="num">Откликов</th><th>Создана</th></tr>
            </thead>
            <tbody>
              {q.data?.map((r) => (
                <tr key={r.id} className="click" onClick={() => nav(`/requests/${r.id}`)}>
                  <td>{r.id}</td>
                  <td>
                    {r.title || '—'}
                    <div className="small muted">
                      {name(r.categoryId)} · {r.author} · {r.source}
                      {r.confidence !== null && ` · уверенность ${r.confidence.toFixed(2)}`}
                    </div>
                  </td>
                  <td><Status s={r.status} /></td>
                  <td className="small">{region(r.regionCode)}</td>
                  <td className="num">{r.deliveries}</td>
                  <td className="num">{r.offersCount}</td>
                  <td className="small muted">{dt(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Loading>
      </div>
    </>
  );
}

interface AdminRequest {
  id: number;
  title: string | null;
  status: string;
  rawText: string;
  category: { id: number; name: { ru: string } } | null;
  fields: Record<string, unknown>;
  regionCode: string | null;
  deadline: string | null;
  budgetUzs: number | null;
  confidence: number | null;
  answers: { q: string; a: string }[];
  offers: { id: number; priceUzs: number; leadTimeDays: number; status: string; supplier: { id: number; name: string } }[];
  deliveries: { companyId: number; name: string; wave: number; score: number; manual: boolean; notifyAt: string; seenAt: string | null; respondedAt: string | null }[];
  wave: number;
  createdAt: string;
}

interface Candidate {
  companyId: number;
  name: string;
  score: number;
  exactCategory: boolean;
  servesRegion: boolean;
  deliveriesToday: number;
}

export function RequestAdmin() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['req', id], queryFn: () => get<AdminRequest>(`/admin/requests/${id}`) });
  const cands = useQuery({ queryKey: ['cands', id], queryFn: () => get<Candidate[]>(`/admin/requests/${id}/candidates`) });
  const { tree } = useCategories();
  const a = useAction();
  const [pick, setPick] = useState<number[]>([]);
  const r = q.data;
  const sent = new Set(r?.deliveries.map((d) => d.companyId));

  return (
    <>
      <p><Link to="/requests">‹ Заявки</Link></p>
      <Loading q={q}>
        {r && (
          <>
            <div className="row between">
              <h1>#{r.id} {r.title}</h1>
              <Status s={r.status} />
            </div>
            <div className="grid g2">
              <div className="card">
                <h2>Заявка</h2>
                <pre>{r.rawText || '—'}</pre>
                {r.answers.map((x, i) => (
                  <p key={i} className="small"><span className="muted">{x.q}</span><br />{x.a}</p>
                ))}
                <dl className="kv" style={{ marginTop: 12 }}>
                  <dt>Категория</dt>
                  <dd>
                    <select
                      className="input"
                      value={r.category?.id ?? ''}
                      onChange={(e) => a.run(() => patch(`/admin/requests/${r.id}`, { categoryId: Number(e.target.value) }))}
                    >
                      <option value="">—</option>
                      {tree.map((root) => (
                        <optgroup key={root.id} label={root.name.ru}>
                          {(root.children ?? []).map((c) => <option key={c.id} value={c.id}>{c.name.ru}</option>)}
                        </optgroup>
                      ))}
                    </select>
                  </dd>
                  {Object.entries(r.fields).map(([k, v]) => (
                    <FragmentKV key={k} k={k} v={String(v)} />
                  ))}
                  <dt>Район</dt><dd>{region(r.regionCode)}</dd>
                  <dt>Срок</dt><dd>{r.deadline ?? '—'}</dd>
                  <dt>Бюджет</dt><dd>{money(r.budgetUzs)}</dd>
                  <dt>Уверенность</dt><dd>{r.confidence?.toFixed(2) ?? '—'}</dd>
                  <dt>Создана</dt><dd>{dt(r.createdAt)}</dd>
                </dl>
                <div className="row" style={{ marginTop: 14 }}>
                  {r.status === 'moderation' && (
                    <button className="btn" disabled={a.busy} onClick={() => a.run(() => post(`/admin/requests/${r.id}/approve`))}>Одобрить и разослать</button>
                  )}
                  {!['rejected', 'cancelled', 'completed', 'reviewed'].includes(r.status) && (
                    <button
                      className="btn danger"
                      disabled={a.busy}
                      onClick={() => {
                        const reason = window.prompt('Причина отказа (увидит автор)');
                        if (reason && reason.trim().length >= 3) a.run(() => post(`/admin/requests/${r.id}/reject`, { reason: reason.trim() }));
                      }}
                    >
                      Отклонить
                    </button>
                  )}
                </div>
              </div>
              <div className="card">
                <h2>Отклики · {r.offers.length}</h2>
                <table>
                  <tbody>
                    {r.offers.map((o) => (
                      <tr key={o.id}>
                        <td><Link to={`/companies/${o.supplier.id}`}>{o.supplier.name}</Link></td>
                        <td className="num">{money(o.priceUzs)}</td>
                        <td className="num">{o.leadTimeDays} дн.</td>
                        <td><span className="pill">{o.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <h2 style={{ marginTop: 18 }}>Рассылка · волна {r.wave}</h2>
                <table>
                  <thead><tr><th>Компания</th><th>Волна</th><th className="num">Балл</th><th>Увидел</th><th>Ответил</th></tr></thead>
                  <tbody>
                    {r.deliveries.map((d) => (
                      <tr key={d.companyId}>
                        <td><Link to={`/companies/${d.companyId}`}>{d.name}</Link>{d.manual && <span className="pill yellow" style={{ marginLeft: 6 }}>вручную</span>}</td>
                        <td>{d.wave}</td>
                        <td className="num">{d.score.toFixed(3)}</td>
                        <td className="small">{dt(d.seenAt)}</td>
                        <td className="small">{dt(d.respondedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card">
              <div className="row between">
                <h2 style={{ margin: 0 }}>Ручная рассылка</h2>
                <button
                  className="btn"
                  disabled={!pick.length || a.busy}
                  onClick={() => a.run(async () => {
                    await post(`/admin/requests/${r.id}/dispatch`, { companyIds: pick });
                    setPick([]);
                  })}
                >
                  Разослать выбранным ({pick.length})
                </button>
              </div>
              <p className="muted small">Кандидаты по категории заявки с баллом скоринга. Ручная рассылка приходит сразу, без задержки тарифа.</p>
              <Loading q={cands}>
                <table>
                  <thead><tr><th /><th>Компания</th><th className="num">Балл</th><th>Категория</th><th>Зона</th><th className="num">Заявок сегодня</th></tr></thead>
                  <tbody>
                    {cands.data?.map((c) => (
                      <tr key={c.companyId}>
                        <td>
                          <input
                            type="checkbox"
                            disabled={sent.has(c.companyId)}
                            checked={pick.includes(c.companyId) || sent.has(c.companyId)}
                            onChange={() => setPick((p) => (p.includes(c.companyId) ? p.filter((x) => x !== c.companyId) : [...p, c.companyId]))}
                          />
                        </td>
                        <td><Link to={`/companies/${c.companyId}`}>{c.name}</Link></td>
                        <td className="num">{c.score.toFixed(3)}</td>
                        <td>{c.exactCategory ? 'точно' : 'вертикаль'}</td>
                        <td>{c.servesRegion ? 'да' : 'нет'}</td>
                        <td className="num">{c.deliveriesToday}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Loading>
            </div>
          </>
        )}
      </Loading>
    </>
  );
}

const FragmentKV = ({ k, v }: { k: string; v: string }) => (
  <>
    <dt>{k}</dt>
    <dd>{v}</dd>
  </>
);

/* ───────── Компании ───────── */

interface CompanyRow {
  id: number;
  name: string;
  isSupplier: boolean;
  regionCode: string;
  trustLevel: number;
  innVerified: boolean;
  hasInn: boolean;
  ratingAvg: number | null;
  dealsClosed: number;
  offersSent: number;
  blocked: boolean;
  planCode: string | null;
  planStatus: string | null;
  periodEnd: string | null;
  createdAt: string;
}

export function Companies() {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [onlySuppliers, setOnlySuppliers] = useState(true);
  const q = useQuery({
    queryKey: ['companies', query, onlySuppliers],
    queryFn: () => get<CompanyRow[]>(`/admin/companies?${new URLSearchParams({ ...(query ? { q: query } : {}), ...(onlySuppliers ? { supplier: '1' } : {}) })}`),
  });
  const nav = useNavigate();
  return (
    <>
      <h1>Компании</h1>
      <div className="filters">
        <input className="input" placeholder="Название" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setQuery(text)} />
        <label className="row"><input type="checkbox" checked={onlySuppliers} onChange={(e) => setOnlySuppliers(e.target.checked)} /> только поставщики</label>
      </div>
      <div className="card">
        <Loading q={q}>
          <table>
            <thead><tr><th>#</th><th>Компания</th><th>Тариф</th><th>Доверие</th><th className="num">Рейтинг</th><th className="num">Отклики</th><th className="num">Сделки</th><th>С</th></tr></thead>
            <tbody>
              {q.data?.map((c) => (
                <tr key={c.id} className="click" onClick={() => nav(`/companies/${c.id}`)}>
                  <td>{c.id}</td>
                  <td>
                    {c.name} {c.blocked && <span className="pill magenta">заблокирована</span>}
                    <div className="small muted">{region(c.regionCode)}{c.hasInn && !c.innVerified && ' · ИНН ждёт проверки'}</div>
                  </td>
                  <td>
                    <span className={`pill ${c.planCode && c.planCode !== 'free' ? 'cyan' : ''}`}>{PLANS[(c.planCode ?? 'free') as PlanCode]?.name.ru}</span>
                    {c.planStatus === 'grace' && <span className="pill yellow">grace</span>}
                  </td>
                  <td>L{c.trustLevel}</td>
                  <td className="num">{c.ratingAvg?.toFixed(1) ?? '—'}</td>
                  <td className="num">{c.offersSent}</td>
                  <td className="num">{c.dealsClosed}</td>
                  <td className="small muted">{dt(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Loading>
      </div>
    </>
  );
}

interface CompanyFull {
  id: number;
  name: string;
  type: string;
  inn: string | null;
  innVerifiedAt: string | null;
  regionCode: string;
  about: string | null;
  isSupplier: boolean;
  trustLevel: number;
  ratingAvg: number | null;
  ratingCount: number;
  dealsClosed: number;
  offersSent: number;
  blocked: boolean;
  createdAt: string;
  members: { userId: number; firstName: string | null; username: string | null; role: string; phone: string | null; phoneVerified: boolean }[];
  plan: { planCode: PlanCode; status: string; periodEnd: string | null; offersUsed: number; offersPerMonth: number | null };
  invoices: InvoiceRow[];
}

export function CompanyPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['company', id], queryFn: () => get<CompanyFull>(`/admin/companies/${id}`) });
  const a = useAction();
  const [plan, setPlan] = useState<PlanCode>('start');
  const [months, setMonths] = useState(1);
  const [lastLink, setLastLink] = useState<string | null>(null);
  const c = q.data;
  return (
    <>
      <p><Link to="/companies">‹ Компании</Link></p>
      <Loading q={q}>
        {c && (
          <>
            <h1>{c.name}</h1>
            <div className="grid g2">
              <div className="card">
                <h2>Профиль</h2>
                <dl className="kv">
                  <dt>Форма</dt><dd>{c.type}</dd>
                  <dt>ИНН</dt>
                  <dd>
                    {c.inn ?? '—'} {c.innVerifiedAt ? <span className="pill good">проверен</span> : c.inn ? <span className="pill yellow">не проверен</span> : null}
                  </dd>
                  <dt>Регион</dt><dd>{region(c.regionCode)}</dd>
                  <dt>Доверие</dt><dd>L{c.trustLevel}</dd>
                  <dt>Рейтинг</dt><dd>{c.ratingAvg?.toFixed(2) ?? '—'} ({c.ratingCount})</dd>
                  <dt>Откликов / сделок</dt><dd>{c.offersSent} / {c.dealsClosed}</dd>
                  <dt>О компании</dt><dd>{c.about ?? '—'}</dd>
                  <dt>Создана</dt><dd>{dt(c.createdAt)}</dd>
                </dl>
                <div className="row" style={{ marginTop: 14 }}>
                  {c.inn && !c.innVerifiedAt && (
                    <button className="btn" disabled={a.busy} onClick={() => a.run(() => post(`/admin/companies/${c.id}/verify-inn`), `ИНН ${c.inn} проверен по госреестру?`)}>
                      ИНН проверен
                    </button>
                  )}
                  <button className="btn danger" disabled={a.busy} onClick={() => a.run(() => post(`/admin/companies/${c.id}/block`, { blocked: !c.blocked }), c.blocked ? 'Разблокировать?' : 'Заблокировать компанию?')}>
                    {c.blocked ? 'Разблокировать' : 'Заблокировать'}
                  </button>
                </div>
              </div>
              <div className="card">
                <h2>Сотрудники</h2>
                <table>
                  <tbody>
                    {c.members.map((m) => (
                      <tr key={m.userId}>
                        <td>{m.firstName} {m.username && <span className="muted">@{m.username}</span>}</td>
                        <td>{m.role}</td>
                        <td>{m.phone ? `+${m.phone}` : '—'} {m.phoneVerified && <span className="pill good">✓</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="small muted">Просмотр телефонов и ИНН записывается в журнал действий.</p>
              </div>
            </div>
            <div className="card">
              <div className="row between">
                <h2 style={{ margin: 0 }}>
                  Тариф: {PLANS[c.plan.planCode].name.ru} <span className="pill">{c.plan.status}</span>
                </h2>
                <span className="muted small">
                  до {c.plan.periodEnd ? dt(c.plan.periodEnd) : '—'} · откликов в месяце {c.plan.offersUsed}/{c.plan.offersPerMonth ?? '∞'}
                </span>
              </div>
              <div className="row" style={{ margin: '14px 0' }}>
                <select className="input" value={plan} onChange={(e) => setPlan(e.target.value as PlanCode)}>
                  {(['start', 'pro', 'business'] as PlanCode[]).map((p) => (
                    <option key={p} value={p}>{PLANS[p].name.ru} · {formatUzs(PLANS[p].priceUzs)} сум</option>
                  ))}
                </select>
                <select className="input" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
                  {[1, 3, 6, 12].map((m) => <option key={m} value={m}>{m} мес.</option>)}
                </select>
                <button
                  className="btn"
                  disabled={a.busy}
                  onClick={() => a.run(async () => {
                    const inv = await post<{ payUrl: string }>('/admin/invoices', { companyId: c.id, planCode: plan, months });
                    setLastLink(inv.payUrl);
                  })}
                >
                  Выставить счёт на {formatUzs(PLANS[plan].priceUzs * months)} сум
                </button>
              </div>
              {lastLink && (
                <p className="small">
                  Ссылка на оплату для клиента: <a href={lastLink} target="_blank" rel="noreferrer">{lastLink}</a>{' '}
                  <button className="btn sec" onClick={() => navigator.clipboard.writeText(lastLink)}>Копировать</button>
                </p>
              )}
              <InvoiceTable rows={c.invoices} />
            </div>
          </>
        )}
      </Loading>
    </>
  );
}

/* ───────── Счета ───────── */

interface InvoiceRow {
  id: number;
  companyId: number;
  companyName: string;
  planCode: PlanCode;
  months: number;
  amountUzs: number;
  status: string;
  paidAt: string | null;
  paidVia: string | null;
  payToken: string;
  createdAt: string;
}

function InvoiceTable({ rows }: { rows: InvoiceRow[] }) {
  const a = useAction();
  const api = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000';
  return (
    <table>
      <thead><tr><th>№</th><th>Компания</th><th>Тариф</th><th className="num">Сумма</th><th>Статус</th><th>Создан</th><th /></tr></thead>
      <tbody>
        {rows.map((i) => (
          <tr key={i.id}>
            <td><a href={`${api}/pay/${i.payToken}`} target="_blank" rel="noreferrer">{i.id}</a></td>
            <td><Link to={`/companies/${i.companyId}`}>{i.companyName}</Link></td>
            <td>{PLANS[i.planCode]?.name.ru} × {i.months}</td>
            <td className="num">{money(i.amountUzs)}</td>
            <td>
              <span className={`pill ${i.status === 'paid' ? 'good' : i.status === 'issued' ? 'yellow' : ''}`}>{i.status}</span>
              {i.paidVia && <span className="small muted"> {i.paidVia}</span>}
            </td>
            <td className="small muted">{dt(i.createdAt)}</td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              {i.status === 'issued' && (
                <>
                  <button className="btn" disabled={a.busy} onClick={() => a.run(() => post(`/admin/invoices/${i.id}/paid`, { via: 'bank_transfer' }), `Оплата по счёту №${i.id} поступила на расчётный счёт?`)}>
                    Оплачен
                  </button>{' '}
                  <button className="btn danger" disabled={a.busy} onClick={() => a.run(() => post(`/admin/invoices/${i.id}/cancel`), 'Отменить счёт?')}>
                    ×
                  </button>
                </>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Invoices() {
  const q = useQuery({ queryKey: ['invoices'], queryFn: () => get<InvoiceRow[]>('/admin/invoices') });
  return (
    <>
      <h1>Счета</h1>
      <p className="muted">Счёт выставляется со страницы компании. Оплаты через Payme и Click отмечаются автоматически, переводы — кнопкой после сверки с выпиской.</p>
      <div className="card">
        <Loading q={q}>{q.data && <InvoiceTable rows={q.data} />}</Loading>
      </div>
    </>
  );
}

/* ───────── Команда ───────── */

export function StaffPage() {
  const q = useQuery({ queryKey: ['staff'], queryFn: () => get<{ userId: number; role: string; firstName: string | null; username: string | null; telegramId: number }[]>('/admin/staff') });
  const a = useAction();
  const [tg, setTg] = useState('');
  const [role, setRole] = useState('moderator');
  return (
    <>
      <h1>Команда</h1>
      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <input className="input" placeholder="Telegram ID" value={tg} onChange={(e) => setTg(e.target.value.replace(/\D/g, ''))} />
          <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="moderator">Модератор</option>
            <option value="support">Поддержка</option>
            <option value="admin">Админ</option>
          </select>
          <button className="btn" disabled={!tg || a.busy} onClick={() => a.run(() => post('/admin/staff', { telegramId: Number(tg), role }))}>
            Добавить
          </button>
          <span className="muted small">Человек должен хотя бы раз запустить бота.</span>
        </div>
        <Loading q={q}>
          <table>
            <tbody>
              {q.data?.map((s) => (
                <tr key={s.userId}>
                  <td>{s.firstName} {s.username && <span className="muted">@{s.username}</span>}</td>
                  <td className="muted">{s.telegramId}</td>
                  <td><span className="pill cyan">{s.role}</span></td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn danger" disabled={a.busy} onClick={() => a.run(() => del(`/admin/staff/${s.userId}`), 'Убрать из команды?')}>
                      Убрать
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Loading>
      </div>
    </>
  );
}
