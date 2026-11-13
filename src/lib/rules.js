// Shared-lib pattern. The same file loads three ways without a build step:
// as a classic content script (isolated world), as a side-effect import in the
// module service worker, and through require() under node --test.
// The IIFE matters: classic content scripts share one global scope, so a
// top-level const in two libs would collide. Only the namespace escapes.
(() => {
  const rules = {};

  globalThis.Papieren ??= {};
  globalThis.Papieren.rules = rules;
  if (typeof module === 'object') module.exports = rules;
})();
