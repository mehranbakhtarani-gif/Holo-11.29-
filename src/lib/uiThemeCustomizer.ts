/**
 * UI Theme Customizer Engine (Holoo Apex)
 *
 * Allows users to personalize primary brand colors and semantic accents across the entire
 * Tailwind v4 + CSS variable design system, with automatic 11-step shade generation,
 * WCAG contrast calculation, and resilient localStorage persistence.
 */

export const UI_THEME_STORAGE_KEY = 'holoo_ui_theme_customizer_v1';
export const UI_THEME_CHANGE_EVENT = 'holoo-ui-theme-changed';

export interface UiThemeConfig {
  presetId: string;
  primaryColor: string;
  secondaryAccent: string;
  warningAccent: string;
  dangerAccent: string;
}

export interface UiThemePreset {
  id: string;
  name: string;
  description: string;
  primaryColor: string;
  secondaryAccent: string;
  warningAccent: string;
  dangerAccent: string;
}

export const DEFAULT_UI_THEME: UiThemeConfig = {
  presetId: 'apex-indigo',
  primaryColor: '#6366F1',
  secondaryAccent: '#10B981',
  warningAccent: '#F59E0B',
  dangerAccent: '#EF4444',
};

export const UI_THEME_PRESETS: UiThemePreset[] = [
  {
    id: 'apex-indigo',
    name: 'نیلی کلاسیک Apex',
    description: 'پالت پیش‌فرض حسابداری شرکتی با تمرکز بالا',
    primaryColor: '#6366F1',
    secondaryAccent: '#10B981',
    warningAccent: '#F59E0B',
    dangerAccent: '#EF4444',
  },
  {
    id: 'emerald-treasury',
    name: 'زمردی خزانه‌داری',
    description: 'سبز فیروزه‌ای مالی با کنتراست آرام برای کار طولانی',
    primaryColor: '#0F766E',
    secondaryAccent: '#16A34A',
    warningAccent: '#D97706',
    dangerAccent: '#DC2626',
  },
  {
    id: 'royal-sapphire',
    name: 'لاجوردی بانکی',
    description: 'آبی رسمی سازمانی برای دفاتر و گزارش‌های مدیریتی',
    primaryColor: '#2563EB',
    secondaryAccent: '#0D9488',
    warningAccent: '#EA580C',
    dangerAccent: '#E11D48',
  },
  {
    id: 'executive-amber',
    name: 'کهربایی اجرایی',
    description: 'ترکیب گرم طلایی-کهربایی با مکمل سبز صنعتی',
    primaryColor: '#B45309',
    secondaryAccent: '#059669',
    warningAccent: '#CA8A04',
    dangerAccent: '#DC2626',
  },
  {
    id: 'crimson-ledger',
    name: 'یاقوتی مدرن',
    description: 'هویت متمایز یاقوتی همراه با مکمل فیروزه‌ای',
    primaryColor: '#BE123C',
    secondaryAccent: '#0F766E',
    warningAccent: '#D97706',
    dangerAccent: '#DC2626',
  },
  {
    id: 'graphite-steel',
    name: 'گرافیتی مینیمال',
    description: 'خنثی و حرفه‌ای برای تمرکز حداکثری روی اعداد',
    primaryColor: '#334155',
    secondaryAccent: '#0284C7',
    warningAccent: '#D97706',
    dangerAccent: '#E11D48',
  },
];

export type ShadeStep = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950;
export const SHADE_STEPS: ShadeStep[] = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

