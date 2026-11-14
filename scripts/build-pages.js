const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ffmpeg = require('ffmpeg-static');

const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
const distDir = path.join(root, 'dist');

fs.rmSync(distDir, { recursive: true, force: true });
fs.cpSync(publicDir, distDir, { recursive: true });

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
const coreUmdDir = path.join(root, 'node_modules/@ffmpeg/core/dist/umd');
let bundledWasm = false;
if (fs.existsSync(ffmpegUmdDir) && fs.existsSync(coreUmdDir)) {
  const targetFfmpegDir = path.join(vendorDir, 'ffmpeg');
  fs.mkdirSync(targetFfmpegDir, { recursive: true });
  for (const dir of [ffmpegUmdDir, coreUmdDir]) {
    for (const entry of fs.readdirSync(dir)) {
      fs.copyFileSync(path.join(dir, entry), path.join(targetFfmpegDir, entry));
    }
  }
  bundledWasm = true;
}

fs.writeFileSync(path.join(distDir, '.nojekyll'), '');

console.log(`Built static GitHub Pages bundle in ${distDir} (same-origin ffmpeg.wasm bundled: ${bundledWasm ? 'yes' : 'cdn-fallback'})`);
