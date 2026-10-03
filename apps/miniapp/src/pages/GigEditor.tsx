import { GIG_LIMITS, GIG_PACKAGE_CODES, type GigPackageCode } from '@dominify/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { del, get, imgSrc, patch, post, uploadFile, type CompanyProfile, type GigCard, type GigEditable, type MyGig } from '../api';
import { useT, type Key } from '../i18n';
import { useSession } from '../session';
import { confetti } from '../motion';
import { confirm, haptic } from '../tg';
import { BackButton, Empty, Icons, MainButton, money, Section, Spinner, useToast, VerifiedMark } from '../ui';
import { useLeafCategories } from './fields';
import { Avatar, isTop } from './Market';

/* ───────── Список услуг продавца ───────── */

export function MyGigs() {
  const t = useT();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { supplierCompanyId } = useSession();
  const q = useQuery({ queryKey: ['my-gigs', supplierCompanyId], queryFn: () => get<MyGig[]>(`/v1/gigs/mine?companyId=${supplierCompanyId}`) });
  const company = useQuery({ queryKey: ['company', supplierCompanyId], queryFn: () => get<CompanyProfile>(`/v1/companies/${supplierCompanyId}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['my-gigs'] });

  const toggle = async (g: MyGig) => {
    await post(`/v1/gigs/${g.id}/active`, { active: !g.active });
    haptic('success');
    toast(g.active ? t('gigHidden') : t('gigPublished'));
    refresh();
  };
  const remove = async (g: MyGig) => {
    if (!(await confirm(t('deleteGigAsk')))) return;
    await del(`/v1/gigs/${g.id}`);
    refresh();
  };

  if (q.isLoading) return <Spinner />;
  const list = q.data ?? [];

  if (!list.length) {
    return (
      <div className="gigs-empty">
        <div className="gigs-empty-art">
          <img src="/demo/banner.svg" alt="" />
          <img src="/demo/logo.svg" alt="" />
          <img src="/demo/stickers.svg" alt="" />
        </div>
        <h1 style={{ margin: '16px 4px 6px' }}>{t('gigsEmptyTitle')}</h1>
        <p className="muted" style={{ margin: '0 4px 14px' }}>{t('gigsEmptyText')}</p>
        <Section>
          <ul className="pkg-features">
            {(['gigsTip1', 'gigsTip2', 'gigsTip3'] as const).map((k) => (
              <li key={k}>{Icons.check}{t(k)}</li>
            ))}
          </ul>
        </Section>
        <MainButton text={`+ ${t('newGig')}`} onClick={() => nav('/my-gigs/new')} />
      </div>
    );
  }

  return (
    <>
      {company.data && !company.data.innVerified && (
        <div className="promo verify-prompt">
          <VerifiedMark />
          <div>
            <b>{t('verifyInnTitle')}</b>
            <div className="small">{t('verifyInnText')}</div>
            {!company.data.hasInn && (
              <button className="btn secondary" style={{ marginTop: 8 }} onClick={() => nav(`/company/${supplierCompanyId}`)}>
                {t('verifyInnBtn')}
              </button>
            )}
          </div>
        </div>
      )}
      <div className="block-head">
        <h2>{t('myGigs')} · {list.length}</h2>
        <button className="btn ghost" onClick={() => nav('/my-gigs/new')}>+ {t('newGig')}</button>
      </div>
      {list.map((g) => (
        <section key={g.id} className="section my-gig">
          <div className="my-gig-main" onClick={() => nav(`/my-gigs/${g.id}`)}>
            <div className="my-gig-cover">{g.cover && <img src={imgSrc(g.cover)} alt="" />}</div>
            <div className="cell-main">
              <span className={`pill ${g.active ? 'good' : ''}`}>{g.active ? t('gigActive') : t('gigHidden')}</span>
              <div className="my-gig-title">{g.title}</div>
              <div className="small muted">
                {g.fromPriceUzs !== null && t.f('fromPriceTpl', money(g.fromPriceUzs))} · {t.f('ordersTpl', g.ordersCount)}
              </div>
            </div>
          </div>
          <div className="my-gig-actions">
            <button onClick={() => nav(`/my-gigs/${g.id}`)}>{t('edit')}</button>
            {g.active && <button onClick={() => nav(`/gigs/${g.id}`)}>{t('view')}</button>}
            <button onClick={() => toggle(g)}>{g.active ? t('hide') : t('publish')}</button>
            <button className="danger" onClick={() => remove(g)}>{t('delete')}</button>
          </div>
        </section>
      ))}
    </>
  );
}

/* ───────── Мастер создания и редактирования ───────── */

interface Img {
  ref: string | null;
  preview: string;
  uploading: boolean;
}

interface PkgDraft {
  code: GigPackageCode;
  name: string;
  price: string;
  days: string;
  revisions: number;
  summary: string;
  features: string[];
}

interface Draft {
  categoryId: number | null;
  title: string;
  description: string;
  gallery: Img[];
  tiers: 1 | 3;
  packages: PkgDraft[];
  tags: string[];
  active: boolean;
}

type Errors = Partial<Record<string, string>>;

const STEPS: Key[] = ['stepBasics', 'stepPricing', 'stepMedia', 'stepReview'];
const PKG_NAME: Record<GigPackageCode, Key> = { basic: 'pkgBasic', standard: 'pkgStandard', premium: 'pkgPremium' };
const draftKey = (companyId: number) => `gig_draft_${companyId}`;

function emptyDraft(t: (k: Key) => string): Draft {
  return {
    categoryId: null,
    title: '',
    description: '',
    gallery: [],
    tiers: 3,
    packages: GIG_PACKAGE_CODES.map((code, i) => ({ code, name: t(PKG_NAME[code]), price: '', days: '', revisions: i + 1, summary: '', features: [] })),
    tags: [],
    active: true,
  };
}

function fromGig(g: GigEditable, t: (k: Key) => string): Draft {
  const base = emptyDraft(t);
  return {
    categoryId: g.categoryId,
    title: g.title,
    description: g.description,
    gallery: g.gallery.map((ref) => ({ ref, preview: imgSrc(ref) ?? '', uploading: false })),
    tiers: g.packages.length >= 3 ? 3 : 1,
    packages: base.packages.map((p) => {
      const s = g.packages.find((x) => x.code === p.code);
      return s ? { code: s.code, name: s.name, price: String(s.priceUzs), days: String(s.days), revisions: s.revisions, summary: s.summary, features: s.features } : p;
    }),
    tags: g.tags,
    active: g.active,
  };
}

const usedPackages = (d: Draft) => (d.tiers === 3 ? d.packages : d.packages.filter((p) => p.code === 'standard'));

function validate(d: Draft, step: number, t: (k: Key) => string): Errors {
  const e: Errors = {};
  if (step === 0 || step === 3) {
    if (d.title.trim().length < GIG_LIMITS.titleMin) e.title = t('errTitleShort');
    if (!d.categoryId) e.category = t('errCategory');
  }
  if (step === 1 || step === 3) {
    const pk = usedPackages(d);
    pk.forEach((p, i) => {
      if (!(Number(p.price) >= 10_000)) e[`price_${p.code}`] = t('errPrice');
      else if (i > 0 && Number(p.price) <= Number(pk[i - 1].price)) e[`price_${p.code}`] = t('errPriceOrder');
      const days = Number(p.days);
      if (!(days >= 1 && days <= 90)) e[`days_${p.code}`] = t('errDays');
    });
  }
  if (step === 2 || step === 3) {
    if (d.gallery.some((g) => g.uploading)) e.gallery = t('errUploading');
    else if (!d.gallery.some((g) => g.ref)) e.gallery = t('errPhotos');
    if (ownTextLength(d.description, t('descTemplateText')) < GIG_LIMITS.descMin) e.description = t('errDesc');
  }
  return e;
}

/** Длина описания без строк незаполненного шаблона — иначе один шаблон проходит минимум. */
function ownTextLength(desc: string, template: string) {
  const skip = new Set(template.split('\n').map((l) => l.trim()));
  return desc
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => !skip.has(l))
    .map((l) => l.replace(/^[—–-]\s*/, ''))
    .join(' ')
    .trim().length;
}

export function GigEditor() {
  const t = useT();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { id } = useParams();
  const editId = id && id !== 'new' ? Number(id) : null;
  const { supplierCompanyId } = useSession();
  const companyId = supplierCompanyId!;

  const existing = useQuery({ queryKey: ['gig-edit', editId], queryFn: () => get<GigEditable>(`/v1/gigs/${editId}/edit`), enabled: !!editId });
  const company = useQuery({ queryKey: ['company', companyId], queryFn: () => get<CompanyProfile>(`/v1/companies/${companyId}`) });
  const { leaves } = useLeafCategories();

  const [d, setD] = useState<Draft | null>(null);
  const [step, setStep] = useState(0);
  const [tried, setTried] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);

  // Новая услуга: восстанавливаем черновик. localStorage, а не CloudStorage: там лимит 4 КБ на значение.
  useEffect(() => {
    if (d) return;
    if (editId) {
      if (existing.data) setD(fromGig(existing.data, t));
      return;
    }
    try {
      const saved = localStorage.getItem(draftKey(companyId));
      if (saved) {
        const parsed = JSON.parse(saved) as Draft;
        parsed.gallery = parsed.gallery.filter((g) => g.ref).map((g) => ({ ...g, preview: imgSrc(g.ref) ?? '', uploading: false }));
        setD(parsed);
        toast(t('draftRestored'));
        return;
      }
    } catch {
      /* битый черновик — начинаем заново */
    }
    setD(emptyDraft(t));
  }, [editId, existing.data, d, companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!d || editId) return;
    const h = setTimeout(() => {
      try {
        localStorage.setItem(draftKey(companyId), JSON.stringify({ ...d, gallery: d.gallery.filter((g) => g.ref) }));
      } catch {
        /* переполнено — не страшно */
      }
    }, 400);
    return () => clearTimeout(h);
  }, [d, editId, companyId]);

  const categories = useMemo(() => {
    const ids = company.data?.categoryIds ?? [];
    return leaves.filter((c) => ids.includes(c.id) || ids.includes(c.root.id));
  }, [leaves, company.data]);

  if (!d || company.isLoading || (editId && existing.isLoading)) return <><BackButton /><Spinner /></>;
  if (existing.error) return <><BackButton /><Empty>{(existing.error as Error).message}</Empty></>;

  const set = (patchD: Partial<Draft>) => setD((cur) => (cur ? { ...cur, ...patchD } : cur));
  const setPkg = (code: GigPackageCode, p: Partial<PkgDraft>) =>
    setD((cur) => (cur ? { ...cur, packages: cur.packages.map((x) => (x.code === code ? { ...x, ...p } : x)) } : cur));
  const errors = tried[step] ? validate(d, step, t) : {};

  const next = async () => {
    const e = validate(d, step, t);
    if (Object.keys(e).length) {
      setTried((x) => ({ ...x, [step]: true }));
      haptic('error');
      toast(t('fixErrors'), 'error');
      return;
    }
    if (step < STEPS.length - 1) {
      setStep(step + 1);
      window.scrollTo(0, 0);
      return;
    }
    await save();
  };

  const save = async () => {
    setBusy(true);
    const body = {
      companyId,
      categoryId: d.categoryId,
      title: d.title.trim(),
      description: d.description.trim(),
      gallery: d.gallery.filter((g) => g.ref).map((g) => g.ref),
      packages: usedPackages(d).map((p) => ({
        code: p.code,
        name: p.name.trim() || t(PKG_NAME[p.code]),
        priceUzs: Number(p.price),
        days: Number(p.days),
        revisions: p.revisions,
        summary: p.summary.trim(),
        features: p.features,
      })),
      tags: d.tags,
      active: d.active,
    };
    try {
      if (editId) await patch(`/v1/gigs/${editId}`, body);
      else await post('/v1/gigs', body);
      if (!editId) localStorage.removeItem(draftKey(companyId));
      if (d.active && !editId) confetti();
      else haptic('success');
      toast(d.active ? t('gigPublished') : t('gigSaved'));
      qc.invalidateQueries({ queryKey: ['my-gigs'] });
      qc.invalidateQueries({ queryKey: ['gigs'] });
      qc.invalidateQueries({ queryKey: ['gig-edit', editId] });
      nav('/my-gigs', { replace: true });
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };

  const back = () => (step > 0 ? (setStep(step - 1), window.scrollTo(0, 0)) : nav('/my-gigs'));
  const isLast = step === STEPS.length - 1;

  return (
    <>
      <BackButton onClick={back} />
      <div className="wizard-head">
        <div className="small muted">{t.f('stepOf', step + 1, STEPS.length)}</div>
        <h1 style={{ margin: '2px 0 10px' }}>{t(STEPS[step])}</h1>
        <div className="steps" style={{ margin: 0 }}>
          {STEPS.map((s, i) => (
            <i key={s} className={i <= step ? 'on' : ''} />
          ))}
        </div>
      </div>

      {step === 0 && <BasicsStep d={d} set={set} errors={errors} categories={categories} companyId={companyId} />}
      {step === 1 && <PricingStep d={d} set={set} setPkg={setPkg} errors={errors} categorySlug={leaves.find((c) => c.id === d.categoryId)?.slug} />}
      {step === 2 && <MediaStep d={d} setD={setD} errors={errors} />}
      {step === 3 && <ReviewStep d={d} set={set} company={company.data!} />}

      <MainButton
        text={isLast ? (d.active ? t('publish') : t('saveGig')) : t('next')}
        onClick={next}
        loading={busy}
        disabled={categories.length === 0}
      />
    </>
  );
}

/* ───────── Шаги ───────── */

// group: содержимое с кнопками — <label> переадресовал бы клик по подписи на первую кнопку
function Field({ label, hint, error, counter, group, children }: { label: string; hint?: ReactNode; error?: string; counter?: string; group?: boolean; children: ReactNode }) {
  const Tag = group ? 'div' : 'label';
  return (
    <Tag className={`field ${error ? 'has-error' : ''}`} role={group ? 'group' : undefined} aria-label={group ? label : undefined}>
      <span className="row between">
        <span>{label}</span>
        {counter && <span className="muted small mono">{counter}</span>}
      </span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </Tag>
  );
}

function BasicsStep({
  d,
  set,
  errors,
  categories,
  companyId,
}: {
  d: Draft;
  set: (p: Partial<Draft>) => void;
  errors: Errors;
  categories: ReturnType<typeof useLeafCategories>['leaves'];
  companyId: number;
}) {
  const t = useT();
  const nav = useNavigate();
  const [tag, setTag] = useState('');
  const addTags = (raw: string[]) => {
    const next = [...d.tags];
    for (const r of raw) {
      const v = r.trim().toLowerCase().slice(0, 24);
      if (v.length >= 2 && !next.includes(v) && next.length < GIG_LIMITS.tags) next.push(v);
    }
    if (next.length !== d.tags.length) set({ tags: next });
  };
  const addTag = () => {
    addTags([tag]);
    setTag('');
  };
  // Android-клавиатуры в Telegram не присылают key=',' в keydown — режем по запятой в onChange
  const onTagInput = (value: string) => {
    const parts = value.split(',');
    if (parts.length > 1) addTags(parts.slice(0, -1));
    setTag(parts[parts.length - 1]);
  };

  if (!categories.length) {
    return (
      <Section>
        <div className="stack">
          <div className="question">{t('gigNoCategories')}</div>
          <button className="btn secondary" onClick={() => nav(`/company/${companyId}`)}>{t('openCompany')}</button>
        </div>
      </Section>
    );
  }

  return (
    <Section>
      <div className="stack">
        <Field label={t('gigTitleLabel')} error={errors.title} counter={`${d.title.length}/${GIG_LIMITS.titleMax}`} hint={t('gigTitleTip')}>
          <textarea
            className="input"
            style={{ minHeight: 72 }}
            maxLength={GIG_LIMITS.titleMax}
            placeholder={t('gigTitlePh')}
            value={d.title}
            onChange={(e) => set({ title: e.target.value.replace(/\n/g, ' ') })}
          />
        </Field>
        <Field group label={t('gigCategoryLabel')} error={errors.category}>
          <div className="cat-pick">
            {categories.map((c) => (
              <button key={c.id} type="button" className="chip" aria-pressed={d.categoryId === c.id} onClick={() => set({ categoryId: c.id })}>
                {c.name[t.lang]}
              </button>
            ))}
          </div>
        </Field>
        <Field group label={t('tagsLabel')} hint={t('tagsHint')}>
          <div className="tag-input">
            {d.tags.map((x) => (
              <button key={x} type="button" className="tag removable" onClick={() => set({ tags: d.tags.filter((y) => y !== x) })}>
                {x} ×
              </button>
            ))}
            {d.tags.length < GIG_LIMITS.tags && (
              <input
                value={tag}
                placeholder={d.tags.length ? '' : t('tagsPh')}
                aria-label={t('tagsLabel')}
                onChange={(e) => onTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTag();
                  }
                }}
                onBlur={addTag}
              />
            )}
          </div>
        </Field>
      </div>
    </Section>
  );
}

function PricingStep({
  d,
  set,
  setPkg,
  errors,
  categorySlug,
}: {
  d: Draft;
  set: (p: Partial<Draft>) => void;
  setPkg: (code: GigPackageCode, p: Partial<PkgDraft>) => void;
  errors: Errors;
  categorySlug?: string;
}) {
  const t = useT();
  const market = useQuery({
    queryKey: ['gigs', categorySlug, '', 'price'],
    queryFn: () => get<GigCard[]>(`/v1/gigs?category=${categorySlug}&sort=price`),
    enabled: !!categorySlug,
  });
  const prices = (market.data ?? []).map((g) => g.fromPriceUzs).filter((x): x is number => x !== null);
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;

  return (
    <>
      <Section>
        <div className="stack">
          <div className="seg wide" role="group" aria-label={t('oneOrThree')}>
            <button type="button" aria-pressed={d.tiers === 1} onClick={() => set({ tiers: 1 })}>{t('onePackage')}</button>
            <button type="button" aria-pressed={d.tiers === 3} onClick={() => set({ tiers: 3 })}>{t('threePackages')}</button>
          </div>
          <div className="small muted">{t('threeHint')}</div>
          {median && <div className="info-note" style={{ marginTop: 0 }}>{t.f('marketPriceHint', money(median))}</div>}
        </div>
      </Section>
      {usedPackages(d).map((p) => (
        <PackageCard key={p.code} p={p} single={d.tiers === 1} setPkg={setPkg} errors={errors} />
      ))}
    </>
  );
}

function PackageCard({ p, single, setPkg, errors }: { p: PkgDraft; single: boolean; setPkg: (code: GigPackageCode, p: Partial<PkgDraft>) => void; errors: Errors }) {
  const t = useT();
  const [feature, setFeature] = useState('');
  const addFeature = () => {
    const v = feature.trim().slice(0, 80);
    if (v && p.features.length < GIG_LIMITS.features) setPkg(p.code, { features: [...p.features, v] });
    setFeature('');
  };
  const priceErr = errors[`price_${p.code}`];
  const daysErr = errors[`days_${p.code}`];

  return (
    <section className={`section pkg-card ${p.code}`}>
      <div className="pkg-card-head">
        {!single && <span className="pkg-badge">{GIG_PACKAGE_CODES.indexOf(p.code) + 1}</span>}
        <input className="pkg-name-input" value={p.name} maxLength={30} aria-label={t('pkgNameLabel')} onChange={(e) => setPkg(p.code, { name: e.target.value })} />
      </div>
      <div className="section-body stack">
        <div className="grid-2">
          <Field label={t('pkgPrice')} error={priceErr} hint={Number(p.price) >= 10_000 ? `${money(Number(p.price))} ${t('sum')}` : undefined}>
            <input className="input" type="number" inputMode="numeric" placeholder="250000" value={p.price} onChange={(e) => setPkg(p.code, { price: e.target.value })} />
          </Field>
          <Field label={t('pkgDays')} error={daysErr}>
            <input className="input" type="number" inputMode="numeric" placeholder="2" value={p.days} onChange={(e) => setPkg(p.code, { days: e.target.value })} />
          </Field>
        </div>
        <div className="row between">
          <span className="small muted">{t('pkgRevisions')}</span>
          <div className="stepper">
            <button type="button" onClick={() => setPkg(p.code, { revisions: Math.max(0, p.revisions - 1) })} aria-label="-">−</button>
            <b className="mono">{p.revisions}</b>
            <button type="button" onClick={() => setPkg(p.code, { revisions: Math.min(10, p.revisions + 1) })} aria-label="+">+</button>
          </div>
        </div>
        <Field label={t('pkgSummary')}>
          <input className="input" maxLength={160} placeholder={t('pkgSummaryPh')} value={p.summary} onChange={(e) => setPkg(p.code, { summary: e.target.value })} />
        </Field>
        <div className="field">
          <span>{t('pkgFeatures')}</span>
          {p.features.length > 0 && (
            <ul className="pkg-features editable">
              {p.features.map((f, i) => (
                <li key={i}>
                  {Icons.check}
                  <span style={{ flex: 1 }}>{f}</span>
                  <button type="button" aria-label={t('delete')} onClick={() => setPkg(p.code, { features: p.features.filter((_, j) => j !== i) })}>×</button>
                </li>
              ))}
            </ul>
          )}
          {p.features.length < GIG_LIMITS.features && (
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input
                className="input"
                maxLength={80}
                placeholder={t('pkgFeaturePh')}
                value={feature}
                onChange={(e) => setFeature(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addFeature();
                  }
                }}
              />
              <button type="button" className="btn secondary" onClick={addFeature} disabled={!feature.trim()}>
                {t('add')}
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function MediaStep({ d, setD, errors }: { d: Draft; setD: Dispatch<SetStateAction<Draft | null>>; errors: Errors }) {
  const t = useT();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);

  const updateGallery = (fn: (g: Img[]) => Img[]) => setD((cur) => (cur ? { ...cur, gallery: fn(cur.gallery) } : cur));

  const onPick = async (list: FileList | null) => {
    if (!list) return;
    for (const f of Array.from(list).slice(0, GIG_LIMITS.images - d.gallery.length)) {
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) {
        toast('JPG, PNG, WEBP', 'error');
        continue;
      }
      if (f.size > 20 * 1024 * 1024) {
        toast('> 20 MB', 'error');
        continue;
      }
      const entry: Img = { ref: null, preview: URL.createObjectURL(f), uploading: true };
      updateGallery((g) => [...g, entry]);
      try {
        const id = await uploadFile(f);
        updateGallery((g) => g.map((x) => (x === entry ? { ...x, ref: `f:${id}`, uploading: false } : x)));
      } catch (e) {
        updateGallery((g) => g.filter((x) => x !== entry));
        toast((e as Error).message, 'error');
      }
    }
  };

  return (
    <>
      <Section>
        <Field group label={t('galleryLabel')} error={errors.gallery} hint={t('galleryHint')}>
          <div className="gallery-edit">
            {d.gallery.map((g, i) => (
              <div key={g.preview} className={`ge-tile ${i === 0 ? 'cover' : ''}`}>
                <img src={g.preview} alt="" />
                {g.uploading && <div className="ge-loading"><Spinner /></div>}
                {i === 0 && <span className="ge-badge">{t('coverLabel')}</span>}
                {!g.uploading && (
                  <div className="ge-actions">
                    {i > 0 && (
                      <button type="button" onClick={() => updateGallery((all) => [g, ...all.filter((x) => x !== g)])}>
                        ★ {t('makeCover')}
                      </button>
                    )}
                    <button type="button" aria-label={t('delete')} onClick={() => updateGallery((all) => all.filter((x) => x !== g))}>×</button>
                  </div>
                )}
              </div>
            ))}
            {d.gallery.length < GIG_LIMITS.images && (
              <button type="button" className="ge-tile ge-add" onClick={() => input.current?.click()}>
                <span style={{ fontSize: 28, lineHeight: 1 }}>+</span>
                <span className="small">{t('addPhoto')}</span>
              </button>
            )}
          </div>
        </Field>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          hidden
          onChange={(e) => {
            onPick(e.target.files);
            e.target.value = '';
          }}
        />
      </Section>
      <Section>
        <Field label={t('descLabel')} error={errors.description} counter={`${d.description.length}/${GIG_LIMITS.descMax}`}>
          <textarea
            className="input"
            style={{ minHeight: 180 }}
            maxLength={GIG_LIMITS.descMax}
            value={d.description}
            onChange={(e) => setD((cur) => (cur ? { ...cur, description: e.target.value } : cur))}
          />
        </Field>
        {!d.description.trim() && (
          <button type="button" className="btn ghost" onClick={() => setD((cur) => (cur ? { ...cur, description: t('descTemplateText') } : cur))}>
            + {t('descTemplate')}
          </button>
        )}
      </Section>
    </>
  );
}

function ReviewStep({ d, set, company }: { d: Draft; set: (p: Partial<Draft>) => void; company: CompanyProfile }) {
  const t = useT();
  const pk = usedPackages(d);
  const from = Math.min(...pk.map((p) => Number(p.price) || Infinity));
  const checks: [Key, boolean][] = [
    ['qTitle', d.title.trim().length >= 25],
    ['qThree', d.tiers === 3],
    ['qPhotos', d.gallery.filter((g) => g.ref).length >= 3],
    ['qDesc', ownTextLength(d.description, t('descTemplateText')) >= 150],
    ['qFeatures', pk.every((p) => p.features.length > 0)],
  ];
  const score = checks.filter(([, v]) => v).length;

  return (
    <>
      <div className="block-head"><h2>{t('previewCard')}</h2></div>
      <div className="gig-grid single">
        <article className="gig">
          <div className="gig-cover">
            {d.gallery[0] && <img src={d.gallery[0].preview} alt="" />}
            {isTop(company) && <span className="lvl on-cover">★ {t('topSeller')}</span>}
          </div>
          <div className="gig-body">
            <div className="gig-seller">
              <Avatar id={company.id} name={company.name} size={22} />
              <span className="gig-seller-name">{company.name}</span>
            </div>
            <div className="gig-title">{d.title}</div>
            {company.ratingAvg && company.ratingCount ? (
              <span className="rating"><span className="star">★</span><b>{company.ratingAvg.toFixed(1)}</b><span className="muted">({company.ratingCount})</span></span>
            ) : (
              <span className="muted small">{t('noReviews')}</span>
            )}
            <div className="gig-foot">{Number.isFinite(from) && <b className="gig-price">{t.f('fromPriceTpl', money(from))}</b>}</div>
          </div>
        </article>
      </div>

      <Section title={t('stepPricing')} body={false}>
        {pk.map((p) => (
          <div key={p.code} className="cell" style={{ cursor: 'default' }}>
            <div className="cell-main">
              <div className="cell-title">{p.name}</div>
              <div className="cell-sub">{t.f('daysTpl', p.days)} · {t.f('revisionsTpl', p.revisions)}{p.features.length ? ` · ${p.features.length} ✓` : ''}</div>
            </div>
            <b className="mono">{money(Number(p.price))} {t('sum')}</b>
          </div>
        ))}
      </Section>

      <Section title={`${t('quality')} · ${score}/${checks.length}`}>
        <div className="quality-bar"><i style={{ width: `${(score / checks.length) * 100}%` }} /></div>
        <ul className="checklist">
          {checks.map(([k, v]) => (
            <li key={k} className={v ? 'ok' : ''}>
              <span className="ck">{v ? '✓' : ''}</span>
              {t(k)}
            </li>
          ))}
        </ul>
      </Section>

      <Section>
        <label className="check" style={{ padding: 0 }}>
          <input type="checkbox" checked={d.active} onChange={(e) => set({ active: e.target.checked })} />
          <span>{t('publishNow')}</span>
        </label>
      </Section>
    </>
  );
}
