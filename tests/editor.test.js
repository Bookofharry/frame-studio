const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ffmpeg = require('ffmpeg-static');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-test-'));
process.env.FRAME_DATA_DIR = temporary;
const { app, probe } = require('../server');
let server, base, imported, soundtrack;
const fixtures = path.join(__dirname, '..', 'test-results');
before(async () => {
  fs.mkdirSync(fixtures, { recursive: true });
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(fixtures, 'sample-with-audio.mp4')], { stdio: 'ignore', windowsHide: true });
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=0x6d9070:size=360x640:rate=30:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(fixtures, 'sample-silent.mp4')], { stdio: 'ignore', windowsHide: true });
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2', '-af', 'adelay=1000:all=1', path.join(fixtures, 'sample-music.wav')], { stdio: 'ignore', windowsHide: true });
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(temporary, { recursive: true, force: true }); });
test('imports real videos with audio and silent portrait media', async () => {
  const names = ['Chimpanzee_father_seeing_newborn…_f48fe44e.mp4', 'sample-silent.mp4'];
  const sources = ['sample-with-audio.mp4', 'sample-silent.mp4'];
  const form = new FormData(); for (let index = 0; index < names.length; index++) form.append('videos', new Blob([fs.readFileSync(path.join(fixtures, sources[index]))]), names[index]);
  const response = await fetch(`${base}/api/import`, { method: 'POST', body: form }); assert.equal(response.status, 200);
  const result = await response.json(); assert.deepEqual(result.errors, []); assert.equal(result.imported.length, 2); imported = result.imported;
  assert.equal(imported[0].name, names[0]);
  assert.equal(imported[0].audio, true); assert.equal(imported[1].audio, false); assert.equal(imported[1].height, 640);
});
test('rejects invalid trims and non-video files', async () => {
  const response = await fetch(`${base}/api/exports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips: [{ mediaId: imported[0].id, start: 2, end: 1 }] }) }); assert.equal(response.status, 400);
  const form = new FormData(); form.append('videos', new Blob(['not video']), 'invalid….mp4'); const result = await (await fetch(`${base}/api/import`, { method: 'POST', body: form })).json(); assert.equal(result.errors.length, 1); assert.equal(result.imported.length, 0); assert.match(result.errors[0], /^invalid…\.mp4: the MP4 is incomplete or damaged/);
});
test('renders trims, speed, colors, text, joined clips and silence into a playable MP4', { timeout: 90000 }, async () => {
  const response = await fetch(`${base}/api/exports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips: [{ mediaId: imported[0].id, start: 0.5, end: 2.5, speed: 2, brightness: 0.05, contrast: 1.1, saturation: 1.2, volume: 0.5 }, { mediaId: imported[1].id, start: 0, end: 1, speed: 0.5 }], settings: { aspect: '16:9', resolution: '720', fps: '30', quality: '18', text: "Frame: 100% yours, 'hello'" } }) });
  assert.equal(response.status, 200); const { id } = await response.json(); let job;
  for (let i = 0; i < 120; i++) { job = await (await fetch(`${base}/api/exports/${id}`)).json(); if (job.status !== 'rendering') break; await new Promise(resolve => setTimeout(resolve, 500)); }
  assert.equal(job.status, 'complete', JSON.stringify(job)); assert.equal(job.progress, 100);
  const download = await fetch(`${base}/api/exports/${id}/download`); assert.equal(download.status, 200);
  const output = path.join(fixtures, 'verified-export.mp4'); fs.writeFileSync(output, Buffer.from(await download.arrayBuffer()));
  const info = await probe(output); const video = info.streams.find(s => s.codec_type === 'video'); assert.equal(video.codec_name, 'h264'); assert.equal(video.width, 1280); assert.equal(video.height, 720); assert.equal(video.avg_frame_rate, '30/1'); assert.ok(Math.abs(Number(info.format.duration) - (3 - 1 / 3)) < 0.12); assert.ok(info.streams.some(s => s.codec_type === 'audio' && s.codec_name === 'aac'));
});
test('blocks cross-origin local requests', async () => {
  const response = await fetch(`${base}/api/library`, { headers: { Origin: 'https://example.com' } }); assert.equal(response.status, 403);
});
test('crop removes pixels from export and rejects out-of-bounds crops', { timeout: 90000 }, async () => {
  const source = path.join(fixtures, 'crop-halves.mp4');
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=red:size=640x360:rate=24:duration=1', '-vf', 'drawbox=x=320:y=0:w=320:h=360:color=blue:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source], { stdio: 'ignore', windowsHide: true });
  const form = new FormData(); form.append('videos', new Blob([fs.readFileSync(source)]), 'crop-halves.mp4');
  const upload = await (await fetch(`${base}/api/import`, { method: 'POST', body: form })).json();
  const mediaId = upload.imported[0].id;
  const invalid = await fetch(`${base}/api/exports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips: [{ mediaId, crop: { x: 400, y: 0, width: 320, height: 360 } }] }) });
  assert.equal(invalid.status, 400);
  const response = await fetch(`${base}/api/exports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips: [{ mediaId, crop: { x: 320, y: 0, width: 320, height: 360 } }], settings: { resolution: 'source', aspect: 'source' } }) });
  assert.equal(response.status, 200);
  const { id } = await response.json(); let job;
  for (let i = 0; i < 120; i++) { job = await (await fetch(`${base}/api/exports/${id}`)).json(); if (job.status !== 'rendering') break; await new Promise(resolve => setTimeout(resolve, 250)); }
  assert.equal(job.status, 'complete', JSON.stringify(job));
  const result = path.join(fixtures, 'verified-crop.mp4'); fs.writeFileSync(result, Buffer.from(await (await fetch(`${base}/api/exports/${id}/download`)).arrayBuffer()));
  const info = await probe(result); const stream = info.streams.find(s => s.codec_type === 'video');
  assert.equal(stream.width, 320); assert.equal(stream.height, 360);
  const pixels = execFileSync(ffmpeg, ['-v', 'error', '-i', result, '-frames:v', '1', '-vf', 'scale=8:8', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true });
  for (let i = 0; i < pixels.length; i += 3) { assert.ok(pixels[i] < 30 && pixels[i + 2] > 220, 'Every output sample is blue: red half and black padding are absent'); }
});
test('joins three different videos into one MP4 in the selected order', { timeout: 90000 }, async () => {
  const form = new FormData();
  for (const color of ['red', 'lime', 'blue']) {
    const source = path.join(fixtures, `join-${color}.mp4`);
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=${color}:size=320x180:rate=24:duration=1`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source], { stdio: 'ignore', windowsHide: true });
    form.append('videos', new Blob([fs.readFileSync(source)]), `join-${color}.mp4`);
  }
  const imported = await (await fetch(`${base}/api/import`, { method: 'POST', body: form })).json();
  assert.equal(imported.imported.length, 3);
  const clips = [2, 0, 1].map(index => ({ mediaId: imported.imported[index].id }));
  const response = await fetch(`${base}/api/exports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips, settings: { resolution: 'source', aspect: 'source' } }) });
  assert.equal(response.status, 200); const { id } = await response.json(); let job;
  for (let i = 0; i < 120; i++) { job = await (await fetch(`${base}/api/exports/${id}`)).json(); if (job.status !== 'rendering') break; await new Promise(resolve => setTimeout(resolve, 250)); }
  assert.equal(job.status, 'complete', JSON.stringify(job));
  const result = path.join(fixtures, 'verified-join.mp4'); fs.writeFileSync(result, Buffer.from(await (await fetch(`${base}/api/exports/${id}/download`)).arrayBuffer()));
  const info = await probe(result); assert.ok(Math.abs(Number(info.format.duration) - (3 - 2 / 3)) < 0.12);
  for (const [index, channel] of [2, 0, 1].entries()) {
    const pixel = execFileSync(ffmpeg, ['-v', 'error', '-ss', String(0.3 + index * 0.83), '-i', result, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true });
    assert.equal(pixel.length, 3); assert.ok(pixel[channel] > 220, `Clip ${index + 1} has its expected color`);
    for (let c = 0; c < 3; c++) if (c !== channel) assert.ok(pixel[c] < 30, `Clip ${index + 1} contains only the expected source`);
  }
  const blended = execFileSync(ffmpeg, ['-v', 'error', '-ss', '0.83', '-i', result, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true });
  assert.ok(blended[0] > 60 && blended[2] > 60 && blended[0] < 200 && blended[2] < 200, 'The boundary blends blue and red frames');
  const hardCut = await fetch(`${base}/api/exports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips, settings: { resolution: 'source', aspect: 'source', transitionDuration: 0 } }) });
  assert.equal(hardCut.status, 200); const hardCutId = (await hardCut.json()).id; let hardCutJob;
  for (let i = 0; i < 120; i++) { hardCutJob = await (await fetch(`${base}/api/exports/${hardCutId}`)).json(); if (hardCutJob.status !== 'rendering') break; await new Promise(resolve => setTimeout(resolve, 250)); }
  assert.equal(hardCutJob.status, 'complete', JSON.stringify(hardCutJob));
  const hardCutPath = path.join(fixtures, 'verified-hard-cut.mp4'); fs.writeFileSync(hardCutPath, Buffer.from(await (await fetch(`${base}/api/exports/${hardCutId}/download`)).arrayBuffer()));
  assert.ok(Math.abs(Number((await probe(hardCutPath)).format.duration) - 3) < 0.12, 'Choosing hard cuts preserves the full source duration');
  const oneDissolve = await fetch(`${base}/api/exports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips: [{ ...clips[0], transitionAfter: 0.6 }, ...clips.slice(1)], settings: { resolution: 'source', aspect: 'source', transitionDuration: 0 } }) });
  assert.equal(oneDissolve.status, 200); const oneDissolveId = (await oneDissolve.json()).id; let oneDissolveJob;
  for (let i = 0; i < 120; i++) { oneDissolveJob = await (await fetch(`${base}/api/exports/${oneDissolveId}`)).json(); if (oneDissolveJob.status !== 'rendering') break; await new Promise(resolve => setTimeout(resolve, 250)); }
  assert.equal(oneDissolveJob.status, 'complete', JSON.stringify(oneDissolveJob));
  const oneDissolvePath = path.join(fixtures, 'verified-one-dissolve.mp4'); fs.writeFileSync(oneDissolvePath, Buffer.from(await (await fetch(`${base}/api/exports/${oneDissolveId}/download`)).arrayBuffer()));
  assert.ok(Math.abs(Number((await probe(oneDissolvePath)).format.duration) - (3 - 1 / 3)) < 0.12, 'One cut can dissolve while the project default is hard cuts');
});
test('7x export turns seven seconds into one second with audible audio', { timeout: 90000 }, async () => {
  const source = path.join(fixtures, 'speed-seven.mp4');
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=blue:size=320x180:rate=30:duration=7', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=7', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source], { stdio: 'ignore', windowsHide: true });
  const form = new FormData(); form.append('videos', new Blob([fs.readFileSync(source)]), 'speed-seven.mp4');
  const imported = await (await fetch(`${base}/api/import`, { method: 'POST', body: form })).json();
  const response = await fetch(`${base}/api/exports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips: [{ mediaId: imported.imported[0].id, speed: 7 }] }) });
  assert.equal(response.status, 200); const { id } = await response.json(); let job;
  for (let i = 0; i < 120; i++) { job = await (await fetch(`${base}/api/exports/${id}`)).json(); if (job.status !== 'rendering') break; await new Promise(resolve => setTimeout(resolve, 250)); }
  assert.equal(job.status, 'complete', JSON.stringify(job));
  const result = path.join(fixtures, 'verified-seven-times.mp4'); fs.writeFileSync(result, Buffer.from(await (await fetch(`${base}/api/exports/${id}/download`)).arrayBuffer()));
  const info = await probe(result); assert.ok(Math.abs(Number(info.format.duration) - 1) < 0.1, '7 seconds becomes 1 second');
  assert.ok(info.streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
  const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', result, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { windowsHide: true });
  let energy = 0; for (let i = 0; i < pcm.length; i += 2) energy += pcm.readInt16LE(i) ** 2;
  assert.ok(pcm.length >= 14400, 'At least 0.9 seconds of decoded audio');
  assert.ok(Math.sqrt(energy / (pcm.length / 2)) > 100, 'Export retains audible sound');
});

test('imports music with a browser preview and rejects invalid soundtracks', async () => {
  const form = new FormData();
  form.append('audio', new Blob([fs.readFileSync(path.join(fixtures, 'sample-music.wav'))]), 'sample-music.wav');
  form.append('audio', new Blob(['not audio']), 'bad.mp3');
  const response = await fetch(`${base}/api/audio/import`, { method: 'POST', body: form });
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.imported.length, 1); assert.equal(result.errors.length, 1);
  soundtrack = result.imported[0]; assert.equal(soundtrack.type, 'audio');
  assert.equal(soundtrack.duration, 3);
  const preview = await fetch(base + soundtrack.url); assert.equal(preview.status, 200);
  assert.match(preview.headers.get('content-type'), /audio|mp4/);
  const invalidMusic = [
    [{ mediaId: 'missing' }], [{ mediaId: imported[0].id }], [{ mediaId: soundtrack.id, start: 2, end: 1 }],
    [{ mediaId: soundtrack.id, volume: 2 }], [{ mediaId: soundtrack.id, at: -1 }],
    Array.from({ length: 21 }, () => ({ mediaId: soundtrack.id })), { invalid: true }
  ];
  for (const music of invalidMusic) {
    const response = await fetch(`${base}/api/exports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips: [{ mediaId: imported[0].id }], music }) });
    assert.equal(response.status, 400);
  }
  const invalidVideo = await fetch(`${base}/api/exports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips: [{ mediaId: soundtrack.id }] }) });
  assert.equal(invalidVideo.status, 400);
});

test('mixes trimmed music at the chosen time and volume while retaining source sound', { timeout: 90000 }, async () => {
  const project = {
    clips: [{ mediaId: imported[0].id }, { mediaId: imported[1].id, end: 1 }],
    music: [
      { mediaId: soundtrack.id, start: 1.2, end: 2.2, at: 0.5, volume: 0.25 },
      { mediaId: soundtrack.id, start: 1.2, end: 2.2, at: 3.35, volume: 0.5 },
      { mediaId: soundtrack.id, start: 1, end: 2, at: 2, volume: 0 },
      { mediaId: soundtrack.id, at: 8, volume: 1 }
    ]
  };
  const response = await fetch(`${base}/api/exports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(project) });
  assert.equal(response.status, 200); const { id } = await response.json(); let job;
  for (let i = 0; i < 160; i++) { job = await (await fetch(`${base}/api/exports/${id}`)).json(); if (job.status !== 'rendering') break; await new Promise(resolve => setTimeout(resolve, 250)); }
  assert.equal(job.status, 'complete', JSON.stringify(job));
  const output = path.join(fixtures, 'verified-music.mp4');
  fs.writeFileSync(output, Buffer.from(await (await fetch(`${base}/api/exports/${id}/download`)).arrayBuffer()));
  const info = await probe(output); assert.ok(Math.abs(Number(info.format.duration) - (4 - 1 / 3)) < 0.12, 'Music never extends the dissolved video');
  const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { windowsHide: true });
  function amplitude(at, hz) {
    let real = 0, imag = 0; const n = 1200, start = Math.round(at * 8000);
    for (let i = 0; i < n; i++) { const sample = pcm.readInt16LE((start + i) * 2); const phase = 2 * Math.PI * hz * i / 8000; real += sample * Math.cos(phase); imag += sample * Math.sin(phase); }
    return 2 * Math.hypot(real, imag) / n;
  }
  assert.ok(amplitude(0.2, 440) > 1000, 'Original video sound is present');
  assert.ok(amplitude(0.2, 880) < 30, 'Music is silent before its timeline offset');
  assert.ok(amplitude(0.7, 440) > 1000 && amplitude(0.7, 880) > 400, 'Music mixes with original sound, with the source silence trimmed off');
  assert.ok(amplitude(1.8, 880) < 30, 'Music stops at its trim out point');
  assert.ok(amplitude(2.3, 880) < 30, 'Muted music stays silent');
  assert.ok(amplitude(3.2, 440) < 30 && amplitude(3.2, 880) < 30, 'Silent video has silence between music clips');
  assert.ok(amplitude(3.45, 880) > amplitude(0.7, 880) * 1.7, 'Second music clip uses its own volume and survives the video cut');
});

