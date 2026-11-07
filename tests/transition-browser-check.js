const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-transition-browser-'));
  const root = path.join(__dirname, '..');
  const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: '4321', FRAME_DATA_DIR: temporary }, windowsHide: true });
  let browser;
  try {
    await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4321');
    await page.locator('#file-input').setInputFiles([
      path.join(root, 'test-results/sample-with-audio.mp4'),
      path.join(root, 'test-results/sample-silent.mp4')
    ]);
    await page.waitForFunction(() => document.querySelectorAll('.timeline-clip').length === 2 && !document.getElementById('import-zone').disabled);
    const transition = await page.evaluate(() => {
      const sources = project.clips.map(clip => mediaFor(clip));
      project.clips = Array.from({ length: 60 }, (_, index) => freshClip(sources[index % 2]));
      project.settings.transitionDuration = 0.6;
      const index = project.clips.findIndex((_, i) => i > 0 && offset(i) >= 108 && offset(i) <= 110);
      if (index < 0) throw new Error('No transition near 1:48–1:50 in test timeline');
      const at = offset(index);
      seekTimeline(at - 0.3); save();
      return { index, at };
    });
    await page.waitForFunction(() => document.getElementById('video').readyState >= 2 && document.getElementById('video-preload').readyState >= 2 && !document.getElementById('video-preload').seeking);
    const hiddenUntilDecoded = await page.evaluate(() => {
      const incoming = document.getElementById('video-preload');
      Object.defineProperty(incoming, 'readyState', { configurable: true, get: () => 1 });
      seekTimeline(offset(selected + 1) + 0.1);
      updateTime();
      const opacity = Number(document.getElementById('next-viewport').style.opacity);
      delete incoming.readyState;
      return opacity;
    });
    assert.equal(hiddenUntilDecoded, 0, 'A metadata-only next clip stays invisible');
    await page.evaluate(at => { seekTimeline(at - 0.3); window.transitionSamples = []; window.transitionMonitor = setInterval(() => {
      const incoming = document.getElementById('video-preload');
      const opacity = Number(document.getElementById('next-viewport').style.opacity);
      if (opacity > 0) window.transitionSamples.push({ opacity, readyState: incoming.readyState, seeking: incoming.seeking, paused: incoming.paused });
    }, 10); }, transition.at);
    await page.locator('#play').click();
    await page.waitForFunction(index => document.querySelectorAll('.timeline-clip')[index].getAttribute('aria-pressed') === 'true', transition.index, { timeout: 10000 });
    const samples = await page.evaluate(() => { clearInterval(window.transitionMonitor); return window.transitionSamples; });
    assert.ok(samples.length >= 3, 'Preview displays multiple blended frames at the late cut');
    assert.ok(samples.every(sample => sample.readyState >= 2 && !sample.seeking && !sample.paused), 'The incoming layer is decoded and playing whenever visible');
    await page.locator('#play').click();
    await page.locator('.timeline-clip').nth(transition.index - 1).click();
    await page.locator('#transition-after').selectOption('1');
    assert.equal(await page.evaluate(index => project.clips[index - 1].transitionAfter, transition.index), 1, 'The chosen cut can have a longer dissolve');
    assert.ok(await page.evaluate(index => transitionLength(index - 1), transition.index) > 0.6, 'The timeline uses the chosen dissolve length');
    assert.deepEqual(errors, []);
    console.log(`PASS: transition near ${transition.at.toFixed(2)}s blends only decoded, playing frames and reaches the next clip.`);
  } finally {
    await browser?.close(); server.kill(); await new Promise(resolve => server.once('close', resolve)); fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
