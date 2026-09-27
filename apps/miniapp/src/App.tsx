import { pickLang } from '@dominify/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { get, login, patch, post, type ChatItem, type Me } from './api';
import { LangContext, translate, useT } from './i18n';
import { SessionCtx, useSession } from './session';
import { connectSocket, useSocketEvent } from './socket';
import { startRoute } from './tg';
import { Icons, MainButton, Section, Spinner } from './ui';
import { lazy, Suspense } from 'react';

// Экраны грузятся по требованию: первый экран открывается быстрее на мобильном интернете.
const BuyerHome = lazy(() => import('./pages/BuyerHome').then((m) => ({ default: m.BuyerHome })));
const NewRequest = lazy(() => import('./pages/NewRequest').then((m) => ({ default: m.NewRequest })));
const RequestPage = lazy(() => import('./pages/RequestPage').then((m) => ({ default: m.RequestPage })));
const Feed = lazy(() => import('./pages/Supplier').then((m) => ({ default: m.Feed })));
const MyOffers = lazy(() => import('./pages/Supplier').then((m) => ({ default: m.MyOffers })));
const DealsList = lazy(() => import('./pages/Deals').then((m) => ({ default: m.DealsList })));
const DealPage = lazy(() => import('./pages/Deals').then((m) => ({ default: m.DealPage })));
const ChatsList = lazy(() => import('./pages/Chats').then((m) => ({ default: m.ChatsList })));
const ChatPage = lazy(() => import('./pages/Chats').then((m) => ({ default: m.ChatPage })));
const Profile = lazy(() => import('./pages/Profile').then((m) => ({ default: m.Profile })));
const PlanPage = lazy(() => import('./pages/Profile').then((m) => ({ default: m.PlanPage })));
const CompanyForm = lazy(() => import('./pages/CompanyForm').then((m) => ({ default: m.CompanyForm })));

/** Маршрут из start_param или ?r=: req_12, deal_3, chat_5, home. */
function routeFromParam(p: string | null): string | null {
  if (!p) return null;
  const m = /^(req|deal|chat)_(\d+)$/.exec(p);
  if (!m) return null;
  return { req: `/requests/${m[2]}`, deal: `/deals/${m[2]}`, chat: `/chats/${m[2]}` }[m[1] as 'req' | 'deal' | 'chat'];
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    login()
      .then((r) => {
        setMe(r.me);
        connectSocket();
        const target = routeFromParam(r.startParam ?? startRoute());
        if (target) nav(target, { replace: true });
      })
      .catch((e: Error) => setError(e.message));
  }, [nav]);

  const lang = pickLang(me?.lang);
  const session = useMemo(() => {
    if (!me) return null;
    const supplier = me.companies.find((c) => c.id === me.activeCompanyId && c.isSupplier) ?? me.companies.find((c) => c.isSupplier) ?? null;
    return { me, setMe, supplierCompanyId: supplier?.id ?? null };
  }, [me]);

  if (error) {
    return (
      <div className="app no-tabs">
        <div className="empty">
          <p>{error}</p>
          <button className="btn" onClick={() => window.location.reload()}>
            {translate(lang, 'retry')}
          </button>
        </div>
      </div>
    );
  }
  if (!me || !session) return <Spinner />;

  return (
    <LangContext.Provider value={lang}>
      <SessionCtx.Provider value={session}>{me.consent ? <Shell /> : <Consent />}</SessionCtx.Provider>
    </LangContext.Provider>
  );
}

function Consent() {
  const t = useT();
  const { me, setMe } = useSession();
  const [busy, setBusy] = useState(false);
  return (
    <div className="app no-tabs">
      <div className="topbar">
        <div className="brand">
          <span className="dots"><i /><i /><i /><i /></span>Dominify Trade
        </div>
      </div>
      <h1>{t('consentTitle')}</h1>
      <Section>
        <p style={{ margin: 0 }}>{t('consentText')}</p>
      </Section>
      <MainButton
        text={t('consentAccept')}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          await post('/v1/me/consent');
          setMe({ ...me, consent: true });
        }}
      />
    </div>
  );
}

