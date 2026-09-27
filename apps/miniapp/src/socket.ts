import { io, type Socket } from 'socket.io-client';
import { useEffect } from 'react';
import { API_URL, currentToken } from './api';

let socket: Socket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;

/** Одно соединение на приложение. Пинг раз в 30 с: пока приложение открыто, уведомления в бот не дублируются. */
export function connectSocket(): Socket | null {
  const token = currentToken();
  if (!token) return null;
  if (socket) return socket;
  socket = io(API_URL, { path: '/ws', transports: ['websocket'], auth: (cb) => cb({ token: currentToken() }) });
  socket.on('connect', () => socket?.emit('ping'));
  pingTimer = setInterval(() => socket?.connected && socket.emit('ping'), 30_000);
  return socket;
}

export function disconnectSocket() {
  if (pingTimer) clearInterval(pingTimer);
  socket?.disconnect();
  socket = null;
}

/** Подписка на событие; room — комната заявки или чата, к которой нужно присоединиться. */
export function useSocketEvent(event: string, handler: (data: any) => void, room?: string) {
  useEffect(() => {
    const s = connectSocket();
    if (!s) return;
    const join = () => room && s.emit('join', { room });
    join();
    s.on('connect', join);
    s.on(event, handler);
    return () => {
      s.off(event, handler);
      s.off('connect', join);
    };
    // handler намеренно не в зависимостях: переподписка на каждый рендер не нужна
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, room]);
}
