import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft,
  BookOpen,
  Coins,
  Command,
  Compass,
  FileText,
  Landmark,
  Mic,
  Package,
  Search,
  Square,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import type { ActiveModule } from '../types/accounting';
import { useAccounting } from '../context/AccountingContext';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { usePersianSpeechRecognition } from '../hooks/usePersianSpeechRecognition';
import { HighlightedText } from './FuzzyTableSearch';
import {
  executeSmartGlobalSearch,
  type SmartGlobalSearchDataset,
  type SmartSearchCategory,
  type SmartSearchResultItem,
} from '../lib/smartGlobalSearch';
import { getIndexedHolooMenus } from '../lib/holooMenuTree';
import { normalizeSpokenPersianNumbers } from '../lib/financialVoiceSearch';
import { toPersianDigits } from '../lib/format';

const springCurve = {
  type: 'spring' as const,
  stiffness: 430,
  damping: 34,
  mass: 0.8,
};

const CATEGORY_TABS: { id: SmartSearchCategory; label: string }[] = [
  { id: 'all', label: 'همه' },
  { id: 'menu', label: 'منوها و بخش‌ها' },
  { id: 'invoice', label: 'فاکتورها' },
  { id: 'voucher', label: 'اسناد' },
  { id: 'account', label: 'حساب‌ها' },
  { id: 'party', label: 'طرف‌حساب‌ها' },
  { id: 'product', label: 'کالا و انبار' },
  { id: 'cheque', label: 'چک صیادی' },
];

function getCategoryIcon(cat: SmartSearchResultItem['category']) {
  switch (cat) {
    case 'menu':
      return Compass;
    case 'invoice':
      return FileText;
    case 'voucher':
      return BookOpen;
    case 'account':
      return Wallet;
    case 'party':
      return Users;
    case 'product':
      return Package;
    case 'cheque':
      return Landmark;
    case 'currency':
      return Coins;
  }
}

function useSmartSearchDataset(): SmartGlobalSearchDataset {
  const {
    accounts,
    parties,
    products,
    vouchers,
    cheques,
    invoices,
    currencies,
    trialBalance,
    partyBalances,
    profile,
  } = useAccounting();

  return useMemo<SmartGlobalSearchDataset>(
    () => ({
      accounts,
      parties,
      products,
      vouchers,
      cheques,
      invoices,
      currencies,
      trialBalance,
      partyBalances,
      unit: profile.currencyUnit,
    }),
    [
      accounts,
      parties,
      products,
      vouchers,
      cheques,
      invoices,
      currencies,
      trialBalance,
      partyBalances,
      profile.currencyUnit,
    ]
  );
}

/**
 * Full-featured Smart Global Search & Command Palette (Ctrl+K)
 * Indexes every menu item in HOLOO_MENU_TREE plus live vouchers, invoices, accounts,
 * parties, inventory products, Sayadi cheques, and currencies.
 */
