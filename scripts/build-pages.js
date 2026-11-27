const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ffmpeg = require('ffmpeg-static');

const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
const distDir = path.join(root, 'dist');

if (path.dirname(distDir) !== root || path.basename(distDir) !== 'dist') throw new Error('Invalid build output directory');
fs.rmSync(distDir, { recursive: true, force: true });
fs.cpSync(publicDir, distDir, { recursive: true });

// Static hosting has no local API. Select the browser renderer without a
// capabilities probe that would otherwise produce a 404 on every page load.
const indexFile = path.join(distDir, 'index.html');
const indexHtml = fs.readFileSync(indexFile, 'utf8');
fs.writeFileSync(indexFile, indexHtml.replace('<html lang="en">', '<html lang="en" data-frame-mode="browser">'));

const vendorDir = path.join(distDir, 'vendor');
fs.mkdirSync(vendorDir, { recursive: true });
const hlsSrc = path.join(root, 'node_modules/hls.js/dist/hls.min.js');
if (!fs.existsSync(hlsSrc)) {
  throw new Error('Missing node_modules/hls.js/dist/hls.min.js. Run npm install first.');
}
fs.copyFileSync(hlsSrc, path.join(vendorDir, 'hls.min.js'));

const assetsDir = path.join(distDir, 'assets');
fs.mkdirSync(assetsDir, { recursive: true });
const blackMp4 = path.join(assetsDir, 'black-screen.mp4');
const blackJpg = path.join(assetsDir, 'black-screen.jpg');

execFileSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=24:d=60',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
  blackMp4
], { stdio: 'inherit' });

execFileSync(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=480x270:r=1:d=1',
  '-frames:v', '1', '-update', '1', '-q:v', '4',
  blackJpg
], { stdio: 'inherit' });

const ffmpegUmdDir = path.join(root, 'node_modules/@ffmpeg/ffmpeg/dist/umd');
// An explicit classWorkerURL creates a module worker in @ffmpeg/ffmpeg.
// Its core must therefore export the ESM factory (UMD has no default export).
const coreEsmDir = path.join(root, 'node_modules/@ffmpeg/core/dist/esm');
if (!fs.existsSync(ffmpegUmdDir) || !fs.existsSync(coreEsmDir)) {
  throw new Error('Missing pinned FFmpeg browser dependencies. Run npm ci before building Pages.');
}
const targetFfmpegDir = path.join(vendorDir, 'ffmpeg');
fs.mkdirSync(targetFfmpegDir, { recursive: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = { version: 1, assets: {}, parts: [] };
for (const [name, dir] of [['ffmpeg.js', ffmpegUmdDir], ['814.ffmpeg.js', ffmpegUmdDir], ['ffmpeg-core.js', coreEsmDir]]) {
  const bytes = fs.readFileSync(path.join(dir, name));
  const hash = sha256(bytes);
  const file = `${hash}-${name}`;
  fs.writeFileSync(path.join(targetFfmpegDir, file), bytes);
  manifest.assets[name] = { file, size: bytes.length, sha256: hash };
}
const wasm = fs.readFileSync(path.join(coreEsmDir, 'ffmpeg-core.wasm'));
if (!WebAssembly.validate(wasm)) throw new Error('FFmpeg WebAssembly is incomplete or invalid. Reinstall dependencies.');
manifest.size = wasm.length;
// Small static files work on Pages without relying on HTTP Range support.
for (let offset = 0; offset < wasm.length; offset += 1024 * 1024) {
  const bytes = wasm.subarray(offset, offset + 1024 * 1024);
  const hash = sha256(bytes);
  const file = `ffmpeg-core-${hash}.bin`;
  fs.writeFileSync(path.join(targetFfmpegDir, file), bytes);
  manifest.parts.push({ file, size: bytes.length, sha256: hash });
}
fs.writeFileSync(path.join(targetFfmpegDir, 'runtime.json'), JSON.stringify(manifest));

fs.writeFileSync(path.join(distDir, '.nojekyll'), '');

console.log(`Built static GitHub Pages bundle in ${distDir} (FFmpeg bundled in ${manifest.parts.length} retryable parts)`);
