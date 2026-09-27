import { Logger } from '@nestjs/common';
import { users, type Db } from '@dominify/db';
import { pickLang, type Lang } from '@dominify/shared';
import { eq } from 'drizzle-orm';
import { Bot, GrammyError, InlineKeyboard, Keyboard, type Context } from 'grammy';
import IORedis from 'ioredis';
import type { Config } from '../config';
import { AppError } from '../common/http';
import { FilesService } from '../files/files';
import { ParsingService } from '../parsing/parsing.service';
import { RequestsService } from '../requests/requests.service';
import { UsersService } from '../users/users.service';

export interface BotDeps {
  cfg: Config;
  db: Db;
  redis: IORedis;
  users: UsersService;
  requests: RequestsService;
  files: FilesService;
  parsing: ParsingService;
}

const TXT = {
  welcome: {
    ru: 'Здравствуйте! Я помогу найти поставщика для полиграфии и наружной рекламы.\n\nПросто напишите, что нужно, — текстом, голосом или фото. Например: «1000 визиток 90×50, двусторонние, к пятнице, Чиланзар».\n\nЯ разберу заявку и отправлю её пяти лучшим поставщикам рядом.',
    uz: "Assalomu alaykum! Poligrafiya va tashqi reklama bo'yicha yetkazib beruvchi topishga yordam beraman.\n\nNima kerakligini yozing — matn, ovoz yoki rasm bilan. Masalan: «1000 ta vizitka 90×50, ikki tomonlama, jumagacha, Chilonzor».\n\nSo'rovni tahlil qilib, eng yaxshi 5 ta yetkazib beruvchiga yuboraman.",
    uzc: 'Ассалому алайкум! Полиграфия ва ташқи реклама бўйича етказиб берувчи топишга ёрдам бераман.\n\nНима кераклигини ёзинг — матн, овоз ёки расм билан. Масалан: «1000 та визитка 90×50, икки томонлама, жумагача, Чилонзор».\n\nСўровни таҳлил қилиб, энг яхши 5 та етказиб берувчига юбораман.',
  },
  open: { ru: 'Открыть Dominify', uz: 'Dominify ni ochish', uzc: 'Dominify ни очиш' },
  parsing: { ru: 'Разбираю заявку…', uz: "So'rovni tahlil qilyapman…", uzc: 'Сўровни таҳлил қиляпман…' },
  answerTaken: { ru: 'Спасибо, уточняю заявку…', uz: 'Rahmat, aniqlashtiryapman…', uzc: 'Раҳмат, аниқлаштиряпман…' },
  askPhone: {
    ru: 'Нажмите кнопку ниже, чтобы поделиться своим номером. Он нужен, чтобы исполнитель мог с вами связаться.',
    uz: "Raqamingizni yuborish uchun quyidagi tugmani bosing. U ijrochi siz bilan bog'lanishi uchun kerak.",
    uzc: 'Рақамингизни юбориш учун қуйидаги тугмани босинг. У ижрочи сиз билан боғланиши учун керак.',
  },
  sharePhone: { ru: 'Поделиться номером', uz: 'Raqamni yuborish', uzc: 'Рақамни юбориш' },
  notYourPhone: { ru: 'Пришлите, пожалуйста, свой номер кнопкой ниже.', uz: "Iltimos, o'z raqamingizni tugma orqali yuboring.", uzc: 'Илтимос, ўз рақамингизни тугма орқали юборинг.' },
  phoneSaved: { ru: 'Спасибо, номер подтверждён.', uz: 'Rahmat, raqam tasdiqlandi.', uzc: 'Раҳмат, рақам тасдиқланди.' },
  voiceOff: {
    ru: 'Голосовые пока не распознаю. Напишите, пожалуйста, текстом.',
    uz: "Hozircha ovozli xabarlarni tushunmayman. Iltimos, matn bilan yozing.",
    uzc: 'Ҳозирча овозли хабарларни тушунмайман. Илтимос, матн билан ёзинг.',
  },
  submitted: { ru: 'Отправлено поставщикам ✅', uz: 'Yetkazib beruvchilarga yuborildi ✅', uzc: 'Етказиб берувчиларга юборилди ✅' },
  error: { ru: 'Что-то пошло не так. Попробуйте ещё раз чуть позже.', uz: "Nimadir xato ketdi. Birozdan keyin qayta urinib ko'ring.", uzc: 'Нимадир хато кетди. Бироздан кейин қайта уриниб кўринг.' },
  tooLarge: { ru: 'Файл больше 20 МБ, пришлите поменьше.', uz: 'Fayl 20 MB dan katta.', uzc: 'Файл 20 MB дан катта.' },
};

