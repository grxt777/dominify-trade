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
  | 'phone_saved'
  | 'team_joined'
  | 'deal_cancelled'
  | 'deal_disputed'
  | 'deal_resolved'
  | 'deal_reminder'
  | 'request_reopened'
  | 'deal_paid'
  | 'deal_paid_buyer'
  | 'deal_payout_due'
  | 'deal_payout_sent'
  | 'deal_refund_due'
  | 'deal_refund_sent'
  | 'referral_reward'
  | 'gig_reminder'
  | 'draft_reminder'
  | 'reorder_nudge';

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
export const URGENT: NotificationType[] = [
  'request_parsed',
  'request_question',
  'phone_saved',
  'chosen',
  'message',
  'deal_cancelled',
  'deal_disputed',
  'deal_paid',
  'deal_paid_buyer',
  'deal_refund_due',
];

const openDeal = (p: P, l: Lang): Button => ({ text: { ru: 'Открыть сделку', uz: 'Bitimni ochish', uzc: 'Битимни очиш' }[l], route: `deal_${p.dealId}` });

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
    text: p.requestId
      ? `<b>${s(p.from)}</b> ${{ ru: 'пишет по заявке', uz: "so'rov bo'yicha yozmoqda", uzc: 'сўров бўйича ёзмоқда' }[l]} #${s(p.requestId)}:\n${s(p.text)}`
      : `<b>${s(p.from)}</b> ${{ ru: 'пишет об услуге', uz: 'xizmat haqida yozmoqda', uzc: 'хизмат ҳақида ёзмоқда' }[l]} «${s(p.gigTitle)}»:\n${s(p.text)}`,
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
  team_joined: (p, l) => ({
    text: {
      ru: `${s(p.name)} присоединился к вашей команде и теперь видит заявки компании.`,
      uz: `${s(p.name)} jamoangizga qo'shildi va endi kompaniya so'rovlarini ko'radi.`,
      uzc: `${s(p.name)} жамоангизга қўшилди ва энди компания сўровларини кўради.`,
    }[l],
    buttons: [{ text: { ru: 'Команда', uz: 'Jamoa', uzc: 'Жамоа' }[l], route: 'profile' }],
  }),
  deal_cancelled: (p, l) => ({
    text: {
      ru: `Сделка по заявке #${s(p.requestId)} отменена. Причина: ${s(p.reason) || '—'}`,
      uz: `#${s(p.requestId)} so'rov bo'yicha bitim bekor qilindi. Sabab: ${s(p.reason) || '—'}`,
      uzc: `#${s(p.requestId)} сўров бўйича битим бекор қилинди. Сабаб: ${s(p.reason) || '—'}`,
    }[l],
    buttons: [{ text: { ru: 'Открыть', uz: 'Ochish', uzc: 'Очиш' }[l], route: `deal_${p.dealId}` }],
  }),
  deal_disputed: (p, l) => ({
    text: {
      ru: `По сделке #${s(p.dealId)} (заявка #${s(p.requestId)}) открыт спор. Модератор свяжется с обеими сторонами в течение рабочего дня.`,
      uz: `#${s(p.dealId)} bitim (#${s(p.requestId)} so'rov) bo'yicha nizo ochildi. Moderator ish kuni davomida ikkala tomon bilan bog'lanadi.`,
      uzc: `#${s(p.dealId)} битим (#${s(p.requestId)} сўров) бўйича низо очилди. Модератор иш куни давомида иккала томон билан боғланади.`,
    }[l],
    buttons: [{ text: { ru: 'Открыть сделку', uz: 'Bitimni ochish', uzc: 'Битимни очиш' }[l], route: `deal_${p.dealId}` }],
  }),
  deal_resolved: (p, l) => ({
    text: {
      ru: `Спор по сделке #${s(p.dealId)} рассмотрен. Решение: ${s(p.outcome)}. ${s(p.note)}`,
      uz: `#${s(p.dealId)} bitim bo'yicha nizo ko'rib chiqildi. Qaror: ${s(p.outcome)}. ${s(p.note)}`,
      uzc: `#${s(p.dealId)} битим бўйича низо кўриб чиқилди. Қарор: ${s(p.outcome)}. ${s(p.note)}`,
    }[l],
    buttons: [{ text: { ru: 'Открыть сделку', uz: 'Bitimni ochish', uzc: 'Битимни очиш' }[l], route: `deal_${p.dealId}` }],
  }),
  deal_reminder: (p, l) => ({
    text: {
      ru: `Как продвигается сделка по заявке #${s(p.requestId)} «${s(p.title)}»? Когда всё будет готово, отметьте её выполненной. Если что-то пошло не так, отмените сделку или откройте спор.`,
      uz: `#${s(p.requestId)} «${s(p.title)}» bitimi qanday ketyapti? Tayyor bo'lsa, bajarildi deb belgilang. Muammo bo'lsa, bekor qiling yoki nizo oching.`,
      uzc: `#${s(p.requestId)} «${s(p.title)}» битими қандай кетяпти? Тайёр бўлса, бажарилди деб белгиланг. Муаммо бўлса, бекор қилинг ёки низо очинг.`,
    }[l],
    buttons: [{ text: { ru: 'Открыть сделку', uz: 'Bitimni ochish', uzc: 'Битимни очиш' }[l], route: `deal_${p.dealId}` }],
  }),
  request_reopened: (p, l) => ({
    text: {
      ru: `Заявка #${s(p.requestId)} «${s(p.title)}» снова открыта: исполнитель не выбран. Если ваш отклик ещё актуален, покупатель может выбрать вас.`,
      uz: `#${s(p.requestId)} «${s(p.title)}» so'rov yana ochildi. Taklifingiz hali dolzarb bo'lsa, xaridor sizni tanlashi mumkin.`,
      uzc: `#${s(p.requestId)} «${s(p.title)}» сўров яна очилди. Таклифингиз ҳали долзарб бўлса, харидор сизни танлаши мумкин.`,
    }[l],
    buttons: [{ text: { ru: 'Открыть заявку', uz: "So'rovni ochish", uzc: 'Сўровни очиш' }[l], route: `req_${p.requestId}` }],
  }),
  deal_paid: (p, l) => ({
    text: {
      ru: `💰 Покупатель оплатил заказ «${s(p.title)}» — ${s(p.amount)} сум. Деньги хранятся у Dominify и придут вам после приёмки работы (к выплате ${s(p.payout)} сум). Можно приступать.`,
      uz: `💰 Mijoz «${s(p.title)}» buyurtmasini to'ladi — ${s(p.amount)} so'm. Pul Dominify'da saqlanadi va ish qabul qilingach sizga o'tkaziladi (${s(p.payout)} so'm). Ishni boshlashingiz mumkin.`,
      uzc: `💰 Мижоз «${s(p.title)}» буюртмасини тўлади — ${s(p.amount)} сўм. Пул Dominify'да сақланади ва иш қабул қилингач сизга ўтказилади (${s(p.payout)} сўм). Ишни бошлашингиз мумкин.`,
    }[l],
    buttons: [openDeal(p, l)],
  }),
  deal_paid_buyer: (p, l) => ({
    text: {
      ru: `✅ Оплата получена. Деньги в безопасности: исполнитель получит их только после того, как вы подтвердите выполнение заказа «${s(p.title)}».`,
      uz: `✅ To'lov qabul qilindi. Pulingiz xavfsiz: ijrochi uni faqat siz «${s(p.title)}» buyurtmasi bajarilganini tasdiqlaganingizdan keyin oladi.`,
      uzc: `✅ Тўлов қабул қилинди. Пулингиз хавфсиз: ижрочи уни фақат сиз «${s(p.title)}» буюртмаси бажарилганини тасдиқлаганингиздан кейин олади.`,
    }[l],
    buttons: [openDeal(p, l)],
  }),
  deal_payout_due: (p, l) => ({
    text: {
      ru: `Заказ #${s(p.dealId)} принят покупателем. Выплата ${s(p.payout)} сум поступит на ваш счёт в течение 1–2 рабочих дней.`,
      uz: `#${s(p.dealId)} buyurtma mijoz tomonidan qabul qilindi. ${s(p.payout)} so'm 1–2 ish kunida hisobingizga o'tkaziladi.`,
      uzc: `#${s(p.dealId)} буюртма мижоз томонидан қабул қилинди. ${s(p.payout)} сўм 1–2 иш кунида ҳисобингизга ўтказилади.`,
    }[l],
    buttons: [openDeal(p, l)],
  }),
  deal_payout_sent: (p, l) => ({
    text: {
      ru: `Выплата по заказу #${s(p.dealId)} отправлена: ${s(p.payout)} сум. Спасибо за работу!`,
      uz: `#${s(p.dealId)} buyurtma bo'yicha to'lov yuborildi: ${s(p.payout)} so'm. Ishingiz uchun rahmat!`,
      uzc: `#${s(p.dealId)} буюртма бўйича тўлов юборилди: ${s(p.payout)} сўм. Ишингиз учун раҳмат!`,
    }[l],
    buttons: [openDeal(p, l)],
  }),
  deal_refund_due: (p, l) => ({
    text: {
      ru: `Сделка #${s(p.dealId)} отменена. Деньги вернутся на вашу карту в течение 1–3 рабочих дней.`,
      uz: `#${s(p.dealId)} bitim bekor qilindi. Pulingiz 1–3 ish kunida kartangizga qaytariladi.`,
      uzc: `#${s(p.dealId)} битим бекор қилинди. Пулингиз 1–3 иш кунида картангизга қайтарилади.`,
    }[l],
    buttons: [openDeal(p, l)],
  }),
  deal_refund_sent: (p, l) => ({
    text: {
      ru: `Деньги за заказ #${s(p.dealId)} возвращены.`,
      uz: `#${s(p.dealId)} buyurtma uchun pul qaytarildi.`,
      uzc: `#${s(p.dealId)} буюртма учун пул қайтарилди.`,
    }[l],
    buttons: [openDeal(p, l)],
  }),
  referral_reward: (p, l) => ({
    text: {
      ru: `🎁 ${s(p.name) || 'Ваш друг'} сделал первый заказ — вам начислено ${s(p.bonus)} сум бонусов. Ими можно оплатить следующий заказ.`,
      uz: `🎁 ${s(p.name) || "Do'stingiz"} birinchi buyurtmasini berdi — sizga ${s(p.bonus)} so'm bonus berildi. Keyingi buyurtmani shu bilan to'lashingiz mumkin.`,
      uzc: `🎁 ${s(p.name) || 'Дўстингиз'} биринчи буюртмасини берди — сизга ${s(p.bonus)} сўм бонус берилди. Кейинги буюртмани шу билан тўлашингиз мумкин.`,
    }[l],
    buttons: [{ text: { ru: 'Пригласить ещё', uz: 'Yana taklif qilish', uzc: 'Яна таклиф қилиш' }[l], route: 'invite' }],
  }),
  gig_reminder: (p, l) => ({
    text: {
      ru: `Вы смотрели услугу «${s(p.title)}» от ${s(p.seller)}${p.price ? ` — от ${money(p.price)} сум` : ''}. Заказ займёт минуту, а оплата хранится у Dominify до приёмки работы.`,
      uz: `Siz ${s(p.seller)}ning «${s(p.title)}» xizmatini ko'rgan edingiz${p.price ? ` — ${money(p.price)} so'mdan` : ''}. Buyurtma bir daqiqa oladi, to'lov esa ish qabul qilinguncha Dominify'da saqlanadi.`,
      uzc: `Сиз ${s(p.seller)}нинг «${s(p.title)}» хизматини кўрган эдингиз${p.price ? ` — ${money(p.price)} сўмдан` : ''}. Буюртма бир дақиқа олади, тўлов эса иш қабул қилингунча Dominify'да сақланади.`,
    }[l],
    buttons: [{ text: { ru: 'Посмотреть снова', uz: "Qayta ko'rish", uzc: 'Қайта кўриш' }[l], route: `gig_${p.gigId}` }],
  }),
  draft_reminder: (p, l) => ({
    text: {
      ru: `Заявка «${s(p.title) || `#${s(p.requestId)}`}» так и не отправлена исполнителям. Отправьте — первые предложения обычно приходят в течение часа.`,
      uz: `«${s(p.title) || `#${s(p.requestId)}`}» so'rovi hali ijrochilarga yuborilmadi. Yuboring — birinchi takliflar odatda bir soat ichida keladi.`,
      uzc: `«${s(p.title) || `#${s(p.requestId)}`}» сўрови ҳали ижрочиларга юборилмади. Юборинг — биринчи таклифлар одатда бир соат ичида келади.`,
    }[l],
    buttons: [{ text: { ru: 'Завершить заявку', uz: "So'rovni yakunlash", uzc: 'Сўровни якунлаш' }[l], route: `req_${p.requestId}` }],
  }),
  reorder_nudge: (p, l) => ({
    text: {
      ru: `Месяц назад «${s(p.seller)}» выполнил ваш заказ «${s(p.title)}». Нужно повторить или что-то новое? Закажите в пару касаний.`,
      uz: `Bir oy oldin «${s(p.seller)}» «${s(p.title)}» buyurtmangizni bajargan edi. Takrorlash yoki yangi narsa kerakmi? Bir necha bosishda buyurtma bering.`,
      uzc: `Бир ой олдин «${s(p.seller)}» «${s(p.title)}» буюртмангизни бажарган эди. Такрорлаш ёки янги нарса керакми? Бир неча босишда буюртма беринг.`,
    }[l],
    buttons: [{ text: { ru: 'Заказать снова', uz: 'Yana buyurtma berish', uzc: 'Яна буюртма бериш' }[l], route: p.gigId ? `gig_${p.gigId}` : 'new' }],
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
