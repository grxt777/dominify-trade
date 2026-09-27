import { uzLatinToCyrillic, type Lang } from '@dominify/shared';
import { createContext, useContext } from 'react';

/** Строки интерфейса: русский и узбекская латиница; кириллица получается транслитерацией. */
const D = {
  appName: ['Dominify Trade', 'Dominify Trade'],
  loading: ['Загрузка…', 'Yuklanmoqda…'],
  retry: ['Повторить', 'Qayta urinish'],
  save: ['Сохранить', 'Saqlash'],
  cancel: ['Отменить', 'Bekor qilish'],
  back: ['Назад', 'Orqaga'],
  next: ['Далее', 'Keyingi'],
  done: ['Готово', 'Tayyor'],
  yes: ['Да', 'Ha'],
  no: ['Нет', "Yo'q"],
  errorGeneric: ['Что-то пошло не так. Попробуйте ещё раз.', "Nimadir xato ketdi. Qayta urinib ko'ring."],
  openInTelegram: ['Откройте приложение из Telegram-бота', 'Ilovani Telegram-botdan oching'],

  // вкладки
  tabRequests: ['Заявки', "So'rovlar"],
  tabFeed: ['Лента', 'Lenta'],
  tabOffers: ['Отклики', 'Takliflar'],
  tabDeals: ['Сделки', 'Bitimlar'],
  tabChats: ['Чаты', 'Chatlar'],
  tabProfile: ['Профиль', 'Profil'],
  roleBuyer: ['Покупаю', 'Sotib olaman'],
  roleSupplier: ['Продаю', 'Sotaman'],

  // согласие
  consentTitle: ['Добро пожаловать', 'Xush kelibsiz'],
  consentText: [
    'Dominify Trade помогает найти поставщика полиграфии и наружной рекламы за минуты. Чтобы работать, мы храним ваше имя из Telegram, номер телефона и данные компании. Отправляя заявку, вы соглашаетесь с обработкой этих данных.',
    "Dominify Trade poligrafiya va tashqi reklama bo'yicha yetkazib beruvchini bir necha daqiqada topishga yordam beradi. Ishlash uchun Telegramdagi ismingiz, telefon raqamingiz va kompaniya ma'lumotlarini saqlaymiz. So'rov yuborib, ushbu ma'lumotlarni qayta ishlashga rozilik bildirasiz.",
  ],
  consentAccept: ['Согласен, продолжить', 'Roziman, davom etish'],
  privacy: ['Политика конфиденциальности', 'Maxfiylik siyosati'],

  // покупатель
  newRequest: ['Новая заявка', "Yangi so'rov"],
  newRequestHint: ['Опишите своими словами, что нужно', "Nima kerakligini o'z so'zlaringiz bilan yozing"],
  newRequestPlaceholder: [
    'Например: 1000 визиток 90×50, двусторонние, ламинация, к пятнице, Чиланзар',
    "Masalan: 1000 ta vizitka 90×50, ikki tomonlama, laminatsiya, jumagacha, Chilonzor",
  ],
  attach: ['Фото или PDF', 'Rasm yoki PDF'],
  parseButton: ['Разобрать заявку', "So'rovni tahlil qilish"],
  myRequests: ['Мои заявки', "Mening so'rovlarim"],
  noRequests: ['Заявок пока нет. Создайте первую — это займёт минуту.', "Hozircha so'rovlar yo'q. Birinchisini yarating — bir daqiqa oladi."],
  offersN: ['откликов', 'taklif'],
  bestPrice: ['лучшая цена', 'eng yaxshi narx'],
  parsing: ['Разбираю заявку…', "So'rov tahlil qilinmoqda…"],
  parsingHint: ['Обычно это занимает несколько секунд', 'Odatda bir necha soniya'],
  checkAndSend: ['Проверьте заявку', "So'rovni tekshiring"],
  category: ['Категория', 'Toifa'],
  chooseCategory: ['Выберите категорию', 'Toifani tanlang'],
  region: ['Район', 'Hudud'],
  deadline: ['Срок', 'Muddat'],
  budget: ['Бюджет, сум', "Byudjet, so'm"],
  title: ['Заголовок', 'Sarlavha'],
  required: ['обязательно', 'majburiy'],
  question: ['Уточнение', 'Aniqlashtirish'],
  answer: ['Ответить', 'Javob berish'],
  answerPlaceholder: ['Ваш ответ', 'Javobingiz'],
  sendToSuppliers: ['Отправить поставщикам', 'Yetkazib beruvchilarga yuborish'],
  duplicateWarn: ['Похожая заявка уже есть', "O'xshash so'rov allaqachon bor"],
  cancelRequest: ['Отменить заявку', "So'rovni bekor qilish"],
  cancelConfirm: ['Отменить заявку? Поставщики перестанут её видеть.', "So'rov bekor qilinsinmi? Yetkazib beruvchilar uni ko'rmaydi."],
  waitingOffers: ['Ждём отклики', 'Takliflar kutilmoqda'],
  waveInfo: ['Разослано поставщикам, волна', "Yetkazib beruvchilarga yuborildi, to'lqin"],
  moderationInfo: ['Заявку проверяет модератор', "So'rovni moderator tekshirmoqda"],
  offers: ['Отклики', 'Takliflar'],
  choose: ['Выбрать', 'Tanlash'],
  write: ['Написать', 'Yozish'],
  chooseConfirm: ['Выбрать этого исполнителя? Остальным поставщикам придёт отказ, а выбранный получит ваш контакт.', "Ushbu ijrochini tanlaysizmi? Qolganlarga rad javobi boradi, tanlangan esa kontaktingizni oladi."],
  days: ['дн.', 'kun'],
  sum: ['сум', "so'm"],
  deals: ['сделок', 'bitimlar'],
  request: ['Заявка', "So'rov"],
  noReviews: ['нет отзывов', "fikrlar yo'q"],
  trust: ['Доверие', 'Ishonch'],
  trustL0: ['Телефон', 'Telefon'],
  trustL1: ['ИНН проверен', 'STIR tekshirilgan'],
  trustL2: ['Надёжный', 'Ishonchli'],
  trustL3: ['Проверен банком', 'Bank tekshirgan'],
  openDeal: ['Открыть сделку', 'Bitimni ochish'],

  // поставщик
  feedEmpty: ['Новых заявок пока нет. Мы пришлём уведомление в бот, как только появится подходящая.', "Hozircha yangi so'rovlar yo'q. Mos so'rov paydo bo'lishi bilan botga xabar yuboramiz."],
  newBadge: ['новая', 'yangi'],
  closed: ['закрыта', 'yopilgan'],
  yourOffer: ['Ваш отклик', 'Taklifingiz'],
  price: ['Цена, сум', "Narx, so'm"],
  leadTime: ['Срок, дней', 'Muddat, kun'],
  comment: ['Комментарий', 'Izoh'],
  commentPlaceholder: ['Материал, условия, что входит в цену', 'Material, shartlar, narxga nimalar kiradi'],
  sendOffer: ['Откликнуться', 'Taklif berish'],
  updateOffer: ['Обновить отклик', 'Taklifni yangilash'],
  withdraw: ['Отозвать', 'Qaytarib olish'],
  offerSent: ['Отклик отправлен', 'Taklif yuborildi'],
  buyer: ['Покупатель', 'Xaridor'],
  noOffers: ['Вы ещё не откликались', 'Siz hali taklif bermagansiz'],
  becomeSupplier: ['Стать поставщиком', "Yetkazib beruvchi bo'lish"],
  becomeSupplierHint: ['Получайте заявки своей категории и района', "O'z toifangiz va hududingizdan so'rovlar oling"],

  // статусы
  st_draft: ['Черновик', 'Qoralama'],
  st_needs_info: ['Нужно уточнение', 'Aniqlashtirish kerak'],
  st_moderation: ['На проверке', 'Tekshiruvda'],
  st_submitted: ['Отправлена', 'Yuborildi'],
  st_wave_1: ['Разослана', 'Tarqatildi'],
  st_wave_2: ['Разослана шире', 'Kengroq tarqatildi'],
  st_has_offers: ['Есть отклики', 'Takliflar bor'],
  st_supplier_chosen: ['Исполнитель выбран', 'Ijrochi tanlandi'],
  st_completed: ['Выполнена', 'Bajarildi'],
  st_reviewed: ['Оценена', 'Baholandi'],
  st_cancelled: ['Отменена', 'Bekor qilindi'],
  st_expired: ['Истекла', 'Muddati tugadi'],
  st_rejected: ['Отклонена', 'Rad etildi'],
  of_sent: ['Отправлен', 'Yuborildi'],
  of_withdrawn: ['Отозван', 'Qaytarib olindi'],
  of_chosen: ['Выбран', 'Tanlandi'],
  of_rejected: ['Не выбран', 'Tanlanmadi'],
  dl_active: ['В работе', 'Jarayonda'],
  dl_completed: ['Закрыта', 'Yopildi'],
  dl_disputed: ['Спор', 'Nizo'],
  dl_cancelled: ['Отменена', 'Bekor qilindi'],

  // сделки
  deal: ['Сделка', 'Bitim'],
  noDeals: ['Сделок пока нет', "Hozircha bitimlar yo'q"],
  amount: ['Сумма', 'Summa'],
  supplier: ['Исполнитель', 'Ijrochi'],
  contact: ['Контакт', 'Kontakt'],
  confirmDone: ['Подтвердить выполнение', 'Bajarilganini tasdiqlash'],
  confirmDoneAsk: ['Подтвердить, что заказ выполнен?', 'Buyurtma bajarilganini tasdiqlaysizmi?'],
  waitOtherSide: ['Ждём подтверждения второй стороны', 'Ikkinchi tomon tasdiqini kutyapmiz'],
  youConfirmed: ['Вы подтвердили', 'Siz tasdiqladingiz'],
  rate: ['Оцените сделку', 'Bitimni baholang'],
  reviewPlaceholder: ['Пара слов о том, как всё прошло', "Qanday o'tgani haqida bir-ikki so'z"],
  sendReview: ['Отправить отзыв', 'Fikr yuborish'],
  thanksReview: ['Спасибо за отзыв!', 'Fikringiz uchun rahmat!'],
  report: ['Пожаловаться', 'Shikoyat qilish'],
  reportPrompt: ['Опишите проблему', 'Muammoni tasvirlang'],
  reportSent: ['Жалоба отправлена, модератор разберётся', "Shikoyat yuborildi, moderator ko'rib chiqadi"],

  // чаты
  noChats: ['Переписка появится после первого отклика', 'Yozishma birinchi taklifdan keyin paydo bo‘ladi'],
  messagePlaceholder: ['Сообщение', 'Xabar'],
  send: ['Отправить', 'Yuborish'],

  // профиль
  profile: ['Профиль', 'Profil'],
  phone: ['Телефон', 'Telefon'],
  phoneNotConfirmed: ['Номер не подтверждён', 'Raqam tasdiqlanmagan'],
  confirmPhone: ['Подтвердить номер', 'Raqamni tasdiqlash'],
  phoneWhy: ['Номер получит только выбранный вами исполнитель', 'Raqamni faqat siz tanlagan ijrochi oladi'],
  language: ['Язык', 'Til'],
  companies: ['Компании', 'Kompaniyalar'],
  createCompany: ['Добавить компанию', "Kompaniya qo'shish"],
  plan: ['Тариф', 'Tarif'],
  planUntil: ['действует до', 'amal qiladi'],
  planFree: ['Бесплатный', 'Bepul'],
  offersUsed: ['Отклики в этом месяце', 'Shu oydagi takliflar'],
  unlimited: ['без лимита', 'cheklovsiz'],
  notifyDelay: ['Заявки приходят с задержкой', "So'rovlar kechikish bilan keladi"],
  minutes: ['мин', 'daq'],
  noDelay: ['Заявки приходят сразу', "So'rovlar darhol keladi"],
  contactManager: ['Связаться с менеджером', "Menejer bilan bog'lanish"],
  managerWillContact: ['Менеджер свяжется с вами в рабочее время', "Menejer ish vaqtida siz bilan bog'lanadi"],
  planHint: [
    'Тариф подключает менеджер: он пришлёт счёт на компанию. Оплатить можно переводом со счёта или картой по ссылке.',
    "Tarifni menejer ulaydi: kompaniyaga hisob yuboradi. Hisobdan o'tkazma yoki havola orqali karta bilan to'lash mumkin.",
  ],
  support: ['Поддержка', "Qo'llab-quvvatlash"],
  notifications: ['Уведомления в боте', 'Botdagi bildirishnomalar'],
  enableNotifications: ['Разрешить уведомления', 'Bildirishnomalarga ruxsat berish'],
  notificationsOn: ['Включены', 'Yoqilgan'],

  // онбординг
  companyName: ['Название компании', 'Kompaniya nomi'],
  companyType: ['Форма', 'Shakl'],
  llc: ['ООО', 'MChJ'],
  ip: ['ИП', 'YaTT'],
  other: ['Другое', 'Boshqa'],
  inn: ['ИНН (9 цифр) или ПИНФЛ для ИП', 'STIR (9 raqam) yoki YaTT uchun JShShIR'],
  innHint: ['После проверки ИНН рядом с компанией появится отметка «ИНН проверен»', "STIR tekshirilgach, kompaniya yonida «STIR tekshirilgan» belgisi paydo bo'ladi"],
  about: ['О компании', 'Kompaniya haqida'],
  step: ['Шаг', 'Qadam'],
  whatYouDo: ['Что вы делаете', 'Nima bilan shug‘ullanasiz'],
  whereYouWork: ['Где работаете', 'Qayerda ishlaysiz'],
  mainRegion: ['Основной город или район', 'Asosiy shahar yoki tuman'],
  alsoServe: ['Также обслуживаете', 'Shuningdek xizmat ko‘rsatasiz'],
  nationwide: ['Доставка по всей стране', "Butun mamlakat bo'ylab yetkazib berish"],
  finish: ['Готово', 'Tayyor'],
  maxCategories: ['На бесплатном тарифе до 3 категорий', 'Bepul tarifda 3 tagacha toifa'],
  editCompany: ['Изменить компанию', "Kompaniyani o'zgartirish"],
  saved: ['Сохранено', 'Saqlandi'],
} as const;

export type Key = keyof typeof D;

export function translate(lang: Lang, key: Key): string {
  const [ru, uz] = D[key];
  if (lang === 'ru') return ru;
  if (lang === 'uz') return uz;
  return uzLatinToCyrillic(uz);
}

export const LangContext = createContext<Lang>('ru');

export function useT() {
  const lang = useContext(LangContext);
  return Object.assign((key: Key) => translate(lang, key), { lang });
}

export const LANG_NAMES: Record<Lang, string> = { ru: 'Русский', uz: "O'zbekcha", uzc: 'Ўзбекча' };
