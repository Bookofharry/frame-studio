const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ffmpeg = require('ffmpeg-static');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8'
};

function ensureFixtures(resultsDir) {
  fs.mkdirSync(resultsDir, { recursive: true });
  const withAudio = path.join(resultsDir, 'pages-with-audio.mp4');
  const silent = path.join(resultsDir, 'pages-silent.mp4');
  const customWav = path.join(resultsDir, 'pages-tone.wav');
  const sampleMp4Bytes = fs.existsSync(withAudio) ? fs.readFileSync(withAudio) : null;
  if (!sampleMp4Bytes) {
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=#2266cc:s=640x360:r=30:d=1.6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.6',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      withAudio
    ]);
  }
  if (!fs.existsSync(silent)) {
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=#cc6622:s=640x360:r=30:d=1.4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an',
      silent
    ]);
  }
  if (!fs.existsSync(customWav)) {
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1.2',
      customWav
    ]);
  }
  return { withAudio, silent, customWav, mp4Bytes: fs.readFileSync(withAudio) };
}

function startPagesSubpathServer(distDir) {
  const unexpected404s = [];
  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(parsed.pathname);
    if (pathname === '/frame-studio') {
      res.writeHead(301, { Location: '/frame-studio/' });
      res.end();
      return;
    }
    if (!pathname.startsWith('/frame-studio/')) {
      if (pathname !== '/favicon.ico') unexpected404s.push(pathname);
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>404 Not Found</title><h1>404</h1>');
      return;
    }
    const rel = pathname.slice('/frame-studio/'.length) || 'index.html';
    const target = path.resolve(distDir, rel);
    if (!target.startsWith(path.resolve(distDir)) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      if (!pathname.startsWith('/frame-studio/api/capabilities')) {
        unexpected404s.push(pathname);
      }
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>GitHub Pages 404</title><h1>File not found</h1>');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    const stat = fs.statSync(target);
    const range = req.headers.range;
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const start = match && match[1] ? Number(match[1]) : 0;
      const end = match && match[2] ? Math.min(stat.size - 1, Number(match[2])) : stat.size - 1;
      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1
      });
      fs.createReadStream(target, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Length': stat.size
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(target).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, unexpected404s });
    });
  });
}

