import assert from 'node:assert/strict';
import {
  applyUiThemeToDocument,
  buildCssVariablesForTheme,
  computeContrastRatio,
  DEFAULT_UI_THEME,
  generateColorScale,
  getRelativeLuminance,
  isDefaultUiTheme,
  loadUiThemeFromStorage,
  normalizeHexColor,
  resetUiThemeStorage,
  saveUiThemeToStorage,
  SHADE_STEPS,
  UI_THEME_PRESETS,
  UI_THEME_STORAGE_KEY,
} from '../src/lib/uiThemeCustomizer';

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

class MockStyleTarget {
  props = new Map<string, string>();
  setProperty(name: string, value: string): void {
    this.props.set(name, value);
  }
  removeProperty(name: string): void {
    this.props.delete(name);
  }
}

let passed = 0;
function runCase(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

runCase('1. normalizeHexColor handles 3-digit, 6-digit, missing #, and rejects invalid values', () => {
  assert.equal(normalizeHexColor('#abc'), '#AABBCC');
  assert.equal(normalizeHexColor('0f766e'), '#0F766E');
  assert.equal(normalizeHexColor('  #2563eb  '), '#2563EB');
  assert.equal(normalizeHexColor('#12345'), null);
  assert.equal(normalizeHexColor('not-a-color'), null);
  assert.equal(normalizeHexColor(''), null);
});

runCase('2. generateColorScale creates a monotonic light-to-dark 11-step Tailwind ramp', () => {
  const scale = generateColorScale('#0F766E');
  assert.equal(scale[500], '#0F766E');
  for (const step of SHADE_STEPS) {
    assert.ok(normalizeHexColor(scale[step]) !== null, `Shade ${step} must be valid hex`);
  }
  assert.ok(
    getRelativeLuminance(scale[50]) > getRelativeLuminance(scale[300]) &&
      getRelativeLuminance(scale[300]) > getRelativeLuminance(scale[500]) &&
      getRelativeLuminance(scale[500]) > getRelativeLuminance(scale[800]) &&
      getRelativeLuminance(scale[800]) > getRelativeLuminance(scale[950]),
    'Luminance must strictly decrease from shade 50 to shade 950'
  );
});

runCase('3. computeContrastRatio accurately matches WCAG 2.1 benchmarks', () => {
  assert.equal(computeContrastRatio('#000000', '#FFFFFF'), 21);
  assert.equal(computeContrastRatio('#FFFFFF', '#FFFFFF'), 1);
  assert.ok(computeContrastRatio('#0F766E', '#FFFFFF') >= 5.0);
  assert.ok(computeContrastRatio('#2563EB', '#FFFFFF') >= 4.5);
});

runCase('4. localStorage save, load, malformed fallback, and reset round-trip cleanly', () => {
  const storage = new MemoryStorage();

  // Initial empty state returns default
  const initial = loadUiThemeFromStorage(storage);
  assert.equal(isDefaultUiTheme(initial), true);

  // Save custom palette
  const saved = saveUiThemeToStorage(
    {
      presetId: 'custom',
      primaryColor: '#2563eb',
      secondaryAccent: '#0d9488',
      warningAccent: '#ea580c',
      dangerAccent: '#e11d48',
    },
    storage
  );
  // Matches royal-sapphire preset automatically
  assert.equal(saved.presetId, 'royal-sapphire');
  assert.equal(saved.primaryColor, '#2563EB');

  const reloaded = loadUiThemeFromStorage(storage);
  assert.deepEqual(reloaded, saved);

  // Malformed JSON safely falls back to defaults
  storage.setItem(UI_THEME_STORAGE_KEY, '{bad-json');
  assert.deepEqual(loadUiThemeFromStorage(storage), DEFAULT_UI_THEME);

  // Invalid hex field falls back to default for that field without crashing
  storage.setItem(
    UI_THEME_STORAGE_KEY,
    JSON.stringify({ primaryColor: 'javascript:alert(1)', secondaryAccent: '#16a34a' })
  );
  const sanitized = loadUiThemeFromStorage(storage);
  assert.equal(sanitized.primaryColor, DEFAULT_UI_THEME.primaryColor);
  assert.equal(sanitized.secondaryAccent, '#16A34A');
  assert.equal(sanitized.presetId, 'custom');

  // Reset clears storage
  const afterReset = resetUiThemeStorage(storage);
  assert.deepEqual(afterReset, DEFAULT_UI_THEME);
  assert.equal(storage.getItem(UI_THEME_STORAGE_KEY), null);
});

runCase('5. applyUiThemeToDocument injects full Tailwind v4 & Apex tokens and cleans up on default reset', () => {
  const styleTarget = new MockStyleTarget();
  const emeraldPreset = UI_THEME_PRESETS.find((p) => p.id === 'emerald-treasury')!;
  const applied = applyUiThemeToDocument(
    {
      presetId: emeraldPreset.id,
      primaryColor: emeraldPreset.primaryColor,
      secondaryAccent: emeraldPreset.secondaryAccent,
      warningAccent: emeraldPreset.warningAccent,
      dangerAccent: emeraldPreset.dangerAccent,
    },
    styleTarget
  );

  assert.equal(styleTarget.props.get('--apex-primary'), '#0F766E');
  assert.equal(styleTarget.props.get('--color-indigo-500'), '#0F766E');
  assert.equal(styleTarget.props.get('--color-emerald-500'), '#16A34A');
  assert.equal(styleTarget.props.get('--color-teal-500'), '#16A34A');
  assert.equal(styleTarget.props.get('--color-amber-500'), '#D97706');
  assert.equal(styleTarget.props.get('--color-rose-500'), '#DC2626');
  assert.ok(Object.keys(applied).length >= 70);

  // Applying default theme removes all custom inline overrides cleanly
  const defaultVars = buildCssVariablesForTheme(DEFAULT_UI_THEME);
  assert.deepEqual(defaultVars, {});
  applyUiThemeToDocument(DEFAULT_UI_THEME, styleTarget);
  assert.equal(styleTarget.props.size, 0);
});

console.log(`\nAll ${passed} UI Theme Customizer tests passed!`);
