const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function createCatalog({ root, fetcher = fetch }) {
  const directory = path.join(__dirname, 'public/audio-catalog');
  const configFile = path.join(root, 'audio-connections.json');
  const tracks = JSON.parse(fs.readFileSync(path.join(directory, 'catalog.json'), 'utf8'));
  let config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : { userId: randomUUID() };
  if (!fs.existsSync(configFile)) fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const lookup = new Map();
  const epidemicKey = () => process.env.EPIDEMIC_API_KEY || config.epidemic?.apiKey;
  const licenseRef = () => process.env.EPIDEMIC_LICENSE_REFERENCE || config.epidemic?.licenseReference;
  const error = (message, status = 400) => Object.assign(new Error(message), { status });
  async function epidemic(endpoint, options = {}, key = epidemicKey()) {
    if (!key) throw error('Connect an Epidemic Sound developer account first.', 409);
    let response;
    try { response = await fetcher(`https://api.epidemicsound.com${endpoint}`, { ...options, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000) }); }
    catch { throw error('Epidemic Sound could not be reached. Check your connection and try again.', 502); }
    if (!response.ok) throw error(response.status === 429 ? 'Epidemic Sound usage limit reached. Try later or check your plan.' : [401, 403].includes(response.status) ? 'Epidemic Sound denied access. Check your credentials and account permissions.' : 'Epidemic Sound could not complete this request.', 502);
    return response.status === 204 ? {} : response.json();
  }
  function status() {
    return [
      { id: 'builtin', name: 'Free starter library', connected: true, canAdd: true, message: `${tracks.length} bundled tracks and sounds. Available offline.` },
      { id: 'epidemic', name: 'Epidemic Sound', connected: !!epidemicKey(), canAdd: !!epidemicKey() && !!licenseRef(), message: !epidemicKey() ? 'Connect a developer account to search and preview.' : !licenseRef() ? 'Preview access. Adding and exporting require a production licensing agreement.' : 'Connected with a production license reference.' },
      { id: 'feed', name: 'Popular songs · Feed Clips', connected: false, canAdd: false, message: 'Partner onboarding required. The standard service is US-only, with clips up to 60 seconds. Local MP4 downloads need an agreement that explicitly permits this workflow.' }
    ];
  }
  async function connect(body) {
    if (process.env.EPIDEMIC_API_KEY) throw error('This connection is managed through the server environment.');
    if (body.disconnect) { delete config.epidemic; lookup.clear(); }
    else {
      const key = String(body.apiKey || '').trim(), reference = String(body.licenseReference || '').trim();
      if (!key || key.length > 500 || /\s/.test(key)) throw error('Enter a valid API key.');
      if (reference.length > 200) throw error('Keep the license reference below 200 characters.');
      await epidemic('/v0/tracks?limit=1', {}, key);
      if (body.licensed === true && !reference) throw error('Enter the reference for your production licensing agreement.');
      config.epidemic = { apiKey: key, licenseReference: body.licensed === true ? reference : '' };
      lookup.clear();
    }
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    return status();
  }
  async function search({ provider = 'builtin', q = '', category = 'All', offset = 0 }) {
    if (!['builtin', 'epidemic', 'feed'].includes(provider)) throw error('Unknown sound library.');
    q = String(q).slice(0, 150).trim(); offset = Math.max(0, Math.min(10000, Number(offset) || 0));
    if (provider === 'builtin') {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = tracks.filter(t => (category === 'All' || t.category === category) && words.every(word => `${t.title} ${t.artist} ${t.tags.join(' ')} ${t.category}`.toLowerCase().includes(word)));
      return { tracks: matches.map(t => ({ ...t, provider, previewUrl: `/audio-catalog/${t.file}`, canAdd: true })), nextOffset: null };
    }
    if (provider === 'feed') return { tracks: [], nextOffset: null, message: status()[2].message };
    const term = [q, category === 'All' ? '' : category].filter(Boolean).join(' ');
    const result = await epidemic(`/v0/tracks/search?${new URLSearchParams({ term, limit: '20', offset: String(offset) })}`);
    const rows = result.tracks || [];
    const normalized = rows.map(t => ({ id: t.id, provider, title: t.title, artist: (t.mainArtists || []).join(', '), duration: t.length, category: (t.moods || []).map(m => m.name).join(', '), kind: 'Music', license: 'Epidemic Sound agreement', licenseUrl: 'https://www.epidemicsound.com/tools/api/', attributionRequired: false, canAdd: !!licenseRef() && !t.isPreviewOnly }));
    for (const track of normalized) lookup.set(track.id, track);
    if (lookup.size > 500) { const retain = normalized; lookup.clear(); for (const t of retain) lookup.set(t.id, t); }
    return { tracks: normalized, nextOffset: rows.length === 20 ? offset + 20 : null };
  }
  function get(provider, id) {
    const track = provider === 'builtin' ? tracks.find(t => t.id === id) : provider === 'epidemic' ? lookup.get(id) : null;
    if (!track) throw error('Find this track in the library again before using it.', 404);
    return track;
  }
  async function report(type, ids) {
    const analyticsEvent = type === 'tracksExported' ? { type, trackIds: ids, platform: 'LOCAL' } : { type, trackId: ids[0], ...(type === 'trackDownloaded' ? { format: 'mp3', quality: 'high' } : {}) };
    await epidemic('/v0/analytics/report', { method: 'POST', body: JSON.stringify({ events: [{ userId: config.userId, timestamp: new Date().toISOString(), userConnected: false, analyticsEvent }] }) });
  }
  async function preview(provider, id) {
    const track = get(provider, id);
    if (provider === 'builtin') return { url: `/audio-catalog/${track.file}`, hls: false };
    const data = await epidemic(`/v0/tracks/${encodeURIComponent(id)}/stream`);
    await report('trackPreviewed', [id]);
    return { url: data.url, hls: true };
  }
  function assertLicensed(media) {
    for (const item of media) if (item.catalog?.provider === 'epidemic' && (!epidemicKey() || !licenseRef() || item.catalog.licenseReference !== licenseRef())) throw error('Reconnect the production license used for this Epidemic Sound track before exporting.', 403);
  }
  async function prepare(provider, id, destination) {
    const track = get(provider, id);
    if (provider === 'builtin') fs.copyFileSync(path.join(directory, track.file), destination);
    else {
      if (!licenseRef() || !track.canAdd) throw error('This track needs a production license before it can be added or exported.', 403);
      const link = await epidemic(`/v0/tracks/${encodeURIComponent(id)}/download?format=mp3&quality=high`);
      const url = new URL(link.url);
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.epidemicsound.com')) throw error('The provider returned an unsupported download address.', 502);
      const response = await fetcher(url, { signal: AbortSignal.timeout(90000), redirect: 'error' });
      if (!response.ok) throw error('Could not download this track. Try again.', 502);
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 100 * 1024 ** 2) throw error('This track exceeds the 100 MB library download limit.'); chunks.push(chunk); }
      fs.writeFileSync(destination, Buffer.concat(chunks));
      await report('trackDownloaded', [id]);
    }
    return { ...track, catalog: { provider, trackId: id, title: track.title, artist: track.artist, license: track.license, licenseUrl: track.licenseUrl, sourceUrl: track.sourceUrl || '', attributionRequired: track.attributionRequired, modifications: track.modifications || '', ...(provider === 'epidemic' ? { licenseReference: licenseRef() } : {}) } };
  }
  function credits(clips) {
    const used = new Map(); for (const clip of clips) if (clip.media?.catalog) used.set(`${clip.media.catalog.provider}:${clip.media.catalog.trackId}`, clip.media.catalog);
    return [...used.values()].map(t => `${t.title} — ${t.artist}\n${t.sourceUrl}\nLicense: ${t.license}\n${t.licenseUrl}\n${t.modifications}\nUsed with video; may be trimmed and mixed with other audio.${t.attributionRequired ? '\nInclude this credit in your video description or credits.' : ''}`).join('\n\n');
  }
  async function exported(clips) {
    const ids = [...new Set(clips.filter(c => c.media.catalog?.provider === 'epidemic').map(c => c.media.catalog.trackId))];
    if (ids.length) await report('tracksExported', ids);
  }
  return { status, connect, search, preview, prepare, assertLicensed, credits, exported };
}
module.exports = { createCatalog };
