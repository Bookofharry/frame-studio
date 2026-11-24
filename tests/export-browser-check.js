const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-export-check-'));
  let server, browser;
  try {
    let base = process.env.FRAME_TEST_URL;
    if (!base) {
      base = 'http://127.0.0.1:4331';
      server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '4331', FRAME_DATA_DIR: temporary }, windowsHide: true });
      await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(new Error(`Server exited: ${code}`))); });
    }
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.locator('#file-input').setInputFiles(path.join(__dirname, '../test-results/sample-with-audio.mp4'));
    await page.locator('.timeline-clip').waitFor();
    await page.locator('#open-export').click();
    const originalEstimate = await page.locator('#export-size-estimate').textContent();
    await page.locator('#resolution').selectOption('2160');
    assert.notEqual(await page.locator('#export-size-estimate').textContent(), originalEstimate);
    const largeEstimate = await page.locator('#export-size-estimate').textContent();
    await page.locator('#quality').selectOption('23');
    assert.notEqual(await page.locator('#export-size-estimate').textContent(), largeEstimate);
    await page.locator('#fps').selectOption('60');
    await page.locator('#start-export').click();
    await page.locator('#cancel-export').click();
    await page.waitForFunction(() => document.getElementById('export-status').dataset.state === 'cancelled');
    assert.equal(await page.locator('#download-export').isVisible(), false);
    assert.equal(await page.locator('#resolution').isEnabled(), true);
    await page.locator('#resolution').selectOption('source');
    await page.locator('#fps').selectOption('source');
    await page.locator('#start-export').click();
    await page.locator('#download-export').waitFor({ timeout: 30000 });
    const downloaded = await page.request.get(new URL(await page.locator('#download-export').getAttribute('href'), page.url()).href);
    assert.equal(downloaded.status(), 200);
    assert.ok((await downloaded.body()).length > 1000, 'Retry produces a real MP4');
    console.log('PASS: live estimate, native cancellation and successful retry/download');

    // Simulate remote timing and failures at the backend boundary; the real UI,
    // submit guard, polling loop, cancellation and retry handlers stay in use.
    await page.evaluate(() => {
      const request = FrameBackend.request.bind(FrameBackend);
      window.exportCheck = { posts: 0, deletes: [], mode: 'delayed', failures: 0 };
      FrameBackend.request = async (url, options = {}) => {
        const state = window.exportCheck;
        if (url === '/api/exports' && options.method === 'POST') {
          state.posts++;
          state.job = { id: `test-${state.posts}`, status: 'rendering', stage: 'engine', progress: 1, message: 'Preparing your video' };
          if (state.mode === 'delayed') await new Promise(resolve => { state.releaseStart = resolve; });
          return { id: state.job.id };
        }
        if (/^\/api\/exports\/test-/.test(url)) {
          if (options.method === 'DELETE') {
            state.deletes.push(url);
            if (state.mode === 'cancel-failure') { state.mode = 'running'; throw new Error('Offline'); }
            state.job = { ...state.job, status: 'cancelled', stage: 'cancelled', message: 'Export cancelled' };
            return { ok: true };
          }
          if (state.mode === 'reconnect' && state.failures++ === 0) throw new Error('Temporary network failure');
          if (state.mode === 'missing') throw Object.assign(new Error('Not found'), { status: 404 });
          if (state.mode === 'stale') {
            state.mode = 'running';
            const old = { ...state.job };
            await new Promise(resolve => { state.releasePoll = resolve; });
            return old;
          }
          if (state.mode === 'error') state.job = { ...state.job, stage: 'compose', progress: 90, message: 'Finishing your MP4' };
          return { ...state.job };
        }
        return request(url, options);
      };
    });
    await page.locator('#start-export').click();
    await page.waitForFunction(() => !!window.exportCheck.releaseStart);
    await page.evaluate(() => document.getElementById('export-form').requestSubmit());
    assert.equal(await page.evaluate(() => window.exportCheck.posts), 1, 'Double submission is ignored during startup');
    await page.locator('#cancel-export').click();
    assert.equal(await page.locator('#cancel-export').isDisabled(), true);
    await page.evaluate(() => window.exportCheck.releaseStart());
    await page.waitForFunction(() => document.getElementById('export-status').dataset.state === 'cancelled');
    assert.deepEqual(await page.evaluate(() => window.exportCheck.deletes), ['/api/exports/test-1'], 'Queued cancellation targets the new job');
    console.log('PASS: duplicate submission guard and cancellation before job creation finishes');

    await page.evaluate(() => { window.exportCheck.mode = 'reconnect'; });
    await page.locator('#start-export').click();
    await page.waitForFunction(() => document.getElementById('export-message').textContent.includes('Reconnecting'));
    assert.equal(await page.locator('#start-export').isVisible(), false, 'Network failure must not unlock a duplicate export');
    assert.equal(await page.locator('#resolution').isDisabled(), true);
    await page.waitForFunction(() => window.exportCheck.failures >= 2);
    await page.locator('#cancel-export').click();
    await page.waitForFunction(() => document.getElementById('export-status').dataset.state === 'cancelled');
    console.log('PASS: transient status failure recovers automatically without duplicate exports');

    await page.evaluate(() => { window.exportCheck.mode = 'stale'; });
    await page.locator('#start-export').click();
    await page.waitForFunction(() => !!window.exportCheck.releasePoll);
    await page.locator('#cancel-export').click();
    await page.waitForFunction(() => document.getElementById('export-status').dataset.state === 'cancelled');
    await page.evaluate(() => window.exportCheck.releasePoll());
    await page.waitForTimeout(650);
    assert.equal(await page.locator('#export-status').getAttribute('data-state'), 'cancelled', 'Old polling responses cannot revive a cancelled export');

    await page.evaluate(() => { window.exportCheck.mode = 'cancel-failure'; });
    await page.locator('#start-export').click();
    await page.locator('#cancel-export').click();
    await page.waitForFunction(() => !document.getElementById('cancel-export').disabled);
    assert.equal(await page.locator('#start-export').isVisible(), false, 'Unconfirmed cancellation keeps the export locked');
    await page.locator('#cancel-export').click();
    await page.waitForFunction(() => document.getElementById('export-status').dataset.state === 'cancelled');
    console.log('PASS: stale polling cannot overwrite cancellation; cancellation can be retried');

    await page.evaluate(() => { window.exportCheck.mode = 'error'; });
    await page.locator('#start-export').click();
    await page.waitForFunction(() => document.querySelector('[data-step="compose"]').classList.contains('is-active'));
    await page.evaluate(() => {
      window.exportCheck.mode = 'running';
      Object.assign(window.exportCheck.job, { status: 'error', stage: 'error', message: 'Export failed. Try 720p.', detail: 'Your timeline is unchanged.' });
    });
    await page.waitForFunction(() => document.getElementById('export-status').dataset.state === 'error');
    assert.equal(await page.locator('#start-export').textContent(), 'Retry export');
    assert.equal(await page.locator('[data-step="compose"]').evaluate(el => el.classList.contains('is-failed')), true);
    assert.equal(await page.locator('[data-step="clips"]').evaluate(el => el.classList.contains('is-done')), true);
    await page.screenshot({ path: path.join(__dirname, '../test-results/export-retry.png') });

    await page.evaluate(() => { window.exportCheck.mode = 'missing'; });
    await page.locator('#start-export').click();
    await page.waitForFunction(() => document.getElementById('export-message').textContent === 'Export no longer available');
    assert.equal(await page.locator('#start-export').textContent(), 'Retry export');
    console.log('PASS: failed stage stays accurate; missing jobs offer a safe retry');

    const browserPage = await browser.newPage();
    browserPage.on('pageerror', error => errors.push(error.message));
    // Exercise the browser backend itself, with only its encoder replaced. A
    // delayed readFile reproduces cancellation during final MP4 packaging.
    await browserPage.route('**/vendor/ffmpeg/ffmpeg.js', route => route.fulfill({ contentType: 'text/javascript', body: `
      window.encoderCheck = { hold: true, terminated: 0 };
      window.FFmpegWASM = { FFmpeg: class {
        on() {} async load() {} async writeFile() {} async deleteFile() {}
        async exec() { return 0; }
        async readFile() {
          if (window.encoderCheck.hold) await new Promise(resolve => { window.encoderCheck.release = resolve; });
          return new Uint8Array([0, 0, 0, 24]);
        }
        terminate() { window.encoderCheck.terminated++; }
      } };
    ` }));
    await browserPage.route('**/vendor/ffmpeg/ffmpeg-core.*', route => route.fulfill({ contentType: 'application/octet-stream', body: 'test-core' }));
    await browserPage.goto(`${base}/?mode=browser`);
    await browserPage.locator('#file-input').setInputFiles(path.join(__dirname, '../test-results/sample-with-audio.mp4'));
    await browserPage.locator('.timeline-clip').waitFor();
    await browserPage.evaluate(() => {
      const request = FrameBackend.request.bind(FrameBackend);
      FrameBackend.request = async (url, options) => {
        const result = await request(url, options);
        if (url === '/api/exports') window.browserExportId = result.id;
        return result;
      };
    });
    await browserPage.locator('#open-export').click();
    await browserPage.locator('#start-export').click();
    await browserPage.waitForFunction(() => !!window.encoderCheck?.release);
    await browserPage.locator('#cancel-export').click();
    await browserPage.waitForFunction(() => document.getElementById('export-status').dataset.state === 'cancelled');
    await browserPage.evaluate(() => { window.encoderCheck.hold = false; window.encoderCheck.release(); });
    await browserPage.waitForFunction(() => window.encoderCheck.terminated >= 2);
    const cancelled = await browserPage.evaluate(() => FrameBackend.request(`/api/exports/${window.browserExportId}`));
    assert.equal(cancelled.status, 'cancelled', 'Finishing readFile cannot resurrect a cancelled browser export');
    assert.equal(await browserPage.locator('#download-export').isVisible(), false);
    await browserPage.locator('#start-export').click();
    await browserPage.locator('#download-export').waitFor();
    await browserPage.close();
    console.log('PASS: browser packaging cancellation stays cancelled and releases the encoder for retry');
    assert.deepEqual(errors, [], 'No uncaught browser errors');
  } finally {
    await browser?.close();
    if (server) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exited; }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
