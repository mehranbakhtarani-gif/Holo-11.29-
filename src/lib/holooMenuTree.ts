import type React from 'react';
import {
  Activity,
  LayoutDashboard,
  LayoutGrid,
  Package,
  Settings,
  Wallet,
} from 'lucide-react';
import type { ActiveModule } from '../types/accounting';

export interface SubMenuItem {
  key: string;
  label: string;
  module: ActiveModule;
  intent?: string;
  shortcut?: string;
  /** Optional extra Persian/English search terms for smart menu indexing */
  keywords?: string;
}

export interface MenuGroup {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  iconAccent: string;
  shortcut?: string;
  directModule?: ActiveModule;
  keywords?: string;
  items?: SubMenuItem[];
}

export interface IndexedMenuEntry {
  key: string;
  label: string;
  groupId: string;
  groupLabel: string;
  breadcrumb: string;
  module: ActiveModule;
  intent?: string;
  shortcut?: string;
  keywords: string;
  icon: React.ComponentType<{ className?: string }>;
  iconAccent: string;
}

/**
 * Single source of truth for the entire Holoo Apex navigation tree.
 * Consumed by the sidebar, mobile drawer, breadcrumbs, Smart Global Search, and Voice Search.
 */
export const HOLOO_MENU_TREE: MenuGroup[] = [
  {
    id: 'dashboard',
    label: 'داشبورد',
    icon: LayoutDashboard,
    iconAccent: 'text-indigo-500 dark:text-[#818CF8]',
    shortcut: 'F10',
    directModule: 'dashboard',
    keywords: 'داشبورد صفحه اصلی خانه نمای کلی خلاصه مدیریتی نمودار نقدینگی dashboard home',
  },
  {
    id: 'finance',
    label: 'امور مالی',
    icon: Wallet,
    iconAccent: 'text-emerald-600 dark:text-emerald-400',
    keywords: 'مالی حسابداری خزانه فاکتور سند بانک صندوق',
    items: [
      {
        key: 'inv-sale',
        label: 'فاکتور فروش رسمی و مودیان',
        module: 'invoices',
        intent: 'new-sale',
        shortcut: 'F2',
        keywords: 'صدور فاکتور فروش جدید رسمی سامانه مودیان مالیات ارزش افزوده sale invoice',
      },
      {
        key: 'inv-purchase',
        label: 'فاکتور خرید کالا',
        module: 'invoices',
        intent: 'new-purchase',
        shortcut: 'F4',
        keywords: 'ثبت فاکتور خرید جدید خرید نخ تامین کننده ورود کالا purchase invoice',
      },
      {
        key: 'inv-list',
        label: 'آرشیو و مدیریت فاکتورها',
        module: 'invoices',
        keywords: 'لیست فاکتورها فهرست فاکتورهای فروش و خرید جستجوی فاکتور invoices list',
      },
      {
        key: 'inv-reserved',
        label: 'صف فاکتورهای رزرو موقت (۹.۶)',
        module: 'invoices',
        intent: 'reserved',
        keywords: 'رزرو فاکتور موقت صف رزرو هلو ۹.۶ پیش نویس فاکتور reserved',
      },
      {
        key: 'inv-proforma',
        label: 'صدور و تبدیل پیش‌فاکتور',
        module: 'invoices',
        intent: 'new-proforma',
        keywords: 'پیش فاکتور پیش‌فاکتور پیشفاکتور استعلام قیمت تبدیل به فاکتور proforma quote',
      },
      {
        key: 'inv-sale-ret',
        label: 'برگشت از فروش / خرید / ضایعات',
        module: 'invoices',
        intent: 'new-sale-return',
        keywords: 'مرجوعی برگشتی برگشت از فروش برگشت از خرید ضایعات انبار return waste',
      },
      {
        key: 'voucher-new',
        label: 'صدور سند حسابداری جدید',
        module: 'vouchers',
        intent: 'new-voucher',
        shortcut: 'F3',
        keywords: 'ثبت سند جدید سند دوبل بدهکار بستانکار روزنامه حسابداری new voucher',
      },
      {
        key: 'voucher-cartable',
        label: 'کارتابل اسناد و حواله‌ها',
        module: 'vouchers',
        intent: 'cartable',
        keywords: 'کارتابل تایید اسناد حواله بررسی اسناد cartable',
      },
      {
        key: 'voucher-list',
        label: 'دفتر روزنامه و مدیریت اسناد',
        module: 'vouchers',
        keywords: 'لیست اسناد فهرست اسناد دفتر روزنامه حسابداری vouchers journal',
      },
      {
        key: 'voucher-drafts',
        label: 'اسناد موقت (نیاز به قطعی‌سازی)',
        module: 'vouchers',
        intent: 'drafts',
        keywords: 'سند موقت پیش نویس قطعی کردن دائم کردن سند draft vouchers',
      },
      {
        key: 'tr-cheques',
        label: 'چک صیادی و سررسیدها',
        module: 'treasury',
        intent: 'cheques',
        shortcut: 'F7',
        keywords: 'چک چک‌ها صیاد صیادی سررسید وصول خرج چک برگشتی راس گیری خزانه cheques sayadi',
      },
      {
        key: 'tr-quick',
        label: 'دریافت و پرداخت سریع خزانه',
        module: 'treasury',
        intent: 'quick',
        keywords: 'دریافت وجه پرداخت وجه واریز برداشت نقدی کارتخوان پوز انتقال بین بانکی خزانه treasury',
      },
      {
        key: 'tr-reconciliation',
        label: 'مغایرت‌گیری بانکی و چاپ چک',
        module: 'treasury',
        intent: 'reconciliation',
        keywords: 'مغایرت بانکی تطبیق صورتحساب بانک csv چاپ برگه چک کالیبره reconciliation cheque print',
      },
      {
        key: 'fin-petty',
        label: 'تنخواه‌گردان و وام بانکی',
        module: 'finance-ops',
        intent: 'petty-cash',
        keywords: 'تنخواه هزینه روزانه قبض شارژ تنخواه تسویه تنخواه petty cash',
      },
      {
        key: 'tr-fx-reval',
        label: 'ارز، نرخ روز و تسعیر پایان دوره',
        module: 'currencies',
        intent: 'revaluation',
        keywords: 'ارز دلار یورو درهم یوان لیر نرخ برابری مبدل ارز تسعیر سود زیان تسعیر currency fx usd eur',
      },
      {
        key: 'accounts-all',
        label: 'کدینگ حساب‌ها (کل و معین)',
        module: 'accounts',
        keywords: 'کدینگ حساب سرفصل درختواره حسابها گروه کل معین تفصیلی تعریف حساب chart of accounts',
      },
      {
        key: 'parties',
        label: 'طرف‌حساب‌ها و اشخاص',
        module: 'parties',
        shortcut: 'F5',
        keywords: 'مشتری مشتریان فروشنده تامین کننده اشخاص طرف حساب بدهکاران بستانکاران سقف اعتبار parties customers',
      },
    ],
  },
  {
    id: 'inventory',
    label: 'انبار و کالا',
    icon: Package,
    iconAccent: 'text-amber-600 dark:text-amber-400',
    keywords: 'انبار کالا نخ موجودی کاردکس انبارگردانی تولید واردات',
    items: [
      {
        key: 'inv-products',
        label: 'فهرست کالاها و موجودی انبار',
        module: 'inventory',
        shortcut: 'F6',
        keywords: 'تعریف کالا لیست کالاها موجودی نخ قیمت گذاری انبارداری نقطه سفارش products inventory',
      },
      {
        key: 'inv-kardex',
        label: 'کاردکس ریالی (میانگین موزون)',
        module: 'inventory',
        intent: 'kardex',
        keywords: 'کاردکس گردش کالا ورودی خروجی انبار فایفو fifo میانگین موزون kardex',
      },
      {
        key: 'inv-stocktaking',
        label: 'انبارگردانی گروهی و تعدیل',
        module: 'inventory',
        intent: 'stocktaking',
        keywords: 'انبارگردانی شمارش انبار کسری اضافی سند تعدیل stocktaking',
      },
      {
        key: 'inv-transfer',
        label: 'حواله انتقال بین انبارها',
        module: 'inventory',
        intent: 'transfer',
        keywords: 'انتقال انبار جابجایی کالا بین انبارها حواله انتقال warehouse transfer',
      },
      {
        key: 'inv-bulk-price',
        label: 'تغییر گروهی قیمت کالاها',
        module: 'inventory',
        intent: 'bulk-price',
        keywords: 'تغییر قیمت آپدیت نرخ افزایش درصدی قیمت فروش خرید کالاها bulk price',
      },
      {
        key: 'inv-bulk-import',
        label: 'ورود گروهی کالا از اکسل / CSV',
        module: 'inventory',
        intent: 'bulk-import',
        keywords: 'ایمپورت اکسل ورود کالا فایل csv بارگذاری گروهی import excel',
      },
      {
        key: 'inv-barcode-print',
        label: 'چاپ لیبل بارکد کالا',
        module: 'inventory',
        intent: 'barcode-print',
        keywords: 'بارکد لیبل پرینت برچسب کارتن کد کالا barcode label',
      },
      {
        key: 'wh-dyelots',
        label: 'ردیابی لات رنگرزی و شید رنگ',
        module: 'warehouse-crm',
        intent: 'dye-lots',
        keywords: 'شماره لات شید رنگ رنگرزی ردیابی بچ نخ dye lot shade',
      },
      {
        key: 'wh-slips',
        label: 'رسید/حواله مستقل و کالای امانی',
        module: 'warehouse-crm',
        intent: 'slips',
        keywords: 'رسید انبار حواله خروج انبار کالای امانی امانت slips consignment',
      },
      {
        key: 'wh-bom',
        label: 'فرمول تولید (BOM) و بهای تمام‌شده',
        module: 'warehouse-crm',
        intent: 'bom',
        keywords: 'فرمول تولید بوم bom مونتاژ تولید کالا مواد اولیه بهای تمام شده',
      },
      {
        key: 'comm-imports',
        label: 'پرونده واردات نخ و سرشکن هزینه',
        module: 'commercial',
        intent: 'imports',
        keywords: 'واردات کوتاژ گمرک ترخیص سرشکن هزینه حمل بیمه قیمت تمام شده landed cost imports',
      },
      {
        key: 'comm-orders',
        label: 'سفارش فروش و حواله باسکول',
        module: 'commercial',
        intent: 'orders',
        keywords: 'سفارش فروش باسکول توزین وزن واقعی خروج انبار بارکد کارتن orders weighbridge',
      },
      {
        key: 'comm-subcontract',
        label: 'پیمانکاری رنگرزی و بافندگی',
        module: 'commercial',
        intent: 'subcontract',
        keywords: 'پیمانکار کارمزدی رنگرزی بافندگی ارسال نخ خام افت مجاز subcontract',
      },
    ],
  },
  {
    id: 'operations',
    label: 'عملیات',
    icon: LayoutGrid,
    iconAccent: 'text-indigo-600 dark:text-[#818CF8]',
    keywords: 'عملیات شرکتی حقوق اموال مراکز هزینه وام اقساط پایان سال',
    items: [
      {
        key: 'corp-payroll',
        label: 'حقوق و دستمزد و فیش حقوقی',
        module: 'corporate',
        intent: 'payroll',
        shortcut: 'F8',
        keywords: 'حقوق دستمزد پرسنل کارمند فیش حقوقی بیمه مالیات حقوق لیست بیمه payroll salary',
      },
      {
        key: 'corp-assets',
        label: 'اموال، دارایی ثابت و استهلاک',
        module: 'corporate',
        intent: 'assets',
        keywords: 'اموال دارایی ثابت جمعداری استهلاک سالانه fixed assets depreciation',
      },
      {
        key: 'corp-cc',
        label: 'مراکز هزینه و سود پروژه‌ها',
        module: 'corporate',
        intent: 'costcenters',
        keywords: 'مرکز هزینه پروژه بودجه سود پروژه cost center',
      },
      {
        key: 'crm-installments',
        label: 'فروش اقساطی و تخفیف پلکانی',
        module: 'warehouse-crm',
        intent: 'installments',
        keywords: 'اقساط قسط دفترچه قسط فروش قسطی تخفیف پلکانی installments',
      },
      {
        key: 'fin-recurring',
        label: 'اسناد تکرارشونده دوره‌ای',
        module: 'finance-ops',
        intent: 'recurring',
        keywords: 'سند تکرارشونده ماهانه اجاره قبض دوره‌ای recurring vouchers',
      },
      {
        key: 'fin-loans',
        label: 'تسهیلات و اقساط وام بانکی',
        module: 'finance-ops',
        intent: 'loans',
        keywords: 'وام تسهیلات بانکی جدول اقساط بهره بانکی loans',
      },
      {
        key: 'opening-voucher',
        label: 'ثبت سند افتتاحیه اول دوره',
        module: 'vouchers',
        intent: 'new-opening',
        keywords: 'سند افتتاحیه اول سال موجودی اول دوره opening voucher',
      },
      {
        key: 'year-closing',
        label: 'بستن حساب پایان سال مالی',
        module: 'corporate',
        intent: 'closing',
        keywords: 'بستن حسابها اختتامیه پایان سال سود و زیان انباشته closing fiscal year',
      },
      {
        key: 'fin-rollover',
        label: 'انتقال دوره و سال مالی جدید',
        module: 'finance-ops',
        intent: 'fiscal-rollover',
        keywords: 'انتقال سال مالی دوره جدید افتتاح سال جدید rollover',
      },
      {
        key: 'tool-studio',
        label: 'استودیو اسناد و کاتالوگ',
        module: 'studio',
        keywords: 'استودیو کاتالوگ طراحی سند چاپ بروشور studio catalog',
      },
    ],
  },
  {
    id: 'activity',
    label: 'گزارش فعالیت‌ها',
    icon: Activity,
    iconAccent: 'text-emerald-600 dark:text-emerald-400',
    keywords: 'گزارش گزارشها حسابرسی تراز سود و زیان دفتر کل ممیزی مالیات',
    items: [
      {
        key: 'audit-center',
        label: 'مرکز حسابرسی و کنترل اسناد',
        module: 'audit',
        keywords: 'حسابرسی کنترل خطا مغایرت سند تراز نبودن سلامت سیستم سینک آفلاین audit center',
      },
      {
        key: 'tool-audit-log',
        label: 'گزارش ممیزی و تاریخچه عملیات',
        module: 'settings',
        intent: 'audit-log',
        keywords: 'لاگ فعالیت تاریخچه ممیزی چه کسی تغییر داد audit log',
      },
      {
        key: 'rep-trial',
        label: 'تراز آزمایشی ۲/۴/۶/۸ ستونی',
        module: 'reports',
        intent: 'trial',
        shortcut: 'F9',
        keywords: 'تراز آزمایشی تراز کل معین ۴ ستونی ۶ ستونی ۸ ستونی trial balance',
      },
      {
        key: 'rep-pnl',
        label: 'صورت سود و زیان جامع',
        module: 'reports',
        intent: 'pnl',
        keywords: 'سود و زیان درآمد هزینه سود خالص گزارش سود pnl profit loss',
      },
      {
        key: 'rep-balance',
        label: 'ترازنامه استاندارد',
        module: 'reports',
        intent: 'balance',
        keywords: 'ترازنامه دارایی بدهی سرمایه حقوق صاحبان سهام balance sheet',
      },
      {
        key: 'rep-moroor',
        label: 'مرور حساب‌ها (دریل‌داون)',
        module: 'reports',
        intent: 'moroor',
        keywords: 'مرور حساب دریل داون گروه کل معین تفصیلی moroor',
      },
      {
        key: 'rep-ledger',
        label: 'دفتر کل و معین',
        module: 'reports',
        intent: 'ledger',
        keywords: 'دفتر کل دفتر معین گردش حساب ریز حساب ledger',
      },
      {
        key: 'rep-party',
        label: 'صورتحساب تفصیلی طرف‌حساب',
        module: 'reports',
        intent: 'party-ledger',
        keywords: 'صورتحساب مشتری معین اشخاص گردش بدهکار بستانکار ارسال واتساپ party ledger',
      },
      {
        key: 'rep-aging',
        label: 'گزارش سنی مطالبات (۰ تا +۹۰)',
        module: 'reports',
        intent: 'aging',
        keywords: 'سنی مطالبات معوق بدهکاران دیرکرد وصول aging report',
      },
      {
        key: 'rep-abc',
        label: 'تحلیل هوشمند ABC کالا و مشتری',
        module: 'reports',
        intent: 'abc',
        keywords: 'تحلیل abc پرفروش ترین کالا بهترین مشتری پارتو',
      },
      {
        key: 'rep-vat',
        label: 'ارزش افزوده، ماده ۱۶۹ و بیمه',
        module: 'reports',
        intent: 'vat',
        keywords: 'مالیات ارزش افزوده معاملات فصلی ماده ۱۶۹ بیمه dsk ttms سامانه مودیان vat statutory',
      },
      {
        key: 'rep-prod-profit',
        label: 'سود ناخالص کالا و پورسانت',
        module: 'reports',
        intent: 'product-profit',
        keywords: 'سود کالا حاشیه سود پورسانت بازاریاب واسطه product profit commission',
      },
    ],
  },
  {
    id: 'settings',
    label: 'تنظیمات',
    icon: Settings,
    iconAccent: 'text-slate-500 dark:text-slate-400',
    keywords: 'تنظیمات پیکربندی ابری ریست بازنشانی پشتیبان کاربران قالب چاپ',
    items: [
      {
        key: 'tool-settings',
        label: 'تنظیمات شرکتی، ابری و بازنشانی',
        module: 'settings',
        keywords: 'تنظیمات نام شرکت سال مالی ریال تومان ابر supabase firebase ریست بازنشانی خام کردن دیتابیس پاک کردن کل اطلاعات settings reset',
      },
      {
        key: 'tool-local-backup',
        label: 'پشتیبان داخلی و همزمانی دستگاه‌ها',
        module: 'settings',
        intent: 'local-backup',
        keywords: 'بکاپ پشتیبان گیری بازیابی json دانلود فایل آفلاین همگام سازی backup restore',
      },
      {
        key: 'tool-rbac',
        label: 'کاربران و سطوح دسترسی (RBAC)',
        module: 'settings',
        intent: 'rbac',
        keywords: 'کاربران اپراتور نقش دسترسی امنیت رمز عبور rbac users permissions',
      },
      {
        key: 'inv-designer',
        label: 'سفارشی‌سازی قالب چاپ فاکتور',
        module: 'settings',
        intent: 'invoice-designer',
        keywords: 'طراحی فاکتور قالب چاپ هلو لوگو پاورقی یک واحدی دو واحدی سه واحدی invoice designer print',
      },
      {
        key: 'tool-notifications',
        label: 'اعلان‌های بومی (PWA) و یادآوری چک',
        module: 'settings',
        intent: 'notifications',
        keywords: 'اعلان اعلانها نوتیفیکیشن بومی native notifications api یادآوری سررسید چک تاییدیه سند حسابداری pwa هشدار',
      },
    ],
  },
];

