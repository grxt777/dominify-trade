import type { GigPackage } from '@dominify/shared';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { createDb, type Db } from './client';
import { seedCatalog } from './seed';
import {
  categories,
  chats,
  companies,
  deals,
  gigs,
  memberships,
  offers,
  requests,
  reviews,
  serviceAreas,
  subscriptions,
  supplierCategories,
  users,
} from './schema';

/**
 * Демо-витрина: шесть исполнителей с услугами, пакетами и отзывами по закрытым сделкам.
 * Нужна для показа продукта и разработки интерфейса. Войти за исполнителя локально: ?dev=<telegramId>.
 *   node dist/demo.js          — пересоздать демо-данные
 *   node dist/demo.js --remove — удалить их
 */

const SELLER_TG = 9_900_000_000;
const BUYER_TG = 9_900_100_000;
const TG_RANGE_END = 9_900_200_000;

interface DemoReview {
  buyer: number;
  stars: number;
  text: string;
  amountUzs: number;
  daysAgo: number;
}

interface DemoSeller {
  owner: string;
  company: string;
  about: string;
  categories: string[];
  trustLevel: number;
  ratingAvg: number;
  ratingCount: number;
  dealsClosed: number;
  responseMin: number;
  sinceDaysAgo: number;
  gig: {
    category: string;
    title: string;
    description: string;
    cover: string;
    gallery: string[];
    tags: string[];
    ordersCount: number;
    packages: GigPackage[];
  };
  reviews: DemoReview[];
}

const pkg = (code: GigPackage['code'], name: string, priceUzs: number, days: number, revisions: number, summary: string, features: string[]): GigPackage => ({
  code,
  name,
  priceUzs,
  days,
  revisions,
  summary,
  features,
});

const BUYERS = ['Aziz', 'Malika', 'Sardor', 'Dilnoza', 'Otabek', 'Kamola', 'Rustam', 'Gulnora'];