test('adds real catalog music once and supplies credits for the exported video', { timeout: 90000 }, async () => {
  const request = () => fetch(`${base}/api/audio/catalog/add`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'builtin', id: 'pulse' }) });
  const responses = await Promise.all([request(), request()]);
  const tracks = await Promise.all(responses.map(r => { assert.equal(r.status, 200); return r.json(); }));
  assert.equal(tracks[0].id, tracks[1].id, 'Concurrent adds reuse the same source');
  assert.equal(tracks[0].catalog.artist, 'Kevin MacLeod');
  const response = await fetch(`${base}/api/exports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips: [{ mediaId: imported[0].id, end: 1 }], music: [{ mediaId: tracks[0].id, start: 10, end: 11, at: 0, volume: 0.4 }] }) });
  assert.equal(response.status, 200); const { id } = await response.json(); let job;
  for (let i = 0; i < 100; i++) { job = await (await fetch(`${base}/api/exports/${id}`)).json(); if (job.status !== 'rendering') break; await new Promise(resolve => setTimeout(resolve, 200)); }
  assert.equal(job.status, 'complete', JSON.stringify(job));
  const credits = await fetch(`${base}/api/exports/${id}/credits`); assert.equal(credits.status, 200);
  const text = await credits.text(); assert.match(text, /Kevin MacLeod/); assert.match(text, /CC BY 4.0/); assert.match(text, /Excerpt/);
  const providers = await (await fetch(`${base}/api/audio/providers`)).json();
  assert.equal(providers.find(p => p.id === 'epidemic').canAdd, false);
  const blocked = await fetch(`${base}/api/audio/catalog/add`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'feed', id: 'unlicensed-song' }) });
  assert.equal(blocked.status, 404);
});
