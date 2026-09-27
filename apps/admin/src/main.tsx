import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { API_URL, auth, BOT_USERNAME, get } from './api';
import { Companies, CompanyPage, Dashboard, Invoices, Moderation, RequestAdmin, Requests, StaffPage } from './pages';
import './styles.css';

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1 } } });

declare global {
  interface Window {
    onTelegramAuth?: (user: Record<string, string | number>) => void;
  }
}

/** Вход через Telegram Login Widget. Домен админки нужно указать боту в BotFather командой /setdomain. */
function Login() {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [devId, setDevId] = useState('');

  const finish = async (path: string, body: unknown) => {
    const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) {
      setError(data?.error?.message ?? 'Не удалось войти');
      return;
    }
    auth.set(data.token);
    window.location.reload();
  };

  useEffect(() => {
    window.onTelegramAuth = (user) => void finish('/v1/auth/admin', user);
    const s = document.createElement('script');
    s.src = 'https://telegram.org/js/telegram-widget.js?22';
    s.async = true;
    s.setAttribute('data-telegram-login', BOT_USERNAME);
    s.setAttribute('data-size', 'large');
    s.setAttribute('data-radius', '8');
    s.setAttribute('data-onauth', 'onTelegramAuth(user)');
    box.current?.appendChild(s);
  }, []);

  return (
    <div className="login card">
      <div className="brand" style={{ justifyContent: 'center' }}>
        <span className="dots"><i /><i /><i /><i /></span>Dominify · Админка
      </div>
      <p className="muted">Вход для команды платформы через Telegram.</p>
      <div ref={box} />
      {error && <div className="err">{error}</div>}
      {import.meta.env.DEV && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
          <input className="input" placeholder="Telegram ID (dev)" value={devId} onChange={(e) => setDevId(e.target.value)} />
          <button className="btn sec" onClick={() => finish('/v1/auth/dev', { telegramId: Number(devId), admin: true, firstName: 'Admin' })}>
            Dev-вход
          </button>
        </div>
      )}
    </div>
  );
}

function Shell() {
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => get<{ counts: { moderation_open: number } }>('/admin/stats'), refetchInterval: 30_000 });
  const open = stats.data?.counts.moderation_open ?? 0;
  const link = (to: string, label: string, badge?: number) => (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
      <span>{label}</span>
      {badge ? <span className="pill magenta">{badge}</span> : null}
    </NavLink>
  );
  return (
    <div className="layout">
      <nav className="side">
        <div className="brand">
          <span className="dots"><i /><i /><i /><i /></span>Dominify
        </div>
        {link('/', 'Метрики')}
        {link('/moderation', 'Модерация', open)}
        {link('/requests', 'Заявки')}
        {link('/companies', 'Компании')}
        {link('/invoices', 'Счета')}
        {link('/staff', 'Команда')}
        <div className="grow" />
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            auth.clear();
            window.location.reload();
          }}
        >
          Выйти
        </a>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/moderation" element={<Moderation />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/requests/:id" element={<RequestAdmin />} />
          <Route path="/companies" element={<Companies />} />
          <Route path="/companies/:id" element={<CompanyPage />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/staff" element={<StaffPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>{auth.get() ? <Shell /> : <Login />}</BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
