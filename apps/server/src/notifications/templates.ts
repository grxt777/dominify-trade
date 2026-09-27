import { formatUzs, type Lang } from '@dominify/shared';

export type NotificationType =
  | 'request_parsed'
  | 'request_question'
  | 'request_submitted'
  | 'request_moderation'
  | 'request_rejected'
  | 'request_expired'
  | 'new_request'
  | 'new_offer'
  | 'offer_digest'
  | 'chosen'
  | 'not_chosen'
  | 'message'
  | 'supplier_reminder'
  | 'deal_confirm_other'
  | 'review_ask'
  | 'subscription_activated'
  | 'subscription_expiring'
  | 'subscription_grace'
  | 'subscription_expired'
  | 'phone_saved';

export interface Button {
  text: string;
  /** Маршрут Mini App: откроется кнопкой web_app. */
  route?: string;
  /** Данные callback-кнопки для бота. */
  callback?: string;
}

export interface Rendered {
  text: string;
  buttons: Button[];
}

type P = Record<string, unknown>;

const s = (v: unknown) => String(v ?? '');
const money = (v: unknown) => formatUzs(Number(v ?? 0));

/** Срочные типы игнорируют тихие часы. */
export const URGENT: NotificationType[] = ['request_parsed', 'request_question', 'phone_saved', 'chosen', 'message'];

