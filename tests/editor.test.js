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
let server, base, imported;
const fixtures = path.join(__dirname, '..', 'test-results');
before(async () => {
  fs.mkdirSync(fixtures, { recursive: true });
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(fixtures, 'sample-with-audio.mp4')], { stdio: 'ignore', windowsHide: true });
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=0x6d9070:size=360x640:rate=30:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(fixtures, 'sample-silent.mp4')], { stdio: 'ignore', windowsHide: true });
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(temporary, { recursive: true, force: true }); });
test('imports real videos with audio and silent portrait media', async () => {
  const form = new FormData(); for (const name of ['sample-with-audio.mp4', 'sample-silent.mp4']) form.append('videos', new Blob([fs.readFileSync(path.join(fixtures, name))]), name);
  const response = await fetch(`${base}/api/import`, { method: 'POST', body: form }); assert.equal(response.status, 200);
  const result = await response.json(); assert.deepEqual(result.errors, []); assert.equal(result.imported.length, 2); imported = result.imported;
  assert.equal(imported[0].audio, true); assert.equal(imported[1].audio, false); assert.equal(imported[1].height, 640);
});
test('rejects invalid trims and non-video files', async () => {
  const response = await fetch(`${base}/api/exports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips: [{ mediaId: imported[0].id, start: 2, end: 1 }] }) }); assert.equal(response.status, 400);
  const form = new FormData(); form.append('videos', new Blob(['not video']), 'invalid.mp4'); const result = await (await fetch(`${base}/api/import`, { method: 'POST', body: form })).json(); assert.equal(result.errors.length, 1); assert.equal(result.imported.length, 0);
});
test('renders trims, speed, colors, text, joined clips and silence into a playable MP4', { timeout: 90000 }, async () => {
  const response = await fetch(`${base}/api/exports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips: [{ mediaId: imported[0].id, start: 0.5, end: 2.5, speed: 2, brightness: 0.05, contrast: 1.1, saturation: 1.2, volume: 0.5 }, { mediaId: imported[1].id, start: 0, end: 1, speed: 0.5 }], settings: { aspect: '16:9', resolution: '720', fps: '30', quality: '18', text: "Frame: 100% yours, 'hello'" } }) });
  assert.equal(response.status, 200); const { id } = await response.json(); let job;
  for (let i = 0; i < 120; i++) { job = await (await fetch(`${base}/api/exports/${id}`)).json(); if (job.status !== 'rendering') break; await new Promise(resolve => setTimeout(resolve, 500)); }
  assert.equal(job.status, 'complete', JSON.stringify(job)); assert.equal(job.progress, 100);
  const download = await fetch(`${base}/api/exports/${id}/download`); assert.equal(download.status, 200);
  const output = path.join(fixtures, 'verified-export.mp4'); fs.writeFileSync(output, Buffer.from(await download.arrayBuffer()));
  const info = await probe(output); const video = info.streams.find(s => s.codec_type === 'video'); assert.equal(video.codec_name, 'h264'); assert.equal(video.width, 1280); assert.equal(video.height, 720); assert.equal(video.avg_frame_rate, '30/1'); assert.ok(Math.abs(Number(info.format.duration) - 3) < 0.2); assert.ok(info.streams.some(s => s.codec_type === 'audio' && s.codec_name === 'aac'));
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
  const info = await probe(result); assert.ok(Math.abs(Number(info.format.duration) - 3) < 0.2);
  for (const [index, channel] of [2, 0, 1].entries()) {
    const pixel = execFileSync(ffmpeg, ['-v', 'error', '-ss', String(index + 0.5), '-i', result, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true });
    assert.equal(pixel.length, 3); assert.ok(pixel[channel] > 220, `Clip ${index + 1} has its expected color`);
    for (let c = 0; c < 3; c++) if (c !== channel) assert.ok(pixel[c] < 30, `Clip ${index + 1} contains only the expected source`);
  }
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