export const DEMO_SELLERS: DemoSeller[] = [
  {
    owner: 'Jasur',
    company: 'Banner Pro Toshkent',
    about: "8 yildan beri banner va keng formatli chop etish bilan shug'ullanamiz. O'z ustaxonamiz Chilonzorda, 3,2 metrli printer.",
    categories: ['ads.banners', 'print.large-format', 'ads.install'],
    trustLevel: 2,
    ratingAvg: 4.9,
    ratingCount: 128,
    dealsClosed: 214,
    responseMin: 12,
    sinceDaysAgo: 900,
    gig: {
      category: 'ads.banners',
      title: 'Bannerni 24 soatda chop etaman va o‘rnatib beraman',
      description:
        "Do'kon, tadbir yoki aksiya uchun banner. 440–510 g/m² banner matosi, ko'chada 2–3 yil rangini yo'qotmaydi. Maketingiz bo'lmasa, dizaynerimiz tayyorlab beradi. Toshkent bo'ylab yetkazish va balandlikda o'rnatish xizmati bor.",
      cover: '/demo/banner.svg',
      gallery: ['/demo/banner.svg', '/demo/storefront.svg'],
      tags: ['banner', 'chop etish', "o'rnatish"],
      ordersCount: 214,
      packages: [
        pkg('basic', 'Oddiy', 180_000, 1, 1, 'Banner 3×2 m, tayyor maketingiz bilan', ['3×2 m gacha', 'Lyuverslar', 'Ofisdan olib ketish']),
        pkg('standard', 'Standart', 390_000, 2, 2, 'Banner 6×3 m, lyuvers va yetkazib berish', ['6×3 m gacha', 'Lyuverslar va kantlash', 'Toshkent bo‘ylab yetkazish', 'Maketni tekshirish']),
        pkg('premium', 'Premium', 750_000, 3, 3, 'Dizayn, chop etish va o‘rnatish — hammasi bitta joyda', ['6×3 m gacha', 'Banner dizayni', 'Yetkazish', '5 m gacha balandlikda o‘rnatish']),
      ],
    },
    reviews: [
      { buyer: 0, stars: 5, text: "Kechqurun buyurtma berdim, ertalab banner do'kon ustida turgan edi. Ranglar maketdagidek chiqdi.", amountUzs: 390_000, daysAgo: 6 },
      { buyer: 1, stars: 5, text: "Aksiya uchun 4 ta banner qildirdik. Narx kelishilgandek, o'rnatishgacha o'zlari qilishdi.", amountUzs: 1_400_000, daysAgo: 21 },
      { buyer: 2, stars: 4, text: 'Sifat zo‘r, faqat yetkazish 2 soatga kechikdi. Oldindan ogohlantirishdi.', amountUzs: 180_000, daysAgo: 40 },
      { buyer: 3, stars: 5, text: 'Dizaynni ham ular qilib berishdi, 2 marta tuzatishdi. Tavsiya qilaman.', amountUzs: 750_000, daysAgo: 75 },
    ],
  },
  {
    owner: 'Nilufar',
    company: 'Logo Studio Nilufar',
    about: "Brend dizayneri. 300 dan ortiq logotip: kafe, klinika, qurilish kompaniyalari. Avval brifingda biznesingizni o'rganaman, keyin chizaman.",
    categories: ['design.logo', 'design.identity', 'design.layout'],
    trustLevel: 1,
    ratingAvg: 5.0,
    ratingCount: 64,
    dealsClosed: 71,
    responseMin: 25,
    sinceDaysAgo: 540,
    gig: {
      category: 'design.logo',
      title: 'Biznesingiz uchun esda qoladigan logotip yarataman',
      description:
        "Logotip — brendingizning yuzi. Qisqa brif to'ldirasiz, men 2–4 ta konsepsiya taklif qilaman, tanlanganini mukammal holatga keltiraman. Barcha formatlar: AI, PDF, PNG, SVG — banner, vizitka va Instagram uchun tayyor.",
      cover: '/demo/logo.svg',
      gallery: ['/demo/logo.svg', '/demo/cards.svg'],
      tags: ['logotip', 'brending', 'dizayn'],
      ordersCount: 71,
      packages: [
        pkg('basic', 'Oddiy', 250_000, 3, 2, '2 ta logotip konsepsiyasi', ['2 ta konsepsiya', 'PNG va JPG', 'Tijorat uchun foydalanish huquqi']),
        pkg('standard', 'Standart', 590_000, 5, 4, '4 ta konsepsiya va vizitka dizayni', ['4 ta konsepsiya', 'Vektor fayllar: AI, SVG, PDF', 'Vizitka dizayni', 'Ijtimoiy tarmoqlar uchun variant']),
        pkg('premium', 'Premium', 1_900_000, 10, 8, 'Logotip va to‘liq brendbuk', ['6 ta konsepsiya', 'Brendbuk: ranglar, shriftlar, qoidalar', 'Vizitka, blank, konvert', 'Banner va peshlavha uchun maket']),
      ],
    },
    reviews: [
      { buyer: 4, stars: 5, text: "Kafemiz uchun logotip qildirdik. Birinchi konsepsiyadayoq 'bu bizniki' dedik.", amountUzs: 590_000, daysAgo: 9 },
      { buyer: 5, stars: 5, text: 'Brendbuk juda batafsil chiqdi, bosmaxona ham, SMM-chi ham ishlata oldi.', amountUzs: 1_900_000, daysAgo: 33 },
      { buyer: 6, stars: 5, text: 'Tez, aniq, savollarga darrov javob beradi.', amountUzs: 250_000, daysAgo: 58 },
    ],
  },
  {
    owner: 'Bekzod',
    company: 'BrendAvto',
    about: 'Avtomobil va yuk mashinalarini brendlash. Oracal va 3M plyonkalari, kafolat 3 yil. Sergeli tumanida yopiq boks.',
    categories: ['ads.vehicle', 'ads.plotter'],
    trustLevel: 2,
    ratingAvg: 4.8,
    ratingCount: 91,
    dealsClosed: 133,
    responseMin: 18,
    sinceDaysAgo: 760,
    gig: {
      category: 'ads.vehicle',
      title: 'Avtomobilingizga logotip va reklama yopishtirib beraman',
      description:
        "Yetkazib berish xizmati, taksi parki yoki shaxsiy biznes uchun avtomobil brendlash. Maketni mashinangiz modeliga moslab chizamiz, yopishtirish 1 kunda. Plyonka bo'yoqni buzmaydi, kerak bo'lsa izsiz olinadi.",
      cover: '/demo/vehicle.svg',
      gallery: ['/demo/vehicle.svg', '/demo/stickers.svg'],
      tags: ['avto brendlash', 'plyonka', 'logotip'],
      ordersCount: 133,
      packages: [
        pkg('basic', 'Oddiy', 400_000, 1, 1, 'Ikki eshikka logotip va telefon raqami', ['2 ta eshik', 'Plotter kesish', 'Oracal plyonka']),
        pkg('standard', 'Standart', 1_500_000, 2, 2, 'Ikki yon tomonni to‘liq brendlash', ['2 ta yon tomon', 'Rangli bosma plyonka', 'Maket mashina modeliga moslab', 'Laminatsiya']),
        pkg('premium', 'Premium', 6_500_000, 4, 3, 'Mashinani to‘liq o‘rash', ['Butun kuzov', '3M plyonka', 'Dizayn', '3 yil kafolat']),
      ],
    },
    reviews: [
      { buyer: 7, stars: 5, text: '5 ta Damas uchun brendlash qildik. Hammasi bir xil, chiroyli, bir kunda tayyor.', amountUzs: 7_500_000, daysAgo: 12 },
      { buyer: 0, stars: 4, text: "Sifati yaxshi, faqat navbat 3 kun kutdik. Mavsum bo'lsa kerak.", amountUzs: 1_500_000, daysAgo: 47 },
      { buyer: 2, stars: 5, text: "Logotip juda aniq kesilgan, yarim yildan beri ko'chmadi.", amountUzs: 400_000, daysAgo: 120 },
    ],
  },
  {
    owner: 'Shahzoda',
    company: 'Stiker Market',
    about: "Logotipli stikerlar, qadoq uchun yorliqlar va vitrinalarni yopishtirish. Kichik tirajdan ham ishlaymiz — 100 donadan.",
    categories: ['print.stickers', 'ads.plotter'],
    trustLevel: 1,
    ratingAvg: 4.9,
    ratingCount: 203,
    dealsClosed: 298,
    responseMin: 9,
    sinceDaysAgo: 620,
    gig: {
      category: 'print.stickers',
      title: 'Logotipingiz bilan stikerlar va yorliqlar chop etaman',
      description:
        "Mahsulot qadog'i, kafe stakanlari, sovg'alar uchun stikerlar. Istalgan shakl — kontur bo'yicha kesamiz. Qog'oz, plyonka, shaffof va metallik variantlar. Do'kon vitrinasi va eshiklariga ham brendni yopishtirib beramiz.",
      cover: '/demo/stickers.svg',
      gallery: ['/demo/stickers.svg', '/demo/storefront.svg'],
      tags: ['stiker', 'yorliq', 'vitrina'],
      ordersCount: 298,
      packages: [
        pkg('basic', 'Oddiy', 150_000, 1, 1, '500 dona dumaloq stiker', ['500 dona', 'Diametri 5 sm gacha', "Qog'oz asos"]),
        pkg('standard', 'Standart', 420_000, 2, 2, '2000 dona, kontur bo‘yicha kesish', ['2000 dona', 'Istalgan shakl', 'Plyonka, suvga chidamli', 'Maketni tayyorlash']),
        pkg('premium', 'Premium', 1_200_000, 3, 2, 'Vitrina va eshiklarni brendlash, 10 m² gacha', ['10 m² gacha', "O'lchov va maket", "Plotter kesish va o'rnatish", 'Eski yozuvlarni olib tashlash']),
      ],
    },
    reviews: [
      { buyer: 1, stars: 5, text: "Shirinliklar qadog'i uchun 2000 ta stiker — ranglar yorqin, kesish aniq.", amountUzs: 420_000, daysAgo: 4 },
      { buyer: 3, stars: 5, text: "Vitrinani bir kechada yopishtirishdi, ertalab do'kon ochilishiga ulgurdi.", amountUzs: 1_200_000, daysAgo: 29 },
      { buyer: 5, stars: 4, text: 'Yaxshi, lekin birinchi partiyada 20 ta stiker qiyshiq kesilgan edi — darrov almashtirishdi.', amountUzs: 150_000, daysAgo: 66 },
      { buyer: 6, stars: 5, text: 'Narxi bozordagidan arzonroq, sifati esa yaxshiroq.', amountUzs: 420_000, daysAgo: 90 },
    ],
  },
  {
    owner: 'Akmal',
    company: 'Harf va Neon Lab',
    about: "Hajmli harflar, neon va yoritilgan peshlavhalar. O'z sexi, lazer va frezer stanoklari. Loyiha, ishlab chiqarish va o'rnatish.",
    categories: ['ads.letters', 'ads.neon', 'ads.signboards', 'ads.lightbox'],
    trustLevel: 3,
    ratingAvg: 4.7,
    ratingCount: 45,
    dealsClosed: 58,
    responseMin: 40,
    sinceDaysAgo: 1100,
    gig: {
      category: 'ads.letters',
      title: 'Hajmli harflar va neon peshlavha yasab, o‘rnatib beraman',
      description:
        "Do'kon, restoran yoki ofis uchun peshlavha: akril va metall harflar, LED yoritish, egiluvchan neon. Joyiga chiqib o'lchaymiz, vizualizatsiya ko'rsatamiz, keyin ishlab chiqaramiz. Hokimiyat ruxsatnomasi uchun hujjatlarni tayyorlashga yordam beramiz.",
      cover: '/demo/neon.svg',
      gallery: ['/demo/neon.svg', '/demo/storefront.svg'],
      tags: ['peshlavha', 'neon', 'hajmli harflar'],
      ordersCount: 58,
      packages: [
        pkg('basic', 'Oddiy', 900_000, 4, 1, 'Neon yozuv 1 metrgacha, ichki makon uchun', ['1 m gacha', 'Egiluvchan neon', 'Akril asos', 'Blok va kabel']),
        pkg('standard', 'Standart', 3_500_000, 7, 2, 'Hajmli harflar 3 metrgacha, yoritilgan', ['3 m gacha', 'Akril va PVX', 'LED yoritish', 'Vizualizatsiya']),
        pkg('premium', 'Premium', 7_800_000, 10, 3, 'Fasad peshlavhasi: loyiha, ishlab chiqarish va o‘rnatish', ['6 m gacha', 'Metall karkas', 'Avtovyshka bilan o‘rnatish', '1 yil kafolat']),
      ],
    },
    reviews: [
      { buyer: 4, stars: 5, text: 'Restoranimiz peshlavhasi kechasi ajoyib ko‘rinadi. Vizualizatsiyadagidek chiqdi.', amountUzs: 7_800_000, daysAgo: 18 },
      { buyer: 7, stars: 4, text: "Ish sifati a'lo, muddat 2 kunga cho'zildi.", amountUzs: 3_500_000, daysAgo: 71 },
    ],
  },
  {
    owner: 'Doniyor',
    company: 'Print Express',
    about: "Tezkor bosmaxona: vizitka, flayer, buklet, menyu. Ertaga kerakmi — ertaga tayyor. Yunusobodda 2 ta filial.",
    categories: ['print.business-cards', 'print.flyers', 'print.booklets', 'design.layout'],
    trustLevel: 2,
    ratingAvg: 4.9,
    ratingCount: 312,
    dealsClosed: 486,
    responseMin: 6,
    sinceDaysAgo: 1300,
    gig: {
      category: 'print.business-cards',
      title: 'Vizitka va flayerlarni ertagacha chop etaman',
      description:
        "Raqamli va ofset bosma. 300–350 g/m² qog'oz, mat yoki yaltiroq laminatsiya. Maketni bepul tekshiramiz: shriftlar, chetlar va ranglarni bosmaga tayyorlaymiz. Yunusobod va Chilonzordan olib ketish yoki kuryer.",
      cover: '/demo/cards.svg',
      gallery: ['/demo/cards.svg', '/demo/logo.svg'],
      tags: ['vizitka', 'flayer', 'tezkor bosma'],
      ordersCount: 486,
      packages: [
        pkg('basic', 'Oddiy', 120_000, 1, 1, '1000 ta vizitka, bir tomonlama', ['1000 dona', '4+0, 300 g/m²', 'Maketni tekshirish']),
        pkg('standard', 'Standart', 210_000, 1, 2, '1000 ta vizitka, ikki tomonlama, laminatsiya', ['1000 dona', '4+4, 350 g/m²', 'Mat laminatsiya', 'Kuryer Toshkent bo‘ylab']),
        pkg('premium', 'Premium', 650_000, 2, 3, 'Vizitka, flayer va dizayn to‘plami', ['1000 vizitka', '1000 flayer A5', 'Dizayn', 'Kuryer']),
      ],
    },
    reviews: [
      { buyer: 2, stars: 5, text: 'Kechki 6 da buyurtma, ertalab 10 da tayyor. Doim shu yerdan olamiz.', amountUzs: 210_000, daysAgo: 2 },
      { buyer: 6, stars: 5, text: "Maketimdagi xatoni o'zlari topib, chop etishdan oldin ogohlantirishdi.", amountUzs: 120_000, daysAgo: 15 },
      { buyer: 7, stars: 5, text: "Flayerlar sifati yaxshi, qog'oz qalin.", amountUzs: 650_000, daysAgo: 37 },
      { buyer: 1, stars: 4, text: 'Hammasi yaxshi, faqat kuryer biroz kechikdi.', amountUzs: 210_000, daysAgo: 52 },
    ],
  },
];

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

