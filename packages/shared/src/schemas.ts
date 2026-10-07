import { z } from 'zod';
import { ACTIVE_ROLES, COMPANY_TYPES, LANGS } from './enums';

/** Схемы тел запросов API. Одни и те же схемы валидируют форму на фронте и запрос на бэкенде. */

export const updateMeSchema = z.object({
  lang: z.enum(LANGS).optional(),
  activeRole: z.enum(ACTIVE_ROLES).optional(),
  activeCompanyId: z.number().int().positive().nullable().optional(),
});
export type UpdateMeDto = z.infer<typeof updateMeSchema>;

/** ИНН в Узбекистане: 9 цифр у юрлиц, у ИП используется ПИНФЛ из 14 цифр. */
export const innSchema = z
  .string()
  .trim()
  .regex(/^(\d{9}|\d{14})$/, 'ИНН: 9 цифр, для ИП — 14 цифр ПИНФЛ');

export const createCompanySchema = z.object({
  name: z.string().trim().min(2).max(200),
  type: z.enum(COMPANY_TYPES),
  inn: innSchema.optional(),
  regionCode: z.string().min(2).max(64),
  isSupplier: z.boolean().default(false),
  isBuyer: z.boolean().default(true),
  about: z.string().trim().max(1000).optional(),
  categoryIds: z.array(z.number().int().positive()).max(30).default([]),
  areas: z
    .array(z.object({ regionCode: z.string().min(2).max(64) }))
    .max(40)
    .default([]),
  deliversNationwide: z.boolean().default(false),
});
export type CreateCompanyDto = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = createCompanySchema.partial();
export type UpdateCompanyDto = z.infer<typeof updateCompanySchema>;

export const GIG_PACKAGE_CODES = ['basic', 'standard', 'premium'] as const;
export type GigPackageCode = (typeof GIG_PACKAGE_CODES)[number];

/** Пакет услуги на витрине исполнителя. */
export interface GigPackage {
  code: GigPackageCode;
  name: string;
  priceUzs: number;
  days: number;
  revisions: number;
  summary: string;
  features: string[];
}

/** Загруженная продавцом картинка услуги хранится как «f:<fileId>»; демо — как путь к статике. */
export const GIG_IMAGE_RE = /^(f:\d{1,12}|\/demo\/[\w-]{1,40}\.svg)$/;
export const GIG_LIMITS = { titleMin: 15, titleMax: 120, descMin: 40, descMax: 3000, images: 6, tags: 5, features: 8, perCompany: 20 } as const;

export const gigPackageSchema = z.object({
  code: z.enum(GIG_PACKAGE_CODES),
  name: z.string().trim().min(1).max(30),
  priceUzs: z.number().int().min(10_000).max(10_000_000_000),
  days: z.number().int().min(1).max(90),
  revisions: z.number().int().min(0).max(10),
  summary: z.string().trim().max(160).default(''),
  features: z.array(z.string().trim().min(1).max(80)).max(GIG_LIMITS.features).default([]),
});

export const gigUpsertSchema = z
  .object({
    companyId: z.number().int().positive(),
    categoryId: z.number().int().positive(),
    title: z.string().trim().min(GIG_LIMITS.titleMin).max(GIG_LIMITS.titleMax),
    description: z.string().trim().min(GIG_LIMITS.descMin).max(GIG_LIMITS.descMax),
    gallery: z.array(z.string().regex(GIG_IMAGE_RE)).min(1).max(GIG_LIMITS.images),
    packages: z.array(gigPackageSchema).min(1).max(3),
    tags: z.array(z.string().trim().min(2).max(24)).max(GIG_LIMITS.tags).default([]),
    active: z.boolean().default(true),
  })
  .superRefine((g, ctx) => {
    const codes = g.packages.map((p) => p.code);
    if (new Set(codes).size !== codes.length) ctx.addIssue({ code: 'custom', path: ['packages'], message: 'Пакеты повторяются' });
    // Как на Fiverr: старший пакет не может стоить меньше младшего — иначе покупатель не поймёт разницу.
    const sorted = [...g.packages].sort((a, b) => GIG_PACKAGE_CODES.indexOf(a.code) - GIG_PACKAGE_CODES.indexOf(b.code));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].priceUzs <= sorted[i - 1].priceUzs) {
        ctx.addIssue({ code: 'custom', path: ['packages', i, 'priceUzs'], message: 'Цена старшего пакета должна быть выше младшего' });
      }
    }
  });
