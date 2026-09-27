/* Сквозной прогон против запущенных api и воркера (NOTIFY_DRIVER=log, LLM_PROVIDER=rules).
 * Покупатель → заявка → разбор → отправка → волна 1 → оплата тарифов (Payme, Click, счёт) → отклики → выбор →
 * чат → подтверждение → отзыв → метрики. Запуск: node dist/e2e/run.js */
import { signInitData } from '../auth/init-data';
import { createHash } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:3000';
const BOT = process.env.BOT_TOKEN!;
const PAYME_KEY = process.env.PAYME_KEY ?? '';
const CLICK_SECRET = process.env.CLICK_SECRET_KEY ?? '';
const RUN = Date.now() % 100000;

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T = any>(method: string, path: string, token?: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; data: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, data };
}

async function login(tgId: number, name: string): Promise<string> {
  const initData = signInitData(
    { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'e2e', user: JSON.stringify({ id: tgId, first_name: name, language_code: 'ru', allows_write_to_pm: true }) },
    BOT,
  );
  const r = await call('POST', '/v1/auth/telegram', undefined, undefined, { authorization: `tma ${initData}` });
  if (r.status !== 200) throw new Error(`Вход не удался: ${JSON.stringify(r.data)}`);
  return r.data.token;
}

async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  let v = await fn();
  while (!pred(v) && Date.now() < until) {
    await sleep(300);
    v = await fn();
  }
  return v;
}

