(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FrameExportSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function output(crop, sourceFps, settings) {
    let ratio = crop.width / crop.height;
    if (settings.aspect !== 'source') {
      const [width, height] = settings.aspect.split(':').map(Number);
      ratio = width / height;
    }
    const shortEdge = settings.resolution === 'source' ? Math.min(crop.width, crop.height) : Number(settings.resolution);
    const even = value => Math.max(2, Math.round(value / 2) * 2);
    const [width, height] = ratio >= 1
      ? [even(shortEdge * ratio), even(shortEdge)]
      : [even(shortEdge), even(shortEdge / ratio)];
    const fps = settings.fps === 'source' ? Math.min(60, Math.max(1, sourceFps || 30)) : Number(settings.fps);
    return { width, height, fps };
  }
  function estimate({ width, height, fps }, seconds, quality, browserMode) {
    // CRF does not target a bitrate. Use a broad planning range, including the
    // 192 kbps AAC track; content and encoder presets can exceed this range.
    const bitsPerPixel = 0.09 * 2 ** ((23 - Number(quality)) / 6);
    const videoRate = width * height * fps * bitsPerPixel * (browserMode ? 1.5 : 1);
    const bytes = rate => Math.max(0, seconds) * (rate + 192000) / 8 * 1.02;
    return { low: bytes(videoRate * 0.4), high: bytes(videoRate * 2.5) };
  }
  function sizeRange({ low, high }) {
    const unit = high >= 1e9 ? 'GB' : 'MB';
    const divisor = unit === 'GB' ? 1e9 : 1e6;
    return `${Math.max(0.1, low / divisor).toFixed(1)}–${Math.max(0.1, high / divisor).toFixed(1)} ${unit}`;
  }
  return { output, estimate, sizeRange };
});
