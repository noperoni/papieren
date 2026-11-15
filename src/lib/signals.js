// The Signal registry (packs design, lib/signals.js): each Signal is one way
// to judge a post, and rules.evaluate() walks them by rank. A Signal file
// registers itself at load, after this file and before rules.js.
// Shared-lib pattern, see rules.js.
//
// Signal: { id, rank, active(settings, ctx), judge(post, ctx),
//           rules?(settings), fromUser?(user), fromTweet?(tweet), prepare?(records, ctx) }
(() => {
  const list = [];

  function register(signal) {
    if (list.some((s) => s.id === signal.id)) throw new Error(`Signal ${signal.id} registered twice`);
    list.push(signal);
    list.sort((a, b) => a.rank - b.rank);
  }

  // The live list, by rank: read on every judged cell, so not copied.
  const all = () => list;
  const get = (id) => list.find((s) => s.id === id);

  const signals = { register, all, get };

  globalThis.Papieren ??= {};
  globalThis.Papieren.signals = signals;
  if (typeof module === 'object') module.exports = signals;
})();