export const SmartGlobalSearchModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onNavigate: (mod: ActiveModule, intent?: string, subKey?: string) => void;
}> = ({ open, onClose, onNavigate }) => {
  const dataset = useSmartSearchDataset();
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 70);
  const [category, setCategory] = useState<SmartSearchCategory>('all');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const totalMenuCount = useMemo(() => getIndexedHolooMenus().length, []);

  const speech = usePersianSpeechRecognition({
    onInterim: (text) => {
      if (text.trim()) setQuery(normalizeSpokenPersianNumbers(text));
    },
    onFinal: (text) => {
      if (text.trim()) setQuery(normalizeSpokenPersianNumbers(text));
    },
  });

  useEffect(() => {
    if (!open) {
      speech.stopListening();
      speech.clearError();
      return;
    }
    setActiveIndex(0);
    setCategory('all');
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 30);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const response = useMemo(
    () => executeSmartGlobalSearch(debouncedQuery, dataset, { category, maxResults: 32 }),
    [debouncedQuery, dataset, category]
  );

  const results = response.results;
  const safeActiveIndex = results.length > 0 ? Math.min(activeIndex, results.length - 1) : 0;

  useEffect(() => {
    setActiveIndex(0);
  }, [debouncedQuery, category]);

  useEffect(() => {
    const el = itemRefs.current[safeActiveIndex];
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [safeActiveIndex]);

  const handleSelectItem = (item: SmartSearchResultItem) => {
    speech.stopListening();
    onNavigate(item.module, item.intent, item.subKey);
    onClose();
    setQuery('');
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="smart-global-search-backdrop"
          dir="rtl"
          role="dialog"
          aria-modal="true"
          aria-label="جستجوی هوشمند منوها، اسناد و حساب‌ها"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          onClick={onClose}
          className="fixed inset-0 z-50 flex items-start justify-center pt-[6vh] sm:pt-[9vh] bg-slate-950/60 backdrop-blur-sm p-3 sm:p-4 no-print"
        >
          <motion.div
            key="smart-global-search-panel"
            initial={{ opacity: 0, scale: 0.97, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -6 }}
            transition={springCurve}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl rounded-2xl bg-white dark:bg-[#111622] border border-slate-200 dark:border-slate-800 overflow-hidden shadow-2xl flex flex-col max-h-[82vh]"
          >
            {/* Search Input Bar */}
            <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-slate-200/80 dark:border-slate-800">
              <Search className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    onClose();
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActiveIndex((prev) => (results.length > 0 ? (prev + 1) % results.length : 0));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActiveIndex((prev) =>
                      results.length > 0 ? (prev - 1 + results.length) % results.length : 0
                    );
                  } else if (e.key === 'Enter' && results[safeActiveIndex]) {
                    e.preventDefault();
                    handleSelectItem(results[safeActiveIndex]);
                  }
                }}
                placeholder="جستجو در منوها (انبارگردانی، حقوق، تراز، تنظیمات...)، اسناد، فاکتورها و حساب‌ها..."
                aria-label="عبارت جستجوی هوشمند"
                className="w-full bg-transparent text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none"
              />

              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    inputRef.current?.focus();
                  }}
                  aria-label="پاک کردن جستجو"
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}

              {speech.isSupported && (
                <button
                  type="button"
                  onClick={speech.toggleListening}
                  title={speech.isListening ? 'توقف ضبط صوتی' : 'جستجوی صوتی فارسی'}
                  aria-label={speech.isListening ? 'توقف ضبط صوتی' : 'جستجوی صوتی فارسی'}
                  className={`h-8 px-2.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                    speech.isListening
                      ? 'bg-rose-600 text-white'
                      : 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 border border-indigo-200/70 dark:border-indigo-800/70'
                  }`}
                >
                  {speech.isListening ? (
                    <>
                      <Square className="w-3 h-3 fill-current shrink-0" />
                      <span>در حال شنیدن...</span>
                    </>
                  ) : (
                    <>
                      <Mic className="w-3.5 h-3.5 shrink-0" />
                      <span className="hidden sm:inline">صوتی</span>
                    </>
                  )}
                </button>
              )}

              <button
                type="button"
                onClick={onClose}
                aria-label="بستن جستجو"
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {speech.errorMessage && (
              <div className="px-4 py-2 text-xs text-rose-700 dark:text-rose-300 bg-rose-50/80 dark:bg-rose-950/40 border-b border-rose-200/70 dark:border-rose-900/60">
                {speech.errorMessage}
              </div>
            )}

            {/* Functional Category Filter Tabs */}
            <div
              role="tablist"
              aria-label="فیلتر دسته‌بندی نتایج"
              className="px-4 py-2 border-b border-slate-100 dark:border-slate-800/80 bg-slate-50/70 dark:bg-slate-950/40 flex items-center gap-1 overflow-x-auto"
            >
              {CATEGORY_TABS.map((tab) => {
                const count = response.counts[tab.id];
                const active = category === tab.id;
                const hideWhenZero = Boolean(debouncedQuery.trim()) && tab.id !== 'all' && count === 0;
                if (hideWhenZero) return null;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setCategory(tab.id)}
                    className={`px-2.5 py-1.5 rounded-lg text-xs whitespace-nowrap shrink-0 transition-colors cursor-pointer tabular-nums ${
                      active
                        ? 'bg-indigo-600 text-white font-semibold shadow-xs'
                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800 font-medium'
                    }`}
                  >
                    <span>{tab.label}</span>
                    {(debouncedQuery.trim() || tab.id === 'menu') && (
                      <span
                        className={`mr-1.5 font-code text-[11px] ${
                          active ? 'text-indigo-100' : 'text-slate-400 dark:text-slate-500'
                        }`}
                      >
                        {toPersianDigits(tab.id === 'menu' && !debouncedQuery.trim() ? totalMenuCount : count)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Results List */}
            <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/80">
              {!debouncedQuery.trim() && (
                <div className="px-4 py-2 text-[11px] font-medium text-slate-500 dark:text-slate-400 bg-slate-50/50 dark:bg-slate-900/40 flex items-center justify-between">
                  <span>
                    {category === 'menu'
                      ? `همه ${toPersianDigits(totalMenuCount)} گزینه منوی درختی هلو`
                      : 'دسترسی سریع به منوهای درختی هلو (برای مشاهده همه، عبارت دلخواه را تایپ کنید)'}
                  </span>
                  {category !== 'menu' && (
                    <button
                      type="button"
                      onClick={() => setCategory('menu')}
                      className="text-indigo-600 dark:text-indigo-400 hover:underline font-semibold cursor-pointer"
                    >
                      نمایش همه {toPersianDigits(totalMenuCount)} منو
                    </button>
                  )}
                </div>
              )}

              {results.length === 0 ? (
                <div className="p-10 text-center space-y-2">
                  <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                    موردی مطابق با «{query.trim()}» یافت نشد
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    می‌توانید نام هر منو (مثل انبارگردانی، تراز آزمایشی، چک صیادی، تنظیمات، حقوق)، شماره سند، فاکتور، کد حساب یا نام کالا را تایپ کنید.
                  </p>
                </div>
              ) : (
                results.map((item, idx) => {
                  const Icon = getCategoryIcon(item.category);
                  const isActive = idx === safeActiveIndex;
                  const metaColor =
                    item.metaTone === 'positive'
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : item.metaTone === 'negative'
                        ? 'text-rose-600 dark:text-rose-400'
                        : item.metaTone === 'warning'
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-slate-700 dark:text-slate-200';

                  return (
                    <button
                      key={item.id}
                      ref={(el) => {
                        itemRefs.current[idx] = el;
                      }}
                      type="button"
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => handleSelectItem(item)}
                      className={`w-full flex items-center justify-between gap-3 px-4 py-3 text-right transition-colors cursor-pointer ${
                        isActive
                          ? 'bg-indigo-50/90 dark:bg-indigo-950/50'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                      }`}
                    >
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <div
                          className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                            item.category === 'menu'
                              ? 'bg-indigo-100/80 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300'
                              : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          <Icon className="w-4 h-4 shrink-0" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                            <HighlightedText text={item.title} query={query} />
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5 flex items-center gap-1.5">
                            <HighlightedText text={item.subtitle} query={query} />
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 shrink-0">
                        <div className="text-left">
                          {item.metaText && (
                            <div className={`text-xs font-bold font-code tabular-nums ${metaColor}`}>
                              {item.metaText}
                            </div>
                          )}
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 whitespace-nowrap">
                            {item.categoryLabel}
                          </div>
                        </div>
                        {item.shortcut ? (
                          <kbd className="font-code text-[10.5px] font-semibold px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300">
                            {item.shortcut}
                          </kbd>
                        ) : (
                          <ArrowLeft
                            className={`w-3.5 h-3.5 shrink-0 transition-transform ${
                              isActive
                                ? 'text-indigo-600 dark:text-indigo-400 -translate-x-0.5'
                                : 'text-slate-300 dark:text-slate-600'
                            }`}
                          />
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {/* Footer Hints */}
            <div className="px-4 py-2.5 bg-slate-50 dark:bg-slate-950/70 border-t border-slate-200/80 dark:border-slate-800 flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400 shrink-0">
              <span className="inline-flex items-center gap-1.5 truncate">
                <Command className="w-3.5 h-3.5 shrink-0" />
                <span>
                  ایندکس زنده {toPersianDigits(totalMenuCount)} منوی درختی هلو + اسناد، فاکتورها، حساب‌ها، کالاها و چک‌ها
                </span>
              </span>
              <span className="font-code whitespace-nowrap shrink-0">↑ ↓ Enter · Esc</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

/**
 * Inline Smart Search Input used on the Executive Dashboard header.
 * Keeps live dashboard filtering intact while popping open an instant dropdown
 * with matching HOLOO_MENU_TREE modules, accounts, vouchers, invoices, parties, products, and cheques.
 */
export const SmartDashboardSearchBox: React.FC<{
  value: string;
  onChange: (next: string) => void;
  onNavigate: (mod: ActiveModule, intent?: string, subKey?: string) => void;
  onOpenVoiceSearch: () => void;
}> = ({ value, onChange, onNavigate, onOpenVoiceSearch }) => {
  const dataset = useSmartSearchDataset();
  const debouncedValue = useDebouncedValue(value, 70);
  const [isFocused, setIsFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const response = useMemo(
    () => executeSmartGlobalSearch(debouncedValue, dataset, { maxResults: 9 }),
    [debouncedValue, dataset]
  );

  const showDropdown = isFocused && value.trim().length > 0;
  const results = response.results;
  const safeActiveIndex = results.length > 0 ? Math.min(activeIndex, results.length - 1) : 0;

  useEffect(() => {
    setActiveIndex(0);
  }, [debouncedValue]);

  useEffect(() => {
    if (!isFocused) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsFocused(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [isFocused]);

  const handleSelect = (item: SmartSearchResultItem) => {
    setIsFocused(false);
    onNavigate(item.module, item.intent, item.subKey);
  };

  return (
    <div ref={containerRef} className="relative flex-1 min-w-0 w-full sm:w-80">
      <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
      <input
        type="text"
        value={value}
        onFocus={() => setIsFocused(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setIsFocused(true);
        }}
        onKeyDown={(e) => {
          if (!showDropdown) return;
          if (e.key === 'Escape') {
            setIsFocused(false);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIndex((prev) => (results.length > 0 ? (prev + 1) % results.length : 0));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex((prev) =>
              results.length > 0 ? (prev - 1 + results.length) % results.length : 0
            );
          } else if (e.key === 'Enter' && results[safeActiveIndex]) {
            e.preventDefault();
            handleSelect(results[safeActiveIndex]);
          }
        }}
        placeholder="جستجوی هوشمند منوها، اسناد، فاکتور، حساب و کالا..."
        aria-label="جستجوی هوشمند منوها، اسناد، فاکتور و کالا"
        aria-expanded={showDropdown}
        className={`w-full h-11 pr-10 ${
          value ? 'pl-28' : 'pl-20'
        } rounded-xl bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors`}
      />

      <div className="absolute left-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label="پاک کردن جستجو"
            className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-lg cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        <motion.button
          type="button"
          whileTap={{ scale: 0.94 }}
          transition={springCurve}
          onClick={onOpenVoiceSearch}
          aria-label="جستجوی صوتی مالی"
          title="جستجوی صوتی مالی (فارسی)"
          className="h-8 px-2.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 dark:hover:bg-indigo-900/70 text-indigo-700 dark:text-indigo-300 border border-indigo-200/80 dark:border-indigo-800/70 inline-flex items-center gap-1 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer transition-colors"
        >
          <Mic className="w-3.5 h-3.5 shrink-0" />
          <span>صوتی</span>
        </motion.button>
      </div>

      {/* Live Smart Search Dropdown (Menus + Accounting Entities) */}
      <AnimatePresence>
        {showDropdown && (
          <motion.div
            key="dashboard-smart-dropdown"
            initial={{ opacity: 0, y: 6, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.985 }}
            transition={{ duration: 0.14 }}
            className="absolute right-0 left-0 sm:left-auto sm:w-[440px] max-w-[94vw] mt-2 z-40 rounded-2xl bg-white dark:bg-[#151A24] border border-slate-200 dark:border-slate-700/90 shadow-2xl overflow-hidden"
          >
            <div className="px-3.5 py-2 border-b border-slate-100 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/60 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
              <span>
                {results.length > 0
                  ? `${toPersianDigits(response.counts.all)} نتیجه هوشمند (${toPersianDigits(response.counts.menu)} منو)`
                  : 'نتیجه‌ای یافت نشد'}
              </span>
              <span className="font-code">Enter برای ورود</span>
            </div>

            {results.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-slate-500 dark:text-slate-400">
                منو، سند یا حسابی مطابق با «{value.trim()}» پیدا نشد.
              </div>
            ) : (
              <div className="max-h-80 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/80">
                {results.map((item, idx) => {
                  const Icon = getCategoryIcon(item.category);
                  const isActive = idx === safeActiveIndex;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onMouseEnter={() => setActiveIndex(idx)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleSelect(item);
                      }}
                      className={`w-full px-3.5 py-2.5 flex items-center justify-between gap-2.5 text-right transition-colors cursor-pointer ${
                        isActive
                          ? 'bg-indigo-50/90 dark:bg-indigo-950/50'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                      }`}
                    >
                      <div className="flex items-start gap-2.5 min-w-0 flex-1">
                        <div
                          className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                            item.category === 'menu'
                              ? 'bg-indigo-100/80 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300'
                              : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-300'
                          }`}
                        >
                          <Icon className="w-3.5 h-3.5 shrink-0" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                            <HighlightedText text={item.title} query={value} />
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                            <HighlightedText text={item.subtitle} query={value} />
                          </div>
                        </div>
                      </div>
                      <div className="text-left shrink-0">
                        {item.metaText ? (
                          <div className="text-[11px] font-bold font-code tabular-nums text-slate-800 dark:text-slate-200">
                            {item.metaText}
                          </div>
                        ) : item.shortcut ? (
                          <kbd className="font-code text-[10px] px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-slate-500">
                            {item.shortcut}
                          </kbd>
                        ) : null}
                        <div className="text-[10.5px] text-slate-400 dark:text-slate-500">
                          {item.categoryLabel}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
