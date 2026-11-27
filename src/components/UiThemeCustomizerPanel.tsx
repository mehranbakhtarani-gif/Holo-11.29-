import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Palette,
  RotateCcw,
  Save,
} from 'lucide-react';
import { useAccounting } from '../context/AccountingContext';
import { toPersianDigits } from '../lib/format';
import {
  applyUiThemeToDocument,
  computeContrastRatio,
  DEFAULT_UI_THEME,
  isDefaultUiTheme,
  loadUiThemeFromStorage,
  normalizeHexColor,
  resetUiThemeStorage,
  saveUiThemeToStorage,
  UI_THEME_CHANGE_EVENT,
  UI_THEME_PRESETS,
  UI_THEME_STORAGE_KEY,
  UiThemeConfig,
} from '../lib/uiThemeCustomizer';

type ColorFieldKey = 'primaryColor' | 'secondaryAccent' | 'warningAccent' | 'dangerAccent';

interface ColorControlMeta {
  key: ColorFieldKey;
  label: string;
  description: string;
  swatches: string[];
}

const COLOR_CONTROLS: ColorControlMeta[] = [
  {
    key: 'primaryColor',
    label: 'رنگ اصلی برند (Primary)',
    description: 'دکمه‌های اصلی، منوی فعال، نمودارها و کادر فوکوس کیبورد',
    swatches: ['#6366F1', '#0F766E', '#2563EB', '#7C3AED', '#B45309', '#BE123C'],
  },
  {
    key: 'secondaryAccent',
    label: 'رنگ مکمل و تأکید (Accent)',
    description: 'تأییدیه‌ها، روند مثبت فروش، موجودی انبار و شاخص‌های سود',
    swatches: ['#10B981', '#0D9488', '#16A34A', '#0284C7', '#059669', '#0891B2'],
  },
  {
    key: 'warningAccent',
    label: 'رنگ هشدار و سررسید (Warning)',
    description: 'یادآوری چک‌های نزدیک، نقطه سفارش انبار و اسناد موقت',
    swatches: ['#F59E0B', '#D97706', '#EA580C', '#CA8A04', '#B45309', '#C2410C'],
  },
  {
    key: 'dangerAccent',
    label: 'رنگ خطا و بحرانی (Danger)',
    description: 'خطاهای ممیزی، کسری موجودی، ابطال اسناد و عملیات حذف',
    swatches: ['#EF4444', '#DC2626', '#E11D48', '#BE123C', '#B91C1C', '#9F1239'],
  },
];

