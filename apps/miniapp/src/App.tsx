import { pickLang } from '@dominify/shared';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { get, login, patch, post, type ChatItem, type Me } from './api';
import { LangContext, translate, useT } from './i18n';
import { Intro, introEnabled } from './intro';
import { RevealRoot } from './motion';
import { SessionCtx, useSession } from './session';
import { connectSocket, useSocketEvent } from './socket';
import { alertMsg, haptic, startRoute } from './tg';
import { Icons, MainButton, Section, Spinner, Splash } from './ui';
import { lazy, Suspense } from 'react';

// Экраны грузятся по требованию: первый экран открывается быстрее на мобильном интернете.
const BuyerHome = lazy(() => import('./pages/BuyerHome').then((m) => ({ default: m.BuyerHome })));
const MarketHome = lazy(() => import('./pages/Market').then((m) => ({ default: m.MarketHome })));
const MarketList = lazy(() => import('./pages/Market').then((m) => ({ default: m.MarketList })));
const GigPage = lazy(() => import('./pages/Market').then((m) => ({ default: m.GigPage })));
const MyGigs = lazy(() => import('./pages/GigEditor').then((m) => ({ default: m.MyGigs })));
const GigEditor = lazy(() => import('./pages/GigEditor').then((m) => ({ default: m.GigEditor })));
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
const SavedPage = lazy(() => import('./pages/Market').then((m) => ({ default: m.SavedPage })));
const InvitePage = lazy(() => import('./pages/Profile').then((m) => ({ default: m.InvitePage })));

/** Маршрут из start_param или ?r=: req_12, deal_3, chat_5, gig_7, profile, invite, saved, new, home. */
function routeFromParam(p: string | null): string | null {
  if (!p) return null;
  const fixed: Record<string, string> = { profile: '/profile', invite: '/invite', saved: '/saved', new: '/new' };
  if (fixed[p]) return fixed[p];
  const m = /^(req|deal|chat|gig)_(\d+)$/.exec(p);
  if (!m) return null;
  return { req: `/requests/${m[2]}`, deal: `/deals/${m[2]}`, chat: `/chats/${m[2]}`, gig: `/gigs/${m[2]}` }[m[1] as 'req' | 'deal' | 'chat' | 'gig'];
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [intro, setIntro] = useState(introEnabled);
  const endIntro = useCallback(() => setIntro(false), []);
  const nav = useNavigate();

  useEffect(() => {
    // Код главной грузится, пока играет заставка.
    void import('./pages/Market');
    login()
      .then(async (r) => {
        const param = r.startParam ?? startRoute();
        // Ссылка-приглашение в команду: startapp=join_<token>.
        const join = param && /^join_([\w-]{10,64})$/.exec(param);
        if (join) {
          try {
            await post('/v1/companies/join', { token: join[1] });
            const fresh = await get<Me>('/v1/me');
            setMe(fresh);
            connectSocket();
            await alertMsg(translate(pickLang(fresh.lang), 'joinedTeam'));
            nav('/feed', { replace: true });
          } catch (e) {
            setMe(r.me);
            connectSocket();
            await alertMsg((e as Error).message);
          }
          return;
        }
        // Из initData сервер засчитывает приглашение сам; ссылка через ?r= приходит без подписи Telegram.
        if (param?.startsWith('ref_') && !r.startParam) await post('/v1/me/referral', { code: param }).catch(() => undefined);
        setMe(r.me);
        connectSocket();
        const target = routeFromParam(param);
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

  let content;
  if (error) {
    content = (
      <div className="app no-tabs">
        <div className="empty">
          <p>{error}</p>
          <button className="btn" onClick={() => window.location.reload()}>
            {translate(lang, 'retry')}
          </button>
        </div>
      </div>
    );
  } else if (!me || !session) {
    content = intro ? null : <Splash />;
  } else {
    content = (
      <LangContext.Provider value={lang}>
        <RevealRoot />
        <SessionCtx.Provider value={session}>{me.consent ? <Shell /> : <Consent />}</SessionCtx.Provider>
      </LangContext.Provider>
    );
  }

  return (
    <>
      {content}
      {intro && <Intro ready={!!session || !!error} onDone={endIntro} />}
    </>
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
  const back = useNavigationType() === 'POP';
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
  const hideTabs = /^\/(chats\/\d+|new|onboarding|company|gigs\/\d+|my-gigs\/(new|\d+))/.test(loc.pathname) || /^\/requests\/\d+/.test(loc.pathname) || /^\/deals\/\d+/.test(loc.pathname);

  const tabs =
    role === 'supplier'
      ? [
          { to: '/feed', label: t('tabFeed'), icon: Icons.inbox, alsoActive: '/offers' },
          { to: '/my-gigs', label: t('tabGigs'), icon: Icons.store },
          { to: '/deals', label: t('tabDeals'), icon: Icons.handshake },
          { to: '/chats', label: t('tabChats'), icon: Icons.chat, badge: unread },
          { to: '/profile', label: t('tabProfile'), icon: Icons.user },
        ]
      : [
          { to: '/', label: t('tabHome'), icon: Icons.home },
          { to: '/orders', label: t('tabOrders'), icon: Icons.list },
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
      <div className={`page ${back ? 'back' : ''}`} key={loc.pathname}>
      <Routes>
        <Route path="/" element={role === 'supplier' ? <Navigate to="/feed" replace /> : <MarketHome />} />
        <Route path="/orders" element={<BuyerHome />} />
        <Route path="/market" element={<MarketList />} />
        <Route path="/gigs/:id" element={<GigPage />} />
        <Route path="/my-gigs" element={supplierCompanyId ? <MyGigs /> : <Navigate to="/onboarding" replace />} />
        <Route path="/my-gigs/:id" element={supplierCompanyId ? <GigEditor /> : <Navigate to="/onboarding" replace />} />
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
        <Route path="/saved" element={<SavedPage />} />
        <Route path="/invite" element={<InvitePage />} />
        <Route path="/onboarding" element={<CompanyForm />} />
        <Route path="/company/:id" element={<CompanyForm />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </div>
      </Suspense>
      {!hideTabs && (
        <nav className="tabs">
          <div className="tabs-in">
            {tabs.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.to === '/'}
                onClick={() => haptic()}
                className={({ isActive }) => `tab ${isActive || ('alsoActive' in tab && loc.pathname === tab.alsoActive) ? 'on' : ''}`}
              >
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
