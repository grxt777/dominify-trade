import { LANGS, type Lang } from '@dominify/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { del, get, patch, post, type Me, type PlanInfo, type TeamMember } from '../api';
import { LANG_NAMES, useT } from '../i18n';
import { useSession } from '../session';
import { disconnectSocket } from '../socket';
import { alertMsg, confirm, haptic, openTelegramLink, requestContact, requestWriteAccess, tg } from '../tg';
import { BackButton, Empty, fmtDate, Icons, money, Section, Spinner, Stars, TrustBadge, useToast } from '../ui';

const SUPPORT_URL = (import.meta.env.VITE_SUPPORT_URL as string | undefined) ?? 'https://t.me/dominify_support';

export function Profile() {
  const t = useT();
  const nav = useNavigate();
  const toast = useToast();
  const { me, setMe, supplierCompanyId } = useSession();
  const [busy, setBusy] = useState(false);

  const reload = async () => setMe(await get<Me>('/v1/me'));

  const confirmPhone = async () => {
    setBusy(true);
    const sent = await requestContact();
    if (!sent) {
      // Вне Telegram или старая версия клиента: номер можно отправить боту командой /phone.
      toast('/phone', 'error');
      setBusy(false);
      return;
    }
    // Контакт приходит боту, бот сохраняет номер; ждём пару секунд и перечитываем профиль.
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const fresh = await get<Me>('/v1/me');
      if (fresh.phoneVerified) {
        setMe(fresh);
        haptic('success');
        break;
      }
    }
    setBusy(false);
  };

  const enableNotifications = async () => {
    const ok = await requestWriteAccess();
    if (ok) {
      await post('/v1/me/write-access');
      await reload();
    }
  };

  const setLang = async (lang: Lang) => setMe(await patch<Me>('/v1/me', { lang }));

  return (
    <>
      <h1>{[me.firstName, me.lastName].filter(Boolean).join(' ') || t('profile')}</h1>

      <Section title={t('phone')}>
        {me.phoneVerified ? (
          <div className="row between">
            <span>{me.phone}</span>
            <span className="pill good">✓</span>
          </div>
        ) : (
          <div className="stack">
            <span className="muted">{t('phoneNotConfirmed')}</span>
            <button className="btn" disabled={busy} onClick={confirmPhone}>
              {t('confirmPhone')}
            </button>
            <span className="muted small">{t('phoneWhy')}</span>
          </div>
        )}
      </Section>

      <Section body={false}>
        <div className="cell" onClick={() => nav('/invite')}>
          <span className="cell-icon">{Icons.gift}</span>
          <div className="cell-main">
            <div className="cell-title">{t('inviteTitle')}</div>
            <div className="cell-sub">{t.f('inviteBannerTpl', money(me.referral.bonusUzs))}</div>
          </div>
          <div className="cell-right">{me.bonusUzs > 0 ? <b className="good-text">{money(me.bonusUzs)}</b> : <span className="chev" />}</div>
        </div>
        <div className="cell" onClick={() => nav('/saved')}>
          <span className="cell-icon">{Icons.heart}</span>
          <div className="cell-main">
            <div className="cell-title">{t('savedTitle')}</div>
          </div>
          <div className="cell-right"><span className="chev" /></div>
        </div>
      </Section>

      <Section title={t('notifications')}>
        {me.botStarted ? (
          <span className="pill good">✓ {t('notificationsOn')}</span>
        ) : (
          <button className="btn secondary" onClick={enableNotifications}>
            {t('enableNotifications')}
          </button>
        )}
      </Section>

      <Section title={t('companies')} body={false}>
        {me.companies.map((c) => (
          <div key={c.id} className="cell" onClick={() => nav(`/company/${c.id}`)}>
            <div className="cell-main">
              <div className="cell-title">{c.name}</div>
              <div className="cell-sub row">
                {c.isSupplier && <span className="pill cyan">{t('roleSupplier')}</span>}
                <span>{c.planName[t.lang]}</span>
                <TrustBadge level={c.trustLevel} />
              </div>
              {c.isSupplier && <div className="cell-sub"><Stars value={c.ratingAvg} count={c.ratingCount} /></div>}
            </div>
            <span className="chev" />
          </div>
        ))}
        <div className="cell" onClick={() => nav('/onboarding')}>
          <div className="cell-main" style={{ color: 'var(--link)', fontWeight: 600 }}>
            + {supplierCompanyId ? t('createCompany') : t('becomeSupplier')}
          </div>
        </div>
      </Section>

      {supplierCompanyId && <TeamSection companyId={supplierCompanyId} />}

      {supplierCompanyId && (
        <Section body={false}>
          <div className="cell" onClick={() => nav('/plan')}>
            <div className="cell-main">
              <div className="cell-title">{t('plan')}</div>
            </div>
            <span className="chev" />
          </div>
        </Section>
      )}

      <Section title={t('language')}>
        <div className="chips">
          {LANGS.map((l) => (
            <button key={l} className="chip" aria-pressed={me.lang === l} onClick={() => setLang(l)}>
              {LANG_NAMES[l]}
            </button>
          ))}
        </div>
      </Section>

      <Section body={false}>
        <a className="cell" href={SUPPORT_URL} target="_blank" rel="noreferrer">
          <div className="cell-main">{t('support')}</div>
          <span className="chev" />
        </a>
      </Section>

      <button className="btn ghost" style={{ color: 'var(--danger, #e5484d)' }} disabled={busy} onClick={deleteAccount}>
        {t('deleteAccount')}
      </button>
    </>
  );

  async function deleteAccount() {
    if (!(await confirm(t('deleteAccountAsk')))) return;
    setBusy(true);
    try {
      await del('/v1/me');
      disconnectSocket();
      await alertMsg(t('accountDeleted'));
      if (tg) tg.close();
      else window.location.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  }
}

