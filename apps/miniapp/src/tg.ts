/** Тонкая типизированная обёртка над window.Telegram.WebApp с запасным поведением для браузера. */

type Haptic = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft';

interface TgButton {
  text: string;
  isVisible: boolean;
  isActive: boolean;
  setText(t: string): TgButton;
  show(): TgButton;
  hide(): TgButton;
  enable(): TgButton;
  disable(): TgButton;
  showProgress(leaveActive?: boolean): TgButton;
  hideProgress(): TgButton;
  onClick(cb: () => void): TgButton;
  offClick(cb: () => void): TgButton;
  setParams(p: Record<string, unknown>): TgButton;
}

interface WebApp {
  initData: string;
  initDataUnsafe: { user?: { id: number; first_name?: string; language_code?: string; allows_write_to_pm?: boolean }; start_param?: string };
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  isExpanded: boolean;
  ready(): void;
  expand(): void;
  close(): void;
  isVersionAtLeast(v: string): boolean;
  enableClosingConfirmation(): void;
  disableClosingConfirmation(): void;
  setHeaderColor?(c: string): void;
  MainButton: TgButton;
  SecondaryButton?: TgButton;
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  HapticFeedback?: {
    impactOccurred(s: Haptic): void;
    notificationOccurred(t: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
  CloudStorage?: {
    setItem(k: string, v: string, cb?: (e: unknown, ok?: boolean) => void): void;
    getItem(k: string, cb: (e: unknown, v?: string) => void): void;
    removeItem(k: string, cb?: (e: unknown, ok?: boolean) => void): void;
  };
  showConfirm(msg: string, cb: (ok: boolean) => void): void;
  showAlert(msg: string, cb?: () => void): void;
  requestContact?(cb: (sent: boolean) => void): void;
  requestWriteAccess?(cb: (allowed: boolean) => void): void;
  openLink(url: string): void;
  openTelegramLink(url: string): void;
  onEvent(e: string, cb: () => void): void;
  offEvent(e: string, cb: () => void): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: WebApp };
  }
}

export const tg: WebApp | undefined = window.Telegram?.WebApp && window.Telegram.WebApp.initData ? window.Telegram.WebApp : undefined;
export const inTelegram = !!tg;

export function tgReady() {
  if (!tg) return;
  tg.ready();
  tg.expand();
}

export function initData(): string {
  return tg?.initData ?? '';
}

/** Маршрут при открытии: start_param из прямой ссылки или ?r= из кнопки уведомления. */
export function startRoute(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('r');
  return tg?.initDataUnsafe.start_param ?? fromUrl ?? null;
}

export function haptic(kind: 'success' | 'error' | 'warning' | 'tap' = 'tap') {
  const h = tg?.HapticFeedback;
  if (!h) return;
  if (kind === 'tap') h.impactOccurred('light');
  else h.notificationOccurred(kind);
}

export function confirm(message: string): Promise<boolean> {
  if (tg?.isVersionAtLeast('6.2')) return new Promise((resolve) => tg!.showConfirm(message, resolve));
  return Promise.resolve(window.confirm(message));
}

export function alertMsg(message: string): Promise<void> {
  if (tg?.isVersionAtLeast('6.2')) return new Promise((resolve) => tg!.showAlert(message, resolve));
  window.alert(message);
  return Promise.resolve();
}

export function requestContact(): Promise<boolean> {
  if (tg?.requestContact && tg.isVersionAtLeast('6.9')) return new Promise((resolve) => tg!.requestContact!(resolve));
  return Promise.resolve(false);
}

export function requestWriteAccess(): Promise<boolean> {
  if (tg?.requestWriteAccess && tg.isVersionAtLeast('6.9')) return new Promise((resolve) => tg!.requestWriteAccess!(resolve));
  return Promise.resolve(false);
}

export function openLink(url: string) {
  if (tg) tg.openLink(url);
  else window.open(url, '_blank', 'noopener');
}

export function openTelegramLink(url: string) {
  if (tg) tg.openTelegramLink(url);
  else window.open(url, '_blank', 'noopener');
}

/** Черновик заявки в облачном хранилище Telegram (или localStorage в браузере). */
export const cloud = {
  get(key: string): Promise<string | null> {
    if (tg?.CloudStorage && tg.isVersionAtLeast('6.9')) {
      return new Promise((resolve) => tg!.CloudStorage!.getItem(key, (_e, v) => resolve(v || null)));
    }
    try {
      return Promise.resolve(localStorage.getItem(key));
    } catch {
      return Promise.resolve(null);
    }
  },
  set(key: string, value: string): void {
    if (tg?.CloudStorage && tg.isVersionAtLeast('6.9')) {
      tg.CloudStorage.setItem(key, value.slice(0, 4000));
      return;
    }
    try {
      localStorage.setItem(key, value);
    } catch {
      /* приватный режим */
    }
  },
  remove(key: string): void {
    if (tg?.CloudStorage && tg.isVersionAtLeast('6.9')) {
      tg.CloudStorage.removeItem(key);
      return;
    }
    try {
      localStorage.removeItem(key);
    } catch {
      /* приватный режим */
    }
  },
};

export function setClosingConfirmation(on: boolean) {
  if (!tg?.isVersionAtLeast('6.2')) return;
  if (on) tg.enableClosingConfirmation();
  else tg.disableClosingConfirmation();
}
