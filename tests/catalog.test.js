const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createCatalog } = require('../audio-catalog');

test('bundled catalog has real audio, correct hashes, searchable categories, and attribution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-catalog-'));
  try {
    const catalog = createCatalog({ root, fetcher: () => { throw new Error('Built-in library must work offline'); } });
    const all = await catalog.search({}); assert.equal(all.tracks.length, 11);
    for (const track of all.tracks) {
      const audio = fs.readFileSync(path.join(__dirname, '../public/audio-catalog', track.file));
      assert.equal(createHash('sha256').update(audio).digest('hex'), track.sha256);
      assert.ok(audio.length > 1000 && track.duration > 0.08);
      assert.ok(track.artist && track.license && track.licenseUrl);
    }
    assert.equal((await catalog.search({ q: 'piano sad', category: 'Emotional' })).tracks[0].id, 'pulse');
    assert.equal((await catalog.search({ category: 'Nature' })).tracks.length, 3);
    assert.equal((await catalog.search({ q: 'no matching title' })).tracks.length, 0);
    assert.equal((await catalog.preview('builtin', 'pulse')).hls, false);
    const prepared = await catalog.prepare('builtin', 'pulse', path.join(root, 'audio'));
    assert.ok(fs.statSync(path.join(root, 'audio')).size > 1000);
    const credits = catalog.credits([{ media: prepared }, { media: prepared }]);
    assert.match(credits, /Kevin MacLeod/); assert.match(credits, /creativecommons.org\/licenses\/by\/4.0/);
    assert.equal(credits.match(/Touching Moments/g).length, 1, 'Repeated uses have one credit');
    await assert.rejects(catalog.prepare('builtin', '../../server.js', path.join(root, 'bad')));
    assert.equal(catalog.status().find(p => p.id === 'feed').canAdd, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('provider adapter verifies keys, protects secrets, enforces licenses, and reports usage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-provider-'));
  const calls = []; const key = 'test-only-not-a-real-key';
  const fetcher = async (url, options) => {
    url = String(url); calls.push({ url, options });
    if (url.startsWith('https://pdn.epidemicsound.com/')) return new Response(Buffer.from('test-audio'));
    if (options.headers.Authorization !== `Bearer ${key}`) return new Response('{}', { status: 401 });
    if (url.includes('/analytics/report')) return Response.json({ eventsCount: 1 });
    if (url.includes('/stream')) return Response.json({ url: 'https://hls-storage.epidemicsite.com/test/master.m3u8' });
    if (url.includes('/download')) return Response.json({ url: 'https://pdn.epidemicsound.com/test.mp3' });
    return Response.json({ tracks: [{ id: 'test-track', title: 'Test Song', mainArtists: ['Test Artist'], length: 45, moods: [{ name: 'Happy' }], isPreviewOnly: false }] });
  };
  try {
    const catalog = createCatalog({ root, fetcher });
    await assert.rejects(catalog.search({ provider: 'epidemic' }), /Connect/);
    await catalog.connect({ apiKey: key });
    assert.ok(!JSON.stringify(catalog.status()).includes(key));
    assert.equal(catalog.status()[1].canAdd, false);
    const tracks = (await catalog.search({ provider: 'epidemic', q: 'happy' })).tracks;
    assert.equal(tracks[0].artist, 'Test Artist'); assert.equal(tracks[0].canAdd, false);
    await assert.rejects(catalog.prepare('epidemic', 'test-track', path.join(root, 'audio')), /production license/);
    assert.equal((await catalog.preview('epidemic', 'test-track')).hls, true);
    await assert.rejects(catalog.connect({ apiKey: 'bad-key' }), /denied/);
    assert.equal(catalog.status()[1].connected, true, 'A failed replacement preserves the previous connection');
    await catalog.connect({ apiKey: key, licensed: true, licenseReference: 'TEST-AGREEMENT' });
    await catalog.search({ provider: 'epidemic' });
    const prepared = await catalog.prepare('epidemic', 'test-track', path.join(root, 'audio'));
    catalog.assertLicensed([prepared]); await catalog.exported([{ media: prepared }]);
    const events = calls.filter(c => c.url.endsWith('/analytics/report')).map(c => JSON.parse(c.options.body).events[0].analyticsEvent.type);
    assert.deepEqual(events, ['trackPreviewed', 'trackDownloaded', 'tracksExported']);
    const reopened = createCatalog({ root, fetcher }); assert.equal(reopened.status()[1].canAdd, true);
    await reopened.connect({ disconnect: true });
    assert.throws(() => reopened.assertLicensed([prepared]), /Reconnect/);
    assert.ok(!fs.readFileSync(path.join(root, 'audio-connections.json'), 'utf8').includes(key));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