/** Удалить демо-данные. Сделки, отклики и чаты демо-исполнителей по настоящим заявкам тоже удаляются. */
export async function removeDemo(db: Db): Promise<number> {
  const demoCompanies = (await db.select({ id: companies.id }).from(companies).where(eq(companies.isDemo, true))).map((r) => r.id);
  const demoUsers = (
    await db
      .select({ id: users.id })
      .from(users)
      .where(and(sql`${users.telegramId} >= ${SELLER_TG}`, sql`${users.telegramId} < ${TG_RANGE_END}`))
  ).map((r) => r.id);
  if (!demoCompanies.length && !demoUsers.length) return 0;

  await db.transaction(async (tx) => {
    const companyIds = demoCompanies.length ? demoCompanies : [-1];
    const userIds = demoUsers.length ? demoUsers : [-1];
    const dealIds = (
      await tx
        .select({ id: deals.id })
        .from(deals)
        .where(or(inArray(deals.supplierCompanyId, companyIds), inArray(deals.buyerUserId, userIds)))
    ).map((r) => r.id);
    if (dealIds.length) {
      await tx.delete(reviews).where(inArray(reviews.dealId, dealIds));
      await tx.delete(deals).where(inArray(deals.id, dealIds));
    }
    await tx.delete(chats).where(inArray(chats.supplierCompanyId, companyIds));
    await tx.delete(offers).where(or(inArray(offers.supplierCompanyId, companyIds), inArray(offers.authorUserId, userIds)));
    await tx.delete(requests).where(inArray(requests.authorUserId, userIds));
    await tx.delete(companies).where(inArray(companies.id, companyIds));
    await tx.delete(users).where(inArray(users.id, userIds));
  });
  return demoCompanies.length;
}