const MIME_OK = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

/** Бот: вход, телефон, быстрые заявки прямо в чате и кнопки из уведомлений. */
export function createBot(d: BotDeps): Bot {
  const log = new Logger('Bot');
  const bot = new Bot(d.cfg.BOT_TOKEN);
  const miniApp = (route = 'home') => `${d.cfg.MINIAPP_URL.replace(/\/$/, '')}/?r=${encodeURIComponent(route)}`;

  const userOf = async (ctx: Context) => {
    const from = ctx.from!;
    const u = await d.users.upsertFromTelegram(
      { id: from.id, first_name: from.first_name, last_name: from.last_name, username: from.username, language_code: from.language_code },
      { botStarted: true },
    );
    return { user: u, lang: pickLang(u.lang) as Lang };
  };

  const openKb = (lang: Lang, route = 'home') => new InlineKeyboard().webApp(TXT.open[lang], miniApp(route));

  bot.command('start', async (ctx) => {
    const { user, lang } = await userOf(ctx);
    const payload = ctx.match?.trim();
    if (payload === 'phone') {
      await ctx.reply(TXT.askPhone[lang], {
        reply_markup: new Keyboard().requestContact(TXT.sharePhone[lang]).resized().oneTime(),
      });
      return;
    }
    await ctx.reply(TXT.welcome[lang], { reply_markup: openKb(lang, payload || 'home') });
    log.log(`start ${user.id}`);
  });

  bot.command('phone', async (ctx) => {
    const { lang } = await userOf(ctx);
    await ctx.reply(TXT.askPhone[lang], { reply_markup: new Keyboard().requestContact(TXT.sharePhone[lang]).resized().oneTime() });
  });

  bot.command('app', async (ctx) => {
    const { lang } = await userOf(ctx);
    await ctx.reply(TXT.open[lang], { reply_markup: openKb(lang) });
  });

  // Телефон принимаем, только если человек поделился своим номером (contact.user_id совпадает с отправителем).
  bot.on('message:contact', async (ctx) => {
    const { user, lang } = await userOf(ctx);
    const c = ctx.message.contact;
    if (c.user_id !== ctx.from.id) {
      await ctx.reply(TXT.notYourPhone[lang]);
      return;
    }
    await d.users.setVerifiedPhone(user.id, c.phone_number);
    await ctx.reply(TXT.phoneSaved[lang], { reply_markup: { remove_keyboard: true } });
    await ctx.reply('👇', { reply_markup: openKb(lang) });
  });

  /** Текст — ответ на уточняющий вопрос, если он ждёт ответа, иначе новая заявка. */
  const handleText = async (ctx: Context, text: string, fileIds: number[] = []) => {
    const { user, lang } = await userOf(ctx);
    const awaiting = await d.redis.get(`await:${user.id}`);
    if (awaiting && fileIds.length === 0) {
      await d.redis.del(`await:${user.id}`);
      try {
        await d.requests.answer(user.id, Number(awaiting), text);
        await ctx.reply(TXT.answerTaken[lang]);
        return;
      } catch {
        // Заявка уже отправлена или отменена: считаем сообщение новой заявкой.
      }
    }
    await d.requests.createDraft(user.id, { text, fileIds }, 'bot');
    await ctx.reply(TXT.parsing[lang]);
  };

  bot.on('message:text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;
    await handleText(ctx, ctx.message.text.slice(0, 4000));
  });

  const download = async (fileId: string): Promise<Buffer> => {
    const f = await ctx_api_getFile(bot, fileId);
    const res = await fetch(`https://api.telegram.org/file/bot${d.cfg.BOT_TOKEN}/${f}`);
    if (!res.ok) throw new Error(`Не удалось скачать файл: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };

  bot.on('message:photo', async (ctx) => {
    const { user } = await userOf(ctx);
    const best = ctx.message.photo[ctx.message.photo.length - 1];
    const buf = await download(best.file_id);
    const saved = await d.files.saveBuffer(user.id, buf, 'image/jpeg', 'photo.jpg', best.file_id);
    await handleText(ctx, ctx.message.caption ?? '', [saved.id]);
  });

  bot.on('message:document', async (ctx) => {
    const { user, lang } = await userOf(ctx);
    const doc = ctx.message.document;
    if (!doc.mime_type || !MIME_OK.has(doc.mime_type)) return;
    if ((doc.file_size ?? 0) > 20 * 1024 * 1024) {
      await ctx.reply(TXT.tooLarge[lang]);
      return;
    }
    const buf = await download(doc.file_id);
    const saved = await d.files.saveBuffer(user.id, buf, doc.mime_type, doc.file_name ?? 'file', doc.file_id);
    await handleText(ctx, ctx.message.caption ?? '', [saved.id]);
  });

  bot.on('message:voice', async (ctx) => {
    const { user, lang } = await userOf(ctx);
    const v = ctx.message.voice;
    const buf = await download(v.file_id);
    const text = await d.parsing.speechToText(buf, 'voice.ogg', 'audio/ogg');
    if (!text) {
      await ctx.reply(TXT.voiceOff[lang]);
      return;
    }
    const saved = await d.files.saveBuffer(user.id, buf, 'audio/ogg', 'voice.ogg', v.file_id);
    await ctx.reply(`«${text.slice(0, 500)}»`);
    const awaiting = await d.redis.get(`await:${user.id}`);
    await handleText(ctx, text, awaiting ? [] : [saved.id]);
  });

  // Кнопка «Отправить» под разобранной заявкой.
  bot.callbackQuery(/^submit:(\d+)$/, async (ctx) => {
    const { user, lang } = await userOf(ctx);
    const id = Number(ctx.match[1]);
    try {
      await d.requests.submit(user.id, { requestId: id });
      await ctx.answerCallbackQuery({ text: TXT.submitted[lang] });
      await ctx.editMessageReplyMarkup({ reply_markup: openKb(lang, `req_${id}`) }).catch(() => undefined);
    } catch (e) {
      const msg = e instanceof AppError ? ((e.getResponse() as { message?: string }).message ?? TXT.error[lang]) : TXT.error[lang];
      await ctx.answerCallbackQuery({ text: msg.slice(0, 190), show_alert: true });
    }
  });

  // Пользователь заблокировал или разблокировал бота.
  bot.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    const blocked = status === 'kicked';
    await d.db.update(users).set({ botBlocked: blocked, ...(blocked ? {} : { botStarted: true }) }).where(eq(users.telegramId, ctx.from.id));
  });

  bot.catch(async (err) => {
    log.error(`Ошибка в апдейте ${err.ctx.update.update_id}: ${err.error instanceof Error ? err.error.message : String(err.error)}`);
    if (err.error instanceof GrammyError) return;
    const lang = pickLang(err.ctx.from?.language_code) as Lang;
    await err.ctx.reply(TXT.error[lang]).catch(() => undefined);
  });

  return bot;
}

async function ctx_api_getFile(bot: Bot, fileId: string): Promise<string> {
  const f = await bot.api.getFile(fileId);
  if (!f.file_path) throw new Error('Telegram не вернул путь к файлу');
  return f.file_path;
}

/** Меню и команды бота: кнопка меню открывает Mini App. */
export async function configureBot(bot: Bot, cfg: Config) {
  await bot.api.setMyCommands([
    { command: 'start', description: 'Начать' },
    { command: 'app', description: 'Открыть приложение' },
    { command: 'phone', description: 'Подтвердить номер' },
  ]);
  await bot.api.setMyCommands(
    [
      { command: 'start', description: 'Boshlash' },
      { command: 'app', description: 'Ilovani ochish' },
      { command: 'phone', description: 'Raqamni tasdiqlash' },
    ],
    { language_code: 'uz' },
  );
  if (cfg.MINIAPP_URL.startsWith('https://')) {
    await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Dominify', web_app: { url: cfg.MINIAPP_URL } } });
  }
}
