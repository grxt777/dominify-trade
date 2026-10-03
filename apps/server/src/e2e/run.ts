/* Сквозной прогон против запущенных api и воркера (NOTIFY_DRIVER=log, LLM_PROVIDER=rules).
 * Покупатель → заявка → разбор → отправка → волна 1 → оплата тарифов (Payme, Click, счёт) → отклики → выбор →
 * чат → подтверждение → отзыв → метрики. Запуск: node dist/e2e/run.js */
import { signInitData } from '../auth/init-data';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

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

/** Dev-вход: в Telegram номер подтверждает бот, здесь — сразу. Вызывается и для уже вошедших, чтобы добавить телефон. */
async function devLogin(tgId: number, name: string, phone?: string): Promise<string> {
  const r = await call('POST', '/v1/auth/dev', undefined, { telegramId: tgId, firstName: name, phone });
  if (r.status !== 200) throw new Error(`Dev-вход не удался: ${JSON.stringify(r.data)}`);
  return r.data.token;
}

const phoneOf = (prefix: string, n: number) => `+998${prefix}${String(n).padStart(7, '0').slice(-7)}`;

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
  await devLogin(buyerTg, 'Покупатель', phoneOf('90', RUN));
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
    await devLogin(tg, `Поставщик ${i + 1}`, phoneOf('91', RUN * 10 + i));
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
  const buyerCompany = (n: number) => ({ name: `Закупки ${n}-${RUN}`, type: 'llc', inn: String(310_000_000 + RUN * 10 + n), regionCode: 'tashkent', isSupplier: false, isBuyer: true });
  const extra1 = await call('POST', '/v1/companies', suppliers[6].token, buyerCompany(1));
  const extra2 = await call('POST', '/v1/companies', suppliers[6].token, buyerCompany(2));
  const extra3 = await call('POST', '/v1/companies', suppliers[6].token, buyerCompany(3));
  ok(extra1.status === 201 && extra2.status === 201 && extra3.status === 409 && extra3.data.error?.code === 'company_limit', 'больше 3 компаний на одного человека создать нельзя');

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

  console.log('\n4. Файлы и заявка покупателя');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const pre = await call('POST', '/v1/files', buyer, { fileName: 'maket.png', mime: 'image/png', size: png.length });
  const put = await fetch(pre.data.uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: png });
  const doneUp = await call('POST', `/v1/files/${pre.data.id}/complete`, buyer);
  ok(put.status === 200 && doneUp.data.status === 'ready', 'файл загружен через api по подписанной ссылке');
  const dl = await call('GET', `/v1/files/${pre.data.id}/url`, buyer);
  const back = Buffer.from(await (await fetch(dl.data.url)).arrayBuffer());
  ok(back.equals(png), 'файл скачивается обратно без изменений');
  const foreign = await call('GET', `/v1/files/${pre.data.id}/url`, suppliers[5].token);
  ok(foreign.status === 404, 'чужой файл недоступен');
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

  console.log('\n9. Двойная оплата Payme + Click и места в команде');
  const proInv = (await call('POST', '/admin/invoices', admin, { companyId: suppliers[2].companyId, planCode: 'pro', months: 1 })).data;
  const proAcc = { invoice_id: String(proInv.id) };
  const pmTx = `pm2-${RUN}`;
  const pmCreated = await pm('CreateTransaction', { id: pmTx, time: Date.now(), amount: 34_900_000, account: proAcc });
  ok(pmCreated.data.result?.state === 1, 'Payme: транзакция по счёту «Про» создана');
  const pmSecond = await pm('CreateTransaction', { id: `${pmTx}-b`, time: Date.now(), amount: 34_900_000, account: proAcc });
  ok(pmSecond.data.error?.code === -31051, 'Payme: вторая транзакция по тому же счёту отклонена');
  const clickBusy: Record<string, string> = { ...clickBase, click_trans_id: `${RUN}02`, merchant_trans_id: String(proInv.id), amount: '349000.00', action: '0' };
  const busy = await call('POST', '/webhooks/click/prepare', undefined, { ...clickBusy, sign_string: sign(clickBusy) });
  ok(busy.data.error === -4, 'Click: пока идёт оплата через Payme, второй платёж не принимается');
  const manualBusy = await call('POST', `/admin/invoices/${proInv.id}/paid`, admin, { via: 'bank_transfer' });
  const cancelBusy = await call('POST', `/admin/invoices/${proInv.id}/cancel`, admin);
  ok(manualBusy.status === 409 && cancelBusy.status === 409, 'админ не может отметить оплату или отменить счёт во время оплаты');
  const pmPerformed = await pm('PerformTransaction', { id: pmTx });
  ok(pmPerformed.data.result?.state === 2, 'Payme: оплата «Про» проведена');
  const clickAfter = await call('POST', '/webhooks/click/prepare', undefined, { ...clickBusy, click_trans_id: `${RUN}03`, sign_string: sign({ ...clickBusy, click_trans_id: `${RUN}03` }) });
  ok(clickAfter.data.error === -4, 'Click: оплаченный счёт повторно не оплачивается');
  const plan2 = await call('GET', `/v1/billing/plan?companyId=${suppliers[2].companyId}`, suppliers[2].token);
  ok(plan2.data.planCode === 'pro' && plan2.data.seats === 2, 'тариф «Про» активен, в команде 2 места');

  const freeInvite = await call('POST', `/v1/companies/${suppliers[6].companyId}/invites`, suppliers[6].token);
  ok(freeInvite.status === 402 && freeInvite.data.error?.code === 'seat_limit', 'на бесплатном тарифе пригласить сотрудника нельзя');
  const invite = await call('POST', `/v1/companies/${suppliers[2].companyId}/invites`, suppliers[2].token);
  ok(invite.status === 201 && invite.data.token && String(invite.data.url).includes(`join_${invite.data.token}`), 'владелец создал приглашение со ссылкой в Mini App');
  const notOwner = await call('POST', `/v1/companies/${suppliers[2].companyId}/invites`, suppliers[3].token);
  ok(notOwner.status === 403 || notOwner.status === 404, 'чужой человек не создаёт приглашения');
  const managerTg = 960_000 + RUN;
  const manager = await login(managerTg, 'Менеджер');
  const joined = await call('POST', '/v1/companies/join', manager, { token: invite.data.token });
  ok(joined.status === 200 || joined.status === 201, 'сотрудник вступил по приглашению');
  const reuse = await call('POST', '/v1/companies/join', await login(961_000 + RUN, 'Второй'), { token: invite.data.token });
  ok(reuse.status >= 400, 'приглашение одноразовое');
  const team = await call('GET', `/v1/companies/${suppliers[2].companyId}/members`, suppliers[2].token);
  ok(team.data.seats === 2 && team.data.members.length === 2, 'в команде 2 человека из 2 мест');
  const third = await call('POST', `/v1/companies/${suppliers[2].companyId}/invites`, suppliers[2].token);
  ok(third.status === 402, 'сверх мест тарифа приглашать нельзя');

  console.log('\n10. Вторая заявка: скрытие контактов, файлы, отмена сделки, спор');
  const draft2 = await call('POST', '/v1/requests/parse', buyer, { text: 'Нужны визитки 500 шт 90х50, Чиланзар' });
  const req2 = draft2.data.id;
  await waitFor(() => call('GET', `/v1/requests/${req2}`, buyer), (r) => r.data.confidence !== null && r.data.confidence !== undefined);
  await call('POST', '/v1/requests', buyer, { requestId: req2 });
  const sees = async (i: number) => ((await call('GET', `/v1/feed?companyId=${suppliers[i].companyId}`, suppliers[i].token)).data as any[]).some((x) => x.id === req2);
  const delivered = await waitFor(() => Promise.all([0, 1, 2].map(sees)), (v) => v.every(Boolean));
  ok(delivered.every(Boolean), 'вторая заявка дошла до поставщиков');

  const noPhone = await call('POST', `/v1/requests/${req2}/offers`, manager, { priceUzs: 300_000, leadTimeDays: 2 });
  ok(noPhone.status === 403 && noPhone.data.error?.code === 'phone_required', 'без подтверждённого телефона откликнуться нельзя');

  const leakOffer = await call('POST', `/v1/requests/${req2}/offers`, suppliers[0].token, { priceUzs: 250_000, leadTimeDays: 1, comment: 'Звоните +998 90 123 45 67 или @print_master' });
  ok(leakOffer.status === 201 && !leakOffer.data.comment?.includes('123 45 67') && !leakOffer.data.comment?.includes('@print_master'), 'контакты в комментарии к отклику скрыты');
  const stolen = await call('POST', `/v1/requests/${req2}/offers`, suppliers[1].token, { priceUzs: 260_000, leadTimeDays: 2, fileIds: [pre.data.id] });
  ok(stolen.status === 403, 'к отклику нельзя приложить чужой файл');
  const o2b = await call('POST', `/v1/requests/${req2}/offers`, suppliers[1].token, { priceUzs: 270_000, leadTimeDays: 2 });
  ok(o2b.status === 201, 'второй поставщик откликнулся');

  const chats2 = (await call('GET', '/v1/chats', buyer)).data as any[];
  const chatA = chats2.find((c) => c.requestId === req2 && c.supplierName.startsWith('Типография 1-'));
  const chatB = chats2.find((c) => c.requestId === req2 && c.supplierName.startsWith('Типография 2-'));
  const leakMsg = await call('POST', `/v1/chats/${chatB.id}/messages`, suppliers[1].token, { text: 'Пишите в телеграм t.me/print2 или на 93 123-45-67' });
  ok(leakMsg.data.masked === true && !leakMsg.data.text.includes('t.me') && !leakMsg.data.text.includes('45-67'), 'контакты в чате до выбора исполнителя скрыты');
  const beforeDeal = await call('GET', `/v1/chats/${chatB.id}/messages`, buyer);
  ok(beforeDeal.data.contactsOpen === false, 'до выбора чат показывает, что контакты закрыты');
  const foreignFile = await call('POST', `/v1/chats/${chatA.id}/messages`, suppliers[0].token, { fileId: pre.data.id });
  ok(foreignFile.status === 403, 'в чат нельзя отправить чужой файл');

  const html = Buffer.from('<html><script>alert(document.cookie)</script></html>');
  const fake = await call('POST', '/v1/files', buyer, { fileName: 'maket.png', mime: 'image/png', size: html.length });
  const fakePut = await fetch(fake.data.uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: html });
  const fakeDone = await call('POST', `/v1/files/${fake.data.id}/complete`, buyer);
  ok(fakePut.status === 415 && fakeDone.status === 400, 'HTML под видом PNG не принимается');

  const dealA = (await call('POST', `/v1/offers/${leakOffer.data.id}/choose`, buyer)).data;
  ok(dealA.status === 'active', 'выбран первый исполнитель');
  const openA = await call('GET', `/v1/chats/${chatA.id}/messages`, buyer);
  ok(openA.data.contactsOpen === true, 'после выбора контакты в чате открыты');
  await call('POST', `/v1/deals/${dealA.id}/confirm`, suppliers[0].token);
  const buyerCancel = await call('POST', `/v1/deals/${dealA.id}/cancel`, buyer, { reason: 'Передумали заказывать' });
  ok(buyerCancel.status === 409 && buyerCancel.data.error?.code === 'other_confirmed', 'покупатель не отменяет сделку, которую исполнитель уже отметил выполненной');
  const supCancel = await call('POST', `/v1/deals/${dealA.id}/cancel`, suppliers[0].token, { reason: 'Нет нужной бумаги' });
  ok(supCancel.status === 200 && supCancel.data.status === 'cancelled' && supCancel.data.closedBy === 'supplier', 'исполнитель отменил сделку с причиной');
  const reopened = await call('GET', `/v1/requests/${req2}`, buyer);
  ok(reopened.data.status === 'has_offers' && reopened.data.offers.some((o: any) => o.id === o2b.data.id && o.status === 'sent'), 'заявка снова открыта, отклик второго поставщика вернулся');
  const reOffer = await call('POST', `/v1/requests/${req2}/offers`, suppliers[0].token, { priceUzs: 240_000, leadTimeDays: 1 });
  ok(reOffer.status === 409 && reOffer.data.error?.code === 'offer_closed', 'отменивший исполнитель повторно не откликается');

  const dealB = (await call('POST', `/v1/offers/${o2b.data.id}/choose`, buyer)).data;
  ok(dealB.status === 'active', 'выбран второй исполнитель');
  const shortReason = await call('POST', `/v1/deals/${dealB.id}/dispute`, buyer, { reason: 'no' });
  ok(shortReason.status === 400, 'спор без причины не открывается');
  const disputed = await call('POST', `/v1/deals/${dealB.id}/dispute`, buyer, { reason: 'Тираж напечатан с браком' });
  ok(disputed.data.status === 'disputed', 'покупатель открыл спор');
  const disputes = (await call('GET', '/admin/deals?status=disputed', admin)).data as any[];
  ok(disputes.some((d) => d.id === dealB.id), 'спор виден в админке');
  const modItems = (await call('GET', '/admin/moderation', admin)).data as any[];
  ok(modItems.some((m) => m.kind === 'deal_dispute' && m.refId === dealB.id), 'спор попал в очередь модерации');
  const resolved = await call('POST', `/admin/deals/${dealB.id}/resolve`, admin, { outcome: 'complete', note: 'Брак исправлен' });
  ok(resolved.status === 200 && resolved.data.status === 'completed', 'модератор закрыл спор, сделка завершена');
  const afterResolve = await call('GET', `/v1/companies/${suppliers[1].companyId}`, buyer);
  ok(afterResolve.data.dealsClosed === 1, 'завершённая модератором сделка засчитана исполнителю');

  console.log('\n11. Чёрный список и удаление аккаунта');
  const badTg = 970_000 + RUN;
  const badUser = await devLogin(badTg, 'Мошенник');
  ok((await call('GET', '/v1/me', badUser)).status === 200, 'до блокировки доступ есть');
  await call('POST', '/admin/blacklist', admin, { kind: 'telegram_id', value: String(badTg), reason: 'e2e' });
  const blockedMe = await call('GET', '/v1/me', badUser);
  ok(blockedMe.status === 403 && blockedMe.data.error?.code === 'blocked', 'после блокировки выданный токен перестаёт работать');
  const leaver = await devLogin(980_000 + RUN, 'Уходящий', phoneOf('94', RUN));
  const del = await call('DELETE', '/v1/me', leaver);
  ok(del.status === 204, 'пользователь удалил аккаунт');
  ok((await call('GET', '/v1/me', leaver)).status === 401, 'токен удалённого аккаунта недействителен');

  console.log('\n12. Повторный seed не стирает правки админа');
  const editable = cats.flatMap((c) => c.children).find((c: any) => c.slug !== 'print.business-cards' && Array.isArray(c.fields));
  const marker = { key: 'e2e_marker', type: 'text', label: { ru: 'e2e', uz: 'e2e', uzc: 'e2e' } };
  await call('PATCH', `/admin/categories/${editable.id}`, admin, { fields: [...editable.fields, marker] });
  execFileSync(process.execPath, [resolve(__dirname, '../../../../packages/db/dist/seed.js')], { env: process.env, stdio: 'ignore' });
  await call('PATCH', `/admin/categories/${editable.id}`, admin, {});
  const afterSeed = ((await call('GET', '/v1/categories')).data as any[]).flatMap((c) => c.children).find((c: any) => c.id === editable.id);
  ok(afterSeed?.fields?.some((f: any) => f.key === 'e2e_marker'), 'поля категории, изменённые в админке, пережили seed');

  console.log('\n13. Витрина: демо-исполнители и заказ услуги');
  const demoJs = resolve(__dirname, '../../../../packages/db/dist/demo.js');
  execFileSync(process.execPath, [demoJs], { env: process.env, stdio: 'ignore' });
  execFileSync(process.execPath, [demoJs], { env: process.env, stdio: 'ignore' });
  const gigBuyer = await devLogin(990_000 + RUN, 'Заказчик', phoneOf('95', RUN));
  await call('POST', '/v1/me/consent', gigBuyer);
  const gigList = (await call('GET', '/v1/gigs', gigBuyer)).data as any[];
  ok(gigList.length === 6 && gigList.every((g) => g.fromPriceUzs > 0 && g.company?.name), 'повторный demo-seed не плодит дубли: 6 услуг с ценой «от» и исполнителем');
  const adsGigs = (await call('GET', '/v1/gigs?category=ads', gigBuyer)).data as any[];
  ok(adsGigs.length > 0 && adsGigs.length < gigList.length, 'фильтр по вертикали включает подкатегории');
  const byPrice = (await call('GET', '/v1/gigs?sort=price', gigBuyer)).data as any[];
  ok(byPrice.every((g, i) => i === 0 || byPrice[i - 1].fromPriceUzs <= g.fromPriceUzs), 'сортировка по цене');
  const bannerCard = gigList.find((g) => g.cover === '/demo/banner.svg');
  const gig = (await call('GET', `/v1/gigs/${bannerCard.id}`, gigBuyer)).data;
  ok(gig.packages?.length === 3 && gig.reviews.length > 0 && !!gig.company.owner, 'страница услуги: три пакета, отзывы из сделок, владелец');

  const seller = await devLogin(9_900_000_001, 'Jasur');
  const ownOrder = await call('POST', '/v1/requests/parse', seller, { gigId: gig.id });
  ok(ownOrder.status === 400 && ownOrder.data.error?.code === 'own_gig', 'свою услугу заказать нельзя');

  const order = await call('POST', '/v1/requests/parse', gigBuyer, { text: 'Баннер 3x6 для магазина, текст СКИДКИ', gigId: gig.id, packageCode: 'premium' });
  ok(order.status === 201 && order.data.order?.package?.code === 'premium', 'заказ услуги создаёт заявку с выбранным пакетом');
  const orderParsed = await waitFor(() => call('GET', `/v1/requests/${order.data.id}`, gigBuyer), (r) => r.data.confidence != null);
  ok(orderParsed.data.category?.slug === 'ads.banners' && orderParsed.data.budgetUzs === gig.packages.find((p: any) => p.code === 'premium').priceUzs, 'категория и бюджет взяты из услуги, а не угаданы');
  const orderSub = await call('POST', '/v1/requests', gigBuyer, { requestId: order.data.id });
  ok(orderSub.status === 201 && orderSub.data.status === 'submitted', 'заказ отправлен без модерации');
  const sellerSees = await waitFor(
    async () => ((await call('GET', `/v1/feed?companyId=${gig.company.id}`, seller)).data as any[]).some((x) => x.id === order.data.id),
    Boolean,
  );
  ok(sellerSees, 'выбранный исполнитель получил заказ в первой волне сразу');
  const sellerView = await call('GET', `/v1/requests/${order.data.id}`, seller);
  ok(sellerView.data.order?.package?.name === 'Premium', 'исполнитель видит, какой пакет заказан');
  const sellerOffer = await call('POST', `/v1/requests/${order.data.id}/offers`, seller, { priceUzs: 750_000, leadTimeDays: 3 });
  ok(sellerOffer.status === 201, 'демо-исполнитель может откликнуться');

  execFileSync(process.execPath, [demoJs, '--remove'], { env: process.env, stdio: 'ignore' });
  ok(((await call('GET', '/v1/gigs', gigBuyer)).data as any[]).length === 0, 'demo-seed --remove убирает витрину');
  const orphan = await call('GET', `/v1/requests/${order.data.id}`, gigBuyer);
  ok(orphan.status === 200 && orphan.data.order === null, 'заявка покупателя пережила удаление демо, блок заказа исчез');

  console.log('\n14. Продавец выставляет свою услугу');
  const owner = suppliers[0];
  const preG = await call('POST', '/v1/files', owner.token, { fileName: 'work.png', mime: 'image/png', size: png.length });
  await fetch(preG.data.uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: png });
  await call('POST', `/v1/files/${preG.data.id}/complete`, owner.token);
  const gigDto = {
    companyId: owner.companyId,
    categoryId: bc.id,
    title: 'Напечатаю 1000 визиток за сутки с доставкой',
    description: 'Печатаем на мелованной бумаге 300 г, ламинация по желанию. Макет проверим бесплатно.',
    gallery: [`f:${preG.data.id}`],
    packages: [
      { code: 'basic', name: 'Базовый', priceUzs: 150_000, days: 1, revisions: 1, summary: '500 шт', features: ['Односторонние'] },
      { code: 'standard', name: 'Стандарт', priceUzs: 250_000, days: 2, revisions: 2, summary: '1000 шт', features: ['Двусторонние'] },
    ],
    tags: ['визитки', 'печать'],
  };
  const badOrder = await call('POST', '/v1/gigs', owner.token, { ...gigDto, packages: gigDto.packages.map((p) => ({ ...p, priceUzs: 400_000 - p.priceUzs })) });
  ok(badOrder.status === 400, 'старший пакет дешевле младшего — отказ');
  const withPhone = await call('POST', '/v1/gigs', owner.token, { ...gigDto, description: `${gigDto.description} Звоните +998 90 123 45 67` });
  ok(withPhone.status === 400 && withPhone.data.error?.code === 'contacts_in_gig', 'телефон в описании услуги не пропускается');
  const banners = cats.flatMap((c) => c.children).find((c: any) => c.slug === 'ads.banners');
  const otherCat = await call('POST', '/v1/gigs', owner.token, { ...gigDto, categoryId: banners.id });
  ok(otherCat.status === 400 && otherCat.data.error?.code === 'category_not_in_profile', 'категория не из профиля компании — отказ');
  const stolenImg = await call('POST', '/v1/gigs', owner.token, { ...gigDto, gallery: [`f:${pre.data.id}`] });
  ok(stolenImg.status === 403, 'чужую картинку в галерею не поставить');
  const gigCreated = await call('POST', '/v1/gigs', owner.token, gigDto);
  ok(gigCreated.status === 201 && gigCreated.data.id > 0, 'услуга создана');
  const gigId = gigCreated.data.id;
  const gigIntruder = await call('PATCH', `/v1/gigs/${gigId}`, suppliers[1].token, { ...gigDto, companyId: suppliers[1].companyId });
  ok(gigIntruder.status === 403, 'чужую услугу изменить нельзя');
  const inMarket = ((await call('GET', `/v1/gigs?category=${bc.slug}`, gigBuyer)).data as any[]).find((g) => g.id === gigId);
  ok(inMarket?.fromPriceUzs === 150_000, 'услуга появилась в каталоге с ценой «от»');
  const imgRes = await fetch(`${API}/v1/gigs/image/${preG.data.id}`);
  ok(imgRes.status === 200 && Buffer.from(await imgRes.arrayBuffer()).equals(png), 'картинка услуги доступна без входа');
  ok((await fetch(`${API}/v1/gigs/image/${pre.data.id}`)).status === 404, 'файл не из галереи по этому адресу не отдаётся');
  const gigUpd = await call('PATCH', `/v1/gigs/${gigId}`, owner.token, { ...gigDto, title: 'Напечатаю визитки за сутки и привезу в офис' });
  ok(gigUpd.status === 200 && gigUpd.data.title.includes('привезу'), 'услуга отредактирована');
  await call('POST', `/v1/gigs/${gigId}/active`, owner.token, { active: false });
  const hiddenInMarket = ((await call('GET', '/v1/gigs', gigBuyer)).data as any[]).some((g) => g.id === gigId);
  const mineList = (await call('GET', `/v1/gigs/mine?companyId=${owner.companyId}`, owner.token)).data as any[];
  ok(!hiddenInMarket && mineList.some((g) => g.id === gigId && !g.active), 'скрытая услуга пропала из каталога, но осталась у продавца');
  const delGig = await call('DELETE', `/v1/gigs/${gigId}`, owner.token);
  ok(delGig.status === 204 && !((await call('GET', `/v1/gigs/mine?companyId=${owner.companyId}`, owner.token)).data as any[]).length, 'услуга удалена');

  console.log('\n15. Удержание: избранное, вопросы, рефералы, безопасная сделка, напоминания');
  const g15 = (await call('POST', '/v1/gigs', owner.token, gigDto)).data;
  const friendTg = 991_000 + RUN;
  const friend = await devLogin(friendTg, 'Друг', phoneOf('96', RUN));
  await call('POST', '/v1/me/consent', friend);

  const refMe = (await call('GET', '/v1/me', gigBuyer)).data;
  ok(/^ref_[0-9a-z]+$/.test(refMe.referral?.code) && String(refMe.referral.link).includes(refMe.referral.code), 'у пользователя есть реферальный код и ссылка');
  ok(refMe.firstOrder?.percent === 10 && refMe.bonusUzs === 0, 'новичку обещана скидка 10% на первый заказ, бонусов пока нет');
  const selfRef = await call('POST', '/v1/me/referral', gigBuyer, { code: refMe.referral.code });
  ok(selfRef.data.applied === false, 'свой реферальный код не засчитывается');
  const applied = await call('POST', '/v1/me/referral', friend, { code: refMe.referral.code });
  const appliedAgain = await call('POST', '/v1/me/referral', friend, { code: (await call('GET', '/v1/me', buyer)).data.referral.code });
  ok(applied.data.applied === true && appliedAgain.data.applied === false, 'друг пришёл по ссылке; второй пригласивший уже не засчитывается');

  const favOn = await call('POST', `/v1/gigs/${g15.id}/favorite`, friend, { on: true });
  const favs = (await call('GET', '/v1/gigs/favorites', friend)).data as any[];
  const cardFav = ((await call('GET', `/v1/gigs?category=${bc.slug}`, friend)).data as any[]).find((g) => g.id === g15.id);
  ok(favOn.status === 200 && favs.some((g) => g.id === g15.id) && cardFav?.favorite === true, 'услуга добавлена в избранное, на карточке горит сердечко');
  await call('POST', `/v1/gigs/${g15.id}/favorite`, friend, { on: false });
  ok(!((await call('GET', '/v1/gigs/favorites', friend)).data as any[]).length, 'из избранного убирается');

  const seen = (await call('GET', `/v1/gigs/${g15.id}`, buyer)).data;
  const ownSeen = (await call('GET', `/v1/gigs/${g15.id}`, owner.token)).data;
  ok(seen.mine === false && ownSeen.mine === true, 'страница услуги знает, своя ли она');
  ok(((await call('GET', '/v1/gigs/recent', buyer)).data as any[])[0]?.id === g15.id, 'просмотренная услуга попала в «Вы смотрели»');
  ok(!((await call('GET', '/v1/gigs/recent', owner.token)).data as any[]).some((g) => g.id === g15.id), 'свои просмотры продавцу не засчитываются');
  const verifiedList = (await call('GET', '/v1/gigs?verified=1', friend)).data as any[];
  ok(verifiedList.length > 0 && verifiedList.every((g) => g.company.innVerified) && verifiedList.some((g) => g.id === g15.id), 'фильтр «Проверенные» показывает только компании с проверенным ИНН');

  const ask = await call('POST', `/v1/gigs/${g15.id}/ask`, buyer);
  const askAgain = await call('POST', `/v1/gigs/${g15.id}/ask`, buyer);
  ok(ask.status === 200 && ask.data.chatId === askAgain.data.chatId, 'вопрос по услуге открывает один чат на пару покупатель × услуга');
  const ownAsk = await call('POST', `/v1/gigs/${g15.id}/ask`, owner.token);
  ok(ownAsk.status === 403 && ownAsk.data.error?.code === 'self_chat', 'себе вопрос не задать');
  ok(!((await call('GET', '/v1/chats', owner.token)).data as any[]).some((c) => c.id === ask.data.chatId), 'пустой чат-вопрос продавцу не показывается');
  const q1 = await call('POST', `/v1/chats/${ask.data.chatId}/messages`, buyer, { text: 'Сделаете за 12 часов? Мой номер 90 555 44 33' });
  ok(q1.data.masked === true && !q1.data.text.includes('44 33'), 'контакты в вопросе до заказа скрыты');
  const sellerChat = ((await call('GET', '/v1/chats', owner.token)).data as any[]).find((c) => c.id === ask.data.chatId);
  ok(sellerChat?.requestId === null && sellerChat.title === g15.title && sellerChat.unread === 1, 'продавец видит вопрос с названием услуги');
  const askMsgs = (await call('GET', `/v1/chats/${ask.data.chatId}/messages`, owner.token)).data;
  ok(askMsgs.gigTitle === g15.title && askMsgs.contactsOpen === false, 'в чате-вопросе контакты закрыты всегда');

  const statsPub = (await call('GET', '/v1/gigs/stats', friend)).data;
  ok(statsPub.dealsCompleted >= 2 && statsPub.suppliers >= 1, 'живая статистика витрины отдаётся');

  /** Заказ услуги от покупателя → отклик продавца → выбор. Возвращает id сделки. */
  const orderDeal = async (who: string, priceUzs: number) => {
    const r = await call('POST', '/v1/requests/parse', who, { text: 'Визитки 500 шт 90х50, Чиланзар', gigId: g15.id, packageCode: 'basic' });
    await waitFor(() => call('GET', `/v1/requests/${r.data.id}`, who), (x) => x.data.confidence != null);
    const s = await call('POST', '/v1/requests', who, { requestId: r.data.id });
    await waitFor(async () => ((await call('GET', `/v1/feed?companyId=${owner.companyId}`, owner.token)).data as any[]).some((x) => x.id === r.data.id), Boolean);
    const o = await call('POST', `/v1/requests/${r.data.id}/offers`, owner.token, { priceUzs, leadTimeDays: 1 });
    const c = await call('POST', `/v1/offers/${o.data.id}/choose`, who);
    if (c.status !== 200) throw new Error(`Заказ услуги не дошёл до сделки: ${JSON.stringify({ r: r.data?.error, s: s.data?.error ?? s.data?.status, o: o.data?.error, c: c.data })}`);
    return c.data.id as number;
  };
  const dealInvoice = async (id: number) => ((await call('GET', '/admin/invoices', admin)).data as any[]).find((i) => i.kind === 'deal' && i.dealId === id && i.status !== 'cancelled');
  const pmDeal = async (inv: any, tx: string) => {
    const amount = inv.amountUzs * 100;
    const account = { invoice_id: String(inv.id) };
    const check = await pm('CheckPerformTransaction', { amount, account });
    await pm('CreateTransaction', { id: tx, time: Date.now(), amount, account });
    const perf = await pm('PerformTransaction', { id: tx });
    return check.data.result?.allow === true && perf.data.result?.state === 2;
  };

  const d1 = await orderDeal(friend, 200_000);
  const d1Buyer = (await call('GET', `/v1/deals/${d1}`, friend)).data;
  const d1Sup = (await call('GET', `/v1/deals/${d1}`, owner.token)).data;
  ok(d1Buyer.payment?.status === 'none' && d1Buyer.payment.quote?.firstOrder === true && d1Buyer.payment.quote.discountUzs === 20_000 && d1Buyer.payment.quote.payUzs === 180_000, 'первый заказ: скидка 10% видна до оплаты');
  ok(d1Sup.payment?.payoutUzs === 190_000 && d1Sup.payment.feePercent === 5, 'исполнитель видит сумму к выплате за вычетом 5% комиссии');
  ok(d1Buyer.supplier.innVerified === true && d1Buyer.request.gigId === g15.id, 'в сделке видно, что ИНН исполнителя проверен, и из какой она услуги');
  ok((await call('POST', `/v1/deals/${d1}/pay`, owner.token)).status === 403, 'исполнитель не оплачивает за покупателя');
  const pay1 = await call('POST', `/v1/deals/${d1}/pay`, friend);
  const pay1again = await call('POST', `/v1/deals/${d1}/pay`, friend);
  ok(pay1.status === 200 && pay1.data.amountUzs === 180_000 && pay1again.data.payUrl === pay1.data.payUrl, 'счёт на оплату создан, повторное нажатие не плодит счета');
  const payPage = await (await fetch(pay1.data.payUrl.replace(/^https?:\/\/[^/]+/, API))).text();
  ok(payPage.includes('180') && payPage.includes(`Типография 1-${RUN}`), 'страница оплаты заказа открывается с суммой и исполнителем');
  ok(((await call('GET', `/v1/deals/${d1}`, friend)).data.payment.status === 'awaiting'), 'сделка ждёт оплаты');
  const inv1 = await dealInvoice(d1);
  ok(await pmDeal(inv1, `pmd1-${RUN}`), 'Payme: заказ оплачен');
  const held = (await call('GET', `/v1/deals/${d1}`, friend)).data;
  ok(held.payment.status === 'held' && held.payment.paidUzs === 180_000 && held.canCancel === false, 'деньги удерживаются платформой, отменить в одностороннем порядке нельзя');
  const paidCancel = await call('POST', `/v1/deals/${d1}/cancel`, friend, { reason: 'Передумал после оплаты' });
  ok(paidCancel.status === 409 && paidCancel.data.error?.code === 'paid_use_dispute', 'после оплаты покупатель решает вопрос через спор');
  ok((await call('GET', '/v1/me', friend)).data.firstOrder === null, 'скидка на первый заказ использована');
  ok(((await call('GET', '/admin/escrow?status=held', admin)).data as any[]).some((x) => x.id === d1 && x.paidUzs === 180_000 && x.paidVia === 'payme'), 'админ видит удержанные деньги');

  await call('POST', `/v1/deals/${d1}/confirm`, owner.token);
  const d1done = await call('POST', `/v1/deals/${d1}/confirm`, friend);
  ok(d1done.data.status === 'completed' && d1done.data.payment.status === 'payout_due', 'покупатель принял работу — деньги к выплате исполнителю');
  const refAfter = (await call('GET', '/v1/me', gigBuyer)).data;
  ok(refAfter.bonusUzs === 50_000 && refAfter.referral.rewarded === 1 && refAfter.referral.invited === 1, 'пригласивший получил 50 000 бонусов после первой оплаченной сделки друга');
  const payout = await call('POST', `/admin/escrow/${d1}/payout`, admin);
  const payoutTwice = await call('POST', `/admin/escrow/${d1}/payout`, admin);
  ok(payout.status === 200 && payout.data.paymentStatus === 'paid_out' && payoutTwice.status === 400, 'админ отметил выплату; повторно не выплачивается');
  ok((await pm('CancelTransaction', { id: `pmd1-${RUN}`, reason: 5 })).data.error?.code === -31007, 'Payme: после выплаты исполнителю возврат через Payme невозможен');

  const d2 = await orderDeal(gigBuyer, 100_000);
  const q2 = (await call('GET', `/v1/deals/${d2}`, gigBuyer)).data.payment.quote;
  ok(q2.discountUzs === 10_000 && q2.bonusUzs === 45_000 && q2.payUzs === 45_000, 'бонусы покрывают не больше половины заказа');
  await call('POST', `/v1/deals/${d2}/pay`, gigBuyer);
  ok((await call('GET', '/v1/me', gigBuyer)).data.bonusUzs === 5_000, 'бонусы списаны в счёт');
  const inv2 = await dealInvoice(d2);
  await call('POST', `/v1/deals/${d2}/cancel`, owner.token, { reason: 'Нет нужной бумаги' });
  ok((await call('GET', '/v1/me', gigBuyer)).data.bonusUzs === 50_000, 'сделка отменена до оплаты — бонусы вернулись');
  ok((await pm('CheckPerformTransaction', { amount: inv2.amountUzs * 100, account: { invoice_id: String(inv2.id) } })).data.error?.code === -31051, 'Payme: счёт отменённой сделки не оплачивается');

  const d3 = await orderDeal(friend, 120_000);
  const q3 = (await call('GET', `/v1/deals/${d3}`, friend)).data.payment.quote;
  ok(q3.firstOrder === false && q3.payUzs === 120_000, 'второй заказ — без скидки');
  await call('POST', `/v1/deals/${d3}/pay`, friend);
  ok(await pmDeal(await dealInvoice(d3), `pmd3-${RUN}`), 'Payme: второй заказ оплачен');
  const supCancel3 = await call('POST', `/v1/deals/${d3}/cancel`, owner.token, { reason: 'Сломался станок' });
  ok(supCancel3.data.status === 'cancelled' && supCancel3.data.payment.status === 'refund_due', 'исполнитель отменил оплаченный заказ — деньги к возврату покупателю');
  ok(((await call('GET', '/admin/escrow?status=refund_due', admin)).data as any[]).some((x) => x.id === d3), 'возврат ждёт в админке');
  const pmRefund = await pm('CancelTransaction', { id: `pmd3-${RUN}`, reason: 5 });
  const afterRefund = (await call('GET', `/v1/deals/${d3}`, friend)).data;
  ok(pmRefund.data.result?.state === -2 && afterRefund.payment.status === 'refunded', 'Payme вернул деньги — сделка помечена как возвращённая');
  ok((await call('POST', `/admin/escrow/${d3}/refund`, admin)).status === 400, 'дважды не возвращается');

  const growthOut = execFileSync(process.execPath, [resolve(__dirname, 'growth.js'), String(buyerTg), String(dealId)], { env: process.env }).toString();
  const growth = JSON.parse(growthOut.trim().split('\n').at(-1)!);
  const types = (growth.sent as any[]).map((n) => n.type);
  ok(types.includes('gig_reminder') && growth.sent.find((n: any) => n.type === 'gig_reminder')?.payload.gigId === g15.id, 'напоминание о просмотренной, но не заказанной услуге');
  ok(types.includes('reorder_nudge') && growth.sent.find((n: any) => n.type === 'reorder_nudge')?.payload.dealId === dealId, 'через 30 дней после сделки — предложение заказать снова');
  ok(growth.second.viewed === 0 && growth.second.reorders === 0, 'напоминания не повторяются');

  console.log(failures ? `\n✗ Провалено проверок: ${failures}` : '\n✓ Все проверки прошли');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