export const UiThemeCustomizerPanel: React.FC<{ highlighted?: boolean }> = ({
  highlighted = false,
}) => {
  const { showToast } = useAccounting();
  const [theme, setTheme] = useState<UiThemeConfig>(() => loadUiThemeFromStorage());
  const [hexDrafts, setHexDrafts] = useState<Record<ColorFieldKey, string>>(() => {
    const initial = loadUiThemeFromStorage();
    return {
      primaryColor: initial.primaryColor,
      secondaryAccent: initial.secondaryAccent,
      warningAccent: initial.warningAccent,
      dangerAccent: initial.dangerAccent,
    };
  });
  const [copiedPalette, setCopiedPalette] = useState(false);

  // Sync if changed from another tab or external trigger
  useEffect(() => {
    const syncFromStore = () => {
      const latest = loadUiThemeFromStorage();
      setTheme(latest);
      setHexDrafts({
        primaryColor: latest.primaryColor,
        secondaryAccent: latest.secondaryAccent,
        warningAccent: latest.warningAccent,
        dangerAccent: latest.dangerAccent,
      });
    };

    const handleStorage = (e: StorageEvent) => {
      if (e.key === UI_THEME_STORAGE_KEY) {
        const latest = loadUiThemeFromStorage();
        applyUiThemeToDocument(latest);
        syncFromStore();
      }
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener(UI_THEME_CHANGE_EVENT, syncFromStore);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(UI_THEME_CHANGE_EVENT, syncFromStore);
    };
  }, []);

  const isDefault = useMemo(() => isDefaultUiTheme(theme), [theme]);

  const commitTheme = (next: UiThemeConfig) => {
    const saved = saveUiThemeToStorage(next);
    applyUiThemeToDocument(saved);
    setTheme(saved);
    setHexDrafts({
      primaryColor: saved.primaryColor,
      secondaryAccent: saved.secondaryAccent,
      warningAccent: saved.warningAccent,
      dangerAccent: saved.dangerAccent,
    });
  };

  const handleSelectPreset = (presetId: string) => {
    const preset = UI_THEME_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    commitTheme({
      presetId: preset.id,
      primaryColor: preset.primaryColor,
      secondaryAccent: preset.secondaryAccent,
      warningAccent: preset.warningAccent,
      dangerAccent: preset.dangerAccent,
    });
    showToast(`پالت رنگی «${preset.name}» اعمال و در حافظه مرورگر ذخیره شد.`);
  };

  const handleColorPick = (key: ColorFieldKey, hexValue: string) => {
    const normalized = normalizeHexColor(hexValue);
    if (!normalized) return;
    commitTheme({
      ...theme,
      presetId: 'custom',
      [key]: normalized,
    });
  };

  const handleHexInputChange = (key: ColorFieldKey, rawValue: string) => {
    const cleaned = rawValue.slice(0, 7);
    setHexDrafts((prev) => ({ ...prev, [key]: cleaned }));
    const normalized = normalizeHexColor(cleaned);
    if (normalized) {
      commitTheme({
        ...theme,
        presetId: 'custom',
        [key]: normalized,
      });
    }
  };

  const handleHexInputBlur = (key: ColorFieldKey) => {
    const normalized = normalizeHexColor(hexDrafts[key]);
    if (!normalized) {
      setHexDrafts((prev) => ({ ...prev, [key]: theme[key] }));
    } else {
      setHexDrafts((prev) => ({ ...prev, [key]: normalized }));
    }
  };

  const handleReset = () => {
    const resetConfig = resetUiThemeStorage();
    applyUiThemeToDocument(resetConfig);
    setTheme(resetConfig);
    setHexDrafts({
      primaryColor: resetConfig.primaryColor,
      secondaryAccent: resetConfig.secondaryAccent,
      warningAccent: resetConfig.warningAccent,
      dangerAccent: resetConfig.dangerAccent,
    });
    showToast('رنگ‌بندی محیط کاربری به حالت پیش‌فرض هلو Apex بازگردانده شد.');
  };

  const handleExplicitSave = () => {
    commitTheme(theme);
    showToast('تنظیمات رنگ‌بندی برند و Accentها با موفقیت در localStorage ذخیره شد.');
  };

  const handleCopyPalette = async () => {
    const payload = JSON.stringify(theme, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      setCopiedPalette(true);
      showToast('کد رنگ‌بندی پالت در کلیپ‌بورد کپی شد.');
      setTimeout(() => setCopiedPalette(false), 1800);
    } catch {
      showToast('امکان دسترسی به کلیپ‌بورد در این مرورگر وجود ندارد.', 'warning');
    }
  };

  const activePresetName = useMemo(() => {
    const found = UI_THEME_PRESETS.find((p) => p.id === theme.presetId);
    return found ? found.name : 'سفارشی کاربر';
  }, [theme.presetId]);

  return (
    <section
      aria-label="شخصی‌سازی رنگ‌بندی محیط کاربری"
      className={`bg-white dark:bg-slate-900 border rounded-xl p-5 space-y-5 transition-all ${
        highlighted
          ? 'border-indigo-500 ring-2 ring-indigo-500/20'
          : 'border-slate-200 dark:border-slate-800'
      }`}
    >
      {/* Header Row */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pb-4 border-b border-slate-200/80 dark:border-slate-800">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-indigo-50 dark:bg-indigo-950/50 border border-indigo-200/70 dark:border-indigo-800/60 flex items-center justify-center shrink-0 mt-0.5">
            <Palette className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              شخصی‌سازی رنگ‌بندی محیط کاربری (UI Theme Customizer)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              تغییر زنده رنگ اصلی برند و رنگ‌های تأکید (Accent) در کل نرم‌افزار با ذخیره خودکار در localStorage مرورگر
            </p>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400 mt-1.5">
              <span>پالت فعال: {activePresetName}</span>
              <span aria-hidden="true">·</span>
              <span className="font-code tabular-nums" dir="ltr">
                {theme.primaryColor}
              </span>
              <span aria-hidden="true">/</span>
              <span className="font-code tabular-nums" dir="ltr">
                {theme.secondaryAccent}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleCopyPalette}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copiedPalette ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copiedPalette ? 'کپی شد' : 'کپی پالت'}</span>
          </button>
          <button
            type="button"
            onClick={handleReset}
            disabled={isDefault}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-45 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>بازگشت به پیش‌فرض</span>
          </button>
        </div>
      </div>

      {/* Section 1: Curated Corporate Presets */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-200">
            پالت‌های آماده سازمانی
          </h3>
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            انتخاب سریع با یک کلیک
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {UI_THEME_PRESETS.map((preset) => {
            const active = theme.presetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleSelectPreset(preset.id)}
                className={`text-right p-3 rounded-lg border transition-colors cursor-pointer flex items-start justify-between gap-3 ${
                  active
                    ? 'border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/30'
                    : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 bg-slate-50/40 dark:bg-slate-950/40'
                }`}
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                      {preset.name}
                    </span>
                    {active && <Check className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400 shrink-0" />}
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-1">
                    {preset.description}
                  </p>
                </div>

                {/* Color Preview Swatch Strip */}
                <div className="flex items-center gap-1 shrink-0 pt-0.5" aria-hidden="true">
                  <span
                    className="w-4 h-4 rounded-sm border border-black/10 dark:border-white/15"
                    style={{ backgroundColor: preset.primaryColor }}
                  />
                  <span
                    className="w-4 h-4 rounded-sm border border-black/10 dark:border-white/15"
                    style={{ backgroundColor: preset.secondaryAccent }}
                  />
                  <span
                    className="w-3 h-4 rounded-sm border border-black/10 dark:border-white/15"
                    style={{ backgroundColor: preset.warningAccent }}
                  />
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Section 2: Custom Brand & Accent Color Pickers */}
      <div className="pt-4 border-t border-slate-200/80 dark:border-slate-800 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-200">
            تنظیم دقیق رنگ‌های اصلی برند و Accentها
          </h3>
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            ساخت خودکار طیف ۵۰ تا ۹۵۰ برای حالت روشن و تاریک
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {COLOR_CONTROLS.map((ctrl) => {
            const currentHex = theme[ctrl.key];
            const whiteContrast = computeContrastRatio(currentHex, '#FFFFFF');
            const lowContrastOnWhite = whiteContrast < 3.0;

            return (
              <div
                key={ctrl.key}
                className="p-3.5 rounded-lg border border-slate-200/90 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-950/40 space-y-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <label
                      htmlFor={`ui-theme-${ctrl.key}`}
                      className="block text-xs font-semibold text-slate-900 dark:text-white"
                    >
                      {ctrl.label}
                    </label>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      {ctrl.description}
                    </p>
                  </div>

                  {/* Native Color Picker + Hex Input */}
                  <div className="flex items-center gap-2 shrink-0">
                    <input
                      id={`ui-theme-${ctrl.key}`}
                      type="color"
                      value={currentHex}
                      onChange={(e) => handleColorPick(ctrl.key, e.target.value)}
                      aria-label={ctrl.label}
                      className="w-9 h-9 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent p-0.5 cursor-pointer shrink-0"
                    />
                    <input
                      type="text"
                      value={hexDrafts[ctrl.key]}
                      onChange={(e) => handleHexInputChange(ctrl.key, e.target.value)}
                      onBlur={() => handleHexInputBlur(ctrl.key)}
                      dir="ltr"
                      spellCheck={false}
                      aria-label={`کد هگز ${ctrl.label}`}
                      className="w-[88px] px-2 py-1.5 text-xs font-code tabular-nums uppercase rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                    />
                  </div>
                </div>

                {/* Quick Swatches + Live WCAG Contrast Info */}
                <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-200/60 dark:border-slate-800/80">
                  <div className="flex items-center gap-1.5">
                    {ctrl.swatches.map((sw) => {
                      const isPicked = currentHex.toUpperCase() === sw.toUpperCase();
                      return (
                        <button
                          key={sw}
                          type="button"
                          onClick={() => handleColorPick(ctrl.key, sw)}
                          title={sw}
                          aria-label={`انتخاب رنگ ${sw} برای ${ctrl.label}`}
                          className={`w-5 h-5 rounded-md border transition-transform cursor-pointer flex items-center justify-center ${
                            isPicked
                              ? 'scale-110 ring-2 ring-offset-1 ring-slate-900 dark:ring-white dark:ring-offset-slate-900 border-white/60'
                              : 'border-black/15 dark:border-white/15 hover:scale-105'
                          }`}
                          style={{ backgroundColor: sw }}
                        >
                          {isPicked && <Check className="w-3 h-3 text-white drop-shadow" />}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex items-center gap-1 text-[11px] font-code tabular-nums text-slate-500 dark:text-slate-400">
                    {lowContrastOnWhite && (
                      <AlertTriangle
                        className="w-3.5 h-3.5 text-amber-500 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    <span>
                      کنتراست: {toPersianDigits(whiteContrast.toFixed(1))}:۱
                      {whiteContrast >= 4.5
                        ? ' · عالی'
                        : whiteContrast >= 3.0
                        ? ' · مناسب'
                        : ' · روشن'}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Section 3: Live UI Preview Strip + Save Action */}
      <div className="pt-4 border-t border-slate-200/80 dark:border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
            پیش‌نمایش زنده:
          </span>
          <span className="inline-flex items-center px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold">
            دکمه اصلی برند
          </span>
          <span className="inline-flex items-center px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold">
            تأیید و ثبت
          </span>
          <span className="inline-flex items-center px-2.5 py-1 rounded-md border border-indigo-200 dark:border-indigo-800/70 bg-indigo-50/80 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 text-xs font-medium">
            تب فعال منو
          </span>
          <span className="text-xs font-semibold text-amber-600 dark:text-amber-400">
            هشدار سررسید
          </span>
          <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">
            ·
          </span>
          <span className="text-xs font-semibold text-rose-600 dark:text-rose-400">
            خطای تراز
          </span>
        </div>

        <button
          type="button"
          onClick={handleExplicitSave}
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Save className="w-3.5 h-3.5" />
          <span>ذخیره رنگ‌بندی در حافظه مرورگر</span>
        </button>
      </div>
    </section>
  );
};
