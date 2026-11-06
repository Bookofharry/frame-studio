const $ = id => document.getElementById(id);
const video = $('video');
const cropFor = clip => clip.crop || FrameCrop.full(mediaFor(clip));
const defaults = () => ({ name: 'Untitled project', mediaIds: [], clips: [], music: [], settings: { aspect: 'source', text: '', resolution: 'source', fps: 'source', quality: '18' } });
let project = defaults(), library = [], allMedia = [], selected = -1, history = [], future = [], playing = false, importing = false, jobId = null, pollTimer, toastTimer;
let pixelsPerSecond = 60, timelineGesture = null, gestureMoved = false, previewFrame = 0;
try { const saved = JSON.parse(localStorage.getItem('frame-project')); if (saved?.clips && saved?.settings) project = saved; } catch {}
const mediaFor = clip => library.find(m => m.id === clip?.mediaId);
function refreshProjectLibrary() {
  project.music ||= [];
  const ids = new Set([...(project.mediaIds || []), ...project.clips.map(clip => clip.mediaId), ...project.music.map(clip => clip.mediaId)]);
  project.mediaIds = [...ids];
  library = allMedia.filter(media => ids.has(media.id) && media.type !== 'audio');
  musicLibrary = allMedia.filter(media => ids.has(media.id) && media.type === 'audio');
  renderLibrary();
  renderMusicLibrary();
}
const current = () => project.clips[selected];
const length = clip => (clip.end - clip.start) / clip.speed;
const total = () => project.clips.reduce((sum, c) => sum + length(c), 0);
const offset = index => project.clips.slice(0, index).reduce((sum, c) => sum + length(c), 0);
function time(seconds, precision = 1) { const scale = 10 ** precision; const ticks = Math.round(Math.max(0, seconds || 0) * scale); return `${String(Math.floor(ticks / (60 * scale))).padStart(2, '0')}:${((ticks % (60 * scale)) / scale).toFixed(precision).padStart(3 + precision, '0')}`; }
function toast(message) { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4500); }
function save() { try { localStorage.setItem('frame-project', JSON.stringify(project)); $('save-state').textContent = '● Saved on this device'; } catch { $('save-state').textContent = 'Save project to keep your edits'; } }
function remember() { history.push(JSON.stringify(project)); if (history.length > 60) history.shift(); future = []; updateHistoryButtons(); }
function updateHistoryButtons() { $('undo').disabled = !history.length; $('redo').disabled = !future.length; }
async function api(url, options) { const response = await fetch(url, options); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Something went wrong. Please try again.'); return result; }
function renderLibrary() {
  $('media-count').textContent = library.length;
  $('library').replaceChildren();
  for (const media of library) {
    const card = document.createElement('article'); card.className = 'media-card'; card.dataset.mediaId = media.id;
    const thumbnail = document.createElement('div'); thumbnail.className = 'media-thumbnail'; thumbnail.draggable = true; thumbnail.title = 'Drag to the timeline to insert this video';
    thumbnail.addEventListener('dragstart', event => { event.dataTransfer.setData('application/x-frame-media', media.id); event.dataTransfer.effectAllowed = 'copy'; });
    const image = document.createElement('img'); image.src = media.thumbnail; image.alt = ''; image.loading = 'lazy';
    const duration = document.createElement('span'); duration.className = 'duration-badge'; duration.textContent = time(media.duration);
    thumbnail.append(image, duration);
    const edit = document.createElement('button'); edit.className = 'edit-media'; edit.textContent = 'Edit video'; edit.setAttribute('aria-label', `Edit ${media.name}`);
    edit.onclick = () => { const index = project.clips.findIndex(c => c.mediaId === media.id); if (index === -1) addClip(media); else { selectClip(index); renderTimeline(); } $('preview-stage').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    thumbnail.append(edit);
    const info = document.createElement('div'); info.className = 'media-info';
    const details = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = media.name; name.title = media.name;
    const meta = document.createElement('small'); meta.textContent = `${media.width} × ${media.height} · ${Math.round(media.fps)} fps · Original ${time(media.duration)}`;
    details.append(name, meta);
    const edits = document.createElement('div'); edits.className = 'library-edits';
    const add = document.createElement('button'); add.className = 'add-clip'; add.textContent = '+ Add original to timeline'; add.setAttribute('aria-label', `Add ${media.name} to timeline`); add.onclick = () => { addClip(media); toast('Video added at the end. Use Play all to preview the joined videos.'); };
    info.append(details); card.append(thumbnail, info, edits, add); $('library').append(card);
  }
  syncLibraryState();
  $('import-zone').parentElement.classList.toggle('has-media', library.length > 0);
  filterLibrary();
}
function clipState(clip, media) {
  const states = [];
  if (clip.start > 0.001 || clip.end < media.duration - 0.001) states.push('Trimmed');
  if (clip.crop) states.push('Cropped');
  if (clip.speed !== 1) states.push(`${clip.speed}× speed`);
  if (clip.brightness !== 0 || clip.contrast !== 1 || clip.saturation !== 1) states.push('Color adjusted');
  if (clip.volume === 0) states.push('Muted'); else if (clip.volume !== 1) states.push(`Volume ${Math.round(clip.volume * 100)}%`);
  return states.length ? states.join(' · ') : 'Full clip';
}
function syncLibraryState() {
  for (const card of $('library').children) {
    const media = library.find(m => m.id === card.dataset.mediaId); if (!media) continue;
    const matches = project.clips.map((clip, index) => ({ clip, index })).filter(item => item.clip.mediaId === media.id);
    const active = matches.find(item => item.index === selected);
    const badge = card.querySelector('.duration-badge');
    badge.textContent = active ? time(length(active.clip)) : matches.length === 1 ? time(length(matches[0].clip)) : matches.length > 1 ? `${matches.length} clips · ${time(matches.reduce((sum, item) => sum + length(item.clip), 0))}` : time(media.duration);
    badge.title = active ? `Selected clip ${active.index + 1}: timeline duration` : matches.length > 1 ? 'Combined duration of this video’s timeline clips' : matches.length ? 'Edited timeline duration' : 'Original video duration';
    card.classList.toggle('is-selected', !!active);
    card.classList.toggle('is-on-timeline', matches.length > 0);
    const edits = card.querySelector('.library-edits');
    const signature = JSON.stringify(matches);
    if (card.dataset.editState !== signature) {
      card.dataset.editState = signature; edits.replaceChildren();
      if (!matches.length) {
        const note = document.createElement('p'); note.className = 'library-source-state'; note.textContent = 'Original · Not on timeline'; edits.append(note);
      }
      for (const { clip, index } of matches) {
        const row = document.createElement('button'); row.className = 'library-clip'; row.dataset.clipId = clip.id;
        row.setAttribute('aria-label', `Edit timeline clip ${index + 1} of ${media.name}`);
        const heading = document.createElement('span'); heading.className = 'library-clip-heading';
        const label = document.createElement('strong'); label.textContent = `Clip ${index + 1}`;
        const duration = document.createElement('span'); duration.className = 'library-clip-duration'; duration.textContent = time(length(clip));
        heading.append(label, duration);
        const range = document.createElement('span'); range.className = 'library-clip-range'; range.textContent = `In ${time(clip.start, 2)} → Out ${time(clip.end, 2)}`;
        range.title = `Source range: ${clip.start.toFixed(3)} to ${clip.end.toFixed(3)} seconds`;
        const state = document.createElement('span'); state.className = 'library-clip-state'; state.textContent = clipState(clip, media);
        row.append(heading, range, state);
        row.onclick = () => { const target = project.clips.findIndex(c => c.id === clip.id); if (target !== -1) { selectClip(target); renderTimeline(); } };
        edits.append(row);
      }
    }
    edits.querySelectorAll('.library-clip').forEach(row => {
      const isSelected = row.dataset.clipId === current()?.id;
      row.classList.toggle('selected', isSelected); row.setAttribute('aria-pressed', String(isSelected));
    });
    const edit = card.querySelector('.edit-media');
    edit.onclick = () => { const index = active?.index ?? matches[0]?.index; if (index === undefined) addClip(media); else { selectClip(index); renderTimeline(); } $('preview-stage').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  }
}
function addClip(media) {
  return addClips([media]);
}
function addClips(items) {
  const available = Math.max(0, 100 - project.clips.length);
  const additions = items.slice(0, available);
  if (!additions.length) { toast('The timeline holds up to 100 clips. Remove a clip before adding more.'); return 0; }
  remember();
  delete project.emptyByChoice;
  const firstAdded = project.clips.length;
  project.clips.push(...additions.map(media => ({ id: crypto.randomUUID(), mediaId: media.id, start: 0, end: media.duration, speed: 1, volume: 1, brightness: 0, contrast: 1, saturation: 1 })));
  selectClip(firstAdded); renderTimeline(); save();
  $('timeline-clips').querySelector('.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return additions.length;
}
function renderTimeline() {
  const container = $('timeline-clips'); container.replaceChildren();
  if (!project.clips.length) { const empty = document.createElement('div'); empty.className = 'timeline-empty'; empty.textContent = 'Drop videos here to start editing'; container.append(empty); }
  project.clips.forEach((clip, index) => {
    const media = mediaFor(clip); const button = document.createElement('div'); button.className = `timeline-clip${index === selected ? ' selected' : ''}`; button.setAttribute('role', 'button'); button.tabIndex = 0; button.dataset.clipId = clip.id;
    button.style.width = `${Math.max(1, length(clip) * pixelsPerSecond)}px`;
    const body = document.createElement('div'); body.className = 'clip-body';
    if (media) body.style.backgroundImage = `url("${media.thumbnail}")`;
    const title = document.createElement('strong'); title.textContent = `${String(index + 1).padStart(2, '0')}  ${media?.name || 'Missing source'}`;
    const detail = document.createElement('small'); detail.textContent = `${time(length(clip))}  ·  ${clip.speed}×`;
    const audio = document.createElement('span'); audio.className = 'clip-audio'; audio.textContent = media?.audio ? (clip.volume ? `♫ Source audio · ${Math.round(clip.volume * 100)}%` : 'Muted') : 'No source audio';
    body.append(title, detail, audio); button.append(body);
    for (const edge of ['start', 'end']) {
      const handle = document.createElement('span'); handle.className = `trim-handle ${edge}`; handle.dataset.edge = edge; handle.textContent = '│'; handle.title = `Drag to trim ${edge}`;
      handle.setAttribute('role', 'slider'); handle.setAttribute('aria-label', `Trim ${edge} of clip ${index + 1}`); handle.setAttribute('aria-valuemin', '0'); handle.setAttribute('aria-valuemax', media?.duration || clip.end); handle.setAttribute('aria-valuenow', clip[edge]); handle.tabIndex = index === selected ? 0 : -1;
      handle.onkeydown = event => { if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); const step = (event.shiftKey ? 10 : 1) / (media?.fps || 30); trim(edge, clip[edge] + (event.key === 'ArrowRight' ? step : -step)); };
      button.append(handle);
    }
    button.addEventListener('pointerdown', event => beginClipGesture(event, clip.id));
    button.onclick = event => { if (gestureMoved || event.target.closest('.trim-handle')) return; selectClip(index); renderTimeline(); };
    button.onkeydown = event => { if (event.target === button && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); selectClip(index); renderTimeline(); } };
    button.setAttribute('aria-label', `Select clip ${index + 1}: ${media?.name || 'Missing source'}`); button.setAttribute('aria-pressed', index === selected); container.append(button);
  });
  $('clip-count').textContent = `${project.clips.length} clip${project.clips.length === 1 ? '' : 's'}`;
  $('total-time').textContent = time(total()); $('scrubber').max = total() || 1;
  const extent = Math.max(total(), ...(project.music || []).map(clip => clip.at + clip.end - clip.start));
  const width = Math.max($('timeline-scroll').clientWidth, extent * pixelsPerSecond + 180);
  $('timeline-content').style.width = `${width}px`;
  const interval = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].find(value => value * pixelsPerSecond >= 70) || 3600;
  const ticks = []; for (let seconds = 0; seconds * pixelsPerSecond < width; seconds += interval) { const tick = document.createElement('span'); tick.style.left = `${seconds * pixelsPerSecond}px`; tick.textContent = time(seconds); ticks.push(tick); }
  $('ruler').replaceChildren(...ticks); $('ruler').style.setProperty('--minor-step', `${interval * pixelsPerSecond / 4}px`);
  for (const id of ['split', 'remove', 'duplicate', 'play', 'back', 'forward']) $(id).disabled = !project.clips.length;
  updateHistoryButtons();
  document.querySelectorAll('[data-edit-tool]').forEach(button => { button.disabled = !current(); });
  $('play-all').disabled = !project.clips.length;
  $('timeline-earlier').disabled = selected <= 0;
  $('timeline-later').disabled = selected < 0 || selected >= project.clips.length - 1;
  $('join-summary').textContent = project.clips.length ? `${time(total())} total · All clips export as one video` : 'Drop media onto the track to start';
  syncLibraryState();
  renderMusic();
  updateTime();
}
function stop() { playing = false; video.pause(); pauseMusic(); stopCatalogPreview(); $('play').textContent = '▶'; $('play').setAttribute('aria-label', 'Play timeline'); }
function selectClip(index, at, resume = false) {
  if (!resume) stop();
  selectedMusicId = '';
  selected = index; const clip = current(), media = mediaFor(clip);
  $('clip-controls').disabled = !clip; $('preview-empty').hidden = !!clip;
  $('video-frame').style.display = clip ? 'block' : 'none';
  $('selected-name').textContent = media?.name || 'Select a clip to get started';
  $('source-label').textContent = media ? `${media.width} × ${media.height} · ${Math.round(media.fps)} fps` : 'No clip selected';
  $('editing-hint').textContent = media ? `Clip ${index + 1} · ${time(length(clip))} · ${clipState(clip, media)}` : 'Select a timeline clip to edit';
  $('selection-badge').textContent = clip ? `Clip ${index + 1}` : 'Project';
  if (!clip || !media) { video.dataset.mediaId = ''; video.removeAttribute('src'); video.load(); updateTime(); return; }
  const seek = at === undefined ? clip.start : at;
  const ready = () => { video.currentTime = Math.min(clip.end - 0.001, Math.max(clip.start, seek)); applyPreview(); if (resume) video.play().catch(() => { stop(); toast('This file cannot play in the browser. Try an H.264 MP4; export may still work.'); }); updateTime(); };
  if (video.dataset.mediaId !== media.id) { video.dataset.mediaId = media.id; video.src = media.url; video.onloadedmetadata = ready; }
  else if (video.readyState >= 1) ready(); else video.onloadedmetadata = ready;
  renderControls();
  applyPreview();
}
function renderControls() {
  const clip = current(); if (!clip) return;
  $('trim-start').value = clip.start.toFixed(2); $('trim-end').value = clip.end.toFixed(2);
  for (const key of ['brightness', 'contrast', 'saturation', 'volume', 'speed']) $(key).value = clip[key];
  for (const key of ['brightness', 'contrast', 'saturation', 'volume']) $(`${key}-value`).textContent = key === 'brightness' ? `${Math.round(clip[key] * 100) > 0 ? '+' : ''}${Math.round(clip[key] * 100)}` : `${Math.round(clip[key] * 100)}%`;
  $('move-left').disabled = selected <= 0; $('move-right').disabled = selected === project.clips.length - 1;
  const crop = cropFor(clip);
  $('crop-summary').textContent = `${crop.width} × ${crop.height} px · ${clip.crop ? 'Crop applied' : 'Full frame'}`;
  syncLibraryState();
}
function applyPreview() {
  const clip = current(), media = mediaFor(clip); if (!clip || !media) return;
  video.style.filter = `brightness(${1 + clip.brightness}) contrast(${clip.contrast}) saturate(${clip.saturation})`;
  video.volume = clip.volume; video.playbackRate = clip.speed;
  const first = cropFor(project.clips[0]);
  const ratio = project.settings.aspect === 'source' ? first.width / first.height : (() => { const [w, h] = project.settings.aspect.split(':').map(Number); return w / h; })();
  const stage = $('preview-stage'); let width = stage.clientWidth, height = width / ratio;
  if (height > stage.clientHeight) { height = stage.clientHeight; width = height * ratio; }
  $('video-frame').style.width = `${width}px`; $('video-frame').style.height = `${height}px`;
  const crop = cropFor(clip);
  const scale = Math.min(width / crop.width, height / crop.height);
  const viewport = $('crop-viewport');
  Object.assign(viewport.style, { width: `${crop.width * scale}px`, height: `${crop.height * scale}px`, left: `${(width - crop.width * scale) / 2}px`, top: `${(height - crop.height * scale) / 2}px` });
  Object.assign(video.style, { width: `${media.width * scale}px`, height: `${media.height * scale}px`, left: `${-crop.x * scale}px`, top: `${-crop.y * scale}px` });
  $('title-preview').textContent = project.settings.text; $('title-preview').style.fontSize = `${height * 0.045}px`;
  $('player-format').textContent = project.settings.aspect === 'source' ? 'Original' : project.settings.aspect;
}
function updateTime() {
  const clip = current(); const position = clip ? offset(selected) + Math.max(0, Math.min(clip.end, video.currentTime || clip.start) - clip.start) / clip.speed : 0;
  $('current-time').textContent = time(position); $('scrubber').value = position;
  $('timeline-playhead').style.left = `${position * pixelsPerSecond}px`;
  for (const id of ['ruler', 'timeline-playhead']) { $(id).setAttribute('aria-valuemax', total()); $(id).setAttribute('aria-valuenow', position); $(id).setAttribute('aria-valuetext', time(position, 2)); }
  if (playing && !timelineGesture) { const viewport = $('timeline-scroll'); const x = position * pixelsPerSecond; if (x > viewport.scrollLeft + viewport.clientWidth - 25 || x < viewport.scrollLeft) viewport.scrollLeft = Math.max(0, x - 80); }
  syncMusic(position);
}
function seekTimeline(position) {
  let start = 0;
  for (let index = 0; index < project.clips.length; index++) { const clip = project.clips[index]; if (position < start + length(clip) || index === project.clips.length - 1) { selectClip(index, clip.start + (position - start) * clip.speed, playing); renderTimeline(); return; } start += length(clip); }
}
function nextClip() { if (!playing) return; if (selected < project.clips.length - 1) { selectClip(selected + 1, undefined, true); renderTimeline(); } else { stop(); updateTime(); } }
function checkClipEnd() { const clip = current(); if (playing && clip && !video.seeking && video.dataset.mediaId === clip.mediaId && video.currentTime >= clip.end - 0.015) nextClip(); }
video.addEventListener('timeupdate', () => { updateTime(); checkClipEnd(); });
video.addEventListener('ended', checkClipEnd);
video.addEventListener('error', () => { if (video.getAttribute('src')) { stop(); toast('Browser preview unavailable for this codec. Use an H.264 MP4 for preview; FFmpeg can still export this file.'); } });
$('play').onclick = () => {
  if (!current()) return;
  if (playing) { stop(); return; }
  playing = true; $('play').textContent = 'Ⅱ'; $('play').setAttribute('aria-label', 'Pause timeline');
  if (Number($('scrubber').value) >= total() - 0.05) { selectClip(0, undefined, true); renderTimeline(); }
  else { if (video.currentTime >= current().end - 0.05) video.currentTime = current().start; video.play().catch(() => { stop(); toast('Unable to preview this file. Try an H.264 MP4.'); }); }
};
$('scrubber').oninput = e => seekTimeline(Number(e.target.value));
function stepFrame(direction, count = 1) { stop(); const fps = mediaFor(current())?.fps || 30; seekTimeline(Math.max(0, Math.min(total(), Number($('scrubber').value) + direction * count / fps))); }
$('back').onclick = () => stepFrame(-1);
$('forward').onclick = () => stepFrame(1);
async function importFiles(files) {
  if (!files.length) return;
  if (importing) return toast('Wait for the current import to finish, then add more videos.');
  if (files.length > 20) { toast('Import up to 20 videos at a time.'); return; }
  importing = true;
  const form = new FormData(); for (const file of files) form.append('videos', file);
  const zone = $('import-zone'); zone.disabled = true; const label = zone.querySelector('strong'); label.textContent = 'Importing your videos…';
  try {
    const result = await api('/api/import', { method: 'POST', body: form }); allMedia.push(...result.imported);
    project.mediaIds = [...new Set([...project.mediaIds, ...result.imported.map(media => media.id)])]; refreshProjectLibrary();
    const count = result.imported.length ? addClips(result.imported) : 0;
    const notice = count ? `${count} video${count === 1 ? '' : 's'} added to the timeline. Export saves all clips as one MP4.` : 'No videos added to the timeline.';
    toast([notice, count < result.imported.length ? 'Timeline limit reached; remaining videos are in the library.' : '', ...result.errors].filter(Boolean).join(' '));
  }
  catch (error) { toast(error.message); } finally { importing = false; zone.disabled = false; label.textContent = 'Import media'; $('file-input').value = ''; }
}
for (const id of ['import-small', 'import-main', 'import-zone', 'timeline-import']) $(id).onclick = () => $('file-input').click();
$('file-input').onchange = e => importFiles([...e.target.files]);
for (const event of ['dragenter', 'dragover']) $('import-zone').addEventListener(event, e => { e.preventDefault(); $('import-zone').classList.add('dragover'); });
for (const event of ['dragleave', 'drop']) $('import-zone').addEventListener(event, e => { e.preventDefault(); $('import-zone').classList.remove('dragover'); });
$('import-zone').addEventListener('drop', e => importFiles([...e.dataTransfer.files]));
function trim(key, value) {
  const clip = current(); if (!clip) return;
  const n = Number(value), media = mediaFor(clip);
  if (!Number.isFinite(n) || n < 0 || n > media.duration || (key === 'start' ? clip.end - n : n - clip.start) < 0.08) { toast('Keep at least 0.08 seconds, within the source video.'); renderControls(); return; }
  remember(); clip[key] = n; selectClip(selected); renderTimeline(); save();
}
$('trim-start').onchange = e => trim('start', e.target.value); $('trim-end').onchange = e => trim('end', e.target.value);
$('mark-start').onclick = () => trim('start', video.currentTime); $('mark-end').onclick = () => trim('end', video.currentTime);
for (const key of ['brightness', 'contrast', 'saturation', 'volume']) {
  $(key).addEventListener('pointerdown', remember); $(key).addEventListener('keydown', e => { if (e.key.startsWith('Arrow')) remember(); });
  $(key).oninput = e => { if (!current()) return; current()[key] = Number(e.target.value); renderControls(); applyPreview(); save(); $('undo').disabled = !history.length; };
}
$('speed').onchange = e => { remember(); current().speed = Number(e.target.value); applyPreview(); renderTimeline(); save(); };
function colorPreset(values) { if (!current()) return; remember(); Object.assign(current(), values); renderControls(); applyPreview(); renderTimeline(); save(); }
$('reset-color').onclick = () => colorPreset({ brightness: 0, contrast: 1, saturation: 1 });
document.querySelectorAll('[data-preset]').forEach(button => button.onclick = () => colorPreset({ natural: { brightness: 0, contrast: 1, saturation: 1 }, vivid: { brightness: 0.02, contrast: 1.12, saturation: 1.25 }, mono: { brightness: 0, contrast: 1.08, saturation: 0 } }[button.dataset.preset]));
$('split').onclick = () => {
  const clip = current(); if (!clip) return; const position = video.currentTime;
  if (position - clip.start < 0.08 || clip.end - position < 0.08) return toast('Move the playhead inside the clip before splitting.');
  remember(); const right = { ...clip, id: crypto.randomUUID(), start: position }; clip.end = position; project.clips.splice(selected + 1, 0, right); selectClip(selected + 1); renderTimeline(); save(); toast('Clip split at the playhead.');
};
$('remove').onclick = () => { if (selectedMusicId) return removeMusic(); if (!current()) return; remember(); project.clips.splice(selected, 1); selectClip(project.clips.length ? Math.min(selected, project.clips.length - 1) : -1); renderTimeline(); save(); };
function move(direction) { const next = selected + direction; if (next < 0 || next >= project.clips.length) return; remember(); [project.clips[selected], project.clips[next]] = [project.clips[next], project.clips[selected]]; selectClip(next); renderTimeline(); save(); }
$('move-left').onclick = () => move(-1); $('move-right').onclick = () => move(1);
$('timeline-earlier').onclick = () => move(-1); $('timeline-later').onclick = () => move(1);
$('play-all').onclick = () => { if (!project.clips.length) return; selectClip(0); renderTimeline(); $('play').click(); };
function restore() { refreshProjectLibrary(); $('project-name').value = project.name; $('aspect').value = project.settings.aspect; $('title-text').value = project.settings.text; for (const key of ['resolution', 'fps', 'quality']) $(key).value = project.settings[key]; selectClip(project.clips.length ? Math.max(0, Math.min(selected, project.clips.length - 1)) : -1); renderTimeline(); save(); }
$('undo').onclick = () => { if (importing) return toast('Wait for the import to finish before undoing.'); if (!history.length) return; future.push(JSON.stringify(project)); project = JSON.parse(history.pop()); restore(); };
$('redo').onclick = () => { if (importing) return toast('Wait for the import to finish before redoing.'); if (!future.length) return; history.push(JSON.stringify(project)); project = JSON.parse(future.pop()); restore(); };
$('duplicate').onclick = () => { if (!current() || project.clips.length >= 100) return; remember(); const copy = JSON.parse(JSON.stringify(current())); copy.id = crypto.randomUUID(); project.clips.splice(selected + 1, 0, copy); selectClip(selected + 1); renderTimeline(); save(); };
$('aspect').onchange = e => { remember(); project.settings.aspect = e.target.value; applyPreview(); save(); renderTimeline(); };
$('title-text').onfocus = remember; $('title-text').oninput = e => { project.settings.text = e.target.value; applyPreview(); save(); $('undo').disabled = !history.length; };
$('project-name').onchange = e => { project.name = e.target.value.trim() || 'Untitled project'; save(); };
$('save-project').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, ...project }, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `${project.name.replace(/[^a-z0-9 _-]/gi, '') || 'Frame'}.frame.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Project saved. Keep the app’s data folder with its source videos.');
};
$('load-project').onclick = () => $('project-input').click();
$('project-input').onchange = async e => {
  try {
    const file = e.target.files[0]; if (!file) return;
    if (importing) throw new Error('Wait for the import to finish before opening another project.');
    const data = JSON.parse(await file.text());
    if (data.version !== 1 || typeof data.name !== 'string' || !Array.isArray(data.clips) || !data.settings || data.clips.length > 100) throw new Error('Choose a valid Frame project file.');
    if (data.mediaIds !== undefined && (!Array.isArray(data.mediaIds) || data.mediaIds.some(id => typeof id !== 'string'))) throw new Error('This project contains an invalid media list.');
    allMedia = await api('/api/library');
    validateMusic(data.music === undefined ? [] : data.music);
    for (const clip of data.clips) { const m = allMedia.find(media => media.id === clip.mediaId); if (m && clip.crop != null && !FrameCrop.valid(clip.crop, m)) throw new Error('This project contains an invalid crop.'); if (!m || m.type === 'audio') throw new Error('This project needs videos that are not in this computer’s library.'); for (const k of ['start', 'end', 'speed', 'volume', 'brightness', 'contrast', 'saturation']) if (!Number.isFinite(clip[k])) throw new Error('This project contains invalid clip settings.'); if (clip.start < 0 || clip.end > m.duration || clip.end - clip.start < 0.08 || clip.speed < 0.5 || clip.speed > 7 || clip.volume < 0 || clip.volume > 1 || Math.abs(clip.brightness) > 0.5 || clip.contrast < 0.5 || clip.contrast > 2 || clip.saturation < 0 || clip.saturation > 2) throw new Error('This project contains invalid clip settings.'); }
    if (!['source', '16:9', '9:16', '1:1'].includes(data.settings.aspect) || typeof data.settings.text !== 'string') throw new Error('This project contains invalid canvas settings.');
    remember(); project = { name: data.name.slice(0, 60), mediaIds: data.mediaIds || data.clips.map(clip => clip.mediaId), clips: data.clips, music: data.music || [], settings: { ...defaults().settings, ...data.settings, text: data.settings.text.slice(0, 120) } }; $('media-search').value = ''; restore(); toast('Project opened.');
  } catch (error) { toast(error.message); } finally { e.target.value = ''; }
};
$('new-project').onclick = () => $('new-dialog').showModal(); $('keep-project').onclick = () => $('new-dialog').close();
$('confirm-new').onclick = () => { if (importing) return toast('Wait for the import to finish before starting a new project.'); remember(); project = defaults(); selected = -1; $('media-search').value = ''; video.dataset.mediaId = ''; restore(); $('new-dialog').close(); };
$('open-export').onclick = () => { if (!project.clips.length) return toast('Add a video to your timeline first.'); stop(); $('export-credit-note').hidden = !project.music.some(c => musicSource(c)?.catalog?.attributionRequired && c.volume > 0 && c.at < total()); $('export-description').textContent = `${project.clips.length} clip${project.clips.length === 1 ? '' : 's'} · ${time(total())} total. All timeline clips will be joined in order into one MP4 video.`; $('export-dialog').showModal(); };
$('close-export').onclick = () => $('export-dialog').close();
function exportBusy(busy) { for (const key of ['resolution', 'fps', 'quality']) $(key).disabled = busy; $('start-export').hidden = busy; $('cancel-export').hidden = !busy; }
async function poll() {
  try {
    const job = await api(`/api/exports/${jobId}`);
    $('export-message').textContent = job.message; $('export-progress').value = job.progress; $('export-percent').textContent = `${job.progress}%`;
    if (job.status === 'rendering') pollTimer = setTimeout(poll, 750);
    else { exportBusy(false); if (job.status === 'complete') { $('download-export').href = `/api/exports/${job.id}/download`; $('download-export').hidden = false; $('download-credits').hidden = !job.credits; $('download-credits').href = `/api/exports/${job.id}/credits`; $('start-export').textContent = 'Export again'; toast('Your MP4 is ready to download.'); } }
  } catch (error) { exportBusy(false); $('export-message').textContent = error.message; }
}
$('export-form').onsubmit = async e => {
  e.preventDefault(); if (jobId && !$('cancel-export').hidden) return;
  for (const key of ['resolution', 'fps', 'quality']) project.settings[key] = $(key).value;
  save(); exportBusy(true); $('download-export').hidden = true; $('download-credits').hidden = true; $('export-status').hidden = false; $('export-message').textContent = 'Preparing your video'; $('export-progress').value = 0; $('export-percent').textContent = '0%';
  try { const result = await api('/api/exports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(project) }); jobId = result.id; clearTimeout(pollTimer); poll(); }
  catch (error) { exportBusy(false); $('export-message').textContent = error.message; }
};
$('cancel-export').onclick = async () => { try { await api(`/api/exports/${jobId}`, { method: 'DELETE' }); clearTimeout(pollTimer); poll(); } catch (error) { toast(error.message); } };
document.addEventListener('keydown', e => {
  if (e.defaultPrevented || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) || document.querySelector('dialog[open]')) return;
  const command = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
  if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
  else if (command && key === 'z') { e.preventDefault(); $(e.shiftKey ? 'redo' : 'undo').click(); }
  else if (command && key === 'y') { e.preventDefault(); $('redo').click(); }
  else if (command && key === 'b') { e.preventDefault(); $('split').click(); }
  else if (command && key === 'd') { e.preventDefault(); $('duplicate').click(); }
  else if (['Delete', 'Backspace'].includes(e.key)) { e.preventDefault(); $('remove').click(); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); stepFrame(e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey ? 10 : 1); }
  else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); stop(); seekTimeline(e.key === 'Home' ? 0 : total()); }
});
window.addEventListener('resize', applyPreview);
async function init() {
  try {
    allMedia = await api('/api/library');
    project.music = (Array.isArray(project.music) ? project.music : []).filter(clip => allMedia.some(media => media.id === clip.mediaId && media.type === 'audio'));
    // Migrate the current legacy workspace once; new projects have an explicit empty media list.
    if (!Array.isArray(project.mediaIds)) project.mediaIds = project.emptyByChoice && !project.clips.length ? [] : allMedia.map(media => media.id);
    const valid = project.clips.filter(clip => allMedia.some(media => media.id === clip.mediaId));
    if (valid.length !== project.clips.length) { project.clips = valid; toast('Missing source clips were removed. Import their videos again.'); }
    restore();
  } catch (error) { console.error(error); toast('Could not load the editor. Restart Frame and refresh this page.'); }
}

let cropDraft = null, cropMedia = null, cropDrag = null;
function renderCrop() {
  if (!cropDraft || !cropMedia) return;
  for (const key of ['x', 'y', 'width', 'height']) $(`crop-${key}`).value = cropDraft[key];
  Object.assign($('crop-box').style, { left: `${100 * cropDraft.x / cropMedia.width}%`, top: `${100 * cropDraft.y / cropMedia.height}%`, width: `${100 * cropDraft.width / cropMedia.width}%`, height: `${100 * cropDraft.height / cropMedia.height}%` });
  $('crop-dimensions').textContent = `Keeping ${cropDraft.width} × ${cropDraft.height} pixels of ${cropMedia.width} × ${cropMedia.height}`;
}
function resizeCropStage() {
  if (!$('crop-dialog').open || !cropMedia) return;
  const width = Math.min($('crop-stage').parentElement.clientWidth - 24, innerHeight * 0.42 * cropMedia.width / cropMedia.height);
  $('crop-stage').style.width = `${width}px`;
  $('crop-stage').style.height = `${width * cropMedia.height / cropMedia.width}px`;
}
function openCrop() {
  if (!current()) return toast('Click Edit video in your library first.');
  stop(); cropMedia = mediaFor(current()); cropDraft = { ...cropFor(current()) };
  const canvas = $('crop-image');
  canvas.width = Math.min(1280, cropMedia.width); canvas.height = Math.round(canvas.width * cropMedia.height / cropMedia.width);
  const context = canvas.getContext('2d'); context.clearRect(0, 0, canvas.width, canvas.height);
  if (video.readyState >= 2) context.drawImage(video, 0, 0, canvas.width, canvas.height);
  else {
    const sourceId = cropMedia.id;
    const fallback = new Image(); fallback.onload = () => { if ($('crop-dialog').open && cropMedia.id === sourceId) context.drawImage(fallback, 0, 0, canvas.width, canvas.height); }; fallback.src = cropMedia.thumbnail;
  }
  $('crop-dialog').showModal(); resizeCropStage(); renderCrop();
}
$('open-crop').onclick = openCrop;
document.querySelectorAll('[data-edit-tool]').forEach(button => button.onclick = () => {
  if (!current()) return;
  if (button.dataset.editTool === 'crop') return openCrop();
  setInspector(button.dataset.editTool === 'trim' ? 'video' : button.dataset.editTool === 'color' ? 'adjust' : 'audio');
  const section = $(`${button.dataset.editTool}-section`);
  section.scrollIntoView({ behavior: 'smooth', block: 'center' });
  section.querySelector('input,select')?.focus({ preventScroll: true });
});
for (const id of ['close-crop', 'cancel-crop']) $(id).onclick = () => $('crop-dialog').close();
$('crop-dialog').addEventListener('close', () => { cropDrag = null; });
$('apply-crop').onclick = () => { if (!current() || !FrameCrop.valid(cropDraft, mediaFor(current()))) return; remember(); current().crop = { ...cropDraft }; $('crop-dialog').close(); renderControls(); applyPreview(); renderTimeline(); save(); toast('Crop applied. Preview and export use this area.'); };
$('reset-crop').onclick = () => { if (!current()) return; remember(); delete current().crop; renderControls(); applyPreview(); renderTimeline(); save(); };
document.querySelectorAll('[data-crop-ratio]').forEach(button => button.onclick = () => {
  const parts = button.dataset.cropRatio.split(':').map(Number);
  cropDraft = FrameCrop.preset(parts.length === 2 ? parts[0] / parts[1] : null, cropMedia); renderCrop();
});
for (const key of ['x', 'y', 'width', 'height']) $(`crop-${key}`).onchange = event => {
  const value = Number(event.target.value); if (!Number.isFinite(value)) return renderCrop();
  cropDraft = FrameCrop.normalize({ ...cropDraft, [key]: value }, cropMedia); renderCrop();
};
$('crop-box').addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  event.preventDefault();
  cropDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, crop: { ...cropDraft }, corner: event.target.dataset.corner, bounds: $('crop-stage').getBoundingClientRect() };
  $('crop-box').setPointerCapture(event.pointerId);
});
$('crop-box').addEventListener('pointermove', event => {
  if (!cropDrag || cropDrag.pointerId !== event.pointerId) return;
  const { crop, corner, bounds } = cropDrag;
  const dx = (event.clientX - cropDrag.x) * cropMedia.width / bounds.width;
  const dy = (event.clientY - cropDrag.y) * cropMedia.height / bounds.height;
  if (!corner) cropDraft = FrameCrop.normalize({ ...crop, x: crop.x + dx, y: crop.y + dy }, cropMedia);
  else {
    let left = crop.x, top = crop.y, right = crop.x + crop.width, bottom = crop.y + crop.height;
    if (corner.includes('w')) left = Math.max(0, Math.min(right - 2, left + dx));
    if (corner.includes('e')) right = Math.min(cropMedia.width, Math.max(left + 2, right + dx));
    if (corner.includes('n')) top = Math.max(0, Math.min(bottom - 2, top + dy));
    if (corner.includes('s')) bottom = Math.min(cropMedia.height, Math.max(top + 2, bottom + dy));
    cropDraft = FrameCrop.normalize({ x: left, y: top, width: right - left, height: bottom - top }, cropMedia);
  }
  renderCrop();
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) $('crop-box').addEventListener(event, () => { cropDrag = null; });
window.addEventListener('resize', resizeCropStage);

let joinSelection = [];
function updateJoinSelection() {
  $('add-selected').disabled = !joinSelection.length || project.clips.length + joinSelection.length > 100;
  $('add-selected').textContent = joinSelection.length ? `Add ${joinSelection.length} selected video${joinSelection.length === 1 ? '' : 's'}` : 'Add selected videos';
  $('join-selection').textContent = `${joinSelection.length} selected · ${project.clips.length} already on timeline. ${project.clips.length + joinSelection.length > 100 ? 'Choose fewer videos: the timeline limit is 100 clips.' : 'Numbers show the order they will be added.'}`;
  $('join-list').querySelectorAll('input').forEach(input => {
    const index = joinSelection.indexOf(input.value); input.checked = index !== -1;
    input.closest('label').querySelector('.join-order').textContent = index === -1 ? '' : index + 1;
  });
}
function openJoin() {
  stop(); joinSelection = []; $('join-list').replaceChildren();
  for (const media of library) {
    const row = document.createElement('label'); row.className = 'join-item';
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = media.id; input.setAttribute('aria-label', `Select ${media.name}`);
    input.onchange = () => { if (input.checked) joinSelection.push(media.id); else joinSelection = joinSelection.filter(id => id !== media.id); updateJoinSelection(); };
    const image = document.createElement('img'); image.src = media.thumbnail; image.alt = '';
    const details = document.createElement('span'); details.className = 'join-item-details';
    const name = document.createElement('strong'); name.textContent = media.name;
    const meta = document.createElement('small'); const copies = project.clips.filter(c => c.mediaId === media.id).length;
    meta.textContent = `${time(media.duration)} · ${media.width} × ${media.height}${copies ? ` · On timeline (${copies})` : ''}`;
    details.append(name, meta); const order = document.createElement('span'); order.className = 'join-order';
    row.append(input, image, details, order); $('join-list').append(row);
  }
  if (!library.length) { const empty = document.createElement('p'); empty.className = 'join-empty'; empty.textContent = 'Import two or more videos to get started. They will be added to the timeline together.'; $('join-list').append(empty); }
  updateJoinSelection(); $('join-dialog').showModal();
}
$('timeline-join').onclick = openJoin;
for (const id of ['close-join', 'cancel-join']) $(id).onclick = () => $('join-dialog').close();
$('join-import').onclick = () => { $('join-dialog').close(); $('file-input').click(); };
$('join-select-all').onclick = () => { joinSelection = library.map(m => m.id); updateJoinSelection(); };
$('join-clear').onclick = () => { joinSelection = []; updateJoinSelection(); };
$('add-selected').onclick = () => {
  const items = joinSelection.map(id => library.find(m => m.id === id)).filter(Boolean); if (!items.length) return;
  $('join-dialog').close(); const count = addClips(items);
  toast(`${count} videos added in your selected order. Export saves the whole timeline as one MP4.`);
};

function setInspector(tab) {
  document.querySelectorAll('[data-inspector]').forEach(section => { section.hidden = section.dataset.inspector !== tab; });
  document.querySelectorAll('[data-inspector-tab]').forEach(button => { const active = button.dataset.inspectorTab === tab; button.classList.toggle('active', active); button.setAttribute('aria-pressed', active); });
  $('clip-controls').hidden = tab === 'text' || (tab === 'audio' && !!selectedMusicId);
  document.querySelector('.inspector-scroll').scrollTop = 0;
}
document.querySelectorAll('[data-inspector-tab]').forEach(button => button.onclick = () => setInspector(button.dataset.inspectorTab));
document.querySelectorAll('[data-workspace]').forEach(button => button.onclick = () => {
  document.querySelectorAll('[data-workspace]').forEach(item => item.classList.toggle('active', item === button));
  document.querySelector('.media-content').hidden = button.dataset.workspace === 'audio';
  $('music-content').hidden = button.dataset.workspace !== 'audio';
  if (button.dataset.workspace === 'media') $('media-search').focus();
  else { setInspector(button.dataset.workspace); document.querySelector('.inspector').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
});
function filterLibrary() {
  const query = $('media-search').value.trim().toLowerCase(); let found = 0;
  for (const card of $('library').children) { const media = library.find(m => m.id === card.dataset.mediaId); card.hidden = !media?.name.toLowerCase().includes(query); if (!card.hidden) found++; }
  $('media-search-empty').hidden = !query || found > 0;
}
$('media-search').oninput = filterLibrary;
$('fullscreen').onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('preview-stage').requestFullscreen(); } catch { toast('Fullscreen is unavailable in this browser.'); } };
document.addEventListener('fullscreenchange', applyPreview);
$('shortcuts').onclick = () => toast('Space: play/pause · ←/→: one frame · Ctrl+B: split · Delete: remove · Ctrl+D: duplicate · Ctrl+Z: undo · Ctrl+Shift+Z: redo');
function setTimelineZoom(value) {
  pixelsPerSecond = Math.max(0.1, Math.min(250, value)); $('timeline-zoom').value = pixelsPerSecond;
  renderTimeline();
}
$('timeline-zoom').oninput = event => setTimelineZoom(Number(event.target.value));
$('zoom-in').onclick = () => setTimelineZoom(pixelsPerSecond * 1.25);
$('zoom-out').onclick = () => setTimelineZoom(pixelsPerSecond / 1.25);
$('timeline-fit').onclick = () => { setTimelineZoom(($('timeline-scroll').clientWidth - 40) / Math.max(total(), 5)); $('timeline-scroll').scrollLeft = 0; };
function timelineX(clientX) { const viewport = $('timeline-scroll'); return clientX - viewport.getBoundingClientRect().left + viewport.scrollLeft; }
function insertionIndex(x) { let position = 0; for (let i = 0; i < project.clips.length; i++) { const width = length(project.clips[i]) * pixelsPerSecond; if (x < position + width / 2) return i; position += width; } return project.clips.length; }
function showInsertion(index) { $('drop-indicator').hidden = false; $('drop-indicator').style.left = `${offset(index) * pixelsPerSecond}px`; }
function autoScrollTimeline(clientX) {
  const viewport = $('timeline-scroll'), rect = viewport.getBoundingClientRect();
  if (clientX < rect.left + 28) viewport.scrollLeft -= 18;
  else if (clientX > rect.right - 28) viewport.scrollLeft += 18;
}
function beginClipGesture(event, id) {
  if (event.button !== 0) return;
  const index = project.clips.findIndex(c => c.id === id); if (index === -1) return;
  event.preventDefault(); event.stopPropagation(); gestureMoved = false; stop();
  selectedMusicId = '';
  selected = index; renderControls();
  const edge = event.target.closest('.trim-handle')?.dataset.edge;
  timelineGesture = { type: edge ? 'trim' : 'move', id, edge, startX: event.clientX, scrollLeft: $('timeline-scroll').scrollLeft, clip: { ...current() }, snapshot: JSON.stringify(project), target: index, pointer: event.pointerId };
  $('timeline-scroll').setPointerCapture(event.pointerId);
}
function beginSeek(event) {
  if (event.button !== 0 || !project.clips.length) return;
  event.preventDefault(); stop(); gestureMoved = true;
  timelineGesture = { type: 'seek', pointer: event.pointerId };
  $('timeline-scroll').setPointerCapture(event.pointerId);
  seekTimeline(Math.max(0, Math.min(total(), timelineX(event.clientX) / pixelsPerSecond)));
}
$('ruler').addEventListener('pointerdown', beginSeek);
$('timeline-playhead').addEventListener('pointerdown', beginSeek);
$('timeline-clips').addEventListener('pointerdown', event => { if (!event.target.closest('.timeline-clip')) beginSeek(event); });
for (const id of ['ruler', 'timeline-playhead']) $(id).onkeydown = event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); stepFrame(event.key === 'ArrowLeft' ? -1 : 1); } };
window.addEventListener('pointermove', event => {
  const gesture = timelineGesture; if (!gesture || event.pointerId !== gesture.pointer) return;
  if (gesture.type === 'seek') { autoScrollTimeline(event.clientX); seekTimeline(Math.max(0, Math.min(total(), timelineX(event.clientX) / pixelsPerSecond))); return; }
  if (!gestureMoved && Math.abs(event.clientX - gesture.startX) < 4) return;
  gestureMoved = true; autoScrollTimeline(event.clientX);
  if (gesture.type === 'move') {
    gesture.target = insertionIndex(timelineX(event.clientX)); showInsertion(gesture.target);
    const node = [...$('timeline-clips').children].find(item => item.dataset.clipId === gesture.id); node?.classList.add('dragging'); return;
  }
  const clip = project.clips.find(c => c.id === gesture.id), media = mediaFor(clip); if (!clip || !media) return;
  const delta = (event.clientX - gesture.startX + $('timeline-scroll').scrollLeft - gesture.scrollLeft) / pixelsPerSecond * clip.speed;
  const snapped = Math.round((gesture.clip[gesture.edge] + delta) * media.fps) / media.fps;
  clip[gesture.edge] = gesture.edge === 'start' ? Math.max(0, Math.min(clip.end - 0.08, snapped)) : Math.min(media.duration, Math.max(clip.start + 0.08, snapped));
  renderControls(); renderTimeline();
  if (video.dataset.mediaId === media.id && video.readyState >= 1) video.currentTime = gesture.edge === 'start' ? clip.start : Math.max(clip.start, clip.end - 1 / media.fps);
});
function finishTimelineGesture(event, cancelled = false) {
  const gesture = timelineGesture; if (!gesture || gesture.pointer !== event.pointerId) return;
  timelineGesture = null; $('drop-indicator').hidden = true;
  if ($('timeline-scroll').hasPointerCapture(event.pointerId)) $('timeline-scroll').releasePointerCapture(event.pointerId);
  if (gesture.type === 'seek') return;
  if (cancelled) { project = JSON.parse(gesture.snapshot); selectClip(Math.max(0, project.clips.findIndex(c => c.id === gesture.id))); renderTimeline(); return; }
  const source = project.clips.findIndex(c => c.id === gesture.id);
  if (gesture.type === 'move' && gestureMoved) {
    const target = Math.max(0, gesture.target - (gesture.target > source ? 1 : 0));
    if (target !== source) { const [clip] = project.clips.splice(source, 1); project.clips.splice(target, 0, clip); }
  }
  if (JSON.stringify(project) !== gesture.snapshot) { history.push(gesture.snapshot); if (history.length > 60) history.shift(); future = []; }
  selectClip(project.clips.findIndex(c => c.id === gesture.id)); renderTimeline(); save();
  // Consume the synthetic click following a drag; the next pointerdown resets it.
  gestureMoved = true;
}
window.addEventListener('pointerup', event => finishTimelineGesture(event));
window.addEventListener('pointercancel', event => finishTimelineGesture(event, true));
$('timeline-scroll').addEventListener('dragover', event => {
  if (![...event.dataTransfer.types].some(type => ['application/x-frame-media', 'Files'].includes(type))) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; $('timeline-scroll').classList.add('dragover'); autoScrollTimeline(event.clientX); showInsertion(insertionIndex(timelineX(event.clientX)));
});
$('timeline-scroll').addEventListener('dragleave', event => { if (!$('timeline-scroll').contains(event.relatedTarget)) { $('timeline-scroll').classList.remove('dragover'); $('drop-indicator').hidden = true; } });
$('timeline-scroll').addEventListener('drop', event => {
  event.preventDefault(); $('timeline-scroll').classList.remove('dragover'); $('drop-indicator').hidden = true;
  if (event.dataTransfer.files.length) { importFiles([...event.dataTransfer.files]); return; }
  const media = library.find(m => m.id === event.dataTransfer.getData('application/x-frame-media')); if (!media) return;
  const target = insertionIndex(timelineX(event.clientX)); const previousLength = project.clips.length;
  if (!addClip(media)) return;
  const [added] = project.clips.splice(previousLength, 1); project.clips.splice(target, 0, added); selectClip(target); renderTimeline(); save();
});
video.addEventListener('play', () => {
  cancelAnimationFrame(previewFrame);
  const tick = () => { if (!playing || video.paused) return; updateTime(); checkClipEnd(); previewFrame = requestAnimationFrame(tick); }; tick();
});
new ResizeObserver(() => { applyPreview(); if (!timelineGesture) renderTimeline(); }).observe($('preview-stage'));
setupMusic();
setupCatalog();
init();