export async function seedDemo(db: Db): Promise<{ sellers: number; reviews: number }> {
  await seedCatalog(db);
  await removeDemo(db);
  const cats = await db.select({ id: categories.id, slug: categories.slug, name: categories.name }).from(categories);
  const catBySlug = new Map(cats.map((c) => [c.slug, c]));
  const cat = (slug: string) => {
    const c = catBySlug.get(slug);
    if (!c) throw new Error(`Нет категории ${slug}`);
    return c;
  };

  let reviewCount = 0;
  await db.transaction(async (tx) => {
    const buyers = await tx
      .insert(users)
      .values(BUYERS.map((firstName, i) => ({ telegramId: BUYER_TG + i + 1, firstName, lang: 'uz', consentAt: new Date(), botStarted: true })))
      .returning({ id: users.id });

    for (const [i, s] of DEMO_SELLERS.entries()) {
      const since = daysAgo(s.sinceDaysAgo);
      const [owner] = await tx
        .insert(users)
        .values({
          telegramId: SELLER_TG + i + 1,
          firstName: s.owner,
          lang: 'uz',
          consentAt: since,
          botStarted: true,
          activeRole: 'supplier',
          createdAt: since,
          // Без подтверждённого номера откликаться нельзя. Настоящего номера у демо нет — только метка.
          phoneHash: `demo-${SELLER_TG + i + 1}`,
          phoneVerifiedAt: since,
        })
        .returning({ id: users.id });
      const [co] = await tx
        .insert(companies)
        .values({
          name: s.company,
          type: 'llc',
          regionCode: 'tashkent',
          about: s.about,
          isSupplier: true,
          isBuyer: false,
          trustLevel: s.trustLevel,
          innVerifiedAt: s.trustLevel >= 1 ? since : null,
          ratingAvg: s.ratingAvg,
          ratingCount: s.ratingCount,
          dealsClosed: s.dealsClosed,
          offersSent: Math.round(s.dealsClosed * 2.6),
          medianResponseMin: s.responseMin,
          isDemo: true,
          createdAt: since,
        })
        .returning({ id: companies.id });
      await tx.update(users).set({ activeCompanyId: co.id }).where(eq(users.id, owner.id));
      await tx.insert(memberships).values({ userId: owner.id, companyId: co.id, role: 'owner' });
      await tx.insert(supplierCategories).values(s.categories.map((slug) => ({ companyId: co.id, categoryId: cat(slug).id })));
      await tx.insert(serviceAreas).values({ companyId: co.id, regionCode: 'tashkent' });
      await tx.insert(subscriptions).values({ companyId: co.id, planCode: 'pro', status: 'active', periodStart: new Date(), periodEnd: daysAgo(-365), source: 'manual' });
      await tx.insert(gigs).values({
        companyId: co.id,
        categoryId: cat(s.gig.category).id,
        title: s.gig.title,
        description: s.gig.description,
        cover: s.gig.cover,
        gallery: s.gig.gallery,
        packages: s.gig.packages,
        tags: s.gig.tags,
        ordersCount: s.gig.ordersCount,
        createdAt: since,
      });

      // Отзывы только через закрытые сделки — как в живом продукте.
      const gigCat = cat(s.gig.category);
      for (const r of s.reviews) {
        const at = daysAgo(r.daysAgo);
        const buyerId = buyers[r.buyer].id;
        const [req] = await tx
          .insert(requests)
          .values({
            authorUserId: buyerId,
            categoryId: gigCat.id,
            status: 'completed',
            title: gigCat.name.ru,
            rawText: s.gig.title,
            lang: 'uz',
            regionCode: 'tashkent',
            confidence: 1,
            wave: 1,
            submittedAt: at,
            closedAt: at,
            createdAt: at,
            updatedAt: at,
          })
          .returning({ id: requests.id });
        const leadDays = s.gig.packages[1]?.days ?? 2;
        const [offer] = await tx
          .insert(offers)
          .values({ requestId: req.id, supplierCompanyId: co.id, authorUserId: owner.id, priceUzs: r.amountUzs, leadTimeDays: leadDays, status: 'chosen', createdAt: at, updatedAt: at })
          .returning({ id: offers.id });
        const doneAt = new Date(at.getTime() + leadDays * 86_400_000);
        const [deal] = await tx
          .insert(deals)
          .values({
            requestId: req.id,
            offerId: offer.id,
            buyerUserId: buyerId,
            supplierCompanyId: co.id,
            amountUzs: r.amountUzs,
            status: 'completed',
            buyerConfirmedAt: doneAt,
            supplierConfirmedAt: doneAt,
            completedAt: doneAt,
            closedBy: 'buyer',
            createdAt: at,
          })
          .returning({ id: deals.id });
        await tx.insert(reviews).values({
          dealId: deal.id,
          authorUserId: buyerId,
          authorSide: 'buyer',
          targetCompanyId: co.id,
          stars: r.stars,
          text: r.text,
          createdAt: doneAt,
        });
        reviewCount += 1;
      }
    }
  });
  return { sellers: DEMO_SELLERS.length, reviews: reviewCount };
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL не задан');
    process.exit(1);
  }
  const { db, pool } = createDb(url, { max: 1 });
  const run = process.argv.includes('--remove')
    ? removeDemo(db).then((n) => console.log(`Демо удалено: ${n} исполнителей`))
    : seedDemo(db).then((r) => {
        console.log(`Демо-витрина: ${r.sellers} исполнителей, ${r.reviews} отзывов`);
        DEMO_SELLERS.forEach((s, i) => console.log(`  ${s.company}: ?dev=${SELLER_TG + i + 1}`));
      });
  run
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
