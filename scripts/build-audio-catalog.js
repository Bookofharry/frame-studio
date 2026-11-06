// Rebuild the bundled starter library from the credited creators' original files.
// This is a maintainer task; users can use the committed audio files offline.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const output = path.join(__dirname, '../public/audio-catalog');
const cache = path.join(__dirname, '../test-results/catalog-sources');
const by = 'https://creativecommons.org/licenses/by/4.0/';
const cc0 = 'https://creativecommons.org/publicdomain/zero/1.0/';
const music = [
  ['pulse', 'Touching Moments One - Pulse', 'USUAN1100039', 'Emotional', 'piano sad gentle love', 0],
  ['dreams', 'Dreams Become Real', 'USUAN1500027', 'Cinematic', 'dreamy piano atmosphere calm', 45],
  ['carefree', 'Carefree', 'USUAN1400037', 'Happy', 'bright ukulele upbeat cheerful', 0],
  ['leaves', 'The House of Leaves', 'USUAN1100710', 'Suspense', 'dark horror tension eerie', 0],
  ['windswept', 'Windswept', 'USUAN1100757', 'Cinematic', 'peaceful guitar strings travel', 0]
].map(([id, title, isrc, category, tags, start]) => ({ id, title, artist: 'Kevin MacLeod', kind: 'Music', category, tags: tags.split(' '), start, seconds: 60, sourceUrl: `https://incompetech.com/music/royalty-free/index.html?isrc=${isrc}`, download: `https://incompetech.com/music/royalty-free/mp3-royaltyfree/${encodeURIComponent(title)}.mp3`, license: 'CC BY 4.0', licenseUrl: by, attributionRequired: true }));
const nature = ['birds', 'river', 'wind'].map(kind => ({ id: `park-${kind}`, title: `Park ${kind[0].toUpperCase() + kind.slice(1)}`, artist: 'Thimras', kind: 'Sound effect', category: 'Nature', tags: ['park', kind, 'ambience', 'outdoors'], start: 0, seconds: 30, sourceUrl: 'https://opengameart.org/content/park-ambiences', download: `https://opengameart.org/sites/default/files/park_ambience_${kind}.wav`, license: 'CC0 1.0', licenseUrl: cc0, attributionRequired: false }));
const effects = [
  { id: 'soft-whoosh', title: 'Soft Whoosh', seconds: 1.5, input: 'anoisesrc=color=pink:amplitude=0.3:d=1.5', filter: 'highpass=f=600,lowpass=f=7000,afade=t=in:d=0.65,afade=t=out:st=0.7:d=0.8' },
  { id: 'gentle-chime', title: 'Gentle Chime', seconds: 2, input: 'aevalsrc=0.16*sin(2*PI*880*t)*exp(-3*t)+0.08*sin(2*PI*1320*t)*exp(-4*t):s=48000:d=2', filter: 'afade=t=in:d=0.005,afade=t=out:st=1.6:d=0.4' },
  { id: 'deep-impact', title: 'Deep Impact', seconds: 1.5, input: 'aevalsrc=0.3*sin(2*PI*(70*t+10*(1-exp(-8*t))))*exp(-5*t):s=48000:d=1.5', filter: 'afade=t=in:d=0.005,afade=t=out:st=1:d=0.5' }
].map(track => ({ ...track, artist: 'Frame Studio', kind: 'Sound effect', category: 'Sound Effects', tags: ['transition', 'effect', 'synthesized'], sourceUrl: '', license: 'CC0 1.0', licenseUrl: cc0, attributionRequired: false }));
async function downloadSource(entry) {
  if (entry.category !== 'Nature') {
    const response = await fetch(entry.download, { signal: AbortSignal.timeout(600000) });
    if (!response.ok) throw new Error(`Download failed: ${entry.id} (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }
  // The original field recordings are large PCM WAVs. Fetch just the header
  // and enough samples for the excerpt, instead of downloading several minutes.
  const head = await fetch(entry.download, { headers: { Range: 'bytes=0-4095' }, signal: AbortSignal.timeout(30000) });
  if (head.status !== 206) throw new Error('The source does not support excerpt downloads.');
  const header = Buffer.from(await head.arrayBuffer());
  const fmt = header.indexOf('fmt '), data = header.indexOf('data');
  if (fmt < 0 || data < 0 || header.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Unsupported field recording format.');
  const size = Math.min(Number(head.headers.get('content-range').split('/')[1]), data + 8 + header.readUInt32LE(fmt + 16) * (entry.seconds + 1));
  const step = 512 * 1024, chunks = [];
  for (let at = 0; at < size; at += step * 4) {
    const group = await Promise.all(Array.from({ length: Math.min(4, Math.ceil((size - at) / step)) }, async (_, i) => {
      const start = at + i * step, end = Math.min(size - 1, start + step - 1);
      const r = await fetch(entry.download, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(60000) });
      if (r.status !== 206) throw new Error('Excerpt request failed.');
      const buffer = Buffer.from(await r.arrayBuffer()); if (buffer.length !== end - start + 1) throw new Error('Incomplete excerpt download.'); return buffer;
    }));
    chunks.push(...group);
  }
  return Buffer.concat(chunks);
}
async function main() {
  fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(cache, { recursive: true }); const tracks = [];
  for (const entry of [...music, ...nature, ...effects]) {
    const file = `${entry.id}.m4a`, target = path.join(output, file); let originalSha256;
    const args = ['-y'];
    if (entry.download) {
      const source = path.join(cache, entry.id);
      if (!fs.existsSync(source)) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            console.log(`Downloading ${entry.id} (attempt ${attempt})`);
            fs.writeFileSync(source, await downloadSource(entry)); break;
          } catch (error) { if (attempt === 3) throw error; }
        }
      }
      originalSha256 = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
      args.push('-ss', String(entry.start), '-i', source, '-t', String(entry.seconds), '-af', `afade=t=in:d=0.1,afade=t=out:st=${entry.seconds - 1}:d=1`);
    } else args.push('-f', 'lavfi', '-i', entry.input, '-af', entry.filter);
    execFileSync(ffmpeg, [...args, '-vn', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', target], { stdio: 'ignore', windowsHide: true });
    const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_format', '-of', 'json', target], { encoding: 'utf8', windowsHide: true }));
    const { input, filter, seconds, start, download, ...metadata } = entry;
    const modifications = download ? `Excerpt from ${start}s, with short fades; converted to AAC by Frame Studio.` : 'Synthesized for Frame Studio; no third-party recording used.';
    tracks.push({ ...metadata, file, duration: Number(info.format.duration), modifications, originalUrl: download || null, downloadedSourceSha256: originalSha256 || null, sourceExcerptDownloaded: entry.category === 'Nature', sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex') });
    console.log(`Prepared ${entry.title}`);
  }
  fs.writeFileSync(path.join(output, 'catalog.json'), JSON.stringify(tracks, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'CREDITS.txt'), tracks.map(t => `${t.title}\nBy ${t.artist}\n${t.sourceUrl}\n${t.license}: ${t.licenseUrl}\n${t.modifications}\n${t.attributionRequired ? 'Credit this artist and license when sharing your video.' : 'Attribution is appreciated but not required.'}`).join('\n\n') + '\n');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
