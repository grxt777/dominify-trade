import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { haptic, tg } from '../tg';
import { useToast } from '../ui';

export interface MapPoint {
  lat: number;
  lng: number;
  address?: string;
}

const TASHKENT = { lat: 41.3111, lng: 69.2797 };

/** Адрес по координатам: OpenStreetMap Nominatim. Без адреса точка всё равно сохраняется. */
async function reverse(lat: number, lng: number, lang: string): Promise<string | undefined> {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${lat}&lon=${lng}&accept-language=${lang === 'ru' ? 'ru' : 'uz,ru'}`,
    );
    if (!r.ok) return undefined;
    const d = (await r.json()) as { address?: Record<string, string>; display_name?: string };
    const a = d.address ?? {};
    const street = [a.road ?? a.pedestrian ?? a.neighbourhood, a.house_number].filter(Boolean).join(', ');
    const area = a.suburb ?? a.city_district ?? a.quarter;
    const city = a.city ?? a.town ?? a.village;
    return [street, area, city].filter(Boolean).join(', ') || d.display_name?.split(',').slice(0, 3).join(',');
  } catch {
    return undefined;
  }
}

/** Где я: геолокация Telegram (Bot API 8.0), а в браузере — navigator.geolocation. */
function locate(): Promise<{ lat: number; lng: number } | null> {
  type Lm = { isInited: boolean; init(cb: () => void): void; getLocation(cb: (d: { latitude: number; longitude: number } | null) => void): void };
  const lm = (tg as unknown as { LocationManager?: Lm } | undefined)?.LocationManager;
  if (lm && tg?.isVersionAtLeast('8.0')) {
    return new Promise((res) => {
      const get = () => lm.getLocation((d) => res(d ? { lat: d.latitude, lng: d.longitude } : null));
      if (lm.isInited) get();
      else lm.init(get);
    });
  }
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((res) =>
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => res(null),
      { enableHighAccuracy: true, timeout: 10_000 },
    ),
  );
}

/**
 * Полноэкранная карта: булавка стоит в центре, пользователь двигает карту под ней.
 * Так точку легко поставить пальцем, а адрес подставляется сам.
 */
export function MapPicker({ initial, onPick, onClose }: { initial?: MapPoint | null; onPick: (p: MapPoint) => void; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const [center, setCenter] = useState<MapPoint>(initial ?? TASHKENT);
  const [address, setAddress] = useState<string | undefined>(initial?.address);
  const [moving, setMoving] = useState(false);
  const [finding, setFinding] = useState(false);

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { zoomControl: false, attributionControl: true }).setView([center.lat, center.lng], initial ? 17 : 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
    m.on('movestart', () => setMoving(true));
    let timer = 0;
    m.on('moveend', () => {
      setMoving(false);
      const c = m.getCenter();
      setCenter({ lat: c.lat, lng: c.lng });
      clearTimeout(timer);
      timer = window.setTimeout(async () => setAddress(await reverse(c.lat, c.lng, t.lang)), 450);
    });
    map.current = m;
    // Без точки сразу пробуем определить, где пользователь.
    if (!initial) void findMe(true);
    return () => {
      clearTimeout(timer);
      m.remove();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const findMe = async (silent = false) => {
    setFinding(true);
    const p = await locate();
    setFinding(false);
    if (!p) {
      if (!silent) toast(t('mapNoGeo'), 'error');
      return;
    }
    haptic();
    map.current?.flyTo([p.lat, p.lng], 17, { duration: 0.8 });
  };

  const done = () => {
    haptic('success');
    onPick({ lat: center.lat, lng: center.lng, address });
  };

  return createPortal(
    <div className="map-sheet" role="dialog" aria-label={t('mapTitle')}>
      <div ref={el} className="map-canvas" />
      <div className={`map-pin ${moving ? 'lift' : ''}`} aria-hidden>
        <i />
      </div>
      <div className="map-top">
        <button className="map-close" onClick={onClose} aria-label={t('back')}>×</button>
        <div className="map-address">
          <span className="small muted">{t('mapTitle')}</span>
          <b>{moving ? '…' : address ?? `${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`}</b>
        </div>
      </div>
      <div className="map-bottom">
        <button className="btn secondary" onClick={() => findMe()} disabled={finding}>
          {finding ? '…' : `◎ ${t('mapMyLocation')}`}
        </button>
        <button className="btn" onClick={done} disabled={moving}>
          {t('mapDone')}
        </button>
      </div>
    </div>,
    document.body,
  );
}