const T: Record<NotificationType, (p: P, l: Lang) => Rendered> = {
  request_parsed: (p, l) => ({
    text: {
      ru: `Заявка разобрана:\n\n<b>${s(p.title)}</b>\n${s(p.summary)}\n\nВсё верно? Отправим её поставщикам.`,
      uz: `So'rov tahlil qilindi:\n\n<b>${s(p.title)}</b>\n${s(p.summary)}\n\nHammasi to'g'rimi? Yetkazib beruvchilarga yuboramiz.`,
      uzc: `Сўров таҳлил қилинди:\n\n<b>${s(p.title)}</b>\n${s(p.summary)}\n\nҲаммаси тўғрими? Етказиб берувчиларга юборамиз.`,
    }[l],
    buttons: [
      { text: { ru: 'Отправить', uz: 'Yuborish', uzc: 'Юбориш' }[l], callback: `submit:${p.requestId}` },
      { text: { ru: 'Проверить в приложении', uz: 'Ilovada tekshirish', uzc: 'Иловада текшириш' }[l], route: `req_${p.requestId}` },
    ],
  }),
  request_question: (p, l) => ({
    text: `${s(p.question)}\n\n<i>${{ ru: 'Ответьте одним сообщением.', uz: 'Bitta xabar bilan javob bering.', uzc: 'Битта хабар билан жавоб беринг.' }[l]}</i>`,
    buttons: [],
  }),
  request_submitted: (p, l) => ({
    text: {
      ru: `Заявка #${s(p.requestId)} отправлена поставщикам. Первые отклики обычно приходят в течение часа.`,
      uz: `#${s(p.requestId)} so'rov yetkazib beruvchilarga yuborildi. Birinchi takliflar odatda bir soat ichida keladi.`,
      uzc: `#${s(p.requestId)} сўров етказиб берувчиларга юборилди. Биринчи таклифлар одатда бир соат ичида келади.`,
    }[l],
    buttons: [{ text: { ru: 'Открыть заявку', uz: "So'rovni ochish", uzc: 'Сўровни очиш' }[l], route: `req_${p.requestId}` }],
  }),
  request_moderation: (p, l) => ({
    text: {
      ru: `Заявку #${s(p.requestId)} проверит модератор, это займёт немного времени. Мы напишем, когда она уйдёт поставщикам.`,
      uz: `#${s(p.requestId)} so'rovni moderator tekshiradi. Yetkazib beruvchilarga yuborilganda xabar beramiz.`,
      uzc: `#${s(p.requestId)} сўровни модератор текширади. Етказиб берувчиларга юборилганда хабар берамиз.`,
    }[l],
    buttons: [],
  }),
  request_rejected: (p, l) => ({
    text: {
      ru: `Заявку #${s(p.requestId)} не удалось отправить: ${s(p.reason)}`,
      uz: `#${s(p.requestId)} so'rovni yuborib bo'lmadi: ${s(p.reason)}`,
      uzc: `#${s(p.requestId)} сўровни юбориб бўлмади: ${s(p.reason)}`,
    }[l],
    buttons: [],
  }),
  request_expired: (p, l) => ({
    text: {
      ru: `Заявка #${s(p.requestId)} закрыта: исполнитель не выбран за 7 дней. Что пошло не так? Напишите пару слов в ответ — это поможет нам.`,
      uz: `#${s(p.requestId)} so'rov yopildi: 7 kun ichida ijrochi tanlanmadi. Nima xato ketdi? Javobda yozing.`,
      uzc: `#${s(p.requestId)} сўров ёпилди: 7 кун ичида ижрочи танланмади. Нима хато кетди? Жавобда ёзинг.`,
    }[l],
    buttons: [],
  }),
  new_request: (p, l) => ({
    text: {
      ru: `Новая заявка в вашей категории:\n\n<b>${s(p.title)}</b>\n${s(p.summary)}`,
      uz: `Sizning toifangizda yangi so'rov:\n\n<b>${s(p.title)}</b>\n${s(p.summary)}`,
      uzc: `Сизнинг тоифангизда янги сўров:\n\n<b>${s(p.title)}</b>\n${s(p.summary)}`,
    }[l],
    buttons: [{ text: { ru: 'Откликнуться', uz: 'Taklif berish', uzc: 'Таклиф бериш' }[l], route: `req_${p.requestId}` }],
  }),
  new_offer: (p, l) => ({
    text: {
      ru: `Первый отклик на заявку #${s(p.requestId)}: ${money(p.priceUzs)} сум, ${s(p.leadTimeDays)} дн. от «${s(p.supplierName)}».`,
      uz: `#${s(p.requestId)} so'rovga birinchi taklif: ${money(p.priceUzs)} so'm, ${s(p.leadTimeDays)} kun, «${s(p.supplierName)}».`,
      uzc: `#${s(p.requestId)} сўровга биринчи таклиф: ${money(p.priceUzs)} сўм, ${s(p.leadTimeDays)} кун, «${s(p.supplierName)}».`,
    }[l],
    buttons: [{ text: { ru: 'Сравнить отклики', uz: 'Takliflarni solishtirish', uzc: 'Таклифларни солиштириш' }[l], route: `req_${p.requestId}` }],
  }),
  offer_digest: (p, l) => ({
    text: {
      ru: `На заявку #${s(p.requestId)} пришло ещё откликов: ${s(p.count)}. Лучшая цена сейчас ${money(p.bestPrice)} сум.`,
      uz: `#${s(p.requestId)} so'rovga yana ${s(p.count)} ta taklif keldi. Eng yaxshi narx: ${money(p.bestPrice)} so'm.`,
      uzc: `#${s(p.requestId)} сўровга яна ${s(p.count)} та таклиф келди. Энг яхши нарх: ${money(p.bestPrice)} сўм.`,
    }[l],
    buttons: [{ text: { ru: 'Сравнить отклики', uz: 'Takliflarni solishtirish', uzc: 'Таклифларни солиштириш' }[l], route: `req_${p.requestId}` }],
  }),
  chosen: (p, l) => ({
    text: {
      ru: `Вас выбрали исполнителем по заявке #${s(p.requestId)} «${s(p.title)}».\n\nКонтакт покупателя: ${s(p.contact)}`,
      uz: `Siz #${s(p.requestId)} «${s(p.title)}» so'rovi bo'yicha ijrochi etib tanlandingiz.\n\nXaridor kontakti: ${s(p.contact)}`,
      uzc: `Сиз #${s(p.requestId)} «${s(p.title)}» сўрови бўйича ижрочи этиб танландингиз.\n\nХаридор контакти: ${s(p.contact)}`,
    }[l],
    buttons: [{ text: { ru: 'Открыть сделку', uz: 'Bitimni ochish', uzc: 'Битимни очиш' }[l], route: `deal_${p.dealId}` }],
  }),
  not_chosen: (p, l) => ({
    text: {
      ru: `По заявке #${s(p.requestId)} покупатель выбрал другого исполнителя. Спасибо за отклик — следующие заявки уже в пути.`,
      uz: `#${s(p.requestId)} so'rov bo'yicha xaridor boshqa ijrochini tanladi. Taklifingiz uchun rahmat.`,
      uzc: `#${s(p.requestId)} сўров бўйича харидор бошқа ижрочини танлади. Таклифингиз учун раҳмат.`,
    }[l],
    buttons: [],
  }),
  message: (p, l) => ({
    text: `<b>${s(p.from)}</b> ${{ ru: 'пишет по заявке', uz: "so'rov bo'yicha yozmoqda", uzc: 'сўров бўйича ёзмоқда' }[l]} #${s(p.requestId)}:\n${s(p.text)}`,
    buttons: [{ text: { ru: 'Ответить', uz: 'Javob berish', uzc: 'Жавоб бериш' }[l], route: `chat_${p.chatId}` }],
  }),
  supplier_reminder: (p, l) => ({
    text: {
      ru: `Вы открыли заявку #${s(p.requestId)} «${s(p.title)}», но ещё не откликнулись. Покупатель ждёт предложения.`,
      uz: `Siz #${s(p.requestId)} «${s(p.title)}» so'rovini ochdingiz, lekin hali taklif bermadingiz.`,
      uzc: `Сиз #${s(p.requestId)} «${s(p.title)}» сўровини очдингиз, лекин ҳали таклиф бермадингиз.`,
    }[l],
    buttons: [{ text: { ru: 'Откликнуться', uz: 'Taklif berish', uzc: 'Таклиф бериш' }[l], route: `req_${p.requestId}` }],
  }),
  deal_confirm_other: (p, l) => ({
    text: {
      ru: `Другая сторона отметила сделку по заявке #${s(p.requestId)} как выполненную. Подтвердите, если всё так.`,
      uz: `Boshqa tomon #${s(p.requestId)} bitimini bajarilgan deb belgiladi. Tasdiqlang.`,
      uzc: `Бошқа томон #${s(p.requestId)} битимини бажарилган деб белгилади. Тасдиқланг.`,
    }[l],
    buttons: [{ text: { ru: 'Подтвердить', uz: 'Tasdiqlash', uzc: 'Тасдиқлаш' }[l], route: `deal_${p.dealId}` }],
  }),
  review_ask: (p, l) => ({
    text: {
      ru: `Сделка по заявке #${s(p.requestId)} закрыта. Оцените, как всё прошло: отзыв видят другие компании.`,
      uz: `#${s(p.requestId)} bitim yopildi. Qanday o'tganini baholang.`,
      uzc: `#${s(p.requestId)} битим ёпилди. Қандай ўтганини баҳоланг.`,
    }[l],
    buttons: [{ text: { ru: 'Оставить отзыв', uz: 'Fikr qoldirish', uzc: 'Фикр қолдириш' }[l], route: `deal_${p.dealId}` }],
  }),
  subscription_activated: (p, l) => ({
    text: {
      ru: `Тариф «${s(p.plan)}» активен до ${s(p.until)}. Спасибо!`,
      uz: `«${s(p.plan)}» tarifi ${s(p.until)} gacha faol. Rahmat!`,
      uzc: `«${s(p.plan)}» тарифи ${s(p.until)} гача фаол. Раҳмат!`,
    }[l],
    buttons: [],
  }),
  subscription_expiring: (p, l) => ({
    text: {
      ru: `Тариф «${s(p.plan)}» закончится ${s(p.until)}. Чтобы продлить, свяжитесь с менеджером — пришлём счёт.`,
      uz: `«${s(p.plan)}» tarifi ${s(p.until)} tugaydi. Uzaytirish uchun menejer bilan bog'laning.`,
      uzc: `«${s(p.plan)}» тарифи ${s(p.until)} тугайди. Узайтириш учун менежер билан боғланинг.`,
    }[l],
    buttons: [],
  }),
  subscription_grace: (p, l) => ({
    text: {
      ru: `Оплаченный период тарифа «${s(p.plan)}» закончился. Ещё 3 дня всё работает как раньше, затем аккаунт перейдёт на бесплатный тариф.`,
      uz: `«${s(p.plan)}» tarifi muddati tugadi. Yana 3 kun hammasi ishlaydi, keyin bepul tarifga o'tadi.`,
      uzc: `«${s(p.plan)}» тарифи муддати тугади. Яна 3 кун ҳаммаси ишлайди, кейин бепул тарифга ўтади.`,
    }[l],
    buttons: [],
  }),
  subscription_expired: (p, l) => ({
    text: {
      ru: `Аккаунт переведён на бесплатный тариф. Заявки продолжат приходить, но с задержкой и лимитом откликов.`,
      uz: `Hisob bepul tarifga o'tkazildi. So'rovlar kechikish bilan keladi.`,
      uzc: `Ҳисоб бепул тарифга ўтказилди. Сўровлар кечикиш билан келади.`,
    }[l],
    buttons: [],
  }),
  phone_saved: (_p, l) => ({
    text: {
      ru: 'Спасибо, номер подтверждён. Можно возвращаться в приложение.',
      uz: "Rahmat, raqam tasdiqlandi. Ilovaga qaytishingiz mumkin.",
      uzc: 'Раҳмат, рақам тасдиқланди. Иловага қайтишингиз мумкин.',
    }[l],
    buttons: [{ text: { ru: 'Открыть приложение', uz: 'Ilovani ochish', uzc: 'Иловани очиш' }[l], route: 'home' }],
  }),
};

export function render(type: NotificationType, payload: P, lang: Lang): Rendered {
  return T[type](payload, lang);
}

/**
 * Когда можно отправить несрочное уведомление: в тихие часы (по умолчанию 22:00–8:00 по Ташкенту)
 * откладываем до конца тихих часов.
 */
export function nextAllowedTime(now: Date, offsetMin: number, quietStart: number, quietEnd: number): Date {
  const local = new Date(now.getTime() + offsetMin * 60_000);
  const h = local.getUTCHours();
  const inQuiet = quietStart > quietEnd ? h >= quietStart || h < quietEnd : h >= quietStart && h < quietEnd;
  if (!inQuiet) return now;
  const target = new Date(local);
  if (h >= quietStart && quietStart > quietEnd) target.setUTCDate(target.getUTCDate() + 1);
  target.setUTCHours(quietEnd, 0, 0, 0);
  return new Date(target.getTime() - offsetMin * 60_000);
}
