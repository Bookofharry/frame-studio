const express = require('express');
const multer = require('multer');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const ffmpegStatic = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;

function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const hasDrawtext = bin => {
    try { return /\bdrawtext\b/.test(execFileSync(bin, ['-hide_banner', '-filters'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
    catch { return false; }
  };
  if (ffmpegStatic && hasDrawtext(ffmpegStatic)) return ffmpegStatic;
  if (hasDrawtext('ffmpeg')) return 'ffmpeg';
  return ffmpegStatic || 'ffmpeg';
}
const ffmpeg = resolveFfmpeg();
const supportsDrawtextAlign = (() => {
  try { return /\btext_align\b/.test(execFileSync(ffmpeg, ['-hide_banner', '-h', 'filter=drawtext'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { return false; }
})();
const cropGeometry = require('./public/crop');
const textLayout = require('./public/text-layout');
const exportName = require('./public/export-name');
const { createCatalog } = require('./audio-catalog');

const root = process.env.FRAME_DATA_DIR || path.join(__dirname, 'data');
for (const dir of ['media', 'exports', 'temp']) fs.mkdirSync(path.join(root, dir), { recursive: true });
const manifest = path.join(root, 'library.json');
let library = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8').replace(/^\uFEFF/, '')) : [];
const jobs = new Map();
const catalog = createCatalog({ root });
const app = express();
app.use((req, res, next) => {
  // The editor is intentionally a loopback-only application.
  const host = req.headers.host || '';
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return res.sendStatus(403);
  if (req.headers.origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.origin)) return res.sendStatus(403);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(path.join(root, 'media')));
app.get('/api/capabilities', (req, res) => res.json({ timedTextExport: true }));
app.get('/vendor/hls.min.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules/hls.js/dist/hls.min.js')));
const upload = multer({ dest: path.join(root, 'media'), limits: { fileSize: 8 * 1024 ** 3, files: 20 } });

function command(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, ...options });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr || 'Video processing failed')));
  });
}
async function probe(file) {
  return JSON.parse(await command(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
}
function uploadName(file) {
  const original = String(file.originalname || 'Untitled media');
  if (!/[\u00c3\u00c2\u00e2\u00f0]/.test(original)) return original;
  const repaired = Buffer.from(original, 'latin1').toString('utf8');
  return repaired.includes('\uFFFD') ? original : repaired;
}
function mediaDuration(info, stream) {
  const direct = [info.format?.duration, stream?.duration].map(Number).find(value => Number.isFinite(value) && value > 0);
  if (direct) return direct;
  const durationTs = Number(stream?.duration_ts);
  const [numerator, denominator] = String(stream?.time_base || '').split('/').map(Number);
  const calculated = durationTs * numerator / denominator;
  return Number.isFinite(calculated) && calculated > 0 ? calculated : NaN;
}
function videoImportError(name, error) {
  if (error?.code === 'NO_VIDEO') return `${name}: no video track was found in this file.`;
  if (error?.code === 'NO_DURATION') return `${name}: the video duration could not be detected. The file may be incomplete.`;
  if (error?.code === 'DECODE') return `${name}: the video track was found but could not be decoded. Try converting it to H.264 MP4.`;
  const detail = String(error?.message || '');
  if (/moov atom not found|invalid data|end of file|error reading header/i.test(detail)) return `${name}: the MP4 is incomplete or damaged. Download or export it again.`;
  if (/unknown decoder|unsupported codec|not supported/i.test(detail)) return `${name}: this video codec is not supported. Convert it to H.264 MP4 and try again.`;
  return `${name}: the video container could not be opened. Try re-exporting it as H.264 MP4.`;
}
async function makeThumbnail(source, destination, duration) {
  const attempts = [Math.min(duration / 3, 1), 0];
  let lastError;
  for (const at of attempts) {
    try {
      await command(ffmpeg, ['-y', '-ss', String(at), '-i', source, '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=480:-2', destination]);
      if (fs.existsSync(destination) && fs.statSync(destination).size) return;
    } catch (error) { lastError = error; }
  }
  const error = new Error(lastError?.message || 'No video frame could be decoded');
  error.code = 'DECODE';
  throw error;
}
app.get('/api/library', (req, res) => res.json(library));
const blackMediaId = 'frame-black-screen-v1';
let blackGeneration;
async function blackScreenMedia() {
  const file = path.join(root, 'media', blackMediaId), thumbnail = `${file}.jpg`;
  const existing = library.find(media => media.id === blackMediaId);
  if (existing && fs.existsSync(file) && fs.existsSync(thumbnail)) return existing;
  if (!blackGeneration) blackGeneration = (async () => {
    try {
      await command(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=24:d=60', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-f', 'mp4', file]);
      await command(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=480x270', '-frames:v', '1', thumbnail]);
      const media = { id: blackMediaId, name: 'Black screen', generated: 'black', duration: 60, width: 1280, height: 720, fps: 24, audio: false, size: fs.statSync(file).size, url: `/media/${blackMediaId}`, thumbnail: `/media/${blackMediaId}.jpg` };
      if (existing) Object.assign(existing, media); else library.push(media);
      fs.writeFileSync(manifest, JSON.stringify(library, null, 2));
      return existing || media;
    } catch (error) { fs.rmSync(file, { force: true }); fs.rmSync(thumbnail, { force: true }); throw error; }
  })();
  try { return await blackGeneration; } finally { blackGeneration = null; }
}
app.post('/api/media/black', async (req, res) => { try { res.json(await blackScreenMedia()); } catch (error) { console.error(`Black screen generation failed: ${error.message}`); res.status(500).json({ error: 'Could not create a black screen. Check that FFmpeg is available and try again.' }); } });
const catalogRoute = fn => async (req, res) => { try { await fn(req, res); } catch (error) { res.status(error.status || 502).json({ error: error.status ? error.message : 'Could not load this sound library. Please try again.' }); } };
app.get('/api/audio/providers', (req, res) => res.json(catalog.status()));
app.post('/api/audio/providers/epidemic', catalogRoute(async (req, res) => res.json(await catalog.connect(req.body))));
app.get('/api/audio/catalog', catalogRoute(async (req, res) => res.json(await catalog.search(req.query))));
app.post('/api/audio/catalog/preview', catalogRoute(async (req, res) => res.json(await catalog.preview(req.body.provider, req.body.id))));
const pendingCatalogImports = new Map();
async function importCatalogTrack(provider, trackId) {
  const key = `${provider}:${trackId}`;
  const existing = library.find(m => m.catalog?.provider === provider && m.catalog?.trackId === trackId);
  if (existing) { catalog.assertLicensed([existing]); return existing; }
  if (pendingCatalogImports.has(key)) return pendingCatalogImports.get(key);
  const task = (async () => {
    const id = randomUUID(), file = path.join(root, 'media', id);
    try {
      const track = await catalog.prepare(provider, trackId, file);
      if (provider === 'builtin') fs.copyFileSync(file, `${file}.m4a`);
      else await command(ffmpeg, ['-y', '-i', file, '-vn', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', `${file}.m4a`]);
      const info = await probe(file); const duration = Number(info.format.duration);
      if (!Number.isFinite(duration) || duration < 0.08) throw new Error('Invalid audio');
      const item = { id, name: track.title, type: 'audio', duration, size: fs.statSync(file).size, url: `/media/${id}.m4a`, catalog: track.catalog };
      library.push(item); fs.writeFileSync(manifest, JSON.stringify(library, null, 2)); return item;
    } catch (error) { fs.rmSync(file, { force: true }); fs.rmSync(`${file}.m4a`, { force: true }); throw error; }
  })();
  pendingCatalogImports.set(key, task);
  try { return await task; } finally { pendingCatalogImports.delete(key); }
}
let activeImports = 0;
const trackImport = (req, res, next) => {
  activeImports++;
  let released = false;
  const release = () => { if (!released) { released = true; activeImports--; } };
  res.on('finish', release);
  res.on('close', release);
  next();
};
app.post('/api/audio/catalog/add', catalogRoute(async (req, res) => res.json(await importCatalogTrack(req.body.provider, req.body.id))));
app.post('/api/audio/import', trackImport, upload.array('audio', 20), async (req, res, next) => {
  const imported = [], errors = [];
  try {
    for (const file of req.files || []) {
      try {
        const info = await probe(file.path);
        const audio = info.streams.find(s => s.codec_type === 'audio');
        const duration = Number(info.format.duration || audio?.duration);
        if (!audio || !Number.isFinite(duration) || duration < 0.08) throw new Error('Not playable audio');
        const id = file.filename;
        // A consistent browser preview; export always reads the original source.
        await command(ffmpeg, ['-y', '-i', file.path, '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', `${file.path}.m4a`]);
        const item = { id, type: 'audio', name: uploadName(file), duration, size: file.size, url: `/media/${id}.m4a` };
        library.push(item); imported.push(item);
      } catch {
        fs.rmSync(file.path, { force: true }); fs.rmSync(`${file.path}.m4a`, { force: true });
        errors.push(`${uploadName(file)}: no readable audio was found.`);
      }
    }
    fs.writeFileSync(manifest, JSON.stringify(library, null, 2));
    res.json({ imported, errors });
  } catch (error) { next(error); }
});
app.post('/api/import', trackImport, upload.array('videos', 20), async (req, res, next) => {
  const imported = [], errors = [];
  try {
    for (const file of req.files || []) {
      const name = uploadName(file);
      try {
        const info = await probe(file.path);
        const video = info.streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
        if (!video) { const error = new Error('No video stream'); error.code = 'NO_VIDEO'; throw error; }
        const duration = mediaDuration(info, video);
        if (!Number.isFinite(duration)) { const error = new Error('No video duration'); error.code = 'NO_DURATION'; throw error; }
        const id = file.filename;
        const rate = video.avg_frame_rate?.split('/').map(Number) || [30, 1];
        const rotation = Math.abs(Number(video.tags?.rotate || video.side_data_list?.find(s => s.rotation)?.rotation || 0));
        const rotated = rotation % 180 === 90;
        const item = { id, name, duration, width: rotated ? video.height : video.width, height: rotated ? video.width : video.height, fps: rate[1] ? rate[0] / rate[1] : 30, audio: info.streams.some(s => s.codec_type === 'audio'), size: file.size, url: `/media/${id}`, thumbnail: `/media/${id}.jpg` };
        await makeThumbnail(file.path, path.join(root, 'media', `${id}.jpg`), duration);
        library.push(item); imported.push(item);
      } catch (error) {
        console.error(`Video import failed for ${name}: ${error.message}`);
        fs.rmSync(file.path, { force: true }); fs.rmSync(`${file.path}.jpg`, { force: true });
        errors.push(videoImportError(name, error));
      }
    }
    fs.writeFileSync(manifest, JSON.stringify(library, null, 2));
    res.json({ imported, errors });
  } catch (error) { next(error); }
});
function number(value, fallback, min, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Value must be between ${min} and ${max}.`);
  return n;
}
function validateProject(body) {
  if (!Array.isArray(body.clips) || !body.clips.length || body.clips.length > 100) throw new Error('Add between 1 and 100 clips to your timeline.');
  const clips = body.clips.map(c => {
    const media = library.find(m => m.id === c.mediaId);
    if (!media || media.type === 'audio') throw new Error('A source video is missing. Import it again.');
    const start = number(c.start, 0, 0, media.duration);
    const end = number(c.end, media.duration, 0, media.duration);
    if (end - start < 0.08) throw new Error('Each clip must be at least 0.08 seconds long.');
    const crop = c.crop === undefined || c.crop === null ? cropGeometry.full(media) : c.crop;
    if (!cropGeometry.valid(crop, media)) throw new Error('The crop must stay within the source video and be at least 2 × 2 pixels.');
    return { media, crop, start, end, speed: number(c.speed, 1, 0.5, 7), volume: number(c.volume, 1, 0, 1), brightness: number(c.brightness, 0, -0.5, 0.5), contrast: number(c.contrast, 1, 0.5, 2), saturation: number(c.saturation, 1, 0, 2), cutAfter: c.cutAfter === true, transitionAfter: c.transitionAfter === undefined ? undefined : number(c.transitionAfter, 0.35, 0, 1.5) };
  });
  const settings = body.settings || {};
  const resolution = ['source', '720', '1080', '2160'].includes(settings.resolution) ? settings.resolution : 'source';
  const aspect = ['source', '16:9', '9:16', '1:1'].includes(settings.aspect) ? settings.aspect : 'source';
  const quality = ['18', '20', '23'].includes(String(settings.quality)) ? String(settings.quality) : '18';
  const fps = ['source', '24', '30', '60'].includes(String(settings.fps)) ? String(settings.fps) : 'source';
  const text = String(settings.text || '').slice(0, 120);
  const transitionDuration = number(settings.transitionDuration, 0.35, 0, 1.5);
  if (body.music !== undefined && (!Array.isArray(body.music) || body.music.length > 20)) throw new Error('Use up to 20 music clips.');
  const music = (body.music || []).map(c => {
    const media = library.find(m => m.id === c.mediaId && m.type === 'audio');
    if (!media) throw new Error('A music source is missing. Import it again.');
    const start = number(c.start, 0, 0, media.duration), end = number(c.end, media.duration, 0, media.duration);
    if (end - start < 0.08) throw new Error('Each music clip must be at least 0.08 seconds long.');
    return { media, start, end, at: number(c.at, 0, 0, 86400), volume: number(c.volume, 0.5, 0, 1) };
  });
  if (body.textClips !== undefined && (!Array.isArray(body.textClips) || body.textClips.length > 20)) throw new Error('Use up to 20 text clips.');
  const textClips = (body.textClips || []).map(clip => {
    if (typeof clip.text !== 'string' || clip.text.length > 120) throw new Error('Each text clip must contain up to 120 characters.');
    return { text: clip.text, at: number(clip.at, 0, 0, 86400), duration: number(clip.duration, 3, 0.1, 3600), x: number(clip.x, 0.5, 0, 1), y: number(clip.y, 0.88, 0, 1), size: number(clip.size, 0.045, 0.02, 0.15) };
  });
  catalog.assertLicensed(music.map(clip => clip.media));
  return { clips, music, textClips, settings: { resolution, aspect, quality, fps, text, transitionDuration } };
}
function overlap(clips, index, duration) {
  if (index < 0 || index >= clips.length - 1) return 0;
  if (clips[index].cutAfter) return 0;
  const chosen = Number(clips[index].transitionAfter ?? duration);
  if (!chosen) return 0;
  if (clips[index].media.id === clips[index + 1].media.id && Math.abs(clips[index].end - clips[index + 1].start) < 0.001) return 0;
  const a = (clips[index].end - clips[index].start) / clips[index].speed;
  const b = (clips[index + 1].end - clips[index + 1].start) / clips[index + 1].speed;
  const value = Math.min(chosen, a / 3, b / 3);
  return value >= 0.05 ? value : 0;
}
function dimensions(media, settings) {
  let ratio = media.width / media.height;
  if (settings.aspect !== 'source') { const [w, h] = settings.aspect.split(':').map(Number); ratio = w / h; }
  const shortEdge = settings.resolution === 'source' ? Math.min(media.width, media.height) : Number(settings.resolution);
  const even = v => Math.max(2, Math.round(v / 2) * 2);
  return ratio >= 1 ? [even(shortEdge * ratio), even(shortEdge)] : [even(shortEdge), even(shortEdge / ratio)];
}
const exportIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let cachedSystemFont;
function resolveFontPath(platform = process.platform, env = process.env, exists = fs.existsSync) {
  if (env.FRAME_FONT_PATH && exists(env.FRAME_FONT_PATH)) return env.FRAME_FONT_PATH;
  const candidates = platform === 'win32'
    ? ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/segoeui.ttf', 'C:/Windows/Fonts/calibri.ttf']
    : platform === 'darwin'
      ? ['/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/SFNS.ttf']
      : [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/TTF/DejaVuSans.ttf',
        '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
        '/usr/share/fonts/liberation-sans/LiberationSans-Regular.ttf',
        '/usr/share/fonts/noto/NotoSans-Regular.ttf',
        '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
        '/usr/share/fonts/truetype/freefont/FreeSans.ttf'
      ];
  const found = candidates.find(candidate => exists(candidate));
  if (found) return found;
  if (platform === process.platform && exists === fs.existsSync) {
    if (cachedSystemFont === undefined) {
      try {
        const matched = execFileSync('fc-match', ['-f', '%{file}', 'sans-serif'], { encoding: 'utf8', windowsHide: true, timeout: 3000 }).trim();
        cachedSystemFont = matched && fs.existsSync(matched) ? matched : null;
      } catch { cachedSystemFont = null; }
    }
    return cachedSystemFont;
  }
  return null;
}
async function render(job, project) {
  const work = path.join(root, 'temp', job.id);
  fs.mkdirSync(work, { recursive: true });
  const { clips, music, textClips, settings } = project;
  const canvasClip = clips.find(clip => clip.media.generated !== 'black') || clips[0];
  const [w, h] = dimensions(canvasClip.crop, settings);
  const fps = settings.fps === 'source' ? Math.min(60, Math.max(1, canvasClip.media.fps)) : Number(settings.fps);
  job.width = w; job.height = h;
  const total = clips.reduce((sum, c, index) => sum + (c.end - c.start) / c.speed - overlap(clips, index, settings.transitionDuration), 0);
  const clipTotal = clips.reduce((sum, c) => sum + (c.end - c.start) / c.speed, 0);
  const timedText = [...textClips, ...(settings.text ? [{ text: settings.text, at: 0, duration: total }] : [])].filter(clip => clip.text && clip.at < total);
  const audible = music.filter(c => c.at < total && c.volume > 0);
  const hasTransitions = clips.length > 1 && clips.some((_, index) => overlap(clips, index, settings.transitionDuration) > 0);
  const hasText = timedText.length > 0;
  const hasMusic = audible.length > 0;
  const needsVideoPass2 = hasTransitions || hasText;
  const needsAudioPass2 = hasTransitions || hasMusic;
  const singlePassDirect = clips.length === 1 && !needsVideoPass2 && !needsAudioPass2;
  const clipExt = (needsVideoPass2 || needsAudioPass2) ? 'mov' : 'mp4';
  const step1Budget = needsVideoPass2 ? 45 : 95;
  const output = path.join(root, 'exports', `${job.id}.mp4`);
  const run = (args, duration, startPct = 0, spanPct = 0) => new Promise((resolve, reject) => {
    if (job.status === 'cancelled') return reject(new Error('Export cancelled'));
    const child = spawn(ffmpeg, ['-hide_banner', '-y', '-progress', 'pipe:1', '-nostats', ...args], { cwd: work, windowsHide: true });
    job.process = child;
    let stderr = '', pending = '';
    child.stdout.on('data', chunk => {
      pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) if (line.startsWith('out_time_us=')) {
        const seconds = Number(line.split('=')[1]) / 1000000;
        if (Number.isFinite(seconds) && spanPct > 0 && duration > 0) {
          const ratio = Math.min(1, Math.max(0, seconds / duration));
          job.progress = Math.min(98, Math.max(job.progress, Math.round(startPct + ratio * spanPct)));
        }
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
    child.on('error', reject);
    child.on('close', code => { job.process = null; code === 0 ? resolve() : reject(new Error(stderr || 'Export failed')); });
  });
  const prepareTextFilters = inputLabel => {
    const font = resolveFontPath();
    let fontOption = 'font=Sans';
    if (font) {
      const localFont = `font${path.extname(font) || '.ttf'}`;
      fs.copyFileSync(font, path.join(work, localFont));
      fontOption = `fontfile=${localFont}`;
    }
    const filters = [];
    timedText.forEach((clip, index) => {
      fs.writeFileSync(path.join(work, `text-${index}.txt`), textLayout.wrap(clip.text, w / h, clip.size ?? 0.045));
      const input = index ? `t${index - 1}` : inputLabel;
      const end = Math.min(total, clip.at + clip.duration);
      const x = clip.x ?? 0.5, y = clip.y ?? 0.88, size = clip.size ?? 0.045;
      const alignOpt = supportsDrawtextAlign ? ':text_align=C' : '';
      filters.push(`[${input}]drawtext=${fontOption}:textfile=text-${index}.txt:expansion=none:fontcolor=white:fontsize=${Math.round(h * size)}:line_spacing=${Math.round(h * size * textLayout.lineSpacing)}${alignOpt}:box=1:boxcolor=black@0.5:boxborderw=${Math.round(h * textLayout.boxPadding)}:x=w*${x}-text_w/2:y=h*${y}-text_h/2:enable='between(t,${clip.at},${end})'[t${index}]`);
    });
    return { filters, outputLabel: `t${timedText.length - 1}` };
  };
  try {
    let completed = 0;
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const duration = (c.end - c.start) / c.speed;
      job.message = `Rendering clip ${i + 1} of ${clips.length}`;
      const args = ['-ss', String(c.start), '-t', String(c.end - c.start), '-i', path.join(root, 'media', c.media.id)];
      if (!c.media.audio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
      const vf = `setpts=(PTS-STARTPTS)/${c.speed},crop=${c.crop.width}:${c.crop.height}:${c.crop.x}:${c.crop.y}:exact=1,scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,eq=brightness=${c.brightness}:contrast=${c.contrast}:saturation=${c.saturation},fps=${fps},format=yuv420p`;
      // Keep each tempo stage at or below 2x to avoid FFmpeg's sample-skipping mode.
      let tempo = c.speed; const tempoFilters = [];
      while (tempo > 2) { tempoFilters.push('atempo=2'); tempo /= 2; }
      tempoFilters.push(`atempo=${tempo}`);
      const af = `asetpts=PTS-STARTPTS,${tempoFilters.join(',')},volume=${c.volume},aresample=48000,aformat=channel_layouts=stereo,apad`;
      const videoCodec = needsVideoPass2 ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0'] : ['-c:v', 'libx264', '-preset', 'medium', '-crf', settings.quality];
      const audioCodec = needsAudioPass2 ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', '192k'];
      const clipTarget = singlePassDirect ? output : `${i}.${clipExt}`;
      args.push('-map', '0:v:0', '-map', c.media.audio ? '0:a:0' : '1:a:0', '-vf', vf, '-af', af, '-t', String(duration), ...videoCodec, ...audioCodec, '-ar', '48000', '-ac', '2', '-video_track_timescale', '90000', ...(singlePassDirect ? ['-movflags', '+faststart'] : []), clipTarget);
      const startPct = clipTotal > 0 ? step1Budget * (completed / clipTotal) : 0;
      const spanPct = clipTotal > 0 ? step1Budget * (duration / clipTotal) : step1Budget;
      await run(args, duration, startPct, spanPct);
      completed += duration;
    }
    if (!singlePassDirect) {
      let stage2Out;
      if (hasTransitions) {
        job.message = hasText ? 'Joining clips and adding timed text' : 'Finishing your MP4';
        const args = clips.flatMap((_, index) => ['-i', `${index}.${clipExt}`]);
        const filters = clips.map((_, index) => `[${index}:v]fps=${fps},settb=AVTB,setpts=PTS-STARTPTS[base${index}]`);
        let elapsed = (clips[0].end - clips[0].start) / clips[0].speed;
        for (let index = 1; index < clips.length; index++) {
          const duration = overlap(clips, index - 1, settings.transitionDuration);
          const offset = Math.max(0, elapsed - duration);
          const v = index === 1 ? 'base0' : `v${index - 1}`, a = index === 1 ? '0:a' : `a${index - 1}`;
          if (duration) {
            filters.push(`[${v}][base${index}]xfade=transition=fade:duration=${duration}:offset=${offset},fps=${fps},settb=AVTB[v${index}]`);
            filters.push(`[${a}][${index}:a]acrossfade=d=${duration}:c1=tri:c2=tri[a${index}]`);
          } else {
            filters.push(`[${v}][base${index}]concat=n=2:v=1:a=0,fps=${fps},settb=AVTB[v${index}]`);
            filters.push(`[${a}][${index}:a]concat=n=2:v=0:a=1[a${index}]`);
          }
          elapsed += (clips[index].end - clips[index].start) / clips[index].speed - duration;
        }
        let finalVideo = `v${clips.length - 1}`;
        if (hasText) {
          const textGraph = prepareTextFilters(finalVideo);
          filters.push(...textGraph.filters);
          finalVideo = textGraph.outputLabel;
        }
        stage2Out = hasMusic ? 'stage2.mov' : output;
        const audioCodec = hasMusic ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', '192k'];
        args.push('-filter_complex', filters.join(';'), '-map', `[${finalVideo}]`, '-map', `[a${clips.length - 1}]`, '-t', String(total), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', settings.quality, ...audioCodec, '-video_track_timescale', '90000', ...(hasMusic ? [] : ['-movflags', '+faststart']), stage2Out);
        await run(args, total, step1Budget, 95 - step1Budget);
      } else {
        let concatOut = `0.${clipExt}`;
        if (clips.length > 1) {
          job.message = 'Finishing your MP4';
          fs.writeFileSync(path.join(work, 'clips.txt'), clips.map((_, i) => `file '${i}.${clipExt}'`).join('\n'));
          concatOut = (!hasText && !hasMusic) ? output : `joined.${clipExt}`;
          await run(['-f', 'concat', '-safe', '0', '-i', 'clips.txt', '-c', 'copy', ...((!hasText && !hasMusic) ? ['-movflags', '+faststart'] : []), concatOut], total);
        }
        stage2Out = concatOut;
        if (hasText) {
          job.message = 'Adding timed text';
          const textGraph = prepareTextFilters('0:v');
          stage2Out = hasMusic ? 'stage2.mov' : output;
          await run(['-i', concatOut, '-filter_complex', textGraph.filters.join(';'), '-map', `[${textGraph.outputLabel}]`, '-map', '0:a:0', '-t', String(total), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', settings.quality, '-c:a', 'copy', '-video_track_timescale', '90000', ...(hasMusic ? [] : ['-movflags', '+faststart']), stage2Out], total, step1Budget, 95 - step1Budget);
        }
      }
      if (hasMusic) {
        job.message = 'Mixing music and original sound'; job.progress = Math.max(job.progress, 96);
        const args = ['-i', stage2Out];
        const filters = ['[0:a]aresample=48000,aformat=channel_layouts=stereo,apad[original]'];
        audible.forEach((c, index) => {
          args.push('-ss', String(c.start), '-t', String(Math.min(c.end - c.start, total - c.at)), '-i', path.join(root, 'media', c.media.id));
          filters.push(`[${index + 1}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${c.volume},adelay=${Math.round(c.at * 48000)}S:all=1[m${index}]`);
        });
        filters.push(`[original]${audible.map((_, i) => `[m${i}]`).join('')}amix=inputs=${audible.length + 1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=0:latency=1[mix]`);
        args.push('-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[mix]', '-t', String(total), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', output);
        await run(args, total, 96, 2);
      }
    }
    if (job.status !== 'cancelled') {
      const outputInfo = await probe(output);
      const videoStream = outputInfo.streams.find(stream => stream.codec_type === 'video');
      if (videoStream?.codec_name !== 'h264' || videoStream.pix_fmt !== 'yuv420p' || !outputInfo.streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac')) {
        throw Object.assign(new Error('Export did not produce a browser-compatible H.264/AAC MP4. Please try exporting again.'), { status: 422 });
      }
      const used = music.filter(c => c.at < total && c.volume > 0);
      await catalog.exported(used);
      job.credits = catalog.credits(used);
      if (job.credits) fs.writeFileSync(path.join(root, 'exports', `${job.id}-credits.txt`), job.credits);
      job.status = 'complete'; job.progress = 100; job.message = 'Your video is ready';
    }
  } catch (error) {
    if (job.status !== 'cancelled') { job.status = 'error'; job.message = error.status ? error.message : 'Export failed. Try a lower resolution or re-import the source clip.'; console.error(error.message); }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    if (job.status !== 'complete') {
      fs.rmSync(path.join(root, 'exports', `${job.id}.mp4`), { force: true });
      fs.rmSync(path.join(root, 'exports', `${job.id}-credits.txt`), { force: true });
    }
  }
}
app.post('/api/storage/cleanup', (req, res) => {
  if ([...jobs.values()].some(j => j.status === 'rendering') || activeImports > 0 || pendingCatalogImports.size > 0 || blackGeneration) {
    return res.status(409).json({ error: 'Wait for current imports or exports to finish before cleaning up storage.' });
  }
  if (!Array.isArray(req.body?.keepMediaIds) || req.body.keepMediaIds.some(id => typeof id !== 'string')) {
    return res.status(400).json({ error: 'Provide the list of active project media IDs.' });
  }
  const keepMedia = new Set(req.body.keepMediaIds);
  const keepExportId = typeof req.body.keepExportId === 'string' && exportIdPattern.test(req.body.keepExportId) ? req.body.keepExportId : '';
  const cleanExports = req.body.cleanExports !== false;
  let removedMedia = 0, removedExports = 0, freedBytes = 0;
  const removeFile = filePath => {
    try {
      if (fs.existsSync(filePath)) {
        freedBytes += fs.statSync(filePath).size;
        fs.rmSync(filePath, { force: true });
        return true;
      }
    } catch {}
    return false;
  };
  const retained = [];
  for (const item of library) {
    if (keepMedia.has(item.id)) retained.push(item);
    else {
      removedMedia++;
      const base = path.join(root, 'media', item.id);
      removeFile(base); removeFile(`${base}.jpg`); removeFile(`${base}.m4a`);
    }
  }
  library = retained;
  fs.writeFileSync(manifest, JSON.stringify(library, null, 2));
  const validMediaFiles = new Set();
  for (const item of library) {
    validMediaFiles.add(item.id);
    validMediaFiles.add(`${item.id}.jpg`);
    validMediaFiles.add(`${item.id}.m4a`);
  }
  for (const entry of fs.readdirSync(path.join(root, 'media'))) {
    if (!validMediaFiles.has(entry)) removeFile(path.join(root, 'media', entry));
  }
  if (cleanExports) {
    const keepExportFiles = keepExportId ? new Set([`${keepExportId}.mp4`, `${keepExportId}-credits.txt`]) : new Set();
    for (const entry of fs.readdirSync(path.join(root, 'exports'))) {
      if (keepExportFiles.has(entry)) continue;
      if (removeFile(path.join(root, 'exports', entry)) && entry.endsWith('.mp4')) removedExports++;
    }
    for (const id of jobs.keys()) {
      if (id !== keepExportId) jobs.delete(id);
    }
  }
  res.json({ removedMedia, removedExports, freedBytes });
});
app.post('/api/exports', (req, res) => {
  try {
    if ([...jobs.values()].some(j => j.status === 'rendering')) return res.status(409).json({ error: 'An export is already running. Wait for it to finish or cancel it.' });
    const project = validateProject(req.body);
    if (jobs.size >= 50) {
      for (const [oldId, oldJob] of jobs) {
        if (oldJob.status !== 'rendering') { jobs.delete(oldId); if (jobs.size < 50) break; }
      }
    }
    const job = { id: randomUUID(), status: 'rendering', progress: 0, message: 'Preparing your video' };
    jobs.set(job.id, job);
    render(job, project).catch(error => { job.status = 'error'; job.message = error.message; });
    res.json({ id: job.id });
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
app.get('/api/exports/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Export not found. The app may have restarted.' });
  const { process: child, ...status } = job;
  res.json(status);
});
app.delete('/api/exports/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (job?.status === 'rendering') { job.status = 'cancelled'; job.message = 'Export cancelled'; job.process?.kill(); }
  res.json({ ok: true });
});
app.get('/api/exports/:id/download', (req, res) => {
  const id = req.params.id;
  if (!exportIdPattern.test(id)) return res.sendStatus(404);
  if (jobs.has(id) && jobs.get(id).status !== 'complete') return res.sendStatus(404);
  const file = path.join(root, 'exports', `${id}.mp4`);
  if (!fs.existsSync(file)) return res.sendStatus(404);
  res.download(file, exportName.filename(req.query.name));
});
app.get('/api/exports/:id/credits', (req, res) => {
  const id = req.params.id;
  if (!exportIdPattern.test(id)) return res.sendStatus(404);
  if (jobs.has(id) && (jobs.get(id).status !== 'complete' || !jobs.get(id).credits)) return res.sendStatus(404);
  const file = path.join(root, 'exports', `${id}-credits.txt`);
  if (!fs.existsSync(file)) return res.sendStatus(404);
  res.download(file, 'Frame-music-credits.txt');
});
app.use((error, req, res, next) => { console.error(error.message); res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Please import videos smaller than 8 GB.' : 'Could not complete this request. Please try again.' }); });
const port = Number(process.env.PORT || 4317);
if (require.main === module) app.listen(port, '127.0.0.1', () => console.log(`Frame is ready at http://127.0.0.1:${port}`));
module.exports = { app, validateProject, dimensions, probe, resolveFontPath };
