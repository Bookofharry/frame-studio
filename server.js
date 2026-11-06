const express = require('express');
const multer = require('multer');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const cropGeometry = require('./public/crop');
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
app.post('/api/audio/catalog/add', catalogRoute(async (req, res) => res.json(await importCatalogTrack(req.body.provider, req.body.id))));
app.post('/api/audio/import', upload.array('audio', 20), async (req, res, next) => {
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
app.post('/api/import', upload.array('videos', 20), async (req, res, next) => {
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
    return { media, crop, start, end, speed: number(c.speed, 1, 0.5, 7), volume: number(c.volume, 1, 0, 1), brightness: number(c.brightness, 0, -0.5, 0.5), contrast: number(c.contrast, 1, 0.5, 2), saturation: number(c.saturation, 1, 0, 2) };
  });
  const settings = body.settings || {};
  const resolution = ['source', '720', '1080', '2160'].includes(settings.resolution) ? settings.resolution : 'source';
  const aspect = ['source', '16:9', '9:16', '1:1'].includes(settings.aspect) ? settings.aspect : 'source';
  const quality = ['18', '20', '23'].includes(String(settings.quality)) ? String(settings.quality) : '18';
  const fps = ['source', '24', '30', '60'].includes(String(settings.fps)) ? String(settings.fps) : 'source';
  const text = String(settings.text || '').slice(0, 120);
  if (body.music !== undefined && (!Array.isArray(body.music) || body.music.length > 20)) throw new Error('Use up to 20 music clips.');
  const music = (body.music || []).map(c => {
    const media = library.find(m => m.id === c.mediaId && m.type === 'audio');
    if (!media) throw new Error('A music source is missing. Import it again.');
    const start = number(c.start, 0, 0, media.duration), end = number(c.end, media.duration, 0, media.duration);
    if (end - start < 0.08) throw new Error('Each music clip must be at least 0.08 seconds long.');
    return { media, start, end, at: number(c.at, 0, 0, 86400), volume: number(c.volume, 0.5, 0, 1) };
  });
  catalog.assertLicensed(music.map(clip => clip.media));
  return { clips, music, settings: { resolution, aspect, quality, fps, text } };
}
function dimensions(media, settings) {
  let ratio = media.width / media.height;
  if (settings.aspect !== 'source') { const [w, h] = settings.aspect.split(':').map(Number); ratio = w / h; }
  const shortEdge = settings.resolution === 'source' ? Math.min(media.width, media.height) : Number(settings.resolution);
  const even = v => Math.max(2, Math.round(v / 2) * 2);
  return ratio >= 1 ? [even(shortEdge * ratio), even(shortEdge)] : [even(shortEdge), even(shortEdge / ratio)];
}
async function render(job, project) {
  const work = path.join(root, 'temp', job.id);
  fs.mkdirSync(work, { recursive: true });
  const { clips, music, settings } = project;
  const [w, h] = dimensions(clips[0].crop, settings);
  const fps = settings.fps === 'source' ? Math.min(60, Math.max(1, clips[0].media.fps)) : Number(settings.fps);
  job.width = w; job.height = h;
  if (settings.text) fs.writeFileSync(path.join(work, 'title.txt'), settings.text);
  const font = process.platform === 'win32' ? 'C:/Windows/Fonts/arial.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  if (settings.text) fs.copyFileSync(font, path.join(work, 'font.ttf'));
  const total = clips.reduce((sum, c) => sum + (c.end - c.start) / c.speed, 0);
  let completed = 0;
  const run = (args, duration, progressWeight = 1) => new Promise((resolve, reject) => {
    if (job.status === 'cancelled') return reject(new Error('Export cancelled'));
    const child = spawn(ffmpeg, ['-hide_banner', '-y', '-progress', 'pipe:1', '-nostats', ...args], { cwd: work, windowsHide: true });
    job.process = child;
    let stderr = '', pending = '';
    child.stdout.on('data', chunk => {
      pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) if (line.startsWith('out_time_us=')) {
        const seconds = Number(line.split('=')[1]) / 1000000;
        if (Number.isFinite(seconds)) job.progress = Math.min(98, Math.round(95 * (completed + Math.min(seconds, duration) * progressWeight) / total));
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
    child.on('error', reject);
    child.on('close', code => { job.process = null; code === 0 ? resolve() : reject(new Error(stderr || 'Export failed')); });
  });
  try {
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const duration = (c.end - c.start) / c.speed;
      job.message = `Rendering clip ${i + 1} of ${clips.length}`;
      const args = ['-ss', String(c.start), '-t', String(c.end - c.start), '-i', path.join(root, 'media', c.media.id)];
      if (!c.media.audio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
      let vf = `setpts=(PTS-STARTPTS)/${c.speed},crop=${c.crop.width}:${c.crop.height}:${c.crop.x}:${c.crop.y}:exact=1,scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,eq=brightness=${c.brightness}:contrast=${c.contrast}:saturation=${c.saturation},fps=${fps},format=yuv420p`;
      if (settings.text) vf += `,drawtext=fontfile=font.ttf:textfile=title.txt:expansion=none:fontcolor=white:fontsize=${Math.round(h * 0.045)}:box=1:boxcolor=black@0.5:boxborderw=12:x=(w-text_w)/2:y=h-text_h-h*0.08`;
      // Keep each tempo stage at or below 2x to avoid FFmpeg's sample-skipping mode.
      let tempo = c.speed; const tempoFilters = [];
      while (tempo > 2) { tempoFilters.push('atempo=2'); tempo /= 2; }
      tempoFilters.push(`atempo=${tempo}`);
      const af = `asetpts=PTS-STARTPTS,${tempoFilters.join(',')},volume=${c.volume},aresample=48000,aformat=channel_layouts=stereo,apad`;
      args.push('-map', '0:v:0', '-map', c.media.audio ? '0:a:0' : '1:a:0', '-vf', vf, '-af', af, '-t', String(duration), '-c:v', 'libx264', '-preset', 'medium', '-crf', settings.quality, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-video_track_timescale', '90000', `${i}.mp4`);
      await run(args, duration);
      completed += duration;
    }
    job.message = 'Finishing your MP4'; job.progress = 96;
    fs.writeFileSync(path.join(work, 'clips.txt'), clips.map((_, i) => `file '${i}.mp4'`).join('\n'));
    const output = path.join(root, 'exports', `${job.id}.mp4`);
    const audible = music.filter(c => c.at < total && c.volume > 0);
    await run(['-f', 'concat', '-safe', '0', '-i', 'clips.txt', '-c', 'copy', '-movflags', '+faststart', audible.length ? 'joined.mp4' : output], total, 0);
    if (audible.length) {
      job.message = 'Mixing music and original sound';
      const args = ['-i', 'joined.mp4'];
      const filters = ['[0:a]aresample=48000,aformat=channel_layouts=stereo,apad[original]'];
      audible.forEach((c, index) => {
        args.push('-ss', String(c.start), '-t', String(Math.min(c.end - c.start, total - c.at)), '-i', path.join(root, 'media', c.media.id));
        filters.push(`[${index + 1}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${c.volume},adelay=${Math.round(c.at * 48000)}S:all=1[m${index}]`);
      });
      filters.push(`[original]${audible.map((_, i) => `[m${i}]`).join('')}amix=inputs=${audible.length + 1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=0:latency=1[mix]`);
      args.push('-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[mix]', '-t', String(total), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', output);
      await run(args, total, 0);
    }
    if (job.status !== 'cancelled') {
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
    if (job.status !== 'complete') fs.rmSync(path.join(root, 'exports', `${job.id}.mp4`), { force: true });
  }
}
app.post('/api/exports', (req, res) => {
  try {
    if ([...jobs.values()].some(j => j.status === 'rendering')) return res.status(409).json({ error: 'An export is already running. Wait for it to finish or cancel it.' });
    const project = validateProject(req.body);
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
  if (jobs.get(req.params.id)?.status !== 'complete') return res.sendStatus(404);
  res.download(path.join(root, 'exports', `${req.params.id}.mp4`), 'Frame-export.mp4');
});
app.get('/api/exports/:id/credits', (req, res) => {
  if (jobs.get(req.params.id)?.status !== 'complete' || !jobs.get(req.params.id)?.credits) return res.sendStatus(404);
  res.download(path.join(root, 'exports', `${req.params.id}-credits.txt`), 'Frame-music-credits.txt');
});
app.use((error, req, res, next) => { console.error(error.message); res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Please import videos smaller than 8 GB.' : 'Could not complete this request. Please try again.' }); });
const port = Number(process.env.PORT || 4317);
if (require.main === module) app.listen(port, '127.0.0.1', () => console.log(`Frame is ready at http://127.0.0.1:${port}`));
module.exports = { app, validateProject, dimensions, probe };
