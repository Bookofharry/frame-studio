const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const ffprobe = require('ffprobe-static').path;

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const results = path.join(root, 'test-results');

function serve({ resetOnce = new Set() } = {}) {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(dist, pathname.replace(/^\/frame-studio\//, '') || 'index.html');
    if (!pathname.startsWith('/frame-studio/') || !file.startsWith(`${dist}${path.sep}`) || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    const mime = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.mp4': 'video/mp4' };
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Content-Length': fs.statSync(file).size });
    if (resetOnce.delete(path.basename(file))) {
      res.write(fs.readFileSync(file).subarray(0, 100));
      setTimeout(() => res.destroy(), 25);
      return;
    }
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function loadEngine(page) {
  return page.evaluate(async () => {
    const engine = await window.FrameFFmpegLoader.prepare();
    const ffmpeg = new engine.FFmpeg();
    try {
      await ffmpeg.load(engine.loadConfig, { signal: AbortSignal.timeout(60000) });
      return await ffmpeg.exec(['-version']);
    } finally { ffmpeg.terminate(); }
  });
}

async function main() {
  execFileSync(process.execPath, ['scripts/build-pages.js'], { cwd: root, stdio: 'inherit' });
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'vendor/ffmpeg/runtime.json')));
  assert.ok(manifest.parts.length > 1);
  assert.ok(manifest.parts.every(part => part.size <= 1024 * 1024));
  const assembled = Buffer.concat(manifest.parts.map(part => fs.readFileSync(path.join(dist, 'vendor/ffmpeg', part.file))));
  assert.deepEqual(assembled, fs.readFileSync(path.join(root, 'node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm')));
  fs.mkdirSync(results, { recursive: true });
  const server = await serve({ resetOnce: new Set([manifest.parts[1].file]) });
  const address = `http://127.0.0.1:${server.address().port}/frame-studio/`;
  console.log(`Testing real browser exports at ${address}`);
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const requests = new Map();
    let interrupt = true;
    let blockEngine = false;
    let cdnRequests = 0;
    await context.route('https://**/*', route => { cdnRequests++; return route.abort(); });
    await context.route('**/vendor/ffmpeg/**', async route => {
      const name = new URL(route.request().url()).pathname.split('/').pop();
      requests.set(name, (requests.get(name) || 0) + 1);
      if (blockEngine) return route.abort('internetdisconnected');
      if (interrupt && name === manifest.parts[0].file && requests.get(name) === 1) {
        // Same byte length, wrong checksum: a broken cache/proxy response.
        return route.fulfill({ body: Buffer.alloc(manifest.parts[0].size) });
      }
      if (interrupt && name === manifest.parts[2].file) return route.abort('connectionreset');
      return route.continue();
    });
    await page.goto(address);
    const failure = await page.evaluate(() => window.FrameFFmpegLoader.prepare().then(() => null, error => ({ message: error.message, status: error.status })));
    assert.equal(failure.status, 503);
    assert.match(failure.message, /connection.*retry Export/);
    assert.equal(requests.get(manifest.parts[0].file), 2, 'Corrupt part is retried');
    assert.equal(requests.get(manifest.parts[1].file), 2, 'Reset part is retried');
    assert.equal(requests.get(manifest.parts[2].file), 3, 'Retries are bounded');
    assert.equal(cdnRequests, 0, 'A failed part never restarts as a huge CDN transfer');
    interrupt = false;
    await page.reload();
    // Use the real app export path, including its worker, renderer and download.
    await page.locator('#timeline-black').click();
    await page.locator('#black-duration').fill('0.2');
    await page.locator('#add-black').click();
    await page.waitForFunction(() => document.querySelectorAll('.timeline-clip').length === 1);
    await page.locator('#open-export').click();
    await page.locator('#start-export').click();
    await page.locator('#download-export').waitFor({ state: 'visible', timeout: 120000 });
    assert.equal(requests.get(manifest.parts[0].file), 2, 'Verified parts survive page reload');
    assert.equal(requests.get(manifest.parts[1].file), 2);
    assert.equal(requests.get(manifest.parts[2].file), 4, 'Retry resumes at the missing part');
    const output = await page.locator('#download-export').evaluate(async element => Array.from(new Uint8Array(await (await fetch(element.href)).arrayBuffer())));
    const outputPath = path.join(results, 'ffmpeg-recovered-export.mp4');
    fs.writeFileSync(outputPath, Buffer.from(output));
    const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputPath], { encoding: 'utf8' }));
    assert.equal(probe.streams[0].codec_name, 'h264');
    assert.ok(Number(probe.format.duration) >= 0.15 && Number(probe.format.duration) < 0.5);
    await page.screenshot({ path: path.join(results, 'ffmpeg-recovered-export.png') });
    blockEngine = true;
    await page.reload();
    assert.equal(await loadEngine(page), 0, 'Cached engine initializes after reload with all engine network requests blocked');
    assert.equal(cdnRequests, 0);
    assert.deepEqual(errors, []);
    await context.close();

    // Exercise the CDN fallback with no Cache API and an unavailable first CDN.
    // Serve the pinned npm bytes locally so this regression test needs no internet.
    const fallback = await browser.newContext();
    await fallback.addInitScript(() => Object.defineProperty(window, 'caches', { get() { throw new Error('Storage disabled'); } }));
    const fallbackPage = await fallback.newPage();
    const fallbackErrors = [];
    fallbackPage.on('pageerror', error => fallbackErrors.push(error.message));
    await fallback.route('**/vendor/ffmpeg/runtime.json', route => route.fulfill({ status: 404, body: '' }));
    await fallback.route('https://cdn.jsdelivr.net/**', route => route.abort('connectionreset'));
    const fallbackFiles = [];
    await fallback.route('https://unpkg.com/**', route => {
      const url = new URL(route.request().url());
      const rel = url.pathname.replace(/^\//, '').replace(/@0\.12\.10\//, '/');
      fallbackFiles.push(rel);
      return route.fulfill({ path: path.join(root, 'node_modules', rel), contentType: rel.endsWith('.js') ? 'text/javascript' : 'application/wasm' });
    });
    await fallbackPage.goto(address);
    assert.equal(await loadEngine(fallbackPage), 0, 'Fallback module worker imports ESM core successfully without Cache API');
    assert.ok(fallbackFiles.includes('@ffmpeg/core/dist/esm/ffmpeg-core.js'));
    assert.deepEqual(fallbackErrors, []);
    await fallback.close();
    console.log('PASS: real H.264 export, corrupt/reset download retries, bounded failures, resume across reload, cached engine without network, CDN failover, ESM module worker, and disabled storage.');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { serve };
