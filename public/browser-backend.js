(function (global) {
  const DB_NAME = 'frame-studio-browser-db';
  const DB_VERSION = 1;
  const MAX_BROWSER_VIDEO_BYTES = 512 * 1024 * 1024;
  const MAX_BROWSER_AUDIO_BYTES = 150 * 1024 * 1024;
  const BLACK_MEDIA_ID = 'frame-black-screen-v1';
  const FFMPEG_CDN = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd';
  const FFMPEG_CORE_CDN = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';

  let mode = null;
  let modePromise = null;
  let starterTracks = null;
  const mediaUrls = new Map();
  const epidemicLookup = new Map();
  const pendingCatalogAdds = new Map();
  const jobs = new Map();
  let blackPromise = null;
  let ffmpegLoader = null;

  const makeError = (message, status = 400) => Object.assign(new Error(message), { status });

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('config')) db.createObjectStore('config');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function withStore(storeName, txMode, run) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, txMode);
      const store = tx.objectStore(storeName);
      let result;
      Promise.resolve(run(store, tx))
        .then(value => { result = value; })
        .catch(error => { try { tx.abort(); } catch {} reject(error); });
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error('Browser storage operation failed.')); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error('Browser storage operation aborted.')); };
    });
  }

  function idbReq(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getAllMediaRecords() {
    return withStore('media', 'readonly', store => idbReq(store.getAll()));
  }

  async function getMediaRecord(id) {
    return withStore('media', 'readonly', store => idbReq(store.get(id)));
  }

  async function putMediaRecord(record) {
    return withStore('media', 'readwrite', store => idbReq(store.put(record)));
  }

  async function deleteMediaRecord(id) {
    const url = mediaUrls.get(id);
    if (url) { URL.revokeObjectURL(url); mediaUrls.delete(id); }
    return withStore('media', 'readwrite', store => idbReq(store.delete(id)));
  }

  function hydrateMedia(record) {
    let url = mediaUrls.get(record.id);
    if (!url && record.blob) {
      url = URL.createObjectURL(record.blob);
      mediaUrls.set(record.id, url);
    }
    return {
      ...record.item,
      url: url || record.item.url,
      ...(record.thumbnailDataUrl ? { thumbnail: record.thumbnailDataUrl } : {})
    };
  }

  async function getConfig() {
    const existing = await withStore('config', 'readonly', store => idbReq(store.get('state')));
    if (existing && existing.userId) return existing;
    const fresh = { userId: crypto.randomUUID() };
    await withStore('config', 'readwrite', store => idbReq(store.put(fresh, 'state')));
    return fresh;
  }

  async function saveConfig(config) {
    await withStore('config', 'readwrite', store => idbReq(store.put(config, 'state')));
  }

  function applyBrowserWorkspaceBranding() {
    const footerLabel = document.querySelector('.app-footer > span:first-child');
    if (footerLabel && footerLabel.textContent.includes('LOCAL WORKSPACE')) {
      footerLabel.innerHTML = 'FRAME STUDIO <span class="footer-separator">/</span> BROWSER WORKSPACE';
    }
  }

  async function ensureMode() {
    if (mode) return mode;
    if (modePromise) return modePromise;
    modePromise = (async () => {
      try {
        const params = new URLSearchParams(global.location?.search || '');
        if (params.get('mode') === 'browser') {
          mode = 'browser';
          applyBrowserWorkspaceBranding();
          return mode;
        }
        const response = await fetch('./api/capabilities', {
          cache: 'no-store',
          signal: AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined
        });
        const contentType = response.headers.get('content-type') || '';
        if (response.ok && contentType.includes('application/json')) {
          const data = await response.json();
          if (data && data.timedTextExport === true && !data.browserMode) {
            mode = 'server';
            return mode;
          }
        }
      } catch {}
      mode = 'browser';
      applyBrowserWorkspaceBranding();
      return mode;
    })();
    return modePromise;
  }

  async function loadStarterTracks() {
    if (starterTracks) return starterTracks;
    const response = await fetch('./audio-catalog/catalog.json');
    if (!response.ok) throw makeError('Could not load the built-in sound library.', 502);
    starterTracks = await response.json();
    return starterTracks;
  }

  async function detectVideoHasAudio(video, file) {
    if (typeof video.mozHasAudio === 'boolean') return video.mozHasAudio;
    if (video.audioTracks && typeof video.audioTracks.length === 'number') return video.audioTracks.length > 0;
    const capture = video.captureStream || video.mozCaptureStream;
    if (typeof capture === 'function') {
      try {
        const stream = capture.call(video);
        const hasAudio = stream.getAudioTracks().length > 0;
        stream.getTracks().forEach(track => track.stop());
        if (hasAudio) return true;
      } catch {}
    }
    if (typeof video.webkitAudioDecodedByteCount === 'number' && video.webkitAudioDecodedByteCount > 0) return true;
    const AudioCtx = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    if (AudioCtx && file.size <= 64 * 1024 * 1024) {
      try {
        const ctx = new AudioCtx(1, 1, 8000);
        const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
        return decoded.numberOfChannels > 0 && decoded.duration > 0;
      } catch { return false; }
    }
    try {
      const head = new Uint8Array(await file.slice(0, Math.min(file.size, 2 * 1024 * 1024)).arrayBuffer());
      const tail = file.size > 2 * 1024 * 1024
        ? new Uint8Array(await file.slice(file.size - 2 * 1024 * 1024).arrayBuffer())
        : new Uint8Array(0);
      const hasAscii = (buf, word) => {
        const target = [...word].map(ch => ch.charCodeAt(0));
        for (let i = 0; i <= buf.length - target.length; i++) {
          if (target.every((code, j) => buf[i + j] === code)) return true;
        }
        return false;
      };
      if (hasAscii(head.subarray(0, 64), 'ftyp')) return hasAscii(head, 'soun') || hasAscii(tail, 'soun');
    } catch {}
    return true;
  }

  async function probeAndImportVideo(file) {
    const name = String(file.name || 'Untitled video');
    if (file.size > MAX_BROWSER_VIDEO_BYTES) {
      throw new Error(`${name}: keep videos under 512 MB in the browser studio (or run Frame locally for up to 8 GB).`);
    }
    const tempUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('TIMEOUT')), 20000);
        video.onloadeddata = () => { clearTimeout(timer); resolve(); };
        video.onloadedmetadata = () => { if (video.readyState >= 2) { clearTimeout(timer); resolve(); } };
        video.onerror = () => { clearTimeout(timer); reject(new Error('DECODE')); };
        video.src = tempUrl;
      });
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width || !height) throw new Error(`${name}: no video track was found in this file.`);
      const duration = Number(video.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error(`${name}: the video duration could not be detected. The file may be incomplete.`);
      }
      const seekTarget = Math.min(duration / 3, 1);
      if (seekTarget > 0.01) {
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 3000);
          video.onseeked = () => { clearTimeout(timer); resolve(); };
          try { video.currentTime = seekTarget; } catch { clearTimeout(timer); resolve(); }
        });
      }
      const thumbWidth = 480;
      const thumbHeight = Math.max(2, Math.round((thumbWidth * height / width) / 2) * 2);
      const canvas = document.createElement('canvas');
      canvas.width = thumbWidth;
      canvas.height = thumbHeight;
      canvas.getContext('2d').drawImage(video, 0, 0, thumbWidth, thumbHeight);
      const thumbnailDataUrl = canvas.toDataURL('image/jpeg', 0.82);
      const audio = await detectVideoHasAudio(video, file);
      const id = crypto.randomUUID().replace(/-/g, '');
      const item = { id, name, duration, width, height, fps: 30, audio, size: file.size };
      const record = { id, item, blob: file, thumbnailDataUrl };
      await putMediaRecord(record);
      return hydrateMedia(record);
    } catch (error) {
      if (error.message.startsWith(`${name}:`)) throw error;
      throw new Error(`${name}: this video could not be decoded in your browser. Try converting it to H.264 MP4.`);
    } finally {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(tempUrl);
    }
  }

  async function probeAndImportAudio(file) {
    const name = String(file.name || 'Untitled audio');
    if (file.size > MAX_BROWSER_AUDIO_BYTES) throw new Error(`${name}: keep audio files under 150 MB in the browser studio.`);
    const tempUrl = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('TIMEOUT')), 15000);
        audio.onloadedmetadata = () => { clearTimeout(timer); resolve(); };
        audio.onerror = () => { clearTimeout(timer); reject(new Error('INVALID')); };
        audio.src = tempUrl;
      });
      const duration = Number(audio.duration);
      if (!Number.isFinite(duration) || duration < 0.08) throw new Error('INVALID');
      const id = crypto.randomUUID().replace(/-/g, '');
      const item = { id, type: 'audio', name, duration, size: file.size };
      const record = { id, item, blob: file };
      await putMediaRecord(record);
      return hydrateMedia(record);
    } catch (error) {
      if (error.message.startsWith(`${name}:`)) throw error;
      throw new Error(`${name}: no readable audio was found.`);
    } finally {
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(tempUrl);
    }
  }

  function makeBlackThumbnailDataUrl() {
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 270;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 480, 270);
    return canvas.toDataURL('image/jpeg', 0.8);
  }

  async function synthesizeBlackVideoBlob() {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, 640, 360);
    const stream = canvas.captureStream(24);
    const mime = ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(type => global.MediaRecorder?.isTypeSupported?.(type)) || '';
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.start();
    await new Promise(resolve => setTimeout(resolve, 250));
    await new Promise(resolve => { recorder.onstop = resolve; recorder.stop(); });
    stream.getTracks().forEach(track => track.stop());
    return new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
  }

  async function ensureBlackScreenMedia() {
    const existing = await getMediaRecord(BLACK_MEDIA_ID);
    if (existing && existing.blob) return hydrateMedia(existing);
    if (!blackPromise) {
      blackPromise = (async () => {
        let blob;
        try {
          const res = await fetch('./assets/black-screen.mp4');
          if (res.ok && (res.headers.get('content-type') || '').includes('video')) blob = await res.blob();
          else if (res.ok) {
            const candidate = await res.blob();
            if (candidate.size > 500) blob = candidate;
          }
        } catch {}
        if (!blob) blob = await synthesizeBlackVideoBlob();
        const thumbnailDataUrl = makeBlackThumbnailDataUrl();
        const item = {
          id: BLACK_MEDIA_ID,
          name: 'Black screen',
          generated: 'black',
          duration: 60,
          width: 1280,
          height: 720,
          fps: 24,
          audio: false,
          size: blob.size
        };
        const record = { id: BLACK_MEDIA_ID, item, blob, thumbnailDataUrl };
        await putMediaRecord(record);
        return hydrateMedia(record);
      })();
    }
    try { return await blackPromise; } finally { blackPromise = null; }
  }

  async function epidemicRequest(endpoint, options = {}, overrideKey) {
    const config = await getConfig();
    const key = overrideKey ?? config.epidemic?.apiKey;
    if (!key) throw makeError('Connect an Epidemic Sound developer account first.', 409);
    let response;
    try {
      response = await fetch(`https://api.epidemicsound.com${endpoint}`, {
        ...options,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined
      });
    } catch {
      throw makeError('Epidemic Sound could not be reached from this browser. Check your connection (or run Frame locally if CORS is restricted).', 502);
    }
    if (!response.ok) {
      throw makeError(
        response.status === 429
          ? 'Epidemic Sound usage limit reached. Try later or check your plan.'
          : [401, 403].includes(response.status)
            ? 'Epidemic Sound denied access. Check your credentials and account permissions.'
            : 'Epidemic Sound could not complete this request.',
        502
      );
    }
    return response.status === 204 ? {} : response.json();
  }

  async function providerStatus() {
    const tracks = await loadStarterTracks();
    const config = await getConfig();
    const key = config.epidemic?.apiKey;
    const ref = config.epidemic?.licenseReference;
    return [
      { id: 'builtin', name: 'Free starter library', connected: true, canAdd: true, message: `${tracks.length} bundled tracks and sounds. Ready in your browser.` },
      {
        id: 'epidemic',
        name: 'Epidemic Sound',
        connected: !!key,
        canAdd: !!key && !!ref,
        message: !key
          ? 'Connect a developer account in this browser to search and preview.'
          : !ref
            ? 'Preview access. Adding and exporting require a production licensing agreement.'
            : 'Connected in this browser with a production license reference.'
      },
      {
        id: 'feed',
        name: 'Popular songs · Feed Clips',
        connected: false,
        canAdd: false,
        message: 'Partner onboarding required. The standard service is US-only, with clips up to 60 seconds. Local MP4 downloads need an agreement that explicitly permits this workflow.'
      }
    ];
  }

  async function connectEpidemic(body = {}) {
    const config = await getConfig();
    if (body.disconnect) {
      delete config.epidemic;
      epidemicLookup.clear();
    } else {
      const key = String(body.apiKey || '').trim();
      const reference = String(body.licenseReference || '').trim();
      if (!key || key.length > 500 || /\s/.test(key)) throw makeError('Enter a valid API key.');
      if (reference.length > 200) throw makeError('Keep the license reference below 200 characters.');
      await epidemicRequest('/v0/tracks?limit=1', {}, key);
      if (body.licensed === true && !reference) throw makeError('Enter the reference for your production licensing agreement.');
      config.epidemic = { apiKey: key, licenseReference: body.licensed === true ? reference : '' };
      epidemicLookup.clear();
    }
    await saveConfig(config);
    return providerStatus();
  }

  async function searchCatalog(query = {}) {
    const provider = query.provider || 'builtin';
    if (!['builtin', 'epidemic', 'feed'].includes(provider)) throw makeError('Unknown sound library.');
    const q = String(query.q || '').slice(0, 150).trim();
    const category = query.category || 'All';
    const offset = Math.max(0, Math.min(10000, Number(query.offset) || 0));
    if (provider === 'builtin') {
      const tracks = await loadStarterTracks();
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = tracks.filter(t =>
        (category === 'All' || t.category === category) &&
        words.every(word => `${t.title} ${t.artist} ${t.tags.join(' ')} ${t.category}`.toLowerCase().includes(word))
      );
      return { tracks: matches.map(t => ({ ...t, provider, previewUrl: `./audio-catalog/${t.file}`, canAdd: true })), nextOffset: null };
    }
    if (provider === 'feed') {
      const statuses = await providerStatus();
      return { tracks: [], nextOffset: null, message: statuses[2].message };
    }
    const config = await getConfig();
    const ref = config.epidemic?.licenseReference;
    const term = [q, category === 'All' ? '' : category].filter(Boolean).join(' ');
    const result = await epidemicRequest(`/v0/tracks/search?${new URLSearchParams({ term, limit: '20', offset: String(offset) })}`);
    const rows = result.tracks || [];
    const normalized = rows.map(t => ({
      id: t.id,
      provider,
      title: t.title,
      artist: (t.mainArtists || []).join(', '),
      duration: t.length,
      category: (t.moods || []).map(m => m.name).join(', '),
      kind: 'Music',
      license: 'Epidemic Sound agreement',
      licenseUrl: 'https://www.epidemicsound.com/tools/api/',
      attributionRequired: false,
      canAdd: !!ref && !t.isPreviewOnly
    }));
    for (const track of normalized) epidemicLookup.set(track.id, track);
    if (epidemicLookup.size > 500) {
      epidemicLookup.clear();
      for (const track of normalized) epidemicLookup.set(track.id, track);
    }
    return { tracks: normalized, nextOffset: rows.length === 20 ? offset + 20 : null };
  }

  async function reportEpidemic(type, ids) {
    const config = await getConfig();
    const analyticsEvent = type === 'tracksExported'
      ? { type, trackIds: ids, platform: 'WEB' }
      : { type, trackId: ids[0], ...(type === 'trackDownloaded' ? { format: 'mp3', quality: 'high' } : {}) };
    await epidemicRequest('/v0/analytics/report', {
      method: 'POST',
      body: JSON.stringify({ events: [{ userId: config.userId, timestamp: new Date().toISOString(), userConnected: false, analyticsEvent }] })
    });
  }

  async function getCatalogTrack(provider, id) {
    if (provider === 'builtin') {
      const tracks = await loadStarterTracks();
      const found = tracks.find(t => t.id === id);
      if (found) return found;
    } else if (provider === 'epidemic') {
      const found = epidemicLookup.get(id);
      if (found) return found;
    }
    throw makeError('Find this track in the library again before using it.', 404);
  }

  async function previewCatalogTrack(provider, id) {
    const track = await getCatalogTrack(provider, id);
    if (provider === 'builtin') return { url: `./audio-catalog/${track.file}`, hls: false };
    const data = await epidemicRequest(`/v0/tracks/${encodeURIComponent(id)}/stream`);
    await reportEpidemic('trackPreviewed', [id]);
    return { url: data.url, hls: true };
  }

  async function assertCatalogLicensed(mediaItems) {
    const config = await getConfig();
    const key = config.epidemic?.apiKey;
    const ref = config.epidemic?.licenseReference;
    for (const item of mediaItems) {
      if (item.catalog?.provider === 'epidemic' && (!key || !ref || item.catalog.licenseReference !== ref)) {
        throw makeError('Reconnect the production license used for this Epidemic Sound track before exporting.', 403);
      }
    }
  }

  async function addCatalogTrackToLibrary(provider, trackId) {
    const key = `${provider}:${trackId}`;
    const records = await getAllMediaRecords();
    const existing = records.find(r => r.item.catalog?.provider === provider && r.item.catalog?.trackId === trackId);
    if (existing) {
      await assertCatalogLicensed([existing.item]);
      return hydrateMedia(existing);
    }
    if (pendingCatalogAdds.has(key)) return pendingCatalogAdds.get(key);
    const task = (async () => {
      const track = await getCatalogTrack(provider, trackId);
      const config = await getConfig();
      let blob;
      if (provider === 'builtin') {
        const res = await fetch(`./audio-catalog/${track.file}`);
        if (!res.ok) throw makeError('Could not load this sound from the starter library.', 502);
        blob = await res.blob();
      } else {
        const ref = config.epidemic?.licenseReference;
        if (!ref || !track.canAdd) throw makeError('This track needs a production license before it can be added or exported.', 403);
        const link = await epidemicRequest(`/v0/tracks/${encodeURIComponent(trackId)}/download?format=mp3&quality=high`);
        const url = new URL(link.url);
        if (url.protocol !== 'https:' || !url.hostname.endsWith('.epidemicsound.com')) {
          throw makeError('The provider returned an unsupported download address.', 502);
        }
        const res = await fetch(url);
        if (!res.ok) throw makeError('Could not download this track. Try again.', 502);
        blob = await res.blob();
        if (blob.size > 100 * 1024 ** 2) throw makeError('This track exceeds the 100 MB library download limit.');
        await reportEpidemic('trackDownloaded', [trackId]);
      }
      const id = crypto.randomUUID();
      const catalogMeta = {
        provider,
        trackId,
        title: track.title,
        artist: track.artist,
        license: track.license,
        licenseUrl: track.licenseUrl,
        sourceUrl: track.sourceUrl || '',
        attributionRequired: track.attributionRequired,
        modifications: track.modifications || '',
        ...(provider === 'epidemic' ? { licenseReference: config.epidemic?.licenseReference } : {})
      };
      const item = { id, name: track.title, type: 'audio', duration: Number(track.duration), size: blob.size, catalog: catalogMeta };
      const record = { id, item, blob };
      await putMediaRecord(record);
      return hydrateMedia(record);
    })();
    pendingCatalogAdds.set(key, task);
    try { return await task; } finally { pendingCatalogAdds.delete(key); }
  }

  function buildCredits(clips) {
    const used = new Map();
    for (const clip of clips) {
      if (clip.media?.catalog) used.set(`${clip.media.catalog.provider}:${clip.media.catalog.trackId}`, clip.media.catalog);
    }
    return [...used.values()].map(t =>
      `${t.title} — ${t.artist}\n${t.sourceUrl}\nLicense: ${t.license}\n${t.licenseUrl}\n${t.modifications}\nUsed with video; may be trimmed and mixed with other audio.${t.attributionRequired ? '\nInclude this credit in your video description or credits.' : ''}`
    ).join('\n\n');
  }

  function checkedNumber(value, fallback, min, max) {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isFinite(n) || n < min || n > max) throw makeError(`Value must be between ${min} and ${max}.`, 400);
    return n;
  }

  function computeOverlap(clips, index, duration) {
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

  function computeDimensions(media, settings) {
    let ratio = media.width / media.height;
    if (settings.aspect !== 'source') {
      const [w, h] = settings.aspect.split(':').map(Number);
      ratio = w / h;
    }
    const shortEdge = settings.resolution === 'source' ? Math.min(media.width, media.height) : Number(settings.resolution);
    const even = v => Math.max(2, Math.round(v / 2) * 2);
    return ratio >= 1 ? [even(shortEdge * ratio), even(shortEdge)] : [even(shortEdge), even(shortEdge / ratio)];
  }

  async function validateBrowserProject(body) {
    if (!Array.isArray(body?.clips) || !body.clips.length || body.clips.length > 100) {
      throw makeError('Add between 1 and 100 clips to your timeline.');
    }
    const records = await getAllMediaRecords();
    const byId = new Map(records.map(r => [r.id, r]));
    const clips = body.clips.map(c => {
      const record = byId.get(c.mediaId);
      const media = record?.item;
      if (!record || !media || media.type === 'audio') throw makeError('A source video is missing. Import it again.');
      const start = checkedNumber(c.start, 0, 0, media.duration);
      const end = checkedNumber(c.end, media.duration, 0, media.duration);
      if (end - start < 0.08) throw makeError('Each clip must be at least 0.08 seconds long.');
      const crop = c.crop === undefined || c.crop === null ? global.FrameCrop.full(media) : c.crop;
      if (!global.FrameCrop.valid(crop, media)) throw makeError('The crop must stay within the source video and be at least 2 × 2 pixels.');
      return {
        record,
        media,
        crop,
        start,
        end,
        speed: checkedNumber(c.speed, 1, 0.5, 7),
        volume: checkedNumber(c.volume, 1, 0, 1),
        brightness: checkedNumber(c.brightness, 0, -0.5, 0.5),
        contrast: checkedNumber(c.contrast, 1, 0.5, 2),
        saturation: checkedNumber(c.saturation, 1, 0, 2),
        cutAfter: c.cutAfter === true,
        transitionAfter: c.transitionAfter === undefined ? undefined : checkedNumber(c.transitionAfter, 0.35, 0, 1.5)
      };
    });
    const settings = body.settings || {};
    const resolution = ['source', '720', '1080', '2160'].includes(settings.resolution) ? settings.resolution : 'source';
    const aspect = ['source', '16:9', '9:16', '1:1'].includes(settings.aspect) ? settings.aspect : 'source';
    const quality = ['18', '20', '23'].includes(String(settings.quality)) ? String(settings.quality) : '18';
    const fps = ['source', '24', '30', '60'].includes(String(settings.fps)) ? String(settings.fps) : 'source';
    const text = String(settings.text || '').slice(0, 120);
    const transitionDuration = checkedNumber(settings.transitionDuration, 0.35, 0, 1.5);
    if (body.music !== undefined && (!Array.isArray(body.music) || body.music.length > 20)) throw makeError('Use up to 20 music clips.');
    const music = (body.music || []).map(c => {
      const record = byId.get(c.mediaId);
      const media = record?.item;
      if (!record || !media || media.type !== 'audio') throw makeError('A music source is missing. Import it again.');
      const start = checkedNumber(c.start, 0, 0, media.duration);
      const end = checkedNumber(c.end, media.duration, 0, media.duration);
      if (end - start < 0.08) throw makeError('Each music clip must be at least 0.08 seconds long.');
      return { record, media, start, end, at: checkedNumber(c.at, 0, 0, 86400), volume: checkedNumber(c.volume, 0.5, 0, 1) };
    });
    if (body.textClips !== undefined && (!Array.isArray(body.textClips) || body.textClips.length > 20)) throw makeError('Use up to 20 text clips.');
    const textClips = (body.textClips || []).map(clip => {
      if (typeof clip.text !== 'string' || clip.text.length > 120) throw makeError('Each text clip must contain up to 120 characters.');
      return {
        text: clip.text,
        at: checkedNumber(clip.at, 0, 0, 86400),
        duration: checkedNumber(clip.duration, 3, 0.1, 3600),
        x: checkedNumber(clip.x, 0.5, 0, 1),
        y: checkedNumber(clip.y, 0.88, 0, 1),
        size: checkedNumber(clip.size, 0.045, 0.02, 0.15)
      };
    });
    await assertCatalogLicensed(music.map(c => c.media));
    return { clips, music, textClips, settings: { resolution, aspect, quality, fps, text, transitionDuration } };
  }

  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      const existing = [...document.scripts].find(s => s.src === new URL(src, global.location.href).href);
      if (existing && global.FFmpegWASM) return resolve();
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.append(script);
    });
  }

  async function toBlobUrl(url, mimeType) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not fetch ${url}`);
    return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: mimeType }));
  }

  async function ensureFFmpegClass() {
    if (global.FFmpegWASM?.FFmpeg) return ffmpegLoader;
    if (ffmpegLoader) return ffmpegLoader;
    ffmpegLoader = (async () => {
      try {
        const localCheck = await fetch('./vendor/ffmpeg/ffmpeg.js', { method: 'HEAD' });
        if (localCheck.ok && !(localCheck.headers.get('content-type') || '').includes('text/html')) {
          await loadScriptOnce('./vendor/ffmpeg/ffmpeg.js');
          const base = new URL('./vendor/ffmpeg/', global.location.href).href;
          return {
            FFmpeg: global.FFmpegWASM.FFmpeg,
            loadConfig: { coreURL: `${base}ffmpeg-core.js`, wasmURL: `${base}ffmpeg-core.wasm` }
          };
        }
      } catch {}
      await loadScriptOnce(`${FFMPEG_CDN}/ffmpeg.js`);
      const workerCode = await (await fetch(`${FFMPEG_CDN}/814.ffmpeg.js`)).text();
      const patchedWorker = workerCode.replace(/importScripts\(([^)]+)\)/g, (match) => match);
      const classWorkerURL = URL.createObjectURL(new Blob([`self.__webpack_public_path__ = "${FFMPEG_CDN}/";\n${patchedWorker}`], { type: 'text/javascript' }));
      const coreURL = await toBlobUrl(`${FFMPEG_CORE_CDN}/ffmpeg-core.js`, 'text/javascript');
      const wasmURL = await toBlobUrl(`${FFMPEG_CORE_CDN}/ffmpeg-core.wasm`, 'application/wasm');
      return { FFmpeg: global.FFmpegWASM.FFmpeg, loadConfig: { classWorkerURL, coreURL, wasmURL } };
    })().catch(error => {
      ffmpegLoader = null;
      throw error;
    });
    return ffmpegLoader;
  }

  async function renderTextOverlayPng(clip, frameW, frameH) {
    const sizeRatio = clip.size ?? 0.045;
    const sizePx = Math.max(12, Math.round(frameH * sizeRatio));
    const padPx = Math.max(4, Math.round(frameH * global.FrameTextLayout.boxPadding));
    const gapPx = Math.round(sizePx * global.FrameTextLayout.lineSpacing);
    const wrapped = global.FrameTextLayout.wrap(clip.text, frameW / frameH, sizeRatio);
    const lines = wrapped.split('\n');
    const measureCanvas = document.createElement('canvas');
    const measureCtx = measureCanvas.getContext('2d');
    measureCtx.font = `${sizePx}px Arial, sans-serif`;
    const maxLineW = Math.max(...lines.map(line => Math.ceil(measureCtx.measureText(line || ' ').width)), 4);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(4, Math.min(frameW, maxLineW + padPx * 2));
    canvas.height = Math.max(4, lines.length * sizePx + Math.max(0, lines.length - 1) * gapPx + padPx * 2);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = `${sizePx}px Arial, sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    lines.forEach((line, index) => {
      ctx.fillText(line, canvas.width / 2, padPx + index * (sizePx + gapPx));
    });
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }

  function extForBlob(record, fallback) {
    const nameExt = (record.item?.name || '').match(/\.[a-z0-9]{2,5}$/i)?.[0];
    if (nameExt) return nameExt.toLowerCase();
    const mime = record.blob?.type || '';
    if (mime.includes('webm')) return '.webm';
    if (mime.includes('quicktime')) return '.mov';
    if (mime.includes('wav')) return '.wav';
    if (mime.includes('mpeg')) return '.mp3';
    if (mime.includes('ogg')) return '.ogg';
    if (mime.includes('flac')) return '.flac';
    return fallback;
  }

  async function renderBrowserExport(job, project) {
    if (typeof global.__FrameBrowserRenderOverride === 'function') {
      return global.__FrameBrowserRenderOverride(job, project, { buildCredits, reportEpidemic });
    }
    const { clips, music, textClips, settings } = project;
    const canvasClip = clips.find(c => c.media.generated !== 'black') || clips[0];
    const [w, h] = computeDimensions(canvasClip.crop, settings);
    const fps = settings.fps === 'source' ? Math.min(60, Math.max(1, canvasClip.media.fps || 30)) : Number(settings.fps);
    const total = clips.reduce((sum, c, idx) => sum + (c.end - c.start) / c.speed - computeOverlap(clips, idx, settings.transitionDuration), 0);
    const clipTotal = clips.reduce((sum, c) => sum + (c.end - c.start) / c.speed, 0);
    const timedText = [...textClips, ...(settings.text ? [{ text: settings.text, at: 0, duration: total }] : [])].filter(c => c.text && c.at < total);
    const audible = music.filter(c => c.at < total && c.volume > 0);
    const hasTransitions = clips.length > 1 && clips.some((_, idx) => computeOverlap(clips, idx, settings.transitionDuration) > 0);
    const hasText = timedText.length > 0;
    const hasMusic = audible.length > 0;
    const needsVideoPass2 = hasTransitions || hasText;
    const singlePassDirect = clips.length === 1 && !needsVideoPass2 && !hasMusic;
    const step1Budget = needsVideoPass2 ? 45 : 95;

    let ffmpeg;
    let activeStage = { duration: 1, startPct: 0, spanPct: 0 };
    try {
      job.message = 'Loading browser video engine (cached after first use)…';
      const engine = await ensureFFmpegClass();
      if (job.status === 'cancelled') return;
      ffmpeg = new engine.FFmpeg();
      job.ffmpeg = ffmpeg;
      ffmpeg.on('progress', ({ time }) => {
        const seconds = Number(time) / 1000000;
        if (Number.isFinite(seconds) && activeStage.spanPct > 0 && activeStage.duration > 0) {
          const ratio = Math.min(1, Math.max(0, seconds / activeStage.duration));
          job.progress = Math.min(98, Math.max(job.progress, Math.round(activeStage.startPct + ratio * activeStage.spanPct)));
        }
      });
      await ffmpeg.load(engine.loadConfig);
      if (job.status === 'cancelled') return;

      const execStage = async (args, duration, startPct = 0, spanPct = 0) => {
        if (job.status === 'cancelled') throw new Error('Export cancelled');
        activeStage = { duration, startPct, spanPct };
        const code = await ffmpeg.exec(['-hide_banner', '-y', ...args]);
        if (job.status === 'cancelled') throw new Error('Export cancelled');
        if (code !== 0) throw new Error('FFmpeg browser render failed');
      };

      const writtenSources = new Map();
      const ensureInputFile = async (record, prefix, fallbackExt) => {
        if (writtenSources.has(record.id)) return writtenSources.get(record.id);
        const filename = `${prefix}-${writtenSources.size}${extForBlob(record, fallbackExt)}`;
        await ffmpeg.writeFile(filename, new Uint8Array(await record.blob.arrayBuffer()));
        writtenSources.set(record.id, filename);
        return filename;
      };

      let completed = 0;
      for (let i = 0; i < clips.length; i++) {
        const c = clips[i];
        const duration = (c.end - c.start) / c.speed;
        job.message = `Rendering clip ${i + 1} of ${clips.length}`;
        const args = [];
        if (c.media.generated === 'black') {
          args.push('-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}:r=${fps}:d=${duration}`);
          args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
          const clipTarget = singlePassDirect ? 'out.mp4' : `clip-${i}.mp4`;
          const vCodec = needsVideoPass2 ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '14'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', settings.quality];
          const blackVf = `eq=brightness=${c.brightness}:contrast=${c.contrast}:saturation=${c.saturation},format=yuv420p`;
          args.push('-map', '0:v:0', '-map', '1:a:0', '-vf', blackVf, '-af', 'aresample=48000,aformat=channel_layouts=stereo,apad', '-t', String(duration), ...vCodec, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-video_track_timescale', '90000', ...(singlePassDirect ? ['-movflags', '+faststart'] : []), clipTarget);
          await execStage(args, duration, clipTotal > 0 ? step1Budget * (completed / clipTotal) : 0, clipTotal > 0 ? step1Budget * (duration / clipTotal) : step1Budget);
        } else {
          const inputName = await ensureInputFile(c.record, 'src', '.mp4');
          args.push('-ss', String(c.start), '-t', String(c.end - c.start), '-i', inputName);
          if (!c.media.audio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
          const vf = `setpts=(PTS-STARTPTS)/${c.speed},crop=${c.crop.width}:${c.crop.height}:${c.crop.x}:${c.crop.y}:exact=1,scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,eq=brightness=${c.brightness}:contrast=${c.contrast}:saturation=${c.saturation},fps=${fps},format=yuv420p`;
          let tempo = c.speed;
          const tempoFilters = [];
          while (tempo > 2) { tempoFilters.push('atempo=2'); tempo /= 2; }
          tempoFilters.push(`atempo=${tempo}`);
          const af = `asetpts=PTS-STARTPTS,${tempoFilters.join(',')},volume=${c.volume},aresample=48000,aformat=channel_layouts=stereo,apad`;
          const vCodec = needsVideoPass2 ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '14'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', settings.quality];
          const clipTarget = singlePassDirect ? 'out.mp4' : `clip-${i}.mp4`;
          args.push('-map', '0:v:0', '-map', c.media.audio ? '0:a:0' : '1:a:0', '-vf', vf, '-af', af, '-t', String(duration), ...vCodec, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-video_track_timescale', '90000', ...(singlePassDirect ? ['-movflags', '+faststart'] : []), clipTarget);
          await execStage(args, duration, clipTotal > 0 ? step1Budget * (completed / clipTotal) : 0, clipTotal > 0 ? step1Budget * (duration / clipTotal) : step1Budget);
        }
        completed += duration;
      }

      for (const filename of writtenSources.values()) {
        await ffmpeg.deleteFile(filename).catch(() => {});
      }
      writtenSources.clear();

      if (!singlePassDirect) {
        let stage2Out;
        if (hasTransitions) {
          job.message = hasText ? 'Joining clips and adding timed text' : 'Finishing your MP4';
          const args = clips.flatMap((_, idx) => ['-i', `clip-${idx}.mp4`]);
          const filters = clips.map((_, idx) => `[${idx}:v]setpts=PTS-STARTPTS,fps=${fps}[base${idx}]`);
          let elapsed = (clips[0].end - clips[0].start) / clips[0].speed;
          for (let idx = 1; idx < clips.length; idx++) {
            const dur = computeOverlap(clips, idx - 1, settings.transitionDuration);
            const off = Math.max(0, elapsed - dur);
            const v = idx === 1 ? 'base0' : `v${idx - 1}`;
            const a = idx === 1 ? '0:a' : `a${idx - 1}`;
            if (dur) {
              filters.push(`[${v}][base${idx}]xfade=transition=fade:duration=${dur}:offset=${off}[v${idx}]`);
              filters.push(`[${a}][${idx}:a]acrossfade=d=${dur}:c1=tri:c2=tri[a${idx}]`);
            } else {
              filters.push(`[${v}][base${idx}]concat=n=2:v=1:a=0,fps=${fps}[v${idx}]`);
              filters.push(`[${a}][${idx}:a]concat=n=2:v=0:a=1[a${idx}]`);
            }
            elapsed += (clips[idx].end - clips[idx].start) / clips[idx].speed - dur;
          }
          let finalV = `v${clips.length - 1}`;
          if (hasText) {
            for (let tIdx = 0; tIdx < timedText.length; tIdx++) {
              const tClip = timedText[tIdx];
              const pngBytes = await renderTextOverlayPng(tClip, w, h);
              await ffmpeg.writeFile(`text-${tIdx}.png`, pngBytes);
              args.push('-i', `text-${tIdx}.png`);
              const imgIdx = clips.length + tIdx;
              const end = Math.min(total, tClip.at + tClip.duration);
              const x = tClip.x ?? 0.5, y = tClip.y ?? 0.88;
              filters.push(`[${finalV}][${imgIdx}:v]overlay=x=W*${x}-w/2:y=H*${y}-h/2:enable='between(t,${tClip.at},${end})':format=auto[t${tIdx}]`);
              finalV = `t${tIdx}`;
            }
            filters.push(`[${finalV}]format=yuv420p[vout]`);
            finalV = 'vout';
          }
          stage2Out = hasMusic ? 'stage2.mp4' : 'out.mp4';
          args.push('-filter_complex', filters.join(';'), '-map', `[${finalV}]`, '-map', `[a${clips.length - 1}]`, '-t', String(total), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', settings.quality, '-c:a', 'aac', '-b:a', '192k', '-video_track_timescale', '90000', ...(hasMusic ? [] : ['-movflags', '+faststart']), stage2Out);
          await execStage(args, total, step1Budget, 95 - step1Budget);
        } else {
          let concatOut = 'clip-0.mp4';
          if (clips.length > 1) {
            job.message = 'Finishing your MP4';
            const listContent = clips.map((_, idx) => `file 'clip-${idx}.mp4'`).join('\n');
            await ffmpeg.writeFile('clips.txt', new TextEncoder().encode(listContent));
            concatOut = (!hasText && !hasMusic) ? 'out.mp4' : 'joined.mp4';
            await execStage(['-f', 'concat', '-safe', '0', '-i', 'clips.txt', '-c', 'copy', ...((!hasText && !hasMusic) ? ['-movflags', '+faststart'] : []), concatOut], total);
          }
          stage2Out = concatOut;
          if (hasText) {
            job.message = 'Adding timed text';
            const args = ['-i', concatOut];
            const filters = [];
            let prevV = '0:v';
            for (let tIdx = 0; tIdx < timedText.length; tIdx++) {
              const tClip = timedText[tIdx];
              const pngBytes = await renderTextOverlayPng(tClip, w, h);
              await ffmpeg.writeFile(`text-${tIdx}.png`, pngBytes);
              args.push('-i', `text-${tIdx}.png`);
              const end = Math.min(total, tClip.at + tClip.duration);
              const x = tClip.x ?? 0.5, y = tClip.y ?? 0.88;
              filters.push(`[${prevV}][${tIdx + 1}:v]overlay=x=W*${x}-w/2:y=H*${y}-h/2:enable='between(t,${tClip.at},${end})':format=auto[t${tIdx}]`);
              prevV = `t${tIdx}`;
            }
            filters.push(`[${prevV}]format=yuv420p[vout]`);
            stage2Out = hasMusic ? 'stage2.mp4' : 'out.mp4';
            args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '0:a:0', '-t', String(total), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', settings.quality, '-c:a', 'copy', '-video_track_timescale', '90000', ...(hasMusic ? [] : ['-movflags', '+faststart']), stage2Out);
            await execStage(args, total, step1Budget, 95 - step1Budget);
          }
        }

        for (let i = 0; i < clips.length; i++) {
          if (`clip-${i}.mp4` !== stage2Out) await ffmpeg.deleteFile(`clip-${i}.mp4`).catch(() => {});
        }

        if (hasMusic) {
          job.message = 'Mixing music and original sound';
          job.progress = Math.max(job.progress, 96);
          const args = ['-i', stage2Out];
          const filters = ['[0:a]aresample=48000,aformat=channel_layouts=stereo,apad[original]'];
          for (let idx = 0; idx < audible.length; idx++) {
            const c = audible[idx];
            const audioFile = await ensureInputFile(c.record, 'aud', '.m4a');
            args.push('-ss', String(c.start), '-t', String(Math.min(c.end - c.start, total - c.at)), '-i', audioFile);
            filters.push(`[${idx + 1}:a:0]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${c.volume},adelay=${Math.round(c.at * 48000)}S:all=1[m${idx}]`);
          }
          filters.push(`[original]${audible.map((_, i) => `[m${i}]`).join('')}amix=inputs=${audible.length + 1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=0:latency=1[mix]`);
          args.push('-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[mix]', '-t', String(total), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', 'out.mp4');
          await execStage(args, total, 96, 2);
        }
      }

      if (job.status !== 'cancelled') {
        const outputData = await ffmpeg.readFile('out.mp4');
        const mp4Blob = new Blob([outputData.slice().buffer], { type: 'video/mp4' });
        job.downloadUrl = URL.createObjectURL(mp4Blob);
        const epidemicIds = [...new Set(audible.filter(c => c.media.catalog?.provider === 'epidemic').map(c => c.media.catalog.trackId))];
        if (epidemicIds.length) await reportEpidemic('tracksExported', epidemicIds).catch(() => {});
        job.credits = buildCredits(audible);
        if (job.credits) {
          job.creditsUrl = URL.createObjectURL(new Blob([job.credits], { type: 'text/plain;charset=utf-8' }));
        }
        job.status = 'complete';
        job.progress = 100;
        job.message = 'Your video is ready';
      }
    } catch (error) {
      if (job.status !== 'cancelled') {
        job.status = 'error';
        job.message = error.status ? error.message : 'Browser export failed. Try 720p resolution or smaller source clips.';
        console.error(error);
      }
    } finally {
      job.ffmpeg = null;
      try { ffmpeg?.terminate(); } catch {}
    }
  }

  async function cleanupBrowserStorage(body = {}) {
    if ([...jobs.values()].some(j => j.status === 'rendering') || pendingCatalogAdds.size > 0 || blackPromise) {
      throw makeError('Wait for current imports or exports to finish before cleaning up storage.', 409);
    }
    if (!Array.isArray(body?.keepMediaIds) || body.keepMediaIds.some(id => typeof id !== 'string')) {
      throw makeError('Provide the list of active project media IDs.', 400);
    }
    const keepMedia = new Set(body.keepMediaIds);
    const keepExportId = typeof body.keepExportId === 'string' ? body.keepExportId : '';
    const records = await getAllMediaRecords();
    let removedMedia = 0, removedExports = 0, freedBytes = 0;
    for (const record of records) {
      if (!keepMedia.has(record.id)) {
        removedMedia++;
        freedBytes += record.blob?.size || record.item?.size || 0;
        await deleteMediaRecord(record.id);
      }
    }
    if (body.cleanExports !== false) {
      for (const [id, job] of jobs) {
        if (id === keepExportId) continue;
        if (job.downloadUrl) { URL.revokeObjectURL(job.downloadUrl); removedExports++; }
        if (job.creditsUrl) URL.revokeObjectURL(job.creditsUrl);
        jobs.delete(id);
      }
    }
    return { removedMedia, removedExports, freedBytes };
  }

  function parseJsonBody(options) {
    if (!options?.body) return {};
    if (typeof options.body === 'string') return JSON.parse(options.body);
    return options.body;
  }

  async function handleBrowserRequest(rawUrl, options = {}) {
    const parsed = new URL(rawUrl, 'http://frame.local');
    const pathname = parsed.pathname;
    const method = (options.method || 'GET').toUpperCase();

    if (method === 'GET' && pathname === '/api/capabilities') {
      return { timedTextExport: true, browserMode: true };
    }
    if (method === 'GET' && pathname === '/api/library') {
      const records = await getAllMediaRecords();
      return records.map(hydrateMedia);
    }
    if (method === 'POST' && pathname === '/api/media/black') {
      return ensureBlackScreenMedia();
    }
    if (method === 'POST' && pathname === '/api/import') {
      const files = options.body instanceof FormData ? options.body.getAll('videos') : [];
      const imported = [], errors = [];
      for (const file of files.slice(0, 20)) {
        try { imported.push(await probeAndImportVideo(file)); }
        catch (error) { errors.push(error.message); }
      }
      return { imported, errors };
    }
    if (method === 'POST' && pathname === '/api/audio/import') {
      const files = options.body instanceof FormData ? options.body.getAll('audio') : [];
      const imported = [], errors = [];
      for (const file of files.slice(0, 20)) {
        try { imported.push(await probeAndImportAudio(file)); }
        catch (error) { errors.push(error.message); }
      }
      return { imported, errors };
    }
    if (method === 'GET' && pathname === '/api/audio/providers') {
      return providerStatus();
    }
    if (method === 'POST' && pathname === '/api/audio/providers/epidemic') {
      return connectEpidemic(parseJsonBody(options));
    }
    if (method === 'GET' && pathname === '/api/audio/catalog') {
      return searchCatalog(Object.fromEntries(parsed.searchParams.entries()));
    }
    if (method === 'POST' && pathname === '/api/audio/catalog/preview') {
      const body = parseJsonBody(options);
      return previewCatalogTrack(body.provider, body.id);
    }
    if (method === 'POST' && pathname === '/api/audio/catalog/add') {
      const body = parseJsonBody(options);
      return addCatalogTrackToLibrary(body.provider, body.id);
    }
    if (method === 'POST' && pathname === '/api/storage/cleanup') {
      return cleanupBrowserStorage(parseJsonBody(options));
    }
    if (method === 'POST' && pathname === '/api/exports') {
      if ([...jobs.values()].some(j => j.status === 'rendering')) {
        throw makeError('An export is already running. Wait for it to finish or cancel it.', 409);
      }
      const validated = await validateBrowserProject(parseJsonBody(options));
      const job = { id: crypto.randomUUID(), status: 'rendering', progress: 0, message: 'Preparing your video' };
      jobs.set(job.id, job);
      renderBrowserExport(job, validated);
      return { id: job.id };
    }
    const exportMatch = pathname.match(/^\/api\/exports\/([^/]+)$/);
    if (exportMatch) {
      const job = jobs.get(exportMatch[1]);
      if (method === 'GET') {
        if (!job) throw makeError('Export not found. Start a new export to download your MP4.', 404);
        const { ffmpeg, downloadUrl, creditsUrl, ...publicStatus } = job;
        return publicStatus;
      }
      if (method === 'DELETE') {
        if (job?.status === 'rendering') {
          job.status = 'cancelled';
          job.message = 'Export cancelled';
          try { job.ffmpeg?.terminate(); } catch {}
        }
        return { ok: true };
      }
    }
    throw makeError(`Unsupported browser endpoint: ${method} ${pathname}`, 404);
  }

  async function request(url, options) {
    const activeMode = await ensureMode();
    if (activeMode === 'browser') return handleBrowserRequest(url, options);
    const relativeUrl = url.startsWith('/') ? `.${url}` : url;
    const response = await fetch(relativeUrl, options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Something went wrong. Please try again.');
    return result;
  }

  function isBrowserMode() {
    return mode === 'browser';
  }

  function downloadUrl(exportId, requestedName) {
    if (mode === 'browser') {
      const job = jobs.get(exportId);
      if (!job?.downloadUrl) throw new Error('The MP4 is no longer in browser memory. Export again to save another copy.');
      return job.downloadUrl;
    }
    const base = `./api/exports/${exportId}/download`;
    return requestedName ? `${base}?name=${encodeURIComponent(requestedName)}` : base;
  }

  function creditsUrl(exportId) {
    if (mode === 'browser') return jobs.get(exportId)?.creditsUrl || '';
    return `./api/exports/${exportId}/credits`;
  }

  global.FrameBackend = { ensureMode, isBrowserMode, request, downloadUrl, creditsUrl, renderTextOverlayPng };
})(typeof globalThis !== 'undefined' ? globalThis : window);
