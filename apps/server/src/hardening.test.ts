import { describe, expect, it } from 'vitest';
import { CONTACT_PLACEHOLDER, maskContacts } from './common/contacts';
import { devAuthAllowed, type Config } from './config';
import { decideReview, type ReviewContext } from './deals/review-signals';
import { matchesMime } from './files/sniff';
import { render } from './notifications/templates';

describe('maskContacts', () => {
  const masked = (s: string) => maskContacts(s).text;

  it('скрывает узбекские номера в разных записях', () => {
    for (const phone of ['+998 90 123 45 67', '998901234567', '(93) 123-45-67', '90.123.45.67', '+998-71-200-00-00', '97 1234567']) {
      expect(masked(`звоните ${phone} в любое время`)).toBe(`звоните ${CONTACT_PLACEHOLDER} в любое время`);
    }
  });

  it('скрывает почту, @username и ссылки на мессенджеры', () => {
    expect(masked('пишите sales@print.uz')).toBe(`пишите ${CONTACT_PLACEHOLDER}`);
    expect(masked('мой тг @printmaster_uz')).toBe(`мой тг ${CONTACT_PLACEHOLDER}`);
    expect(masked('https://t.me/printmaster')).toBe(CONTACT_PLACEHOLDER);
    expect(masked('wa.me/998901234567')).toBe(CONTACT_PLACEHOLDER);
    expect(masked('instagram.com/print.uz')).toBe(CONTACT_PLACEHOLDER);
  });

  it('не трогает цены, тиражи и размеры', () => {
    const text = '1000 визиток 90×50, цена 350 000 сум, срок 3 дня, тираж 5000, баннер 3x6 м, 4+4';
    expect(maskContacts(text)).toEqual({ text, masked: false });
    expect(masked('итого 1 250 000 сум')).toBe('итого 1 250 000 сум');
  });

  it('сообщает, что текст изменён', () => {
    expect(maskContacts('+998901234567').masked).toBe(true);
    expect(maskContacts('без контактов').masked).toBe(false);
  });
});

describe('matchesMime', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const pdf = Buffer.from('%PDF-1.7\n');
  const html = Buffer.from('<html><script>alert(1)</script></html>');

  it('узнаёт форматы по сигнатуре', () => {
    expect(matchesMime(jpeg, 'image/jpeg')).toBe(true);
    expect(matchesMime(png, 'image/png')).toBe(true);
    expect(matchesMime(pdf, 'application/pdf')).toBe(true);
    expect(matchesMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 '), 'image/webp')).toBe(true);
    expect(matchesMime(Buffer.from('OggS\0'), 'audio/ogg')).toBe(true);
  });

  it('отклоняет подмену типа и неизвестные типы', () => {
    expect(matchesMime(html, 'image/jpeg')).toBe(false);
    expect(matchesMime(html, 'application/pdf')).toBe(false);
    expect(matchesMime(png, 'image/jpeg')).toBe(false);
    expect(matchesMime(html, 'text/html')).toBe(false);
    expect(matchesMime(Buffer.alloc(0), 'image/png')).toBe(false);
  });
});

describe('decideReview', () => {
  const clean: ReviewContext = { authorPhoneVerified: true, authorPhoneMatchesTarget: false, authorIsTargetMember: false, recentCountedPairReviews: 0 };

  it('обычный отзыв учитывается', () => {
    expect(decideReview(clean)).toEqual({ counted: true, flag: null });
  });

  it('отзыв самому себе и с того же номера не учитывается', () => {
    expect(decideReview({ ...clean, authorIsTargetMember: true })).toEqual({ counted: false, flag: 'self_review' });
    expect(decideReview({ ...clean, authorPhoneMatchesTarget: true })).toEqual({ counted: false, flag: 'same_phone' });
  });

  it('без подтверждённого телефона и повторный отзыв не учитываются', () => {
    expect(decideReview({ ...clean, authorPhoneVerified: false })).toEqual({ counted: false, flag: 'unverified_author' });
    expect(decideReview({ ...clean, recentCountedPairReviews: 1 })).toEqual({ counted: false, flag: 'repeat_pair' });
  });

  it('самый явный признак важнее остальных', () => {
    expect(decideReview({ authorPhoneVerified: false, authorPhoneMatchesTarget: true, authorIsTargetMember: true, recentCountedPairReviews: 3 }).flag).toBe('self_review');
  });
});

describe('devAuthAllowed', () => {
  const cfg = (NODE_ENV: Config['NODE_ENV'], DEV_AUTH: boolean) => ({ NODE_ENV, DEV_AUTH }) as unknown as Config;

  it('работает только в development и test', () => {
    expect(devAuthAllowed(cfg('development', true))).toBe(true);
    expect(devAuthAllowed(cfg('test', true))).toBe(true);
    expect(devAuthAllowed(cfg('staging', true))).toBe(false);
    expect(devAuthAllowed(cfg('production', true))).toBe(false);
    expect(devAuthAllowed(cfg('development', false))).toBe(false);
  });
});

describe('новые шаблоны уведомлений', () => {
  it('рендерятся на всех языках с кнопкой в приложение', () => {
    const cases = [
      ['deal_cancelled', { requestId: 5, dealId: 2, reason: 'передумали' }],
      ['deal_disputed', { requestId: 5, dealId: 2 }],
      ['deal_resolved', { requestId: 5, dealId: 2, outcome: 'сделка продолжается', note: '' }],
      ['deal_reminder', { requestId: 5, dealId: 2, title: 'Баннер' }],
      ['request_reopened', { requestId: 5, title: 'Баннер' }],
      ['team_joined', { name: 'Азиз' }],
    ] as const;
    for (const [type, payload] of cases) {
      for (const lang of ['ru', 'uz', 'uzc'] as const) {
        const r = render(type, payload, lang);
        expect(r.text.length).toBeGreaterThan(10);
        expect(r.text).not.toContain('undefined');
        expect(r.buttons[0]?.route).toBeTruthy();
      }
    }
  });
});