let cachedIndexedMenus: IndexedMenuEntry[] | null = null;

/**
 * Flattens and caches every navigable node in HOLOO_MENU_TREE for instant O(n) local fuzzy search.
 */
export function getIndexedHolooMenus(): IndexedMenuEntry[] {
  if (cachedIndexedMenus) return cachedIndexedMenus;

  const entries: IndexedMenuEntry[] = [];
  for (const group of HOLOO_MENU_TREE) {
    if (group.directModule) {
      entries.push({
        key: group.id,
        label: group.label,
        groupId: group.id,
        groupLabel: group.label,
        breadcrumb: group.label,
        module: group.directModule,
        shortcut: group.shortcut,
        keywords: group.keywords || '',
        icon: group.icon,
        iconAccent: group.iconAccent,
      });
    }
    if (group.items) {
      for (const item of group.items) {
        entries.push({
          key: item.key,
          label: item.label,
          groupId: group.id,
          groupLabel: group.label,
          breadcrumb: `${group.label} ← ${item.label}`,
          module: item.module,
          intent: item.intent,
          shortcut: item.shortcut,
          keywords: [group.label, group.keywords || '', item.keywords || '', item.shortcut || '']
            .filter(Boolean)
            .join(' '),
          icon: group.icon,
          iconAccent: group.iconAccent,
        });
      }
    }
  }

  cachedIndexedMenus = entries;
  return entries;
}

export function findGroupIdForModule(mod: ActiveModule, intent?: string): string {
  for (const g of HOLOO_MENU_TREE) {
    if (g.directModule === mod) return g.id;
    if (g.items?.some((it) => it.module === mod && (!intent || it.intent === intent))) {
      return g.id;
    }
  }
  for (const g of HOLOO_MENU_TREE) {
    if (g.items?.some((it) => it.module === mod)) return g.id;
  }
  return 'dashboard';
}

export function getBreadcrumbLabel(mod: ActiveModule, subKey: string | null): string {
  if (mod === 'dashboard') return 'داشبورد';
  for (const g of HOLOO_MENU_TREE) {
    if (g.items) {
      const exact = subKey ? g.items.find((it) => it.key === subKey) : undefined;
      if (exact) return exact.label;
    }
  }
  for (const g of HOLOO_MENU_TREE) {
    const match = g.items?.find((it) => it.module === mod);
    if (match) return match.label;
  }
  return 'هلو آپکس';
}
