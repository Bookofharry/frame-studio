const test = require('node:test');
const assert = require('node:assert/strict');
const { output, estimate, sizeRange } = require('../public/export-settings');

test('export dimensions follow crop, canvas ratio and source FPS limits', () => {
  assert.deepEqual(output({ width: 1080, height: 1920 }, 120, { aspect: 'source', resolution: 'source', fps: 'source' }), { width: 1080, height: 1920, fps: 60 });
  assert.deepEqual(output({ width: 640, height: 360 }, 24, { aspect: '1:1', resolution: 'source', fps: 'source' }), { width: 360, height: 360, fps: 24 });
  assert.deepEqual(output({ width: 640, height: 360 }, 24, { aspect: '9:16', resolution: '720', fps: '30' }), { width: 720, height: 1280, fps: 30 });
});

test('size guidance responds to duration, resolution, FPS, quality and encoder', () => {
  const frame = { width: 1280, height: 720, fps: 30 };
  const base = estimate(frame, 30, 23, false);
  assert.ok(base.low > 30 * 192000 / 8, 'Includes the audio track');
  assert.ok(base.high > base.low, 'Presents a range, not false precision');
  const longer = estimate(frame, 60, 23, false);
  assert.equal(longer.low, base.low * 2);
  assert.equal(longer.high, base.high * 2);
  for (const larger of [
    estimate({ ...frame, width: 1920, height: 1080 }, 30, 23, false),
    estimate({ ...frame, fps: 60 }, 30, 23, false),
    estimate(frame, 30, 18, false),
    estimate(frame, 30, 23, true)
  ]) assert.ok(larger.low > base.low && larger.high > base.high);
  assert.match(sizeRange(base), /MB$/);
  assert.match(sizeRange(estimate(frame, 36000, 18, false)), /GB$/);
});
