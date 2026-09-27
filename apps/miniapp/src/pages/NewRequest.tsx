import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { post, uploadFile, type RequestView } from '../api';
import { useT } from '../i18n';
import { cloud, setClosingConfirmation } from '../tg';
import { BackButton, MainButton, Section, useToast } from '../ui';

const DRAFT_KEY = 'draft_request';

interface Attached {
  id: number | null;
  name: string;
  preview: string | null;
  uploading: boolean;
}

/** Новая заявка: один текст и вложения. Черновик переживает закрытие приложения (облачное хранилище Telegram). */
export function NewRequest() {
  const t = useT();
  const nav = useNavigate();
  const toast = useToast();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Attached[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    cloud.get(DRAFT_KEY).then((v) => v && setText((cur) => cur || v));
  }, []);
  useEffect(() => {
    const id = setTimeout(() => (text ? cloud.set(DRAFT_KEY, text) : cloud.remove(DRAFT_KEY)), 500);
    setClosingConfirmation(!!text);
    return () => clearTimeout(id);
  }, [text]);
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

  const submit = async () => {
    if (!text.trim() && files.length === 0) return;
    setBusy(true);
    try {
      const r = await post<RequestView>('/v1/requests/parse', {
        text: text.trim(),
        fileIds: files.filter((f) => f.id).map((f) => f.id),
      });
      cloud.remove(DRAFT_KEY);
      setClosingConfirmation(false);
      nav(`/requests/${r.id}`, { replace: true });
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };

  const uploading = files.some((f) => f.uploading);

  return (
    <>
      <BackButton to="/" />
      <h1>{t('newRequest')}</h1>
      <Section>
        <div className="stack">
          <textarea
            className="input"
            autoFocus
            maxLength={4000}
            placeholder={t('newRequestPlaceholder')}
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
      <MainButton text={t('parseButton')} onClick={submit} loading={busy} disabled={uploading || (!text.trim() && files.length === 0)} />
    </>
  );
}
