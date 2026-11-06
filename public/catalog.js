let catalogRequest = 0, catalogPreviewRequest = 0, catalogHls = null, catalogNext = null;
let catalogTracks = [], catalogProviders = [], catalogSearchTimer;
function setAudioView(view) {
  $('catalog-panel').hidden = view !== 'discover'; $('project-audio-panel').hidden = view !== 'project';
  document.querySelectorAll('[data-audio-view]').forEach(button => { const active = button.dataset.audioView === view; button.classList.toggle('active', active); button.setAttribute('aria-pressed', active); });
  if (view !== 'discover') stopCatalogPreview();
}
function stopCatalogPreview() {
  catalogPreviewRequest++;
  const player = $('catalog-preview'); if (player) { player.pause(); player.removeAttribute('src'); player.load(); }
  catalogHls?.destroy(); catalogHls = null;
  if ($('catalog-preview-title')) $('catalog-preview-title').textContent = 'Choose a track to preview';
  document.querySelectorAll('[data-preview-track]').forEach(button => { button.textContent = 'Preview'; });
}
async function previewCatalog(track, button) {
  stop(); const request = ++catalogPreviewRequest;
  $('catalog-preview-title').textContent = `Loading ${track.title}…`;
  try {
    const data = await api('/api/audio/catalog/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: track.provider, id: track.id }) });
    if (request !== catalogPreviewRequest) return;
    const audio = $('catalog-preview');
    $('catalog-preview-title').textContent = `${track.title} · ${track.artist}`;
    if (data.hls && !audio.canPlayType('application/vnd.apple.mpegurl')) {
      if (!window.Hls?.isSupported()) throw new Error('This browser cannot preview this streaming format.');
      catalogHls = new Hls(); catalogHls.loadSource(data.url); catalogHls.attachMedia(audio);
      catalogHls.on(Hls.Events.MANIFEST_PARSED, () => { if (request === catalogPreviewRequest) audio.play().catch(() => toast('Press Play in the preview player to listen.')); });
      catalogHls.on(Hls.Events.ERROR, (_, event) => { if (event.fatal && request === catalogPreviewRequest) { stopCatalogPreview(); toast('The preview stream could not be played. Please try again.'); } });
    } else { audio.src = data.url; await audio.play(); }
    if (request === catalogPreviewRequest) button.textContent = 'Playing';
  } catch (error) { if (request === catalogPreviewRequest) { stopCatalogPreview(); toast(error.message); } }
}
async function addCatalogTrack(track, button) {
  if (importing) return toast('Wait for the current import to finish.');
  if (project.music.length >= 20) return toast('The project holds up to 20 music clips.');
  stop(); importing = true; button.disabled = true; button.textContent = 'Adding…';
  try {
    const media = await api('/api/audio/catalog/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: track.provider, id: track.id }) });
    remember();
    if (!allMedia.some(item => item.id === media.id)) allMedia.push(media);
    project.mediaIds = [...new Set([...project.mediaIds, media.id])];
    const clip = makeMusic(media, Number($('scrubber').value)); project.music.push(clip);
    refreshProjectLibrary(); selectMusic(clip.id); save();
    toast(`${track.title} added at the playhead.${track.attributionRequired ? ' Include the supplied music credit when sharing your video.' : ''}`);
  } catch (error) { toast(error.message); }
  finally { importing = false; button.disabled = !track.canAdd; button.textContent = '+ Add'; }
}
function renderCatalogTracks() {
  $('catalog-results').replaceChildren();
  for (const track of catalogTracks) {
    const card = document.createElement('article'); card.className = 'catalog-card'; card.dataset.trackId = track.id;
    const title = document.createElement('strong'); title.textContent = track.title;
    const artist = document.createElement('span'); artist.textContent = `${track.artist} · ${time(track.duration)} · ${track.kind}`;
    const category = document.createElement('small'); category.textContent = track.category;
    const license = document.createElement('a'); license.href = track.licenseUrl; license.target = '_blank'; license.rel = 'noopener noreferrer'; license.textContent = `${track.license}${track.attributionRequired ? ' · Credit required' : ''}`;
    const actions = document.createElement('div'); actions.className = 'catalog-actions';
    const preview = document.createElement('button'); preview.className = 'mini'; preview.textContent = 'Preview'; preview.dataset.previewTrack = track.id; preview.setAttribute('aria-label', `Preview ${track.title}`); preview.onclick = () => previewCatalog(track, preview);
    const add = document.createElement('button'); add.className = 'mini'; add.textContent = '+ Add'; add.disabled = !track.canAdd; add.setAttribute('aria-label', `Add ${track.title} from library`); add.onclick = () => addCatalogTrack(track, add);
    if (!track.canAdd) add.title = 'A production license and track download access are required.';
    actions.append(preview, add); card.append(title, artist, category, license, actions); $('catalog-results').append(card);
  }
  $('catalog-more').hidden = catalogNext === null;
}
async function loadCatalog(append = false) {
  const request = ++catalogRequest; stopCatalogPreview();
  const provider = $('catalog-provider').value, state = catalogProviders.find(item => item.id === provider);
  if (!append) { catalogTracks = []; catalogNext = null; renderCatalogTracks(); }
  $('catalog-status').textContent = 'Loading sounds…'; $('catalog-more').disabled = true;
  $('catalog-connect').hidden = provider === 'builtin';
  if (provider === 'feed' || (provider === 'epidemic' && !state?.connected)) { $('catalog-status').textContent = state?.message || 'Connect a provider account to browse this catalog.'; return; }
  try {
    const params = new URLSearchParams({ provider, q: $('catalog-search').value, category: $('catalog-category').value, offset: String(append ? catalogNext || 0 : 0) });
    const result = await api(`/api/audio/catalog?${params}`);
    if (request !== catalogRequest) return;
    catalogTracks = append ? [...catalogTracks, ...result.tracks] : result.tracks; catalogNext = result.nextOffset;
    renderCatalogTracks();
    $('catalog-status').textContent = result.message || (catalogTracks.length ? `${catalogTracks.length} sounds${provider === 'builtin' ? ' · Ready offline' : state?.canAdd ? '' : ' · Preview only until licensed'}` : 'No matching sounds. Try another search or category.');
  } catch (error) { if (request === catalogRequest) $('catalog-status').textContent = error.message; }
  finally { if (request === catalogRequest) $('catalog-more').disabled = false; }
}
async function loadCatalogProviders() {
  try { catalogProviders = await api('/api/audio/providers'); await loadCatalog(); }
  catch (error) { $('catalog-status').textContent = error.message; }
}
function showConnections() {
  stopCatalogPreview(); $('provider-result').textContent = '';
  const state = catalogProviders.find(p => p.id === 'epidemic');
  $('provider-current-status').textContent = state?.message || 'Not connected';
  $('provider-disconnect').hidden = !state?.connected;
  $('provider-key').value = ''; $('provider-reference').value = ''; $('provider-licensed').checked = false;
  $('provider-reference-label').hidden = true;
  $('audio-connections').showModal();
}
function setupCatalog() {
  document.querySelectorAll('[data-audio-view]').forEach(button => button.onclick = () => setAudioView(button.dataset.audioView));
  $('catalog-provider').onchange = () => { clearTimeout(catalogSearchTimer); loadCatalog(); };
  $('catalog-category').onchange = () => { clearTimeout(catalogSearchTimer); loadCatalog(); };
  $('catalog-search').oninput = () => { clearTimeout(catalogSearchTimer); catalogSearchTimer = setTimeout(() => loadCatalog(), 250); };
  $('catalog-more').onclick = () => loadCatalog(true);
  $('catalog-connect').onclick = showConnections; $('audio-provider-settings').onclick = showConnections;
  $('close-audio-connections').onclick = () => $('audio-connections').close();
  $('audio-connections').addEventListener('close', () => { $('provider-key').value = ''; });
  $('provider-licensed').onchange = event => { $('provider-reference-label').hidden = !event.target.checked; };
  async function saveConnection(disconnect = false) {
    $('provider-save').disabled = true; $('provider-disconnect').disabled = true; $('provider-result').textContent = disconnect ? 'Disconnecting…' : 'Checking the connection…';
    try {
      catalogProviders = await api('/api/audio/providers/epidemic', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ disconnect, apiKey: $('provider-key').value, licensed: $('provider-licensed').checked, licenseReference: $('provider-reference').value }) });
      $('provider-key').value = ''; $('provider-current-status').textContent = catalogProviders.find(p => p.id === 'epidemic').message;
      $('provider-disconnect').hidden = disconnect; $('provider-result').textContent = disconnect ? 'Disconnected.' : 'Connection verified and saved on this computer.';
      loadCatalog();
    } catch (error) { $('provider-result').textContent = error.message; }
    finally { $('provider-save').disabled = false; $('provider-disconnect').disabled = false; }
  }
  $('provider-save').onclick = () => saveConnection(); $('provider-disconnect').onclick = () => saveConnection(true);
  $('catalog-preview').onerror = () => { if ($('catalog-preview').getAttribute('src')) toast('Could not play this preview. Please try again.'); };
  $('catalog-preview').onplay = () => { if (playing) { playing = false; video.pause(); pauseMusic(); $('play').textContent = '▶'; $('play').setAttribute('aria-label', 'Play timeline'); } };
  video.addEventListener('play', stopCatalogPreview);
  document.querySelector('[data-workspace="audio"]').addEventListener('click', () => { if (!catalogProviders.length) loadCatalogProviders(); });
  document.querySelectorAll('[data-workspace]').forEach(button => button.addEventListener('click', () => { if (button.dataset.workspace !== 'audio') stopCatalogPreview(); }));
  $('timeline-music').onclick = () => { document.querySelector('[data-workspace="audio"]').click(); setAudioView('discover'); };
  loadCatalogProviders();
}
