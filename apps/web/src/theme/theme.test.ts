import assert from 'node:assert/strict';
import test from 'node:test';

import { isThemePreference, resolveTheme } from './theme.js';

test('system follows the OS color scheme', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
});

test('explicit light or dark wins over the OS', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});

test('isThemePreference accepts only the three stored values', () => {
  assert.equal(isThemePreference('system'), true);
  assert.equal(isThemePreference('light'), true);
  assert.equal(isThemePreference('dark'), true);
  assert.equal(isThemePreference('auto'), false);
  assert.equal(isThemePreference(null), false);
});
