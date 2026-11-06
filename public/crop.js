(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FrameCrop = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function full(media) { return { x: 0, y: 0, width: media.width, height: media.height }; }
  function valid(crop, media) {
    return crop && ['x', 'y', 'width', 'height'].every(key => Number.isInteger(crop[key])) &&
      crop.x >= 0 && crop.y >= 0 && crop.width >= 2 && crop.height >= 2 &&
      crop.x + crop.width <= media.width && crop.y + crop.height <= media.height;
  }
  function normalize(crop, media) {
    const width = Math.max(2, Math.min(media.width, Math.round(crop.width)));
    const height = Math.max(2, Math.min(media.height, Math.round(crop.height)));
    return { x: Math.max(0, Math.min(media.width - width, Math.round(crop.x))), y: Math.max(0, Math.min(media.height - height, Math.round(crop.y))), width, height };
  }
  function preset(ratio, media) {
    if (!ratio) return full(media);
    const width = Math.min(media.width, media.height * ratio);
    const height = width / ratio;
    return normalize({ x: (media.width - width) / 2, y: (media.height - height) / 2, width, height }, media);
  }
  return { full, valid, normalize, preset };
});
