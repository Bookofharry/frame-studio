(function (root, factory) {
  const names = factory();
  if (typeof module === 'object' && module.exports) module.exports = names;
  else root.FrameExportName = names;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function filename(value) {
    const requested = typeof value === 'string' ? value : '';
    const base = requested.replace(/\.mp4$/i, '').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '').trim().replace(/[. ]+$/g, '').slice(0, 120);
    const safe = base && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base) ? base : 'Frame-export';
    return `${safe}.mp4`;
  }
  return { filename };
});