/** Normalizes 3-digit or 6-digit hex color to uppercase #RRGGBB, or returns null if invalid. */
export function normalizeHexColor(input: string): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  const shortMatch = /^#?([0-9a-fA-F]{3})$/.exec(trimmed);
  if (shortMatch) {
    const [r, g, b] = shortMatch[1].split('');
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  const fullMatch = /^#?([0-9a-fA-F]{6})$/.exec(trimmed);
  if (fullMatch) {
    return `#${fullMatch[1]}`.toUpperCase();
  }
  return null;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const norm = normalizeHexColor(hex) ?? '#6366F1';
  const num = parseInt(norm.slice(1), 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (
    '#' +
    [clamp(r), clamp(g), clamp(b)]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

/** Linearly mixes two hex colors: ratio 0 = hexA, ratio 1 = hexB. */
export function mixHex(hexA: string, hexB: string, ratio: number): string {
  const t = Math.max(0, Math.min(1, ratio));
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  return rgbToHex(
    a.r + (b.r - a.r) * t,
    a.g + (b.g - a.g) * t,
    a.b + (b.b - a.b) * t
  );
}

/**
 * Generates an 11-step Tailwind v4 color ramp (50..950) anchored at 500/600 from any hex color.
 * Ensures light tints stay crisp in light mode and deep shades remain legible in dark mode.
 */
export function generateColorScale(baseHex: string): Record<ShadeStep, string> {
  const base = normalizeHexColor(baseHex) ?? DEFAULT_UI_THEME.primaryColor;
  const lum = getRelativeLuminance(base);
  // Dark bases (e.g. graphite-steel #334155 or emerald-treasury #0F766E) need a lighter 400/300 tint
  // so dark:text-*-400 maintains WCAG AA (>= 4.5:1) legibility on #0B0F17 surfaces.
  const tint400 = lum < 0.12 ? 0.44 : lum < 0.2 ? 0.34 : 0.24;
  const tint300 = lum < 0.12 ? 0.60 : lum < 0.2 ? 0.54 : 0.48;
  return {
    50: mixHex(base, '#FFFFFF', 0.92),
    100: mixHex(base, '#FFFFFF', 0.84),
    200: mixHex(base, '#FFFFFF', 0.72),
    300: mixHex(base, '#FFFFFF', tint300),
    400: mixHex(base, '#FFFFFF', tint400),
    500: base,
    600: mixHex(base, '#0B0F17', 0.14),
    700: mixHex(base, '#0B0F17', 0.30),
    800: mixHex(base, '#0B0F17', 0.48),
    900: mixHex(base, '#0B0F17', 0.64),
    950: mixHex(base, '#0B0F17', 0.78),
  };
}

/** Relative luminance per WCAG 2.1 */
export function getRelativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2.1 contrast ratio between two hex colors (1 to 21). */
export function computeContrastRatio(hexA: string, hexB: string): number {
  const l1 = getRelativeLuminance(hexA);
  const l2 = getRelativeLuminance(hexB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

export function isDefaultUiTheme(config: UiThemeConfig): boolean {
  return (
    config.primaryColor.toUpperCase() === DEFAULT_UI_THEME.primaryColor &&
    config.secondaryAccent.toUpperCase() === DEFAULT_UI_THEME.secondaryAccent &&
    config.warningAccent.toUpperCase() === DEFAULT_UI_THEME.warningAccent &&
    config.dangerAccent.toUpperCase() === DEFAULT_UI_THEME.dangerAccent
  );
}

export function sanitizeUiThemeConfig(raw: unknown): UiThemeConfig {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_UI_THEME };
  }
  const rec = raw as Record<string, unknown>;
  const primaryColor = normalizeHexColor(String(rec.primaryColor ?? '')) ?? DEFAULT_UI_THEME.primaryColor;
  const secondaryAccent = normalizeHexColor(String(rec.secondaryAccent ?? '')) ?? DEFAULT_UI_THEME.secondaryAccent;
  const warningAccent = normalizeHexColor(String(rec.warningAccent ?? '')) ?? DEFAULT_UI_THEME.warningAccent;
  const dangerAccent = normalizeHexColor(String(rec.dangerAccent ?? '')) ?? DEFAULT_UI_THEME.dangerAccent;

  const matchedPreset = UI_THEME_PRESETS.find(
    (p) =>
      p.primaryColor.toUpperCase() === primaryColor &&
      p.secondaryAccent.toUpperCase() === secondaryAccent &&
      p.warningAccent.toUpperCase() === warningAccent &&
      p.dangerAccent.toUpperCase() === dangerAccent
  );

  return {
    presetId: matchedPreset ? matchedPreset.id : 'custom',
    primaryColor,
    secondaryAccent,
    warningAccent,
    dangerAccent,
  };
}

export function loadUiThemeFromStorage(storage?: Pick<Storage, 'getItem'>): UiThemeConfig {
  try {
    const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
    if (!store) return { ...DEFAULT_UI_THEME };
    const raw = store.getItem(UI_THEME_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_UI_THEME };
    return sanitizeUiThemeConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_UI_THEME };
  }
}

export function saveUiThemeToStorage(
  config: UiThemeConfig,
  storage?: Pick<Storage, 'setItem'>
): UiThemeConfig {
  const sanitized = sanitizeUiThemeConfig(config);
  try {
    const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
    if (store) {
      store.setItem(UI_THEME_STORAGE_KEY, JSON.stringify(sanitized));
    }
  } catch {
    // Ignore storage quota errors cleanly
  }
  return sanitized;
}

export function resetUiThemeStorage(storage?: Pick<Storage, 'removeItem'>): UiThemeConfig {
  try {
    const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined);
    if (store) {
      store.removeItem(UI_THEME_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
  return { ...DEFAULT_UI_THEME };
}

/** Collects all CSS variable keys managed by the theme customizer. */
function getManagedCssVarKeys(): string[] {
  const keys = [
    '--apex-primary',
    '--apex-treasury',
    '--apex-analytics',
    '--apex-income',
    '--apex-warning',
    '--apex-alert',
  ];
  const families = ['indigo', 'violet', 'emerald', 'teal', 'amber', 'rose'];
  for (const family of families) {
    for (const step of SHADE_STEPS) {
      keys.push(`--color-${family}-${step}`);
    }
  }
  return keys;
}

/**
 * Computes the exact CSS variable map to apply onto `:root` for a given UiThemeConfig.
 * Returns an empty record when the theme matches DEFAULT_UI_THEME so native CSS rules apply.
 */
export function buildCssVariablesForTheme(config: UiThemeConfig): Record<string, string> {
  const sanitized = sanitizeUiThemeConfig(config);
  if (isDefaultUiTheme(sanitized)) {
    return {};
  }

  const primaryScale = generateColorScale(sanitized.primaryColor);
  const violetCompanion = mixHex(sanitized.primaryColor, '#4F46E5', 0.22);
  const violetScale = generateColorScale(violetCompanion);
  const accentScale = generateColorScale(sanitized.secondaryAccent);
  const warningScale = generateColorScale(sanitized.warningAccent);
  const dangerScale = generateColorScale(sanitized.dangerAccent);

  const vars: Record<string, string> = {
    '--apex-primary': primaryScale[500],
    '--apex-treasury': primaryScale[400],
    '--apex-analytics': primaryScale[500],
    '--apex-income': accentScale[500],
    '--apex-warning': warningScale[500],
    '--apex-alert': dangerScale[500],
  };

  for (const step of SHADE_STEPS) {
    vars[`--color-indigo-${step}`] = primaryScale[step];
    vars[`--color-violet-${step}`] = violetScale[step];
    vars[`--color-emerald-${step}`] = accentScale[step];
    vars[`--color-teal-${step}`] = accentScale[step];
    vars[`--color-amber-${step}`] = warningScale[step];
    vars[`--color-rose-${step}`] = dangerScale[step];
  }

  return vars;
}

interface MinimalStyleTarget {
  setProperty(name: string, value: string): void;
  removeProperty(name: string): void;
}

/** Applies the theme CSS custom properties onto document.documentElement (or a test style target). */
export function applyUiThemeToDocument(
  config: UiThemeConfig,
  styleTarget?: MinimalStyleTarget
): Record<string, string> {
  const target =
    styleTarget ??
    (typeof document !== 'undefined' ? document.documentElement.style : undefined);
  const vars = buildCssVariablesForTheme(config);

  if (target) {
    const entries = Object.entries(vars);
    if (entries.length === 0) {
      for (const key of getManagedCssVarKeys()) {
        target.removeProperty(key);
      }
    } else {
      for (const [key, value] of entries) {
        target.setProperty(key, value);
      }
    }
  }

  if (!styleTarget && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(UI_THEME_CHANGE_EVENT, { detail: sanitizeUiThemeConfig(config) }));
  }

  return vars;
}

/** Hydrates saved theme from localStorage on initial application boot (zero flicker). */
export function initUiThemeFromStorage(): UiThemeConfig {
  const saved = loadUiThemeFromStorage();
  applyUiThemeToDocument(saved);
  return saved;
}