export type GigUpsertDto = z.infer<typeof gigUpsertSchema>;

export const parseRequestSchema = z.object({
  text: z.string().trim().max(4000).default(''),
  fileIds: z.array(z.number().int().positive()).max(10).default([]),
  regionCode: z.string().max(64).optional(),
  /** Заказ с витрины: услуга и пакет. Заявка сначала уйдёт этому исполнителю. */
  gigId: z.number().int().positive().optional(),
  packageCode: z.enum(GIG_PACKAGE_CODES).optional(),
});
export type ParseRequestDto = z.infer<typeof parseRequestSchema>;

/** Точка доставки, выбранная на карте. */
export const deliveryPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().trim().max(300).optional(),
});
export type DeliveryPoint = z.infer<typeof deliveryPointSchema>;

export const submitRequestSchema = z.object({
  requestId: z.number().int().positive(),
  categoryId: z.number().int().positive().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  regionCode: z.string().max(64).optional(),
  title: z.string().trim().min(3).max(200).optional(),
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  budgetUzs: z.number().int().positive().max(100_000_000_000).nullable().optional(),
  deliveryNeeded: z.boolean().nullable().optional(),
  delivery: deliveryPointSchema.nullable().optional(),
});
export type SubmitRequestDto = z.infer<typeof submitRequestSchema>;

export const answerRequestSchema = z
  .object({
    answer: z.string().trim().max(1000).default(''),
    /**
     * Быстрый ответ кнопкой: значение сразу записывается в поле или параметр заявки
     * (quantity, deadline, budget, delivery, location), без повторного разбора.
     */
    field: z.string().max(64).optional(),
    value: z.union([z.string().max(200), z.number(), z.boolean(), deliveryPointSchema]).optional(),
    /** Пропустить необязательный вопрос. */
    skip: z.boolean().optional(),
  })
  .refine((d) => d.answer.length > 0 || d.field !== undefined, { message: 'Пустой ответ' });
export type AnswerRequestDto = z.infer<typeof answerRequestSchema>;

export const createOfferSchema = z.object({
  priceUzs: z.number().int().positive().max(100_000_000_000),
  leadTimeDays: z.number().int().min(0).max(365),
  comment: z.string().trim().max(1000).optional(),
  fileIds: z.array(z.number().int().positive()).max(5).default([]),
});
export type CreateOfferDto = z.infer<typeof createOfferSchema>;

export const reviewSchema = z.object({
  stars: z.number().int().min(1).max(5),
  text: z.string().trim().max(1000).optional(),
});
export type ReviewDto = z.infer<typeof reviewSchema>;

export const sendMessageSchema = z.object({
  text: z.string().trim().max(4000).optional(),
  fileId: z.number().int().positive().optional(),
}).refine((v) => !!v.text || !!v.fileId, { message: 'Пустое сообщение' });
export type SendMessageDto = z.infer<typeof sendMessageSchema>;

export const uploadRequestSchema = z.object({
  fileName: z.string().min(1).max(200),
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'audio/ogg']),
  size: z.number().int().positive().max(20 * 1024 * 1024),
});
export type UploadRequestDto = z.infer<typeof uploadRequestSchema>;

export const complaintSchema = z.object({
  targetType: z.enum(['request', 'offer', 'company', 'message']),
  targetId: z.number().int().positive(),
  reason: z.string().trim().min(3).max(1000),
});
export type ComplaintDto = z.infer<typeof complaintSchema>;

/** Результат ИИ-разбора. Модель обязана вернуть ровно такую структуру. */
export const parseResultSchema = z.object({
  categorySlug: z.string().nullable(),
  title: z.string().max(200),
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  regionCode: z.string().nullable(),
  deadline: z.string().nullable(),
  budgetUzs: z.number().nullable(),
  quantity: z.number().nullable(),
  /** Нужна ли доставка, если покупатель сказал об этом сам; адрес — как написал. */
  delivery: z.boolean().nullable().default(null),
  deliveryAddress: z.string().max(300).nullable().default(null),
  missingFields: z.array(z.string()),
  question: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  lang: z.enum(['ru', 'uz', 'uzc']),
});
export type ParseResult = z.infer<typeof parseResultSchema>;
