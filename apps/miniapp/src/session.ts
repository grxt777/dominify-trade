import { createContext, useContext } from 'react';
import type { Me } from './api';

export interface Session {
  me: Me;
  setMe: (me: Me) => void;
  /** Активная компания поставщика (если есть). */
  supplierCompanyId: number | null;
}

export const SessionCtx = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionCtx);
  if (!s) throw new Error('SessionCtx не инициализирован');
  return s;
}
