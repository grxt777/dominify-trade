import type { GigPackageCode } from '@dominify/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { get, imgSrc, post, type GigCard, type GigView, type MyRequest, type Stats, type SupplierBrief } from '../api';
import { useT, type Key } from '../i18n';
import { burst, CountUp, FadeImg, useTypewriter } from '../motion';
import { useSession } from '../session';
import { haptic } from '../tg';
import { BackButton, Empty, fmtDate, Icons, MainButton, money, regionName, Section, Spinner, TrustBadge, useAgo, useToast, VerifiedMark } from '../ui';

/** Категории на главной: короткие подписи и обложки вместо длинных названий каталога. */
export const MARKET_CATS: { slug: string; label: Key; cover: string }[] = [
  { slug: 'ads.banners', label: 'catBanners', cover: '/demo/banner.svg' },
  { slug: 'design.logo', label: 'catLogo', cover: '/demo/logo.svg' },
  { slug: 'ads.vehicle', label: 'catVehicle', cover: '/demo/vehicle.svg' },
  { slug: 'print.stickers', label: 'catStickers', cover: '/demo/stickers.svg' },
  { slug: 'ads.letters', label: 'catSigns', cover: '/demo/neon.svg' },
  { slug: 'print.business-cards', label: 'catCards', cover: '/demo/cards.svg' },
];

const OPEN = ['draft', 'needs_info', 'moderation', 'submitted', 'wave_1', 'wave_2', 'has_offers', 'supplier_chosen'];
const AVATAR_COLORS = ['#0098cc', '#d6007a', '#e8a200', '#1f9a63', '#6a3df0', '#ff5a5f'];

export const isTop = (c: Pick<SupplierBrief, 'ratingAvg' | 'ratingCount'>) => (c.ratingAvg ?? 0) >= 4.8 && c.ratingCount >= 100;

