import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, post, type ChatItem, type Message } from '../api';
import { useT } from '../i18n';
import { useSession } from '../session';
import { useSocketEvent } from '../socket';
import { BackButton, Empty, fmtDate, fmtTime, Section, Spinner, useToast } from '../ui';

export function ChatsList() {
  const t = useT();
  const nav = useNavigate();
  const { me } = useSession();
  const q = useQuery({ queryKey: ['chats'], queryFn: () => get<ChatItem[]>('/v1/chats') });
  useSocketEvent('message.created', () => q.refetch());
  return (
    <Section title={t('tabChats')} body={false}>
      {q.isLoading && <Spinner />}
      {q.data?.length === 0 && <Empty>{t('noChats')}</Empty>}
      {q.data?.map((c) => (
        <div key={c.id} className="cell" onClick={() => nav(`/chats/${c.id}`)}>
          <div className="cell-main">
            <div className="cell-title">{c.buyerUserId === me.id ? c.supplierName : c.buyerName ?? t('buyer')}</div>
            <div className="cell-sub">
              {!c.requestId && <span className="pill cyan tiny">{t('gigQuestion')}</span>} {c.title || (c.requestId ? `#${c.requestId}` : '')}
            </div>
          </div>
          <div className="cell-right">
            {c.unread > 0 ? <span className="badge">{c.unread}</span> : c.lastMessageAt ? fmtDate(c.lastMessageAt, t.lang) : null}
          </div>
        </div>
      ))}
    </Section>
  );
}

export function ChatPage() {
  const { id } = useParams();
  const chatId = Number(id);
  const t = useT();
  const nav = useNavigate();
  const { me } = useSession();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [maskedNotice, setMaskedNotice] = useState(false);
  const toast = useToast();
  const bottom = useRef<HTMLDivElement>(null);

  const q = useQuery({
    queryKey: ['chat', chatId],
    queryFn: () =>
      get<{
        side: string;
        chat: { requestId: number | null; gigId: number | null };
        gigTitle: string | null;
        supplierName: string | null;
        messages: Message[];
        contactsOpen: boolean;
      }>(`/v1/chats/${chatId}/messages`),
  });
  useSocketEvent(
    'message.created',
    (m: Message) => {
      if (m.chatId !== chatId) return;
      qc.setQueryData(['chat', chatId], (old: typeof q.data) => (old && !old.messages.some((x) => x.id === m.id) ? { ...old, messages: [...old.messages, m] } : old));
    },
    `chat:${chatId}`,
  );

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
    qc.invalidateQueries({ queryKey: ['chats'] });
  }, [q.data?.messages.length, qc]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    try {
      const m = await post<Message & { masked?: boolean }>(`/v1/chats/${chatId}/messages`, { text: body });
      setText('');
      if (m.masked) setMaskedNotice(true);
      qc.setQueryData(['chat', chatId], (old: typeof q.data) => (old && !old.messages.some((x) => x.id === m.id) ? { ...old, messages: [...old.messages, m] } : old));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <BackButton to="/chats" />
      {q.data?.chat.requestId && (
        <button className="btn ghost" onClick={() => nav(`/requests/${q.data!.chat.requestId}`)}>
          #{q.data.chat.requestId} ›
        </button>
      )}
      {q.data && !q.data.chat.requestId && (
        <button className="chat-gig-head" onClick={() => q.data!.chat.gigId && nav(`/gigs/${q.data!.chat.gigId}`)}>
          <span className="pill cyan tiny">{t('gigQuestion')}</span>
          <b className="small">{q.data.gigTitle ?? q.data.supplierName}</b>
          {q.data.chat.gigId && <span className="small muted">{t('openGig')} ›</span>}
        </button>
      )}
      {q.isLoading && <Spinner />}
      {q.data && !q.data.chat.requestId && q.data.messages.length === 0 && q.data.side === 'buyer' && (
        <p className="muted small" style={{ padding: '0 4px' }}>{t('askHint')}</p>
      )}
      {q.data && !q.data.contactsOpen && (
        <p className={`small ${maskedNotice ? '' : 'muted'}`} style={{ padding: '0 4px' }}>
          🔒 {t('contactsHidden')}
        </p>
      )}
      <div className="chat">
        {q.data?.messages.map((m) => (
          <div key={m.id} className={`msg ${m.senderUserId === me.id ? 'mine' : ''}`}>
            {m.text ?? '📎'}
            <time>{fmtTime(m.createdAt, t.lang)}</time>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <div className="composer">
        <input
          className="input"
          placeholder={t('messagePlaceholder')}
          value={text}
          maxLength={4000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && send()}
        />
        <button className="btn" disabled={sending || !text.trim()} onClick={send} aria-label={t('send')}>
          ➤
        </button>
      </div>
    </>
  );
}