function Shell() {
  const t = useT();
  const { me, setMe, supplierCompanyId } = useSession();
  const loc = useLocation();
  const nav = useNavigate();
  const role = me.activeRole === 'supplier' && supplierCompanyId ? 'supplier' : 'buyer';

  const chats = useQuery({ queryKey: ['chats'], queryFn: () => get<ChatItem[]>('/v1/chats'), refetchInterval: 60_000 });
  useSocketEvent('message.created', () => chats.refetch());
  const unread = (chats.data ?? []).reduce((s, c) => s + c.unread, 0);

  const switchRole = async (r: 'buyer' | 'supplier') => {
    if (r === 'supplier' && !supplierCompanyId) {
      nav('/onboarding');
      return;
    }
    const updated = await patch<Me>('/v1/me', { activeRole: r, activeCompanyId: r === 'supplier' ? supplierCompanyId : me.activeCompanyId });
    setMe(updated);
    nav(r === 'supplier' ? '/feed' : '/');
  };

  // Экраны с собственной нижней панелью (чат, форма) прячут вкладки.
  const hideTabs = /^\/(chats\/\d+|new|onboarding|company)/.test(loc.pathname) || /^\/requests\/\d+/.test(loc.pathname) || /^\/deals\/\d+/.test(loc.pathname);

  const tabs =
    role === 'supplier'
      ? [
          { to: '/feed', label: t('tabFeed'), icon: Icons.inbox },
          { to: '/offers', label: t('tabOffers'), icon: Icons.send },
          { to: '/deals', label: t('tabDeals'), icon: Icons.handshake },
          { to: '/chats', label: t('tabChats'), icon: Icons.chat, badge: unread },
          { to: '/profile', label: t('tabProfile'), icon: Icons.user },
        ]
      : [
          { to: '/', label: t('tabRequests'), icon: Icons.list },
          { to: '/deals', label: t('tabDeals'), icon: Icons.handshake },
          { to: '/chats', label: t('tabChats'), icon: Icons.chat, badge: unread },
          { to: '/profile', label: t('tabProfile'), icon: Icons.user },
        ];

  return (
    <div className={`app ${hideTabs ? 'no-tabs' : ''}`}>
      {!hideTabs && (
        <div className="topbar">
          <div className="brand">
            <span className="dots"><i /><i /><i /><i /></span>Dominify
          </div>
          <div className="seg" role="group">
            <button aria-pressed={role === 'buyer'} onClick={() => switchRole('buyer')}>{t('roleBuyer')}</button>
            <button aria-pressed={role === 'supplier'} onClick={() => switchRole('supplier')}>{t('roleSupplier')}</button>
          </div>
        </div>
      )}
      <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/" element={role === 'supplier' ? <Navigate to="/feed" replace /> : <BuyerHome />} />
        <Route path="/new" element={<NewRequest />} />
        <Route path="/requests/:id" element={<RequestPage />} />
        <Route path="/feed" element={supplierCompanyId ? <Feed /> : <Navigate to="/onboarding" replace />} />
        <Route path="/offers" element={<MyOffers />} />
        <Route path="/deals" element={<DealsList />} />
        <Route path="/deals/:id" element={<DealPage />} />
        <Route path="/chats" element={<ChatsList />} />
        <Route path="/chats/:id" element={<ChatPage />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/plan" element={<PlanPage />} />
        <Route path="/onboarding" element={<CompanyForm />} />
        <Route path="/company/:id" element={<CompanyForm />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
      {!hideTabs && (
        <nav className="tabs">
          <div className="tabs-in">
            {tabs.map((tab) => (
              <NavLink key={tab.to} to={tab.to} end={tab.to === '/'} className={({ isActive }) => `tab ${isActive ? 'on' : ''}`}>
                {tab.icon}
                {tab.label}
                {tab.badge ? <span className="badge">{tab.badge}</span> : null}
              </NavLink>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}
