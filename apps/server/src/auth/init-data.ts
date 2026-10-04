import { createHash, createHmac } from 'node:crypto';
import { safeEqualHex } from '../common/crypto';

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
  /** Пользователь разрешил боту писать ему (флаг из initData). */
  allows_write_to_pm?: boolean;
}

export interface ValidInitData {
  user: TelegramUser;
  authDate: number;
  startParam?: string;
  queryId?: string;
}

export class InitDataError extends Error {}

/**
 * Проверка initData из Telegram Mini App.
 * secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
 * hash = hex(HMAC_SHA256(key=secret_key, msg=data_check_string)),
 * data_check_string — все поля кроме hash, отсортированные, в виде key=value через \n.
 * Поле signature (Ed25519 для сторонней проверки) входит в строку: без него подпись новых клиентов не сходится.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateInitData(raw: string, botToken: string, maxAgeSec: number, now = Date.now()): ValidInitData {
  if (!raw) throw new InitDataError('initData пустая');
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash) throw new InitDataError('Нет подписи');

  const pairs: string[] = [];
  params.forEach((value, key) => {
    if (key !== 'hash') pairs.push(`${key}=${value}`);
  });
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!safeEqualHex(expected, hash)) throw new InitDataError('Подпись не совпадает');

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0) throw new InitDataError('Нет auth_date');
  if (now / 1000 - authDate > maxAgeSec) throw new InitDataError('initData устарела');

  const userRaw = params.get('user');
  if (!userRaw) throw new InitDataError('Нет пользователя');
  const user = JSON.parse(userRaw) as TelegramUser;
  if (!user?.id) throw new InitDataError('Нет ID пользователя');

  return {
    user,
    authDate,
    startParam: params.get('start_param') ?? undefined,
    queryId: params.get('query_id') ?? undefined,
  };
}

/** Подписать initData так, как это делает Telegram. Нужно для тестов и e2e. */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  const params = new URLSearchParams(fields);
  params.set('hash', hash);
  return params.toString();
}

/**
 * Проверка данных Telegram Login Widget (вход в админку).
 * secret_key = SHA256(bot_token), hash = hex(HMAC_SHA256(secret_key, data_check_string)).
 * https://core.telegram.org/widgets/login#checking-authorization
 */
export function validateLoginWidget(
  data: Record<string, string | number>,
  botToken: string,
  maxAgeSec: number,
  now = Date.now(),
): TelegramUser {
  const { hash, ...rest } = data;
  if (!hash) throw new InitDataError('Нет подписи');
  const dataCheckString = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('\n');
  const secret = createHash('sha256').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!safeEqualHex(expected, String(hash))) throw new InitDataError('Подпись не совпадает');
  const authDate = Number(rest.auth_date);
  if (!authDate || now / 1000 - authDate > maxAgeSec) throw new InitDataError('Данные входа устарели');
  return {
    id: Number(rest.id),
    first_name: rest.first_name as string | undefined,
    last_name: rest.last_name as string | undefined,
    username: rest.username as string | undefined,
  };
}
