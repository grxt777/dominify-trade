import { COMPANY_TYPES, REGIONS, type CompanyType } from '@dominify/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, patch, post, type CompanyProfile, type Me } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { haptic, requestWriteAccess } from '../tg';
import { BackButton, MainButton, Section, Spinner, useToast } from '../ui';
import { RegionSelect, useLeafCategories } from './fields';

/** Онбординг поставщика за три шага или редактирование компании. */
export function CompanyForm() {
  const { id } = useParams();
  const editId = id ? Number(id) : null;
  const t = useT();
  const nav = useNavigate();
  const toast = useToast();
  const { me, setMe } = useSession();
  const { tree } = useLeafCategories();
  const existing = useQuery({ queryKey: ['company', editId], queryFn: () => get<CompanyProfile>(`/v1/companies/${editId}`), enabled: !!editId });

  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [type, setType] = useState<CompanyType>('llc');
  const [inn, setInn] = useState('');
  const [about, setAbout] = useState('');
  const [cats, setCats] = useState<number[]>([]);
  const [region, setRegion] = useState('tashkent');
  const [areas, setAreas] = useState<string[]>([]);
  const [nationwide, setNationwide] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const c = existing.data;
    if (!c) return;
    setName(c.name);
    setType(c.type as CompanyType);
    setAbout(c.about ?? '');
    setCats(c.categoryIds);
    setRegion(c.regionCode);
    setAreas(c.areas.filter((a) => a !== c.regionCode));
    setNationwide(c.deliversNationwide);
  }, [existing.data]);

  if (editId && existing.isLoading) return <Spinner />;

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const maxCats = 3;
  const innOk = !inn || /^(\d{9}|\d{14})$/.test(inn.trim());

  const save = async () => {
    setBusy(true);
    const body = {
      name: name.trim(),
      type,
      inn: inn.trim() || undefined,
      about: about.trim() || undefined,
      regionCode: region,
      isSupplier: true,
      isBuyer: true,
      categoryIds: cats,
      areas: [region, ...areas.filter((a) => a !== region)].map((regionCode) => ({ regionCode })),
      deliversNationwide: nationwide,
    };
    try {
      if (editId) {
        await patch(`/v1/companies/${editId}`, body);
        toast(t('saved'));
      } else {
        await post('/v1/companies', body);
        // Без разрешения писать бот не сможет присылать заявки.
        if (!me.botStarted && (await requestWriteAccess())) await post('/v1/me/write-access');
      }
      setMe(await get<Me>('/v1/me'));
      haptic('success');
      nav(editId ? '/profile' : '/feed', { replace: true });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const steps = [
    // 1. Компания
    <Section key="company">
      <div className="stack">
        <label className="field">
          <span>{t('companyName')} *</span>
          <input className="input" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          <span className="muted small">{t('companyType')}</span>
          <div className="chips">
            {COMPANY_TYPES.map((ct) => (
              <button key={ct} className="chip" aria-pressed={type === ct} onClick={() => setType(ct)}>
                {t(ct)}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span>{t('inn')}</span>
          <input className="input" inputMode="numeric" value={inn} maxLength={14} onChange={(e) => setInn(e.target.value.replace(/\D/g, ''))} placeholder={editId && existing.data?.hasInn ? '•••••••••' : ''} />
        </label>
        <span className="muted small">{t('innHint')}</span>
        <label className="field">
          <span>{t('about')}</span>
          <textarea className="input" style={{ minHeight: 80 }} maxLength={1000} value={about} onChange={(e) => setAbout(e.target.value)} />
        </label>
      </div>
    </Section>,
    // 2. Категории
    <div key="cats">
      <p className="muted small" style={{ margin: '0 4px 8px' }}>{t('maxCategories')}</p>
      {tree.map((root) => (
        <Section key={root.id} title={root.name[t.lang]}>
          <div className="chips">
            {(root.children ?? []).map((c) => (
              <button
                key={c.id}
                className="chip"
                aria-pressed={cats.includes(c.id)}
                disabled={!cats.includes(c.id) && cats.length >= maxCats && !editId}
                onClick={() => setCats(toggle(cats, c.id))}
              >
                {c.name[t.lang]}
              </button>
            ))}
          </div>
        </Section>
      ))}
    </div>,
    // 3. География
    <Section key="geo">
      <div className="stack">
        <RegionSelect value={region} onChange={setRegion} label={t('mainRegion')} />
        <div className="field">
          <span className="muted small">{t('alsoServe')}</span>
          <div className="chips">
            {REGIONS.filter((r) => !r.parent && r.code !== region).map((r) => (
              <button key={r.code} className="chip" aria-pressed={areas.includes(r.code)} onClick={() => setAreas(toggle(areas, r.code))}>
                {r.name[t.lang]}
              </button>
            ))}
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={nationwide} onChange={(e) => setNationwide(e.target.checked)} />
          <span>{t('nationwide')}</span>
        </label>
      </div>
    </Section>,
  ];

  const canNext = step === 0 ? name.trim().length >= 2 && innOk : step === 1 ? cats.length > 0 : true;
  const last = step === steps.length - 1;

  return (
    <>
      <BackButton to={editId ? '/profile' : undefined} />
      <h1>{editId ? t('editCompany') : t('becomeSupplier')}</h1>
      <div className="steps">
        {steps.map((_, i) => (
          <i key={i} className={i <= step ? 'on' : ''} />
        ))}
      </div>
      {steps[step]}
      {step > 0 && (
        <button className="btn ghost" onClick={() => setStep(step - 1)}>
          ‹ {t('back')}
        </button>
      )}
      <MainButton text={last ? t('finish') : t('next')} disabled={!canNext} loading={busy} onClick={() => (last ? save() : setStep(step + 1))} />
    </>
  );
}
