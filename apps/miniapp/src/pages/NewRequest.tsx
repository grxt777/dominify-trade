import { GIG_PACKAGE_CODES, type GigPackageCode } from '@dominify/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { get, imgSrc, post, uploadFile, type GigView, type RequestView } from '../api';
import { useT } from '../i18n';
import { cloud, setClosingConfirmation } from '../tg';
import { BackButton, MainButton, money, Section, useToast } from '../ui';
import { Avatar } from './Market';

const DRAFT_KEY = 'draft_request';

interface Attached {
  id: number | null;
  name: string;
  preview: string | null;
  uploading: boolean;
}

/**
 * Новая заявка: один текст и вложения. Черновик переживает закрытие приложения (облачное хранилище Telegram).
 * С ?gig=&pkg= — заказ услуги с витрины: заявка сначала уходит выбранному исполнителю.
 */
export function NewRequest() {
  const t = useT();
  const nav = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const gigId = Number(params.get('gig')) || null;
  const pkgParam = params.get('pkg');
  const [pkgCode, setPkgCode] = useState<GigPackageCode | null>(
    (GIG_PACKAGE_CODES as readonly string[]).includes(pkgParam ?? '') ? (pkgParam as GigPackageCode) : null,
  );
  const gig = useQuery({ queryKey: ['gig', gigId], queryFn: () => get<GigView>(`/v1/gigs/${gigId}`), enabled: !!gigId });
  const pkg = gig.data?.packages.find((p) => p.code === pkgCode) ?? gig.data?.packages[0];

  const [text, setText] = useState('');
  const [files, setFiles] = useState<Attached[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // Черновик свободной заявки не подставляем в заказ услуги: там другой контекст.
  useEffect(() => {
    if (!gigId) cloud.get(DRAFT_KEY).then((v) => v && setText((cur) => cur || v));
  }, [gigId]);
  useEffect(() => {
    const id = setTimeout(() => {
      if (!gigId) void (text ? cloud.set(DRAFT_KEY, text) : cloud.remove(DRAFT_KEY));
    }, 500);
    setClosingConfirmation(!!text);
    return () => clearTimeout(id);
  }, [text, gigId]);
  useEffect(() => () => setClosingConfirmation(false), []);

  const onPick = async (list: FileList | null) => {
    if (!list) return;
    for (const f of Array.from(list).slice(0, 10 - files.length)) {
      if (f.size > 20 * 1024 * 1024) {
        toast('> 20 MB', 'error');
        continue;
      }
      const preview = f.type.startsWith('image/') ? URL.createObjectURL(f) : null;
      const entry: Attached = { id: null, name: f.name, preview, uploading: true };
      setFiles((prev) => [...prev, entry]);
      try {
        const id = await uploadFile(f);
        setFiles((prev) => prev.map((x) => (x === entry ? { ...x, id, uploading: false } : x)));
      } catch (e) {
        setFiles((prev) => prev.filter((x) => x !== entry));
        toast((e as Error).message, 'error');
      }
    }
  };

  const empty = !text.trim() && files.length === 0;

  const submit = async () => {
    if (empty && !gigId) return;
    setBusy(true);
    try {
      const r = await post<RequestView>('/v1/requests/parse', {
        text: text.trim(),
        fileIds: files.filter((f) => f.id).map((f) => f.id),
        ...(gigId && { gigId, packageCode: pkg?.code }),
      });
      if (!gigId) cloud.remove(DRAFT_KEY);
      setClosingConfirmation(false);
      nav(`/requests/${r.id}`, { replace: true });
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };

  const uploading = files.some((f) => f.uploading);
  const g = gig.data;

  return (
    <>
      <BackButton />
      <h1>{gigId ? t('orderTitle') : t('newRequest')}</h1>
      {g && (
        <Section>
          <div className="order-card">
            {g.cover && <img src={imgSrc(g.cover)} alt="" />}
            <div className="cell-main">
              <div className="row small muted" style={{ gap: 6 }}>
                <Avatar id={g.company.id} name={g.company.name} size={18} />
                {g.company.name}
              </div>
              <div style={{ fontWeight: 600, marginTop: 2 }}>{g.title}</div>
            </div>
          </div>
          <div className="pkg-tabs compact" role="tablist" style={{ marginTop: 12 }}>
            {g.packages.map((p) => (
              <button key={p.code} role="tab" aria-selected={p.code === pkg?.code} onClick={() => setPkgCode(p.code)}>
                {p.name}
              </button>
            ))}
          </div>
          {pkg && (
            <div className="row between" style={{ marginTop: 10 }}>
              <span className="small muted">{t.f('daysTpl', pkg.days)} · {t.f('revisionsTpl', pkg.revisions)}</span>
              <span className="price">{money(pkg.priceUzs)} <span className="small muted">{t('sum')}</span></span>
            </div>
          )}
          <div className="info-note">{t.f('orderGoesFirst', g.company.name)}</div>
        </Section>
      )}
      <Section>
        <div className="stack">
          <textarea
            className="input"
            autoFocus
            maxLength={4000}
            placeholder={gigId ? t('orderTaskPlaceholder') : t('newRequestPlaceholder')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
          />
          <div className="thumbs">
            {files.map((f, i) => (
              <div key={i} className="thumb">
                {f.preview ? <img src={f.preview} alt="" /> : <span>{f.uploading ? '…' : 'PDF'}</span>}
                {!f.uploading && (
                  <button aria-label="remove" onClick={() => setFiles((prev) => prev.filter((x) => x !== f))}>
                    ×
                  </button>
                )}
              </div>
            ))}
            {files.length < 10 && (
              <button className="thumb" style={{ cursor: 'pointer' }} onClick={() => input.current?.click()}>
                + {t('attach')}
              </button>
            )}
          </div>
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            multiple
            hidden
            onChange={(e) => {
              onPick(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
      </Section>
      <MainButton
        text={gigId ? `${t('sendOrder')}${pkg ? ` · ${money(pkg.priceUzs)} ${t('sum')}` : ''}` : t('parseButton')}
        onClick={submit}
        loading={busy}
        disabled={uploading || (gigId ? !g : empty)}
      />
    </>
  );
}
