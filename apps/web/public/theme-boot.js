/**
 * First-paint theme boot. Must stay a static file so it survives CSP
 * `script-src 'self'` (an inline script would be blocked in production).
 *
 * Keep the preference key, allowed values, and resolution rules in lockstep
 * with `src/theme/theme.ts`. This file exists only to paint the right
 * `data-theme` before CSS arrives; React re-applies the same rules on mount.
 */
(function () {
  var key = 'fh:theme';
  var preference = 'system';
  try {
    var stored = window.localStorage.getItem(key);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      preference = stored;
    }
  } catch (err) {
    // Private mode / blocked storage. Stay on system.
  }
  var systemDark = false;
  try {
    systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (err) {
    // matchMedia can throw in some test environments.
  }
  var resolved =
    preference === 'dark' || (preference === 'system' && systemDark) ? 'dark' : 'light';
  var root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.style.colorScheme = resolved;
})();