async function main() {
  const root = path.join(__dirname, '..');
  const distDir = path.join(root, 'dist');
  const resultsDir = path.join(root, 'test-results');

  execFileSync(process.execPath, [path.join(root, 'scripts/build-pages.js')], { cwd: root, stdio: 'inherit' });
  assert.equal(fs.existsSync(path.join(distDir, '.nojekyll')), true, 'dist/.nojekyll generated');
  assert.equal(fs.existsSync(path.join(distDir, 'vendor/hls.min.js')), true, 'dist/vendor/hls.min.js bundled');
  assert.equal(fs.existsSync(path.join(distDir, 'assets/black-screen.mp4')), true, 'dist/assets/black-screen.mp4 generated');

  const fixtures = ensureFixtures(resultsDir);
  const { server, port, unexpected404s } = await startPagesSubpathServer(distDir);
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    await page.route('https://api.epidemicsound.com/**', async route => {
      const url = new URL(route.request().url());
      const auth = route.request().headers()['authorization'] || '';
      if (auth !== 'Bearer test-epidemic-browser-key') {
        await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'Unauthorized' }) });
        return;
      }
      if (url.pathname === '/v0/tracks') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tracks: [] }) });
        return;
      }
      if (url.pathname === '/v0/tracks/search') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            tracks: [{
              id: 'ep-browser-1',
              title: 'Skyline Drift',
              mainArtists: ['Northern Lights'],
              length: 92,
              moods: [{ name: 'Cinematic' }],
              isPreviewOnly: false
            }]
          })
        });
        return;
      }
      if (url.pathname === '/v0/analytics/report') {
        await route.fulfill({ status: 204, body: '' });
        return;
      }
      await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });

    await page.goto(`http://127.0.0.1:${port}/frame-studio/`);
    await page.waitForFunction(() => window.FrameBackend?.isBrowserMode() === true);
    assert.match(await page.locator('.app-footer').textContent(), /BROWSER WORKSPACE/);

    await page.locator('#file-input').setInputFiles([fixtures.withAudio, fixtures.silent]);
    await page.waitForFunction(() => document.querySelectorAll('.timeline-clip').length === 2);

    const probedLibrary = await page.evaluate(() => window.FrameBackend.request('/api/library'));
    const audioItem = probedLibrary.find(m => m.name === 'pages-with-audio.mp4');
    const silentItem = probedLibrary.find(m => m.name === 'pages-silent.mp4');
    assert.ok(audioItem && silentItem, 'Both videos imported into IndexedDB');
    assert.equal(audioItem.audio, true, 'Video with AAC track detected as audio: true');
    assert.equal(silentItem.audio, false, 'Silent video detected as audio: false');
    assert.match(audioItem.thumbnail, /^data:image\/jpeg;base64,/, 'Client-side canvas thumbnail generated');

    await page.locator('#timeline-black').click();
    await page.locator('#black-duration').fill('1.5');
    await page.locator('#add-black').click();
    await page.waitForFunction(() => document.querySelectorAll('.timeline-clip').length === 3);

    await page.locator('#timeline-text').click();
    await page.locator('#title-text').fill('GitHub Pages Studio Ready');
    await page.waitForFunction(() => document.querySelectorAll('.text-clip').length === 1);

    const pngHeader = await page.evaluate(async () => {
      const bytes = await window.FrameBackend.renderTextOverlayPng(
        { text: 'GitHub Pages Studio Ready', size: 0.05 },
        1280,
        720
      );
      return Array.from(bytes.slice(0, 8));
    });
    assert.deepEqual(pngHeader, [137, 80, 78, 71, 13, 10, 26, 10], 'Timed text overlay renders valid PNG bytes');

    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.timeline-clip').length === 3);
    await page.waitForFunction(() => document.querySelectorAll('.text-clip').length === 1);
    await page.waitForFunction(() => document.getElementById('video').videoWidth === 1280);

    await page.locator('[data-workspace="audio"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 11);
    await page.locator('#catalog-search').fill('piano sad');
    await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 1);
    await page.getByRole('button', { name: 'Preview Touching Moments One - Pulse', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('catalog-preview').currentTime > 0.1);
    await page.getByRole('button', { name: 'Add Touching Moments One - Pulse from library', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.music-clip').length === 1);

    await page.locator('#music-input').setInputFiles(fixtures.customWav);
    await page.waitForFunction(() => document.querySelectorAll('.music-clip').length === 2);

    await page.locator('#audio-provider-settings').click();
    await page.locator('#provider-key').fill('test-epidemic-browser-key');
    await page.locator('#provider-licensed').check();
    await page.locator('#provider-reference').fill('AGREEMENT-PAGES-2026');
    await page.locator('#provider-save').click();
    await page.waitForFunction(() => document.getElementById('provider-result').textContent.includes('verified'));
    await page.locator('#close-audio-connections').click();

    await page.locator('[data-audio-view="discover"]').click();
    await page.locator('#catalog-provider').selectOption('epidemic');
    await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 1);
    assert.match(await page.locator('.catalog-card').textContent(), /Skyline Drift/);

    await page.locator('#audio-provider-settings').click();
    await page.locator('#provider-disconnect').click();
    await page.waitForFunction(() => document.getElementById('provider-result').textContent.includes('Disconnected'));
    await page.locator('#close-audio-connections').click();
    await page.locator('#catalog-provider').selectOption('builtin');
    await page.locator('#catalog-search').fill('');
    await page.waitForFunction(() => document.querySelectorAll('.catalog-card').length === 11);

    const base64Mp4 = fixtures.mp4Bytes.toString('base64');
    await page.evaluate((b64) => {
      window.__releaseExportGate = null;
      window.__FrameBrowserRenderOverride = async (job, validated, helpers) => {
        if (validated.clips.length !== 3 || validated.textClips.length !== 1 || validated.music.length !== 2) {
          throw new Error('Unexpected validated browser project structure');
        }
        job.stage = 'clips';
        job.progress = 55;
        job.message = 'Rendering clip 2 of 3';
        job.detail = 'Clip 2/3 · Encoded 00:01.1 of 00:01.4 · 1280×720 H.264';
        await new Promise(resolve => { window.__releaseExportGate = resolve; });
        const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        job.downloadUrl = URL.createObjectURL(new Blob([raw], { type: 'video/mp4' }));
        const audible = validated.music.filter(c => c.volume > 0);
        job.credits = helpers.buildCredits(audible);
        if (job.credits) {
          job.creditsUrl = URL.createObjectURL(new Blob([job.credits], { type: 'text/plain;charset=utf-8' }));
        }
        job.stage = 'complete';
        job.progress = 100;
        job.status = 'complete';
        job.message = 'Your video is ready';
        job.detail = 'Rendered by Frame Studio · 1280×720 H.264 MP4 · No watermark';
      };
    }, base64Mp4);

    assert.equal(await page.locator('#workspace-mode-badge').textContent(), 'Browser Studio', 'Branded Browser Studio badge shown');
    await page.locator('#project-name').fill('GitHub Pages Cut');
    await page.locator('#open-export').click();
    assert.equal(await page.locator('#export-pill-clips').textContent(), '3 clips', 'Branded export summary pill shows clip count');
    assert.equal(await page.locator('#export-credit-note').isVisible(), true, 'Attribution reminder visible before export');
    await page.locator('#start-export').click();
    await page.waitForFunction(() => document.getElementById('export-percent').textContent === '55%');
    await page.waitForTimeout(180);
    assert.equal(await page.locator('#export-stage-label').textContent(), 'FRAME STUDIO · ENCODING');
    assert.equal(await page.locator('#export-steps li[data-step="engine"]').evaluate(el => el.classList.contains('is-done')), true, 'Engine step marked done');
    assert.equal(await page.locator('#export-steps li[data-step="clips"]').evaluate(el => el.classList.contains('is-active')), true, 'Render step marked active');
    assert.match(await page.locator('#export-detail').textContent(), /1280×720 H\.264/);
    await page.screenshot({ path: path.join(resultsDir, 'export-rendering.png') });
    await page.evaluate(() => window.__releaseExportGate?.());
    await page.locator('#download-export').waitFor({ state: 'visible', timeout: 20000 });
    assert.equal(await page.locator('#export-stage-label').textContent(), 'FRAME STUDIO · READY');
    assert.equal(await page.locator('#download-credits').isVisible(), true, 'Credits download visible');
    await page.screenshot({ path: path.join(resultsDir, 'export-ready.png') });

    const creditsDownloadPromise = page.waitForEvent('download');
    await page.locator('#download-credits').click();
    const creditsDownload = await creditsDownloadPromise;
    assert.equal(creditsDownload.suggestedFilename(), 'Frame-music-credits.txt');
    const savedCredits = path.join(resultsDir, 'pages-credits.txt');
    await creditsDownload.saveAs(savedCredits);
    assert.match(fs.readFileSync(savedCredits, 'utf8'), /Kevin MacLeod/);

    await page.locator('#download-export').click();
    await page.locator('#filename-dialog').waitFor({ state: 'visible' });
    await page.locator('#export-filename').fill('GitHub Pages Final');
    const mp4DownloadPromise = page.waitForEvent('download');
    await page.locator('#confirm-filename').click();
    const mp4Download = await mp4DownloadPromise;
    assert.equal(mp4Download.suggestedFilename(), 'GitHub Pages Final.mp4');
    const savedMp4 = path.join(resultsDir, 'pages-exported.mp4');
    await mp4Download.saveAs(savedMp4);
    assert.equal(fs.statSync(savedMp4).size, fixtures.mp4Bytes.length);
    await page.locator('#close-export').click();

    await page.screenshot({ path: path.join(resultsDir, 'pages-desktop.png'), fullPage: true });

    await page.locator('#new-project').click();
    await page.locator('#new-project-name').fill('Clean Slate');
    await page.locator('#confirm-new').click();
    await page.waitForFunction(() => document.querySelectorAll('.timeline-clip').length === 0);

    await page.locator('#load-project').click();
    await page.waitForFunction(() => document.querySelectorAll('.project-row').length === 2);
    const deleteBtn = page.locator('.project-row', { hasText: 'GitHub Pages Cut' }).locator('.project-delete');
    await deleteBtn.click();
    await deleteBtn.click();
    await page.waitForFunction(() => document.querySelectorAll('.project-row').length === 1);

    await page.locator('#cleanup-storage').click();
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('Cleaned up 5 unused media file(s)'));
    const remainingMedia = await page.evaluate(() => window.FrameBackend.request('/api/library'));
    assert.equal(remainingMedia.length, 0, 'Unreferenced IndexedDB blobs cleaned up');
    await page.locator('#close-projects').click();

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'No mobile horizontal overflow');
    await page.screenshot({ path: path.join(resultsDir, 'pages-mobile.png'), fullPage: true });

    assert.deepEqual(unexpected404s, [], 'Zero subpath asset 404 leaks');
    assert.deepEqual(errors, [], 'Zero uncaught page errors');
    console.log('PASS: static GitHub Pages subpath (/frame-studio/), Browser Mode auto-detection, IndexedDB persistence across reloads, audio/silent video probing, black screen, PNG timed text, offline catalog + Epidemic browser adapter, MP4 + credits download, project deletion & IndexedDB cleanup, and mobile layout.');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