function TeamSection({ companyId }: { companyId: number }) {
  const t = useT();
  const toast = useToast();
  const { me, setMe } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['team', companyId], queryFn: () => get<{ seats: number; members: TeamMember[] }>(`/v1/companies/${companyId}/members`) });
  const [busy, setBusy] = useState(false);
  if (!q.data) return null;
  const amOwner = q.data.members.some((m) => m.userId === me.id && m.role === 'owner');

  const invite = async () => {
    setBusy(true);
    try {
      const r = await post<{ url: string }>(`/v1/companies/${companyId}/invites`);
      const copied = await navigator.clipboard?.writeText(r.url).then(() => true).catch(() => false);
      if (copied) toast(t('inviteCopied'));
      openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(r.url)}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (userId: number) => {
    if (!(await confirm(t('removeMemberAsk')))) return;
    try {
      await del(`/v1/companies/${companyId}/members/${userId}`);
      if (userId === me.id) setMe(await get<Me>('/v1/me'));
      else qc.invalidateQueries({ queryKey: ['team', companyId] });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <Section title={`${t('team')} · ${t('seats')}: ${q.data.members.length}/${q.data.seats}`} body={false}>
      {q.data.members.map((m) => (
        <div key={m.userId} className="cell">
          <div className="cell-main">
            <div className="cell-title">{m.firstName || (m.username ? `@${m.username}` : `#${m.userId}`)}</div>
            <div className="cell-sub">{t(m.role === 'owner' ? 'owner' : 'manager')}</div>
          </div>
          {m.role !== 'owner' && (amOwner || m.userId === me.id) && (
            <button className="btn ghost" onClick={() => remove(m.userId)}>
              {m.userId === me.id ? t('leaveCompany') : t('removeMember')}
            </button>
          )}
        </div>
      ))}
      {amOwner && (
        <div className="cell" onClick={busy ? undefined : invite}>
          <div className="cell-main" style={{ color: 'var(--link)', fontWeight: 600 }}>+ {t('invite')}</div>
        </div>
      )}
    </Section>
  );
}

/** Тариф: статус и лимиты. Цены и кнопки оплаты здесь не показываем — оплата идёт вне Telegram по счёту. */
export function PlanPage() {
  const t = useT();
  const toast = useToast();
  const { supplierCompanyId } = useSession();
  const [sent, setSent] = useState(false);
  const q = useQuery({
    queryKey: ['plan', supplierCompanyId],
    queryFn: () => get<PlanInfo>(`/v1/billing/plan?companyId=${supplierCompanyId}`),
    enabled: !!supplierCompanyId,
  });
  if (!supplierCompanyId) return <><BackButton /><Empty>{t('becomeSupplierHint')}</Empty></>;
  if (q.isLoading || !q.data) return <><BackButton /><Spinner /></>;
  const p = q.data;

  const contact = async () => {
    try {
      await post('/v1/billing/contact', { companyId: supplierCompanyId });
      setSent(true);
      toast(t('managerWillContact'));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <>
      <BackButton to="/profile" />
      <h1>{t('plan')}: {p.planName[t.lang]}</h1>
      <Section>
        <dl className="kv">
          {p.periodEnd && (
            <>
              <dt>{t('planUntil')}</dt>
              <dd>{fmtDate(p.periodEnd, t.lang)}</dd>
            </>
          )}
          <dt>{t('offersUsed')}</dt>
          <dd className="mono">
            {p.offersUsed} / {p.offersPerMonth ?? t('unlimited')}
          </dd>
          <dt>{t('tabFeed')}</dt>
          <dd>{p.notifyDelayMin > 0 ? `${t('notifyDelay')}: ${p.notifyDelayMin} ${t('minutes')}` : t('noDelay')}</dd>
        </dl>
      </Section>
      <Section>
        <div className="stack">
          <span className="muted small">{t('planHint')}</span>
          <button className="btn" disabled={sent} onClick={contact}>
            {sent ? `✓ ${t('managerWillContact')}` : t('contactManager')}
          </button>
        </div>
      </Section>
    </>
  );
}

/** Пригласить друга: ссылка на Mini App с кодом, счётчики и бонусный баланс. */
export function InvitePage() {
  const t = useT();
  const toast = useToast();
  const { me, setMe } = useSession();
  useQuery({ queryKey: ['me-refresh'], queryFn: async () => { const fresh = await get<Me>('/v1/me'); setMe(fresh); return fresh.id; } });
  const r = me.referral;
  const share = () => {
    const url = `https://t.me/share/url?url=${encodeURIComponent(r.link)}&text=${encodeURIComponent(t('inviteShareText'))}`;
    openTelegramLink(url);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(r.link);
      toast(t('refLinkCopied'));
    } catch {
      toast(r.link);
    }
  };
  return (
    <>
      <BackButton to="/profile" />
      <div className="invite-hero">
        <span className="promo-icon big">{Icons.gift}</span>
        <h1>{t('inviteTitle')}</h1>
        <p className="small">{t.f('inviteText', money(r.bonusUzs))}</p>
      </div>
      <Section>
        <div className="stack">
          <div className="invite-link mono small">{r.link}</div>
          <button className="btn block" onClick={share}>{t('inviteShare')}</button>
          <button className="btn secondary block" onClick={copy}>{t('inviteCopy')}</button>
        </div>
      </Section>
      <div className="stats">
        <div><span className="muted small">{t('invitedCount')}</span><b>{r.invited}</b></div>
        <div><span className="muted small">{t('rewardedCount')}</span><b>{r.rewarded}</b></div>
        <div><span className="muted small">{t('bonusBalance')}</span><b>{money(me.bonusUzs)}</b></div>
      </div>
      <p className="muted small" style={{ padding: '0 4px' }}>{t('bonusHint')}</p>
    </>
  );
}