export function Avatar({ id, name, size = 28 }: { id: number; name: string; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.42, background: AVATAR_COLORS[id % AVATAR_COLORS.length] }}>
      {name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

function useResponse() {
  const t = useT();
  return (min: number | null) => (min === null ? null : min < 60 ? `${min} ${t('minutes')}` : `${Math.round(min / 60)} ${t('hoursShort')}`);
}

function Rating({ c }: { c: Pick<SupplierBrief, 'ratingAvg' | 'ratingCount'> }) {
  const t = useT();
  if (!c.ratingAvg || !c.ratingCount) return <span className="muted small">{t('noReviews')}</span>;
  return (
    <span className="rating">
      <span className="star">★</span>
      <b>{c.ratingAvg.toFixed(1)}</b>
      <span className="muted">({c.ratingCount})</span>
    </span>
  );
}

/** Сердечко «в избранное». Состояние меняется сразу, при ошибке откатывается. */
export function FavButton({ gigId, on, className = '' }: { gigId: number; on: boolean; className?: string }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [fav, setFav] = useState(on);
  const [pop, setPop] = useState(0);
  useEffect(() => setFav(on), [on]);
  return (
    <button
      type="button"
      key={pop}
      className={`fav ${fav ? 'on' : ''} ${pop && fav ? 'pop' : ''} ${className}`}
      aria-pressed={fav}
      aria-label={t(fav ? 'unsave' : 'favSave')}
      onClick={async (e) => {
        e.stopPropagation();
        const next = !fav;
        haptic(next ? 'success' : 'tap');
        if (next) {
          burst(e.currentTarget);
          setPop((n) => n + 1);
        }
        setFav(next);
        try {
          await post(`/v1/gigs/${gigId}/favorite`, { on: next });
          if (next) toast(t('savedToast'));
          void qc.invalidateQueries({ queryKey: ['favorites'] });
          void qc.invalidateQueries({ queryKey: ['gigs'] });
          void qc.invalidateQueries({ queryKey: ['gig', gigId] });
        } catch (err) {
          setFav(!next);
          toast((err as Error).message, 'error');
        }
      }}
    >
      {Icons.heart}
    </button>
  );
}

export function GigCardItem({ g, index = 0 }: { g: GigCard; index?: number }) {
  const t = useT();
  const nav = useNavigate();
  return (
    <article className="gig reveal" style={{ '--d': `${(index % 3) * 0.07}s` } as CSSProperties} onClick={() => nav(`/gigs/${g.id}`)}>
      <div className="gig-cover">
        {g.cover ? <FadeImg src={imgSrc(g.cover)} alt="" loading="lazy" /> : null}
        {isTop(g.company) && <span className="lvl on-cover">★ {t('topSeller')}</span>}
        <FavButton gigId={g.id} on={g.favorite} className="on-cover" />
      </div>
      <div className="gig-body">
        <div className="gig-seller">
          <Avatar id={g.company.id} name={g.company.name} size={22} />
          <span className="gig-seller-name">{g.company.name}</span>
          {g.company.innVerified && <VerifiedMark />}
        </div>
        <div className="gig-title">{g.title}</div>
        <Rating c={g.company} />
        <div className="gig-foot">
          {g.fromPriceUzs !== null && <b className="gig-price">{t.f('fromPriceTpl', money(g.fromPriceUzs))}</b>}
        </div>
      </div>
    </article>
  );
}

/** Карточки-заглушки, пока витрина грузится: сразу видно, что здесь будут услуги. */
export function GigGridSkeleton({ n = 4 }: { n?: number }) {
  return (
    <div className="gig-grid" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="gig sk">
          <div className="gig-cover" />
          <div className="gig-body">
            <div className="skeleton" style={{ width: '55%' }} />
            <div className="skeleton" style={{ width: '90%' }} />
            <div className="skeleton" style={{ width: '70%' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function SearchBar({ initial = '', onSearch, animated = false }: { initial?: string; onSearch: (q: string) => void; animated?: boolean }) {
  const t = useT();
  const [q, setQ] = useState(initial);
  const [focused, setFocused] = useState(false);
  const hints = useMemo(() => t('searchHints').split('|'), [t]);
  const ghost = useTypewriter(hints, animated && !q && !focused);
  const showGhost = animated && !q && !focused;
  return (
    <form
      className="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(q.trim());
      }}
    >
      {Icons.search}
      <span className="search-wrap">
        <input
          type="search"
          enterKeyHint="search"
          placeholder={showGhost ? '' : t('searchPlaceholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{ width: '100%' }}
        />
        {showGhost && (
          <span className="search-ghost" aria-hidden>
            {ghost}
            <i className="caret" />
          </span>
        )}
      </span>
    </form>
  );
}

function Steps({ items }: { items: { title: string; text: ReactNode }[] }) {
  return (
    <ol className="timeline">
      {items.map((s, i) => (
        <li key={i} className="reveal" style={{ '--d': `${i * 0.12}s` } as CSSProperties}>
          <span className="tl-dot">{i + 1}</span>
          <div>
            <div className="tl-title">{s.title}</div>
            <div className="muted small">{s.text}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ───────── Главная покупателя: витрина ───────── */

export function LiveStats() {
  const t = useT();
  const s = useQuery({ queryKey: ['stats'], queryFn: () => get<Stats>('/v1/gigs/stats'), staleTime: 5 * 60_000 });
  if (!s.data || !s.data.dealsCompleted) return null;
  const d = s.data;
  return (
    <div className="live">
      <div className="live-stats">
        <div><b><CountUp value={d.dealsCompleted} format={(n) => `${money(Math.round(n))}+`} ms={1400} /></b><span>{t('statDeals')}</span></div>
        <div><b><CountUp value={d.suppliers} /></b><span>{t('statSuppliers')}</span></div>
        {d.avgRating && <div><b>★ <CountUp value={d.avgRating} format={(n) => n.toFixed(1)} ms={1200} /></b><span>{t('statRating')}</span></div>}
      </div>
      {d.ordersToday > 0 && (
        <div className="live-today">
          <i className="pulse" />
          {t.f('todayOrdersTpl', d.ordersToday)}
        </div>
      )}
    </div>
  );
}

function GuaranteeStrip() {
  const t = useT();
  return (
    <div className="g-strip">
      <div>{Icons.shield}<b>{t('gSafeTitle')}</b><span>{t('gSafeShort')}</span></div>
      <div>{Icons.undo}<b>{t('gRefundTitle')}</b><span>{t('gRefundShort')}</span></div>
      <div>{Icons.check}<b>{t('verifiedOnly')}</b><span>{t('gVerifiedShort')}</span></div>
    </div>
  );
}

/** Гарантии на странице услуги и сделки. */
export function Guarantee({ revisions }: { revisions?: number }) {
  const t = useT();
  const items = [
    { icon: Icons.shield, title: t('gSafeTitle'), text: t('gSafeText') },
    { icon: Icons.undo, title: t('gRefundTitle'), text: t('gRefundText') },
    ...(revisions ? [{ icon: Icons.refresh, title: t('gRevTitle'), text: t.f('gRevTextTpl', revisions) }] : []),
  ];
  return (
    <Section title={t('guaranteeTitle')}>
      <ul className="guarantee">
        {items.map((i, k) => (
          <li key={i.title} className="reveal" style={{ '--d': `${k * 0.1}s` } as CSSProperties}>
            <span className="g-icon">{i.icon}</span>
            <div>
              <b>{i.title}</b>
              <div className="small muted">{i.text}</div>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function MiniGigStrip({ items }: { items: GigCard[] }) {
  const t = useT();
  const nav = useNavigate();
  return (
    <div className="cat-strip">
      {items.map((m) => (
        <button key={m.id} className="mini-gig" onClick={() => nav(`/gigs/${m.id}`)}>
          {m.cover && <FadeImg src={imgSrc(m.cover)} alt="" />}
          <span className="small">{m.title}</span>
          {m.fromPriceUzs !== null && <b className="small">{t.f('fromPriceTpl', money(m.fromPriceUzs))}</b>}
        </button>
      ))}
    </div>
  );
}

export function MarketHome() {
  const t = useT();
  const nav = useNavigate();
  const { me } = useSession();
  const gigs = useQuery({ queryKey: ['gigs', '', '', 'recommended'], queryFn: () => get<GigCard[]>('/v1/gigs') });
  const mine = useQuery({ queryKey: ['requests'], queryFn: () => get<MyRequest[]>('/v1/requests') });
  const recent = useQuery({ queryKey: ['gigs', 'recent'], queryFn: () => get<GigCard[]>('/v1/gigs/recent') });
  const saved = useQuery({ queryKey: ['favorites'], queryFn: () => get<GigCard[]>('/v1/gigs/favorites') });
  const active = (mine.data ?? []).filter((r) => OPEN.includes(r.status));

  return (
    <>
      <div className="market-hero">
        {me.firstName && <div className="muted small">{t.f('helloTpl', me.firstName)}</div>}
        <h1 className="market-h1">{t('marketHello')}</h1>
        <div className="muted small" style={{ marginBottom: 12 }}>{t('marketSub')}</div>
        <SearchBar animated onSearch={(q) => nav(`/market?q=${encodeURIComponent(q)}`)} />
        <LiveStats />
      </div>

      {active.length > 0 && (
        <button className="active-orders" onClick={() => nav('/orders')}>
          <span className="badge">{active.length}</span>
          <span>{t('activeOrders')}</span>
          <span className="chev" />
        </button>
      )}

      {me.firstOrder && (
        <div className="promo">
          <span className="promo-icon">{Icons.gift}</span>
          <div>
            <b>{t.f('firstOrderTitleTpl', me.firstOrder.percent)}</b>
            <div className="small">{t.f('firstOrderTextTpl', money(me.firstOrder.maxUzs))}</div>
          </div>
        </div>
      )}

      <GuaranteeStrip />

      {!!recent.data?.length && (
        <>
          <div className="block-head"><h2>{t('recentTitle')}</h2></div>
          <MiniGigStrip items={recent.data} />
        </>
      )}

      {!!saved.data?.length && (
        <button className="active-orders" onClick={() => nav('/saved')}>
          <span className="fav-inline">{Icons.heart}</span>
          <span>{t('savedTitle')} · {saved.data.length}</span>
          <span className="chev" />
        </button>
      )}

      <div className="block-head">
        <h2>{t('popularCats')}</h2>
      </div>
      <div className="cat-strip">
        {MARKET_CATS.map((c) => (
          <button key={c.slug} className="cat-tile" onClick={() => nav(`/market?cat=${c.slug}`)}>
            <img src={c.cover} alt="" />
            <span>{t(c.label)}</span>
          </button>
        ))}
      </div>

      <Section title={t('howToOrder')}>
        <Steps
          items={[
            { title: t('how1Title'), text: t('how1Text') },
            { title: t('how2Title'), text: t('how2Text') },
            { title: t('how3Title'), text: t('how3Text') },
            { title: t('how4Title'), text: t('how4Text') },
          ]}
        />
      </Section>

      <div className="block-head">
        <h2>{t('popularGigs')}</h2>
        <button className="btn ghost" onClick={() => nav('/market')}>{t('seeAll')} ›</button>
      </div>
      {gigs.isLoading && <GigGridSkeleton />}
      <div className="gig-grid">{gigs.data?.slice(0, 6).map((g, i) => <GigCardItem key={g.id} g={g} index={i} />)}</div>

      <div className="cta-card">
        <h2>{t('notFoundTitle')}</h2>
        <div className="small">{t('notFoundText')}</div>
        <button className="btn block" onClick={() => nav('/new')}>+ {t('writeTask')}</button>
      </div>

      {me.referral.bonusUzs > 0 && (
        <button className="invite-banner" onClick={() => nav('/invite')}>
          <span className="promo-icon">{Icons.gift}</span>
          <span>{t.f('inviteBannerTpl', money(me.referral.bonusUzs))}</span>
          <span className="chev" />
        </button>
      )}
    </>
  );
}

export function SavedPage() {
  const t = useT();
  const q = useQuery({ queryKey: ['favorites'], queryFn: () => get<GigCard[]>('/v1/gigs/favorites') });
  return (
    <>
      <BackButton />
      <h1>{t('savedTitle')}</h1>
      {q.isLoading && <GigGridSkeleton />}
      {q.data?.length === 0 && <Empty>{t('savedEmpty')}</Empty>}
      <div className="gig-grid">{q.data?.map((g, i) => <GigCardItem key={g.id} g={g} index={i} />)}</div>
    </>
  );
}

/* ───────── Каталог: категория, поиск, сортировка ───────── */

export function MarketList() {
  const t = useT();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const cat = params.get('cat') ?? '';
  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'recommended';
  const verified = params.get('verified') === '1';
  const gigs = useQuery({
    queryKey: ['gigs', cat, q, sort, verified],
    queryFn: () => get<GigCard[]>(`/v1/gigs?${new URLSearchParams({ ...(cat && { category: cat }), ...(q && { q }), sort, ...(verified && { verified: '1' }) })}`),
  });
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const title = MARKET_CATS.find((c) => c.slug === cat);

  return (
    <>
      <BackButton to="/catalog" />
      <h1>{title ? t(title.label) : q ? `«${q}»` : t('popularGigs')}</h1>
      <div style={{ marginBottom: 10 }}>
        <SearchBar key={q} initial={q} onSearch={(v) => set('q', v)} />
      </div>
      <div className="chip-strip">
        <button className="chip" aria-pressed={!cat} onClick={() => set('cat', '')}>{t('allCategories')}</button>
        {MARKET_CATS.map((c) => (
          <button key={c.slug} className="chip" aria-pressed={cat === c.slug} onClick={() => set('cat', c.slug)}>
            {t(c.label)}
          </button>
        ))}
        <button className="chip" aria-pressed={cat === 'design'} onClick={() => set('cat', 'design')}>{t('catDesign')}</button>
      </div>
      <div className="sort-row">
        {(['recommended', 'rating', 'price'] as const).map((s) => (
          <button key={s} className={`sort ${sort === s ? 'on' : ''}`} onClick={() => set('sort', s === 'recommended' ? '' : s)}>
            {t(s === 'recommended' ? 'sortRecommended' : s === 'rating' ? 'sortRating' : 'sortPrice')}
          </button>
        ))}
        <button className={`sort verified-filter ${verified ? 'on' : ''}`} aria-pressed={verified} onClick={() => set('verified', verified ? '' : '1')}>
          <VerifiedMark /> {t('verifiedOnly')}
        </button>
      </div>
      {gigs.isLoading && <GigGridSkeleton n={6} />}
      {gigs.data?.length === 0 && <Empty>{t('nothingFound')}</Empty>}
      <div className="gig-grid">{gigs.data?.map((g, i) => <GigCardItem key={g.id} g={g} index={i} />)}</div>
      <div className="cta-card">
        <h2>{t('notFoundTitle')}</h2>
        <div className="small">{t('notFoundText')}</div>
        <button className="btn block" onClick={() => nav('/new')}>+ {t('writeTask')}</button>
      </div>
    </>
  );
}

/* ───────── Страница услуги ───────── */

function Gallery({ images }: { images: string[] }) {
  const [idx, setIdx] = useState(0);
  if (!images.length) return null;
  return (
    <div className="gallery">
      <div
        className="gallery-track"
        onScroll={(e) => {
          const el = e.currentTarget;
          setIdx(Math.round(el.scrollLeft / el.clientWidth));
        }}
      >
        {images.map((src, i) => (
          <FadeImg key={i} src={imgSrc(src)} alt="" />
        ))}
      </div>
      {images.length > 1 && (
        <div className="gallery-dots">
          {images.map((_, i) => (
            <i key={i} className={i === idx ? 'on' : ''} />
          ))}
        </div>
      )}
    </div>
  );
}

export function GigPage() {
  const t = useT();
  const nav = useNavigate();
  const resp = useResponse();
  const ago = useAgo();
  const toast = useToast();
  const { me } = useSession();
  const { id } = useParams();
  const q = useQuery({ queryKey: ['gig', Number(id)], queryFn: () => get<GigView>(`/v1/gigs/${id}`) });
  const [code, setCode] = useState<GigPackageCode | null>(null);
  const [asking, setAsking] = useState(false);

  if (q.isLoading) return <><BackButton /><Spinner /></>;
  if (q.error || !q.data) return <><BackButton /><Empty>{(q.error as Error)?.message}</Empty></>;
  const g = q.data;
  const pkg = g.packages.find((p) => p.code === code) ?? g.packages.find((p) => p.code === 'standard') ?? g.packages[0];
  const c = g.company;
  const response = resp(c.medianResponseMin);
  const recentOrder = g.lastOrderAt && Date.now() - new Date(g.lastOrderAt).getTime() < 30 * 86_400_000 ? g.lastOrderAt : null;
  const firstPrice =
    pkg && me.firstOrder ? pkg.priceUzs - Math.min(Math.round((pkg.priceUzs * me.firstOrder.percent) / 100), me.firstOrder.maxUzs) : null;

  const ask = async () => {
    setAsking(true);
    try {
      const r = await post<{ chatId: number }>(`/v1/gigs/${g.id}/ask`);
      nav(`/chats/${r.chatId}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setAsking(false);
    }
  };

  return (
    <>
      <BackButton />
      <div className="gig-hero">
        <Gallery images={g.gallery} />
        {!g.mine && <FavButton gigId={g.id} on={g.favorite} className="on-cover big" />}
      </div>
      <h1 className="gig-h1">{g.title}</h1>
      {recentOrder && (
        <div className="social-proof small">
          <span className="hot">
            {Icons.bolt}
            {t.f('lastOrderTpl', ago(recentOrder))}
          </span>
        </div>
      )}
      <div className="seller-row">
        <Avatar id={c.id} name={c.name} size={40} />
        <div className="seller-main">
          <div className="row" style={{ gap: 6 }}>
            <b>{c.name}</b>
            {c.innVerified && <VerifiedMark withText />}
            {isTop(c) && <span className="lvl">{t('topSeller')}</span>}
          </div>
          <div className="row small muted" style={{ gap: 6 }}>
            <Rating c={c} />
            <span>· {t.f('ordersTpl', c.dealsClosed)}</span>
          </div>
        </div>
      </div>

      {pkg && (
        <section className="section packages">
          <div className="pkg-tabs" role="tablist">
            {g.packages.map((p) => (
              <button
                key={p.code}
                role="tab"
                aria-selected={p.code === pkg.code}
                onClick={() => {
                  haptic();
                  setCode(p.code);
                }}
              >
                {p.name}
              </button>
            ))}
            <span
              className="pkg-ink"
              style={{ width: `${100 / g.packages.length}%`, transform: `translateX(${Math.max(0, g.packages.indexOf(pkg)) * 100}%)` }}
            />
          </div>
          <div className="pkg-body pkg-swap" key={pkg.code}>
            <div className="row between" style={{ alignItems: 'baseline' }}>
              <b className="pkg-name">{pkg.name}</b>
              <span className="price swap">{money(pkg.priceUzs)} <span className="small muted">{t('sum')}</span></span>
            </div>
            <div className="small" style={{ margin: '6px 0 10px' }}>{pkg.summary}</div>
            <div className="pkg-meta">
              <span>{Icons.clock}{t.f('daysTpl', pkg.days)}</span>
              <span>{Icons.refresh}{t.f('revisionsTpl', pkg.revisions)}</span>
            </div>
            <ul className="pkg-features">
              {pkg.features.map((f) => (
                <li key={f}>{Icons.check}{f}</li>
              ))}
            </ul>
            {firstPrice !== null && !g.mine && (
              <div className="first-price small">
                {Icons.gift}
                {t.f('firstOrderPriceTpl', money(firstPrice))}
              </div>
            )}
          </div>
        </section>
      )}

      {!g.mine && (
        <div className="ask-box">
          <button className="btn secondary block" disabled={asking} onClick={ask}>
            {Icons.chat} {t('askSeller')}
          </button>
          <div className="muted small">{t('askHint')}</div>
        </div>
      )}

      <Guarantee revisions={pkg?.revisions} />

      <Section title={t('howOrderGoes')}>
        <Steps
          items={[
            { title: t('how2Title'), text: t('how2Text') },
            { title: t('how3Title'), text: response ? t.f('responseTpl', response) : t('how3Text') },
            { title: t('howWorkTitle'), text: t.f('howWorkText', pkg ? t.f('daysTpl', pkg.days) : '—') },
            { title: t('how4Title'), text: t('how4Text') },
          ]}
        />
      </Section>

      <Section title={t('aboutGig')}>
        <div style={{ whiteSpace: 'pre-wrap' }}>{g.description}</div>
        {g.tags.length > 0 && (
          <div className="chips" style={{ marginTop: 12 }}>
            {g.tags.map((tag) => (
              <span key={tag} className="tag">{tag}</span>
            ))}
          </div>
        )}
      </Section>

      <Section title={t('aboutSeller')}>
        <div className="seller-row" style={{ padding: 0, marginBottom: 12 }}>
          <Avatar id={c.id} name={c.name} size={52} />
          <div className="seller-main">
            <b>{c.name}</b>
            <div className="small muted">{[c.owner, regionName(c.regionCode, t.lang)].filter(Boolean).join(' · ')}</div>
            <div className="row" style={{ marginTop: 4 }}>
              <TrustBadge level={c.trustLevel} />
            </div>
          </div>
        </div>
        <div className="stats">
          <div><span className="muted small">{t('onPlatform')}</span><b>{t.f('sinceTpl', new Date(c.createdAt).getFullYear())}</b></div>
          <div><span className="muted small">{t('avgResponse')}</span><b>{response ?? '—'}</b></div>
          <div><span className="muted small">{t('dealsDone')}</span><b>{c.dealsClosed}</b></div>
          <div><span className="muted small">{t('reviewsTitle')}</span><b>{c.ratingCount}</b></div>
        </div>
        {c.about && <p className="small" style={{ margin: '12px 0 0' }}>{c.about}</p>}
      </Section>

      {g.reviews.length > 0 && (
        <Section title={`${t('reviewsTitle')} · ${c.ratingCount}`} body={false}>
          <div className="review-summary">
            <span className="big">{c.ratingAvg?.toFixed(1)}</span>
            <span className="stars">{'★'.repeat(Math.round(c.ratingAvg ?? 0))}</span>
          </div>
          {g.reviews.map((r) => (
            <div key={r.id} className="review">
              <div className="row between">
                <div className="row" style={{ gap: 8 }}>
                  <Avatar id={r.id + 3} name={r.author ?? '?'} size={28} />
                  <b className="small">{r.author}</b>
                </div>
                <span className="muted small">{fmtDate(r.createdAt, t.lang)}</span>
              </div>
              <div className="stars small">{'★'.repeat(r.stars)}</div>
              {r.text && <div className="small">{r.text}</div>}
              <div className="muted small">{money(r.amountUzs)} {t('sum')}</div>
            </div>
          ))}
        </Section>
      )}

      {g.more.length > 0 && (
        <>
          <div className="block-head"><h2>{t('moreFromSeller')}</h2></div>
          <div className="cat-strip">
            {g.more.map((m) => (
              <button key={m.id} className="mini-gig" onClick={() => nav(`/gigs/${m.id}`)}>
                {m.cover && <FadeImg src={imgSrc(m.cover)} alt="" />}
                <span className="small">{m.title}</span>
                {m.fromPriceUzs !== null && <b className="small">{t.f('fromPriceTpl', money(m.fromPriceUzs))}</b>}
              </button>
            ))}
          </div>
        </>
      )}

      <p className="muted small safe-note">{t('safeNote')}</p>
      {pkg && !g.mine && <MainButton text={`${t('orderNow')} · ${money(pkg.priceUzs)} ${t('sum')}`} onClick={() => nav(`/new?gig=${g.id}&pkg=${pkg.code}`)} />}
    </>
  );
}