async function main() {
  console.log(`E2E против ${API}`);
  const health = await call('GET', '/health');
  ok(health.status === 200 && health.data.ok, 'healthcheck отвечает');

  console.log('\n1. Вход и справочники');
  const buyerTg = 700_000 + RUN;
  const buyer = await login(buyerTg, 'Покупатель');
  ok(!!buyer, 'покупатель вошёл по подписанной initData');
  const bad = await call('POST', '/v1/auth/telegram', undefined, undefined, { authorization: 'tma auth_date=1&hash=00&user=%7B%22id%22%3A1%7D' });
  ok(bad.status === 401, 'поддельная initData отклонена');
  const unauth = await call('GET', '/v1/me');
  ok(unauth.status === 401, 'без токена доступа нет');
  const cats = (await call('GET', '/v1/categories')).data as any[];
  const bc = cats.flatMap((c) => c.children).find((c: any) => c.slug === 'print.business-cards');
  ok(!!bc, 'каталог отдаёт категорию «Визитки»');

  console.log('\n2. Поставщики');
  const suppliers: { token: string; companyId: number; tg: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const tg = 800_000 + RUN * 10 + i;
    const token = await login(tg, `Поставщик ${i + 1}`);
    const r = await call('POST', '/v1/companies', token, {
      name: `Типография ${i + 1}-${RUN}`,
      type: 'llc',
      inn: String(300_000_000 + RUN * 10 + i),
      regionCode: 'tashkent',
      isSupplier: true,
      isBuyer: false,
      categoryIds: [bc.id],
      areas: [{ regionCode: 'tashkent' }],
    });
    if (r.status !== 201) throw new Error(`Компания не создана: ${JSON.stringify(r.data)}`);
    suppliers.push({ token, companyId: r.data.id, tg });
  }
  ok(suppliers.length === 7, '7 поставщиков создали компании');
  const dupInn = await call('POST', '/v1/companies', suppliers[0].token, { name: 'Дубль', type: 'llc', inn: String(300_000_000 + RUN * 10), regionCode: 'tashkent', isSupplier: true });
  ok(dupInn.status === 409, 'повторный ИНН отклонён');

  console.log('\n3. Оплата тарифов: Payme, Click, перевод');
  const admin = (await call('POST', '/v1/auth/dev', undefined, { telegramId: 900_001, firstName: 'Admin', admin: true })).data.token;
  ok(!!admin, 'админ вошёл');
  const forbiddenAdmin = await call('GET', '/admin/stats', buyer);
  ok(forbiddenAdmin.status === 403, 'обычный пользователь не видит админку');

  const invoices: any[] = [];
  for (let i = 0; i < 5; i++) {
    const inv = await call('POST', '/admin/invoices', admin, { companyId: suppliers[i].companyId, planCode: 'start', months: 1 });
    invoices.push(inv.data);
  }
  ok(invoices.every((x) => x.amountUzs === 149000 && x.payUrl), 'выставлено 5 счетов по 149 000 сум');
  const page = await fetch(invoices[0].payUrl.replace(/^https?:\/\/[^/]+/, API));
  ok(page.status === 200 && (await page.text()).includes('149'), 'страница счёта открывается');

  // Payme: CheckPerform → Create → Perform
  const paymeAuth = { authorization: `Basic ${Buffer.from(`Paycom:${PAYME_KEY}`).toString('base64')}` };
  const pm = (method: string, params: object) => call('POST', '/webhooks/payme', undefined, { method, params, id: 1 }, paymeAuth);
  const acc = { invoice_id: String(invoices[0].id) };
  const wrongAuth = await call('POST', '/webhooks/payme', undefined, { method: 'CheckPerformTransaction', params: {}, id: 1 }, { authorization: 'Basic eDp5' });
  ok(wrongAuth.data.error?.code === -32504, 'Payme: чужая авторизация → -32504');
  ok((await pm('CheckPerformTransaction', { amount: 1, account: acc })).data.error?.code === -31001, 'Payme: неверная сумма → -31001');
  ok((await pm('CheckPerformTransaction', { amount: 14_900_000, account: acc })).data.result?.allow === true, 'Payme: CheckPerformTransaction разрешает оплату');
  const txId = `pm-${RUN}`;
  const created = await pm('CreateTransaction', { id: txId, time: Date.now(), amount: 14_900_000, account: acc });
  ok(created.data.result?.state === 1, 'Payme: транзакция создана');
  const again = await pm('CreateTransaction', { id: txId, time: Date.now(), amount: 14_900_000, account: acc });
  ok(again.data.result?.transaction === created.data.result?.transaction, 'Payme: повторный CreateTransaction идемпотентен');
  const performed = await pm('PerformTransaction', { id: txId });
  ok(performed.data.result?.state === 2, 'Payme: транзакция проведена');
  ok((await pm('CancelTransaction', { id: txId, reason: 5 })).data.error?.code === -31007, 'Payme: отмена после активации тарифа запрещена');
  ok((await pm('CheckTransaction', { id: txId })).data.result?.state === 2, 'Payme: CheckTransaction показывает проведённую');

  // Click: Prepare → Complete
  const clickBase = {
    click_trans_id: `${RUN}01`,
    service_id: process.env.CLICK_SERVICE_ID ?? '1',
    click_paydoc_id: '1',
    merchant_trans_id: String(invoices[1].id),
    amount: '149000.00',
    error: '0',
    sign_time: '2026-10-01 10:00:00',
  };
  const sign = (p: Record<string, string>) =>
    createHash('md5')
      .update(`${p.click_trans_id}${p.service_id}${CLICK_SECRET}${p.merchant_trans_id}${p.action === '1' ? p.merchant_prepare_id : ''}${p.amount}${p.action}${p.sign_time}`)
      .digest('hex');
  const prep: Record<string, string> = { ...clickBase, action: '0' };
  const badSign = await call('POST', '/webhooks/click/prepare', undefined, { ...prep, sign_string: 'bad' });
  ok(badSign.data.error === -1, 'Click: неверная подпись → -1');
  const prepared = await call('POST', '/webhooks/click/prepare', undefined, { ...prep, sign_string: sign(prep) });
  ok(prepared.data.error === 0 && prepared.data.merchant_prepare_id, 'Click: Prepare прошёл');
  const comp: Record<string, string> = { ...clickBase, action: '1', merchant_prepare_id: String(prepared.data.merchant_prepare_id) };
  const completed = await call('POST', '/webhooks/click/complete', undefined, { ...comp, sign_string: sign(comp) });
  ok(completed.data.error === 0, 'Click: Complete прошёл');

  for (let i = 2; i < 5; i++) await call('POST', `/admin/invoices/${invoices[i].id}/paid`, admin, { via: 'bank_transfer' });
  const plan0 = await call('GET', `/v1/billing/plan?companyId=${suppliers[0].companyId}`, suppliers[0].token);
  const plan1 = await call('GET', `/v1/billing/plan?companyId=${suppliers[1].companyId}`, suppliers[1].token);
  const plan6 = await call('GET', `/v1/billing/plan?companyId=${suppliers[6].companyId}`, suppliers[6].token);
  ok(plan0.data.planCode === 'start' && plan1.data.planCode === 'start', 'тарифы после Payme и Click активны');
  ok(plan6.data.planCode === 'free' && plan6.data.notifyDelayMin === 15, 'неоплаченный поставщик на бесплатном тарифе с задержкой 15 минут');
  ok(!('priceUzs' in plan0.data), 'Mini App не получает цен тарифов');

  console.log('\n4. Заявка покупателя');
  const draft = await call('POST', '/v1/requests/parse', buyer, { text: 'Нужны визитки 1000 шт 90х50, двусторонние, ламинация, Чиланзар' });
  ok(draft.status === 201 && draft.data.status === 'draft', 'черновик создан');
  const reqId = draft.data.id;
  const parsed = await waitFor(
    () => call('GET', `/v1/requests/${reqId}`, buyer),
    (r) => r.data.confidence !== null && r.data.confidence !== undefined,
  );
  ok(parsed.data.category?.slug === 'print.business-cards', 'воркер разобрал категорию «Визитки»');
  ok(parsed.data.fields.quantity === 1000 && parsed.data.regionCode === 'tashkent.chilonzor', 'тираж и район извлечены');
  const stranger = await call('GET', `/v1/requests/${reqId}`, suppliers[0].token);
  ok(stranger.status === 404, 'до рассылки поставщик заявку не видит');

  const sub = await call('POST', '/v1/requests', buyer, { requestId: reqId });
  ok(sub.status === 201 && sub.data.status === 'submitted', 'заявка отправлена');

  console.log('\n5. Рассылка волнами');
  const feeds = async () =>
    Promise.all(suppliers.map(async (s) => ((await call('GET', `/v1/feed?companyId=${s.companyId}`, s.token)).data as any[]).some((x) => x.id === reqId)));
  const w1 = await waitFor(feeds, (f) => f.filter(Boolean).length >= 5);
  ok(w1.filter(Boolean).length === 5, `волна 1: заявку видят 5 поставщиков (${w1.map((x) => (x ? 1 : 0)).join('')})`);
  ok(w1.slice(0, 5).every(Boolean), 'в первую волну попали оплатившие поставщики');
  const w2 = await waitFor(
    () => call('GET', `/v1/requests/${reqId}`, buyer),
    (r) => r.data.wave === 2,
    20_000,
  );
  ok(w2.data.wave === 2, 'без откликов через WAVE1_WAIT_MIN ушла волна 2');
  const f6 = (await call('GET', `/v1/feed?companyId=${suppliers[6].companyId}`, suppliers[6].token)).data as any[];
  ok(!f6.some((x) => x.id === reqId), 'бесплатный поставщик увидит заявку только через 15 минут');

  console.log('\n6. Отклики');
  const o1 = await call('POST', `/v1/requests/${reqId}/offers`, suppliers[0].token, { priceUzs: 450_000, leadTimeDays: 2, comment: 'Меловка 300 г/м²' });
  const o2 = await call('POST', `/v1/requests/${reqId}/offers`, suppliers[1].token, { priceUzs: 420_000, leadTimeDays: 3 });
  ok(o1.status === 201 && o2.status === 201, 'два поставщика откликнулись');
  const upd = await call('POST', `/v1/requests/${reqId}/offers`, suppliers[0].token, { priceUzs: 400_000, leadTimeDays: 2 });
  ok(upd.data.priceUzs === 400_000, 'повторный отклик обновляет цену');
  const noAccess = await call('POST', `/v1/requests/${reqId}/offers`, suppliers[6].token, { priceUzs: 1, leadTimeDays: 1 });
  ok(noAccess.status === 403, 'без рассылки откликнуться нельзя');
  const view = await call('GET', `/v1/requests/${reqId}`, buyer);
  ok(view.data.offers.length === 2 && view.data.offers[0].priceUzs === 400_000, 'покупатель видит отклики, самый дешёвый первым');
  ok(view.data.status === 'has_offers', 'статус заявки has_offers');
  const supView = await call('GET', `/v1/requests/${reqId}`, suppliers[2].token);
  ok(supView.data.role === 'supplier' && supView.data.offers === undefined && supView.data.rawText === undefined, 'поставщик не видит чужие отклики и исходный текст');

  console.log('\n7. Выбор, чат, сделка, отзыв');
  const chosen = await call('POST', `/v1/offers/${o1.data.id}/choose`, buyer);
  ok(chosen.status === 200 && chosen.data.status === 'active', 'исполнитель выбран, сделка создана');
  const dealId = chosen.data.id;
  const supDeal = await call('GET', `/v1/deals/${dealId}`, suppliers[0].token);
  ok(supDeal.data.side === 'supplier' && supDeal.data.buyer?.name === 'Покупатель', 'поставщик видит контакт покупателя');
  const otherDeal = await call('GET', `/v1/deals/${dealId}`, suppliers[1].token);
  ok(otherDeal.status === 404, 'проигравший поставщик сделку не видит');

  const chats = (await call('GET', '/v1/chats', buyer)).data as any[];
  const chat = chats.find((c) => c.requestId === reqId && c.supplierName.startsWith('Типография 1-'));
  ok(!!chat, 'чат с поставщиком создан');
  await call('POST', `/v1/chats/${chat.id}/messages`, suppliers[0].token, { text: 'Макет пришлёте в PDF?' });
  const msgs = await call('GET', `/v1/chats/${chat.id}/messages`, buyer);
  ok(msgs.data.messages.at(-1)?.text === 'Макет пришлёте в PDF?', 'сообщение дошло до покупателя');
  const intruder = await call('GET', `/v1/chats/${chat.id}/messages`, suppliers[3].token);
  ok(intruder.status === 404, 'чужой чат недоступен');

  const early = await call('POST', `/v1/deals/${dealId}/review`, buyer, { stars: 5 });
  ok(early.status === 400, 'отзыв до закрытия сделки запрещён');
  await call('POST', `/v1/deals/${dealId}/confirm`, buyer);
  const done = await call('POST', `/v1/deals/${dealId}/confirm`, suppliers[0].token);
  ok(done.data.status === 'completed', 'обе стороны подтвердили, сделка закрыта');
  const rev = await call('POST', `/v1/deals/${dealId}/review`, buyer, { stars: 5, text: 'Быстро и качественно' });
  ok(rev.status === 201, 'покупатель оставил отзыв');
  const twice = await call('POST', `/v1/deals/${dealId}/review`, buyer, { stars: 1 });
  ok(twice.status === 400, 'второй отзыв с той же стороны запрещён');
  const profile = await call('GET', `/v1/companies/${suppliers[0].companyId}`, buyer);
  ok(profile.data.ratingAvg === 5 && profile.data.dealsClosed === 1, 'рейтинг и счётчик сделок пересчитаны');

  console.log('\n8. Админка и метрики');
  const stats = await call('GET', '/admin/stats', admin);
  ok(stats.status === 200 && stats.data.counts.suppliers >= 7, 'метрики доступны');
  const adminReq = await call('GET', `/admin/requests/${reqId}`, admin);
  ok(adminReq.data.deliveries.length === 7 && adminReq.data.deliveries.filter((d: any) => d.wave === 1).length === 5, 'админ видит все 7 рассылок: 5 в первой волне и 2 во второй');
  const verify = await call('POST', `/admin/companies/${suppliers[0].companyId}/verify-inn`, admin);
  const afterVerify = await call('GET', `/v1/companies/${suppliers[0].companyId}`, buyer);
  ok(verify.status === 200 && afterVerify.data.trustLevel === 1, 'проверка ИНН даёт уровень доверия L1');

  console.log(failures ? `\n✗ Провалено проверок: ${failures}` : '\n✓ Все проверки прошли');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
