export const API_URL: string = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? 'http://localhost:3000';
export const BOT_USERNAME: string = (import.meta.env.VITE_BOT_USERNAME as string | undefined) ?? 'leetvertexbot';

const KEY = 'dominify_admin_token';

/** Токен админки живёт 12 часов; в sessionStorage, чтобы закрытая вкладка разлогинивала. */
export const auth = {
  get(): string | null {
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set(token: string) {
    try {
      sessionStorage.setItem(KEY, token);
    } catch {
      /* приватный режим */
    }
  },
  clear() {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* приватный режим */
    }
  },
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(auth.get() ? { authorization: `Bearer ${auth.get()}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    auth.clear();
    window.location.reload();
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? `Ошибка ${res.status}`);
  return data as T;
}

export const get = <T,>(p: string) => api<T>('GET', p);
export const post = <T,>(p: string, b?: unknown) => api<T>('POST', p, b ?? {});
export const patch = <T,>(p: string, b: unknown) => api<T>('PATCH', p, b);
export const del = <T,>(p: string) => api<T>('DELETE', p);
