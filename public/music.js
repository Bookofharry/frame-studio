let musicLibrary = [], selectedMusicId = '', musicDrag = null;
const musicPlayers = new Map();
const selectedMusic = () => project.music?.find(clip => clip.id === selectedMusicId);
const musicSource = clip => musicLibrary.find(media => media.id === clip?.mediaId);

function validateMusic(clips) {
  if (!Array.isArray(clips) || clips.length > 20) throw new Error('Use up to 20 music clips.');
  const ids = new Set();
  for (const clip of clips) {
    const source = allMedia.find(media => media.id === clip?.mediaId && media.type === 'audio');
    if (!source) throw new Error('This project needs music that is missing from this computer.');
    if (typeof clip.id !== 'string' || ids.has(clip.id) || !['start', 'end', 'at', 'volume'].every(key => Number.isFinite(clip[key])) || clip.start < 0 || clip.end > source.duration || clip.end - clip.start < 0.08 || clip.at < 0 || clip.at > 86400 || clip.volume < 0 || clip.volume > 1) throw new Error('This project contains invalid music settings.');
    ids.add(clip.id);
  }
}
function pauseMusic() { for (const player of musicPlayers.values()) player.pause(); }
function syncMusic(position) {
  const ids = new Set((project.music || []).map(clip => clip.id));
  for (const [id, player] of musicPlayers) {
    if (!ids.has(id)) { player.pause(); player.removeAttribute('src'); player.load(); player.remove(); musicPlayers.delete(id); }
  }
  for (const clip of project.music || []) {
    const source = musicSource(clip); if (!source) continue;
    let player = musicPlayers.get(clip.id);
    if (!player) {
      player = document.createElement('audio'); player.preload = 'auto'; player.src = source.url; player.dataset.musicId = clip.id;
      player.onerror = () => { if (!player.dataset.warned) { player.dataset.warned = 'true'; toast(`Could not preview ${source.name}. Try importing it again.`); } };
      player.onloadedmetadata = () => syncMusic(Number($('scrubber').value));
      $('music-players').append(player); musicPlayers.set(clip.id, player);
    }
    player.volume = clip.volume;
    const relative = position - clip.at;
    const active = playing && !video.paused && !video.seeking && video.readyState >= 3 && position < total() && relative >= 0 && relative < clip.end - clip.start;
    if (!active || player.readyState < 1) { player.pause(); continue; }
    const target = clip.start + relative;
    if (player.readyState >= 1 && Math.abs(player.currentTime - target) > 0.12) player.currentTime = target;
    if (player.paused && !player.dataset.pending) {
      player.dataset.pending = 'true';
      player.play().catch(error => {
        if (error.name !== 'AbortError' && !player.dataset.warned) { player.dataset.warned = 'true'; toast('Music preview could not start. Press Play again or re-import the audio.'); }
      }).finally(() => { delete player.dataset.pending; });
    }
  }
}
function renderMusicLibrary() {
  $('music-count').textContent = musicLibrary.length;
  $('music-library').replaceChildren();
  for (const media of musicLibrary) {
    const card = document.createElement('article'); card.className = 'music-card';
    const name = document.createElement('strong'); name.textContent = media.name; name.title = media.name;
    const details = document.createElement('small');
    const uses = (project.music || []).filter(clip => clip.mediaId === media.id);
    details.textContent = `${time(media.duration)} original${uses.length ? ` · ${uses.length} on timeline` : ''}`;
    const add = document.createElement('button'); add.className = 'mini'; add.textContent = '+ Add at playhead'; add.setAttribute('aria-label', `Add music ${media.name}`);
    add.onclick = () => addMusic(media);
    if (media.catalog) { const license = document.createElement('small'); license.textContent = media.catalog.license + (media.catalog.attributionRequired ? ' - Credit required' : ''); card.append(name, details, license, add); } else card.append(name, details, add); $('music-library').append(card);
  }
  $('music-empty').hidden = musicLibrary.length > 0;
}
function makeMusic(media, at) { return { id: crypto.randomUUID(), mediaId: media.id, start: 0, end: media.duration, at, volume: 0.5 }; }
function addMusic(media) {
  if (project.music.length >= 20) return toast('The project holds up to 20 music clips.');
  stop(); remember(); const clip = makeMusic(media, Number($('scrubber').value)); project.music.push(clip);
  selectMusic(clip.id); save();
}
async function importMusic(files) {
  if (!files.length) return;
  if (importing) return toast('Wait for the current import to finish.');
  if (files.length > 20) return toast('Import up to 20 audio files at a time.');
  stop(); setAudioView('project'); importing = true; $('import-music').disabled = true; $('music-import-status').textContent = 'Importing audio…';
  const form = new FormData(); for (const file of files) form.append('audio', file);
  try {
    const result = await api('/api/audio/import', { method: 'POST', body: form });
    if (result.imported.length) {
      remember(); allMedia.push(...result.imported);
      project.mediaIds = [...new Set([...project.mediaIds, ...result.imported.map(media => media.id)])];
      let at = Number($('scrubber').value), last;
      for (const media of result.imported.slice(0, 20 - project.music.length)) {
        last = makeMusic(media, Math.min(at, 86400)); project.music.push(last); at += media.duration;
      }
      refreshProjectLibrary(); if (last) selectMusic(last.id); else renderTimeline(); save();
      toast([`${result.imported.length} audio file(s) imported. Music ends with the video.`, ...result.errors].join(' '));
    } else toast(result.errors.join(' ') || 'No audio files imported.');
  } catch (error) { toast(error.message); }
  finally { importing = false; $('import-music').disabled = false; $('music-import-status').textContent = ''; $('music-input').value = ''; }
}
function selectMusic(id) {
  stop(); selectedMusicId = id; setInspector('audio'); renderTimeline();
  $('music-settings').scrollIntoView({ block: 'nearest' });
}
function removeMusic() {
  if (!selectedMusic()) return;
  stop(); remember(); project.music = project.music.filter(clip => clip.id !== selectedMusicId); selectedMusicId = '';
  renderTimeline(); save();
}
function renderMusic() {
  const clips = project.music || [], container = $('music-tracks'); container.replaceChildren();
  if (!clips.length) {
    const empty = document.createElement('button'); empty.className = 'music-track-empty'; empty.textContent = '+ Add music or sound effects'; empty.onclick = () => $('timeline-music').click(); container.append(empty);
  }
  clips.forEach((clip, index) => {
    const source = musicSource(clip), lane = document.createElement('div'); lane.className = 'music-lane';
    const node = document.createElement('div'); node.className = `music-clip${clip.id === selectedMusicId ? ' selected' : ''}`; node.dataset.musicId = clip.id;
    node.style.left = `${clip.at * pixelsPerSecond}px`; node.style.width = `${Math.max(2, (clip.end - clip.start) * pixelsPerSecond)}px`;
    node.tabIndex = 0; node.setAttribute('role', 'button'); node.setAttribute('aria-label', `Edit music ${index + 1}: ${source?.name || 'Missing audio'}`); node.setAttribute('aria-pressed', clip.id === selectedMusicId);
    const label = document.createElement('span'); label.textContent = `♫ ${source?.name || 'Missing audio'} · ${time(clip.end - clip.start)} · ${Math.round(clip.volume * 100)}%`; node.append(label);
    for (const edge of ['start', 'end']) {
      const handle = document.createElement('span'); handle.className = `music-handle ${edge}`; handle.dataset.edge = edge; handle.title = `Drag to trim music ${edge}`; node.append(handle);
    }
    node.onpointerdown = event => beginMusicDrag(event, clip);
    node.onclick = () => { if (!musicDrag) selectMusic(clip.id); };
    node.onkeydown = event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); selectMusic(clip.id); } };
    lane.append(node); container.append(lane);
  });
  $('music-track-header').style.height = `${Math.max(1, clips.length) * 38 + 8}px`;
  const extent = Math.max(total(), ...clips.map(clip => clip.at + clip.end - clip.start));
  $('timeline-content').style.width = `${Math.max($('timeline-scroll').clientWidth, extent * pixelsPerSecond + 180)}px`;
  const clip = selectedMusic(), source = musicSource(clip);
  const tab = document.querySelector('[data-inspector-tab].active')?.dataset.inspectorTab;
  $('clip-controls').hidden = tab === 'text' || (tab === 'audio' && !!clip);
  $('music-controls').disabled = !clip;
  $('music-selected-name').textContent = source?.name || 'Select a music clip below';
  for (const key of ['at', 'start', 'end', 'volume']) $(`music-${key}`).value = clip ? (key === 'volume' ? clip[key] : clip[key].toFixed(2)) : '';
  $('music-volume-value').textContent = clip ? `${Math.round(clip.volume * 100)}%` : '50%';
  $('music-range').textContent = clip ? `In ${time(clip.start, 2)} → Out ${time(clip.end, 2)} · ${time(clip.end - clip.start)} used${clip.at >= total() ? ' · Starts after the video ends' : clip.at + clip.end - clip.start > total() ? ' · Export stops at the end of the video' : ''}` : 'Add music from your computer. Trim and position it independently of your videos.';
  if (clip) {
    $('selection-badge').textContent = 'Music'; $('selected-name').textContent = source?.name || 'Music';
    for (const id of ['split', 'duplicate', 'timeline-earlier', 'timeline-later']) $(id).disabled = true;
    $('remove').disabled = false;
    document.querySelectorAll('.timeline-clip.selected').forEach(node => node.classList.remove('selected'));
    document.querySelectorAll('[data-edit-tool]').forEach(button => { button.disabled = true; });
  } else {
    $('selection-badge').textContent = current() ? `Clip ${selected + 1}` : 'Project';
    $('selected-name').textContent = mediaFor(current())?.name || 'Select a clip to get started';
  }
  renderMusicLibrary();
}
function changeMusic(key, value) {
  const clip = selectedMusic(); if (!clip) return;
  const next = { ...clip, [key]: Number(value) };
  try { validateMusic([next]); } catch (error) { toast(error.message); renderMusic(); return; }
  stop(); remember(); Object.assign(clip, next); renderTimeline(); save();
}
function beginMusicDrag(event, clip) {
  if (event.button !== 0) return;
  event.preventDefault(); event.stopPropagation();
  const edge = event.target.dataset.edge;
  selectMusic(clip.id);
  musicDrag = { id: clip.id, pointer: event.pointerId, x: event.clientX, scroll: $('timeline-scroll').scrollLeft, clip: { ...clip }, edge, snapshot: JSON.stringify(project), moved: false };
  $('timeline-scroll').setPointerCapture(event.pointerId);
}
function finishMusicDrag(event, cancelled = false) {
  const drag = musicDrag; if (!drag || drag.pointer !== event.pointerId) return;
  musicDrag = null;
  if ($('timeline-scroll').hasPointerCapture(event.pointerId)) $('timeline-scroll').releasePointerCapture(event.pointerId);
  if (cancelled) project = JSON.parse(drag.snapshot);
  else if (JSON.stringify(project) !== drag.snapshot) { history.push(drag.snapshot); if (history.length > 60) history.shift(); future = []; }
  renderTimeline(); save();
}
function setupMusic() {
  $('import-music').onclick = () => $('music-input').click();
  $('timeline-music').onclick = () => { document.querySelector('[data-workspace="audio"]').click(); $('music-input').click(); };
  $('music-input').onchange = event => importMusic([...event.target.files]);
  $('music-content').ondragover = event => { event.preventDefault(); };
  $('music-content').ondrop = event => { event.preventDefault(); importMusic([...event.dataTransfer.files]); };
  for (const key of ['at', 'start', 'end', 'volume']) $(`music-${key}`).onchange = event => changeMusic(key, event.target.value);
  $('music-volume').oninput = event => { $('music-volume-value').textContent = `${Math.round(Number(event.target.value) * 100)}%`; };
  $('music-at-playhead').onclick = () => changeMusic('at', Number($('scrubber').value));
  $('music-remove').onclick = removeMusic;
  for (const event of ['waiting', 'seeking', 'pause']) video.addEventListener(event, pauseMusic);
  $('timeline-scroll').addEventListener('scroll', () => { $('track-labels').style.transform = `translateY(-${$('timeline-scroll').scrollTop}px)`; });
  window.addEventListener('pointermove', event => {
    const drag = musicDrag; if (!drag || drag.pointer !== event.pointerId) return;
    if (!drag.moved && Math.abs(event.clientX - drag.x) < 4) return;
    drag.moved = true; autoScrollTimeline(event.clientX);
    const clip = selectedMusic(), source = musicSource(clip); if (!clip || !source) return;
    const delta = (event.clientX - drag.x + $('timeline-scroll').scrollLeft - drag.scroll) / pixelsPerSecond;
    if (drag.edge === 'start') {
      const change = Math.max(-Math.min(drag.clip.start, drag.clip.at), Math.min(drag.clip.end - drag.clip.start - 0.08, delta));
      clip.start = drag.clip.start + change; clip.at = drag.clip.at + change;
    } else if (drag.edge === 'end') clip.end = Math.max(clip.start + 0.08, Math.min(source.duration, drag.clip.end + delta));
    else clip.at = Math.max(0, Math.min(86400, Math.round((drag.clip.at + delta) * 100) / 100));
    renderTimeline();
  });
  window.addEventListener('pointerup', event => finishMusicDrag(event));
  window.addEventListener('pointercancel', event => finishMusicDrag(event, true));
}
