import { t3, type FieldDef } from '@dominify/shared';

type Sel = [string, string, string][]; // value, ru, uz

const opt = (list: Sel) => list.map(([value, ru, uz]) => ({ value, label: t3(ru, uz) }));

const f = {
  qty: (required = true): FieldDef => ({
    key: 'quantity',
    label: t3('Количество / тираж', 'Miqdor / tiraj'),
    type: 'number',
    required,
    unit: 'шт',
    ask: t3('Какой тираж или количество нужно?', 'Qancha miqdor yoki tiraj kerak?'),
  }),
  format: (list: Sel): FieldDef => ({
    key: 'format',
    label: t3('Формат', 'Format'),
    type: 'select',
    required: true,
    options: opt(list),
    ask: t3('Какой формат нужен?', 'Qaysi format kerak?'),
  }),
  size: (required = true): FieldDef => ({
    key: 'size',
    label: t3('Размер', "O'lcham"),
    type: 'text',
    required,
    ask: t3('Какой размер? Например, 3×2 м или 90×50 мм.', "Qanday o'lcham? Masalan, 3×2 m yoki 90×50 mm."),
  }),
  paper: (): FieldDef => ({ key: 'paper_gsm', label: t3('Плотность бумаги, г/м²', "Qog'oz zichligi, g/m²"), type: 'number', unit: 'г/м²' }),
  sides: (): FieldDef => ({
    key: 'sides',
    label: t3('Печать', 'Chop etish'),
    type: 'select',
    options: opt([
      ['4+0', 'Односторонняя цветная', 'Bir tomonlama rangli'],
      ['4+4', 'Двусторонняя цветная', 'Ikki tomonlama rangli'],
      ['1+0', 'Чёрно-белая', 'Oq-qora'],
    ]),
  }),
  material: (list: Sel, required = false): FieldDef => ({
    key: 'material',
    label: t3('Материал', 'Material'),
    type: 'select',
    required,
    options: opt(list),
    ask: t3('Из какого материала?', 'Qaysi materialdan?'),
  }),
  install: (): FieldDef => ({ key: 'installation', label: t3('Нужен монтаж', "O'rnatish kerak"), type: 'boolean' }),
  text: (key: string, ru: string, uz: string, required = false, askRu?: string, askUz?: string): FieldDef => ({
    key,
    label: t3(ru, uz),
    type: 'text',
    required,
    ask: askRu && askUz ? t3(askRu, askUz) : undefined,
  }),
};

export interface SeedCategory {
  slug: string;
  name: ReturnType<typeof t3>;
  keywords: string;
  fields: FieldDef[];
  children?: SeedCategory[];
}

/**
 * Стартовая вертикаль: полиграфия и наружная реклама Ташкента.
 * keywords — корни слов на русском и узбекском; по ним работает запасной разбор без ИИ и подсказки ИИ.
 */
