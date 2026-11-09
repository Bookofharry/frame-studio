(function (root, factory) {
  const layout = factory();
  if (typeof module === 'object' && module.exports) module.exports = layout;
  else root.FrameTextLayout = layout;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function advance(character) {
    if (character === ' ') return 0.28;
    if (/[ilI.,:;!|']/u.test(character)) return 0.26;
    if (/[ftjr()\[\]{}]/u.test(character)) return 0.36;
    if (/[mwMW@%]/u.test(character)) return 0.84;
    if (/[A-Z]/u.test(character)) return 0.68;
    if (/[0-9]/u.test(character)) return 0.56;
    return 0.53;
  }
  function width(text) { return [...text].reduce((sum, character) => sum + advance(character), 0); }
  function wrap(text, aspect, size) {
    const max = Math.max(3, 0.84 * aspect / size);
    const lines = [];
    for (const paragraph of String(text).replace(/\r/g, '').split('\n')) {
      if (!paragraph.trim()) { lines.push(''); continue; }
      let line = '';
      for (const word of paragraph.trim().split(/\s+/u)) {
        const candidate = line ? `${line} ${word}` : word;
        if (width(candidate) <= max) { line = candidate; continue; }
        if (line) { lines.push(line); line = ''; }
        for (const character of word) {
          if (line && width(line + character) > max) { lines.push(line); line = ''; }
          line += character;
        }
      }
      lines.push(line);
    }
    return lines.join('\n');
  }
  return { wrap, boxPadding: 1 / 60, lineSpacing: 0.08 };
});
