// Country picker list for the popup (Req 6.1). Shared-lib pattern, see rules.js.
(() => {
  // Codes CLDR names that are not places a user would pick: EU, Eurozone,
  // Outlying Oceania, United Nations, the two pseudo-locales, Unknown Region.
  const NOT_COUNTRIES = new Set(['EU', 'EZ', 'QO', 'UN', 'XA', 'XB', 'ZZ']);

  // Every region CLDR names over AA..ZZ, plus whatever X itself has returned
  // (its spelling can differ from CLDR's), sorted, with "Unknown" last.
  function pickerList(seen = []) {
    const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
    const out = new Set();
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        const name = NOT_COUNTRIES.has(code) ? undefined : names.of(code);
        if (name) out.add(name);
      }
    }
    for (const s of seen) if (typeof s === 'string' && s.trim()) out.add(s.trim());
    out.delete('Unknown');
    return [...out].sort((x, y) => x.localeCompare(y, 'en')).concat('Unknown');
  }

  const countries = { pickerList };

  globalThis.Papieren ??= {};
  globalThis.Papieren.countries = countries;
  if (typeof module === 'object') module.exports = countries;
})();