export const CATALOG: SeedCategory[] = [
  {
    slug: 'print',
    name: t3('Полиграфия', 'Poligrafiya'),
    keywords: 'полиграф печат типограф poligraf chop bosma',
    fields: [],
    children: [
      {
        slug: 'print.business-cards',
        name: t3('Визитки', 'Vizitkalar'),
        keywords: 'визитк визитн vizitka vizitk',
        fields: [f.qty(), f.size(false), f.sides(), f.paper(), { key: 'lamination', label: t3('Ламинация', 'Laminatsiya'), type: 'boolean' }],
      },
      {
        slug: 'print.flyers',
        name: t3('Листовки и флаеры', 'Varaqalar va flayerlar'),
        keywords: 'листовк флаер flyer flayer varaqa листов',
        fields: [
          f.format([
            ['A4', 'A4', 'A4'],
            ['A5', 'A5', 'A5'],
            ['A6', 'A6', 'A6'],
            ['euro', 'Евро (99×210)', 'Yevro (99×210)'],
          ]),
          f.qty(),
          f.sides(),
          f.paper(),
        ],
      },
      {
        slug: 'print.booklets',
        name: t3('Буклеты', 'Bukletlar'),
        keywords: 'буклет buklet',
        fields: [f.format([['A4', 'A4', 'A4'], ['A5', 'A5', 'A5'], ['euro', 'Евро', 'Yevro']]), f.qty(), f.text('folds', 'Количество сгибов', 'Buklamalar soni'), f.paper()],
      },
      {
        slug: 'print.catalogs',
        name: t3('Каталоги и брошюры', 'Kataloglar va broshyuralar'),
        keywords: 'каталог брошюр журнал katalog broshyura jurnal',
        fields: [
          f.format([['A4', 'A4', 'A4'], ['A5', 'A5', 'A5'], ['other', 'Другой', 'Boshqa']]),
          { key: 'pages', label: t3('Количество страниц', 'Sahifalar soni'), type: 'number', required: true, ask: t3('Сколько страниц?', 'Necha sahifa?') },
          f.qty(),
          {
            key: 'binding',
            label: t3('Переплёт', 'Muqova'),
            type: 'select',
            options: opt([
              ['staple', 'Скрепка', 'Skrepka'],
              ['perfect', 'Клеевой (КБС)', 'Yelimli'],
              ['spiral', 'Пружина', 'Prujina'],
            ]),
          },
        ],
      },
      {
        slug: 'print.stickers',
        name: t3('Наклейки и этикетки', 'Stikerlar va yorliqlar'),
        keywords: 'наклейк стикер этикет самоклей stiker yorliq etiketka',
        fields: [f.size(), f.qty(), f.material([['paper', 'Бумага', "Qog'oz"], ['film', 'Плёнка', 'Plyonka']]), { key: 'die_cut', label: t3('Контурная резка', 'Kontur kesish'), type: 'boolean' }],
      },
      {
        slug: 'print.packaging',
        name: t3('Упаковка и коробки', 'Qadoqlash va qutilar'),
        keywords: 'упаковк коробк пакет бумажн qadoq quti paket',
        fields: [f.text('type', 'Вид упаковки', 'Qadoq turi', true, 'Что за упаковка: коробка, пакет, крафт?', "Qanday qadoq: quti, paket, kraft?"), f.size(), f.qty(), f.material([['cardboard', 'Картон', 'Karton'], ['kraft', 'Крафт', 'Kraft'], ['microflute', 'Микрогофра', 'Mikrogofra']])],
      },
      {
        slug: 'print.calendars',
        name: t3('Календари', 'Kalendarlar'),
        keywords: 'календар kalendar taqvim',
        fields: [
          {
            key: 'type',
            label: t3('Вид календаря', 'Kalendar turi'),
            type: 'select',
            required: true,
            options: opt([
              ['wall', 'Настенный', 'Devoriy'],
              ['desk', 'Настольный', 'Stol ustiga'],
              ['pocket', 'Карманный', "Cho'ntak"],
            ]),
            ask: t3('Какой календарь: настенный, настольный или карманный?', "Qanday kalendar: devoriy, stol ustiga yoki cho'ntak?"),
          },
          f.qty(),
        ],
      },
      {
        slug: 'print.large-format',
        name: t3('Широкоформатная печать', 'Keng formatli bosma'),
        keywords: 'широкоформат интерьерн постер плакат keng format poster plakat',
        fields: [f.size(), f.material([['banner', 'Баннер', 'Banner'], ['film', 'Плёнка', 'Plyonka'], ['paper', 'Бумага', "Qog'oz"], ['canvas', 'Холст', 'Xolst']]), f.qty(false)],
      },
      {
        slug: 'print.souvenirs',
        name: t3('Печать на сувенирах и одежде', 'Suvenir va kiyimga bosma'),
        keywords: 'кружк футболк ручк сувенир худи кепк krujka futbolka ruchka suvenir',
        fields: [f.text('item', 'Изделие', 'Mahsulot', true, 'На чём печатать: кружки, футболки, ручки?', 'Nimaga bosiladi: krujka, futbolka, ruchka?'), f.qty(), f.text('method', 'Метод нанесения', 'Bosish usuli')],
      },
      {
        slug: 'print.forms',
        name: t3('Бланки, конверты, папки', 'Blankalar, konvertlar, papkalar'),
        keywords: 'бланк конверт папк blanka konvert papka',
        fields: [f.text('item', 'Изделие', 'Mahsulot', true, 'Что именно напечатать?', 'Aynan nima chop etiladi?'), f.qty()],
      },
      {
        slug: 'print.consumables',
        name: t3('Расходники для типографий', 'Bosmaxona sarf materiallari'),
        keywords: 'резин офсет пластин краск лак рол ракел декел rezina ofset plastina kraska',
        fields: [
          f.text('item', 'Что нужно', 'Nima kerak', true, 'Что именно нужно купить?', 'Aynan nima kerak?'),
          f.text('machine_model', 'Модель машины', 'Mashina modeli', true, 'Какая модель машины?', 'Mashina modeli qanday?'),
          f.text('format', 'Формат', 'Format'),
          f.qty(false),
        ],
      },
    ],
  },
  {
    slug: 'ads',
    name: t3('Наружная реклама', 'Tashqi reklama'),
    keywords: 'реклам наружн вывеск reklama tashqi',
    fields: [],
    children: [
      {
        slug: 'ads.banners',
        name: t3('Баннеры', 'Bannerlar'),
        keywords: 'баннер растяжк banner',
        fields: [f.size(), f.qty(false), { key: 'eyelets', label: t3('Люверсы', 'Lyuverslar'), type: 'boolean' }, f.install()],
      },
      {
        slug: 'ads.signboards',
        name: t3('Вывески', 'Peshlavhalar'),
        keywords: 'вывеск табличк peshlavha vyveska tablichka',
        fields: [f.size(), f.text('type', 'Вид вывески', 'Peshlavha turi'), f.install()],
      },
      {
        slug: 'ads.lightbox',
        name: t3('Лайтбоксы и световые короба', 'Laytbokslar'),
        keywords: 'лайтбокс световой короб laytboks lightbox',
        fields: [f.size(), { key: 'double_sided', label: t3('Двусторонний', 'Ikki tomonlama'), type: 'boolean' }, f.install()],
      },
      {
        slug: 'ads.letters',
        name: t3('Объёмные буквы', 'Hajmli harflar'),
        keywords: 'объемн объёмн букв hajmli harf',
        fields: [
          f.text('text', 'Текст вывески', 'Yozuv matni', true, 'Какой текст будет на буквах?', 'Harflarda qanday yozuv bo‘ladi?'),
          f.text('letter_height', 'Высота букв', 'Harflar balandligi', true, 'Какая высота букв, в сантиметрах?', 'Harflar balandligi necha santimetr?'),
          { key: 'lighting', label: t3('Подсветка', 'Yoritish'), type: 'boolean' },
          f.install(),
        ],
      },
      {
        slug: 'ads.neon',
        name: t3('Неон', 'Neon'),
        keywords: 'неон neon',
        fields: [f.text('text', 'Текст или рисунок', 'Matn yoki rasm', true, 'Какой текст или рисунок из неона?', 'Neondan qanday matn yoki rasm?'), f.size(false)],
      },
      {
        slug: 'ads.billboards',
        name: t3('Билборды', 'Bilbordlar'),
        keywords: 'билборд щит bilbord',
        fields: [f.text('location', 'Место', 'Joy', true, 'Где нужен билборд?', 'Bilbord qayerda kerak?'), f.text('period', 'Период', 'Muddat'), f.size(false)],
      },
      {
        slug: 'ads.vehicle',
        name: t3('Брендирование транспорта', 'Transportni brendlash'),
        keywords: 'брендир авто машин оклейк транспорт avto mashina brend',
        fields: [f.text('vehicle', 'Транспорт', 'Transport', true, 'Какие машины и сколько?', 'Qanday mashinalar va nechta?'), f.qty(false)],
      },
      {
        slug: 'ads.pos',
        name: t3('POS-материалы и стенды', 'POS-materiallar va stendlar'),
        keywords: 'ролл-ап роллап стенд штендер pos стойк roll-up stend',
        fields: [f.text('type', 'Что нужно', 'Nima kerak', true, 'Что именно: ролл-ап, стенд, штендер?', 'Aynan nima: roll-up, stend, shtender?'), f.qty()],
      },
      {
        slug: 'ads.plotter',
        name: t3('Оклейка витрин, плоттерная резка', 'Vitrinalarni yopishtirish'),
        keywords: 'оклейк витрин плоттер пленк vitrina plotter',
        fields: [f.text('area_m2', 'Площадь, м²', 'Maydon, m²', true, 'Какая площадь оклейки в квадратных метрах?', 'Yopishtirish maydoni necha kvadrat metr?')],
      },
      {
        slug: 'ads.install',
        name: t3('Монтаж и демонтаж', "O'rnatish va demontaj"),
        keywords: 'монтаж демонтаж установк o‘rnatish montaj',
        fields: [f.text('object', 'Что монтировать', "Nima o'rnatiladi", true, 'Что нужно смонтировать или снять?', "Nimani o'rnatish yoki olib tashlash kerak?"), f.text('height_m', 'Высота работ, м', 'Ish balandligi, m')],
      },
    ],
  },
  {
    slug: 'design',
    name: t3('Дизайн и брендинг', 'Dizayn va brending'),
    keywords: 'дизайн макет брендинг dizayn maket brending',
    fields: [],
    children: [
      {
        slug: 'design.logo',
        name: t3('Логотипы', 'Logotiplar'),
        keywords: 'логотип лого logo logotip',
        fields: [
          f.text('brand', 'Название бренда', 'Brend nomi', true, 'Как называется бренд?', 'Brend qanday nomlanadi?'),
          f.text('style', 'Стиль и пожелания', 'Uslub va istaklar'),
        ],
      },
      {
        slug: 'design.identity',
        name: t3('Фирменный стиль и брендбук', 'Firma uslubi va brendbuk'),
        keywords: 'фирменн стиль брендбук айдентик brendbuk firma uslub',
        fields: [f.text('brand', 'Название бренда', 'Brend nomi', true, 'Как называется бренд?', 'Brend qanday nomlanadi?'), f.text('items', 'Что входит', 'Nimalar kiradi')],
      },
      {
        slug: 'design.layout',
        name: t3('Макеты для печати и рекламы', 'Chop etish va reklama uchun maketlar'),
        keywords: 'макет дизайн баннер дизайн листовк maket dizayn',
        fields: [f.text('item', 'Для чего макет', 'Maket nima uchun', true, 'Для чего нужен макет: баннер, листовка, вывеска?', 'Maket nima uchun kerak: banner, varaqa, peshlavha?'), f.size(false)],
      },
    ],
  },
];
