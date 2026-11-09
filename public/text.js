let selectedTextId = '', textDrag = null, textPreviewDrag = null, textTyping = false;
const selectedText = () => (project.textClips || []).find(clip => clip.id === selectedTextId);
const textX = clip => clip.x ?? 0.5;
const textY = clip => clip.y ?? 0.88;
const textSize = clip => clip.size ?? 0.045;
const roundText = value => Math.round(value * 1000) / 1000;

function validateText(clips) {
  if (!Array.isArray(clips) || clips.length > 20) throw new Error('Use up to 20 text clips.');
  const ids = new Set();
  for (const clip of clips) {
    if (typeof clip?.id !== 'string' || ids.has(clip.id) || typeof clip.text !== 'string' || clip.text.length > 120 || !Number.isFinite(clip.at) || clip.at < 0 || clip.at > 86400 || !Number.isFinite(clip.duration) || clip.duration < 0.1 || clip.duration > 3600 || (clip.x !== undefined && (!Number.isFinite(clip.x) || clip.x < 0 || clip.x > 1)) || (clip.y !== undefined && (!Number.isFinite(clip.y) || clip.y < 0 || clip.y > 1)) || (clip.size !== undefined && (!Number.isFinite(clip.size) || clip.size < 0.02 || clip.size > 0.15))) throw new Error('This project contains invalid text settings.');
    ids.add(clip.id);
  }
}

function textLanes(clips = project.textClips || []) {
  const ends = [], lanes = new Map();
  clips.map((clip, index) => ({ clip, index })).sort((a, b) => a.clip.at - b.clip.at || a.index - b.index).forEach(({ clip }) => {
    let lane = ends.findIndex(end => end <= clip.at);
    if (lane === -1) lane = ends.length;
    ends[lane] = clip.at + clip.duration;
    lanes.set(clip.id, lane);
  });
  return { lanes, count: ends.length };
}

function syncText(position) {
  const active = (project.textClips || []).filter(clip => clip.text && clip.at <= position && position < clip.at + clip.duration && position < total());
  const signature = active.map(clip => `${clip.id}:${clip.text}:${textX(clip)}:${textY(clip)}:${textSize(clip)}:${selectedTextId}`).join('|');
  const preview = $('title-preview');
  if (preview.dataset.signature === signature) return;
  preview.dataset.signature = signature;
  preview.replaceChildren(...active.map(clip => {
    const node = document.createElement('span'); node.className = `preview-text${clip.id === selectedTextId ? ' selected' : ''}`; node.textContent = clip.text; node.dataset.textId = clip.id;
    node.style.left = `${textX(clip) * 100}%`; node.style.top = `${textY(clip) * 100}%`;
    node.style.fontSize = `${$('video-frame').clientHeight * textSize(clip)}px`;
    if (clip.id === selectedTextId) { const handle = document.createElement('span'); handle.className = 'preview-text-resize'; handle.title = 'Drag to resize text'; handle.setAttribute('aria-label', 'Resize selected text'); node.append(handle); }
    return node;
  }));
}

function addText() {
  project.textClips ||= [];
  if (project.textClips.length >= 20) return toast('The project holds up to 20 text clips.');
  const duration = Number($('new-text-duration').value);
  if (!Number.isFinite(duration) || duration < 0.1 || duration > 3600) return toast('Choose a text duration between 0.1 and 3600 seconds.');
  stop(); remember();
  const clip = { id: crypto.randomUUID(), text: 'Your text', at: Number($('scrubber').value), duration, x: 0.5, y: 0.88, size: 0.045 };
  project.textClips.push(clip); selectText(clip.id); save();
  $('title-text').focus(); $('title-text').select();
}
function selectText(id) {
  stop(); textTyping = false; selectedMusicId = ''; selectedTextId = id;
  const clip = selectedText(), position = Number($('scrubber').value);
  if (clip && (position < clip.at || position >= clip.at + clip.duration) && total()) seekTimeline(Math.min(total() - 0.01, clip.at + Math.min(clip.duration / 2, 0.05)));
  selectedTextId = id; setInspector('text'); renderTimeline();
  $('text-section').scrollIntoView({ block: 'nearest' });
}
function removeText() {
  if (!selectedText()) return;
  stop(); remember(); project.textClips = project.textClips.filter(clip => clip.id !== selectedTextId); selectedTextId = '';
  renderTimeline(); save();
}
function renderText() {
  const clips = project.textClips || [], container = $('text-tracks'); container.replaceChildren();
  const { lanes, count } = textLanes(clips);
  if (!clips.length) {
    const empty = document.createElement('button'); empty.className = 'text-track-empty'; empty.textContent = '+ Add text at playhead'; empty.onclick = addText; container.append(empty);
  }
  clips.forEach((clip, index) => {
    const node = document.createElement('div'); node.className = `text-clip${clip.id === selectedTextId ? ' selected' : ''}`; node.dataset.textId = clip.id;
    node.style.left = `${clip.at * pixelsPerSecond}px`; node.style.top = `${(lanes.get(clip.id) || 0) * 38 + 4}px`; node.style.width = `${Math.max(2, clip.duration * pixelsPerSecond)}px`;
    node.tabIndex = 0; node.setAttribute('role', 'button'); node.setAttribute('aria-label', `Edit text ${index + 1}: ${clip.text || 'Empty text'}`); node.setAttribute('aria-pressed', String(clip.id === selectedTextId));
    const label = document.createElement('span'); label.textContent = `T  ${clip.text || 'Empty text'} · ${time(clip.duration)}`; node.append(label);
    for (const edge of ['start', 'end']) { const handle = document.createElement('span'); handle.className = `text-handle ${edge}`; handle.dataset.edge = edge; handle.title = `Drag to trim text ${edge}`; node.append(handle); }
    node.onpointerdown = event => beginTextDrag(event, clip);
    node.onclick = () => { if (!textDrag) selectText(clip.id); };
    node.onkeydown = event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); selectText(clip.id); } };
    container.append(node);
  });
  const height = Math.max(1, count) * 38 + 8;
  container.style.height = `${height}px`; $('text-track-header').style.height = `${height}px`;
  const extent = Math.max(total(), ...(project.music || []).map(clip => clip.at + clip.end - clip.start), ...clips.map(clip => clip.at + clip.duration));
  $('timeline-content').style.width = `${Math.max($('timeline-scroll').clientWidth, extent * pixelsPerSecond + 180)}px`;
  const clip = selectedText();
  $('text-controls').disabled = !clip;
  $('title-text').value = clip?.text || '';
  $('text-at').value = clip ? clip.at.toFixed(2) : '';
  $('text-duration').value = clip ? clip.duration.toFixed(2) : '';
  $('text-x').value = clip ? Math.round(textX(clip) * 100) : '';
  $('text-y').value = clip ? Math.round(textY(clip) * 100) : '';
  $('text-size').value = clip ? (textSize(clip) * 100).toFixed(1) : '';
  $('text-range').textContent = clip ? `${time(clip.at, 2)} → ${time(clip.at + clip.duration, 2)}${clip.at >= total() ? ' · Starts after the video ends' : clip.at + clip.duration > total() ? ' · Export stops at the end of the video' : ''}` : 'Select a text clip on the timeline to edit it.';
  if (clip) {
    $('selection-badge').textContent = 'Text'; $('selected-name').textContent = clip.text || 'Text overlay';
    for (const id of ['split', 'duplicate', 'timeline-earlier', 'timeline-later']) $(id).disabled = true;
    $('remove').disabled = false;
    document.querySelectorAll('.timeline-clip.selected').forEach(node => node.classList.remove('selected'));
    document.querySelectorAll('[data-edit-tool]').forEach(button => { button.disabled = true; });
  }
}
function changeText(key, value) {
  const clip = selectedText(); if (!clip) return;
  const next = { ...clip, [key]: Number(value) };
  try { validateText([next]); } catch (error) { toast(error.message); renderText(); return; }
  stop(); remember(); Object.assign(clip, next); renderTimeline(); save();
}
function changeTextAppearance(key, value) {
  const clip = selectedText(); if (!clip || value === '') return;
  const numeric = Number(value) / 100;
  const next = { ...clip, [key]: numeric };
  try { validateText([next]); } catch (error) { toast(error.message); renderText(); return; }
  stop(); remember(); clip[key] = roundText(numeric); renderTimeline(); save();
}
function beginPreviewTextDrag(event) {
  const node = event.target.closest('.preview-text'); if (!node || event.button !== 0) return;
  event.preventDefault(); event.stopPropagation();
  if (selectedTextId !== node.dataset.textId) selectText(node.dataset.textId);
  const clip = selectedText(); if (!clip) return;
  const activeNode = [...$('title-preview').querySelectorAll('.preview-text')].find(item => item.dataset.textId === clip.id);
  const frame = $('video-frame');
  textPreviewDrag = { pointer: event.pointerId, node: activeNode, id: clip.id, mode: event.target.classList.contains('preview-text-resize') ? 'resize' : 'move', x: event.clientX, y: event.clientY, startX: textX(clip), startY: textY(clip), startSize: textSize(clip), width: frame.clientWidth, height: frame.clientHeight, snapshot: JSON.stringify(project) };
  activeNode.setPointerCapture(event.pointerId);
}
function movePreviewText(event) {
  const drag = textPreviewDrag; if (!drag || drag.pointer !== event.pointerId) return;
  const clip = selectedText(); if (!clip || clip.id !== drag.id) return;
  if (drag.mode === 'resize') {
    clip.size = roundText(Math.max(0.02, Math.min(0.15, drag.startSize + ((event.clientX - drag.x) + (event.clientY - drag.y)) / (2 * drag.height) * 0.5)));
    drag.node.style.fontSize = `${drag.height * clip.size}px`;
    $('text-size').value = (clip.size * 100).toFixed(1);
  } else {
    clip.x = roundText(Math.max(0, Math.min(1, drag.startX + (event.clientX - drag.x) / drag.width)));
    clip.y = roundText(Math.max(0, Math.min(1, drag.startY + (event.clientY - drag.y) / drag.height)));
    drag.node.style.left = `${clip.x * 100}%`; drag.node.style.top = `${clip.y * 100}%`;
    $('text-x').value = Math.round(clip.x * 100); $('text-y').value = Math.round(clip.y * 100);
  }
}
function finishPreviewTextDrag(event, cancelled = false) {
  const drag = textPreviewDrag; if (!drag || drag.pointer !== event.pointerId) return;
  textPreviewDrag = null;
  if (drag.node.hasPointerCapture(event.pointerId)) drag.node.releasePointerCapture(event.pointerId);
  if (cancelled) project = JSON.parse(drag.snapshot);
  else if (JSON.stringify(project) !== drag.snapshot) { history.push(drag.snapshot); if (history.length > 60) history.shift(); future = []; }
  renderTimeline(); save();
}
function beginTextDrag(event, clip) {
  if (event.button !== 0) return;
  event.preventDefault(); event.stopPropagation();
  const edge = event.target.dataset.edge;
  selectText(clip.id);
  textDrag = { id: clip.id, pointer: event.pointerId, x: event.clientX, scroll: $('timeline-scroll').scrollLeft, clip: { ...clip }, edge, snapshot: JSON.stringify(project), moved: false };
  $('timeline-scroll').setPointerCapture(event.pointerId);
}
function finishTextDrag(event, cancelled = false) {
  const drag = textDrag; if (!drag || drag.pointer !== event.pointerId) return;
  textDrag = null;
  if ($('timeline-scroll').hasPointerCapture(event.pointerId)) $('timeline-scroll').releasePointerCapture(event.pointerId);
  if (cancelled) project = JSON.parse(drag.snapshot);
  else if (JSON.stringify(project) !== drag.snapshot) { history.push(drag.snapshot); if (history.length > 60) history.shift(); future = []; }
  renderTimeline(); save();
}
function setupText() {
  $('add-text').onclick = addText; $('timeline-text').onclick = addText; $('text-remove').onclick = removeText;
  $('title-preview').addEventListener('pointerdown', beginPreviewTextDrag);
  window.addEventListener('pointermove', movePreviewText);
  window.addEventListener('pointerup', event => finishPreviewTextDrag(event));
  window.addEventListener('pointercancel', event => finishPreviewTextDrag(event, true));
  $('text-at').onchange = event => changeText('at', event.target.value);
  $('text-duration').onchange = event => changeText('duration', event.target.value);
  for (const [id, key] of [['text-x', 'x'], ['text-y', 'y'], ['text-size', 'size']]) $(id).onchange = event => changeTextAppearance(key, event.target.value);
  $('text-at-playhead').onclick = () => changeText('at', Number($('scrubber').value));
  $('title-text').onfocus = () => { textTyping = false; };
  $('title-text').oninput = event => {
    const clip = selectedText(); if (!clip) return;
    if (!textTyping) { remember(); textTyping = true; }
    clip.text = event.target.value;
    const node = [...$('text-tracks').querySelectorAll('.text-clip')].find(item => item.dataset.textId === clip.id);
    if (node) { node.querySelector('span').textContent = `T  ${clip.text || 'Empty text'} · ${time(clip.duration)}`; node.setAttribute('aria-label', `Edit text: ${clip.text || 'Empty text'}`); }
    $('selected-name').textContent = clip.text || 'Text overlay';
    syncText(Number($('scrubber').value)); save();
  };
  $('title-text').onblur = () => { textTyping = false; };
  window.addEventListener('pointermove', event => {
    const drag = textDrag; if (!drag || drag.pointer !== event.pointerId) return;
    if (!drag.moved && Math.abs(event.clientX - drag.x) < 4) return;
    drag.moved = true; autoScrollTimeline(event.clientX);
    const clip = selectedText(); if (!clip) return;
    const delta = (event.clientX - drag.x + $('timeline-scroll').scrollLeft - drag.scroll) / pixelsPerSecond;
    if (drag.edge === 'start') {
      clip.at = Math.max(0, Math.min(drag.clip.at + drag.clip.duration - 0.1, Math.round((drag.clip.at + delta) * 100) / 100));
      clip.duration = Math.round((drag.clip.at + drag.clip.duration - clip.at) * 100) / 100;
    } else if (drag.edge === 'end') clip.duration = Math.max(0.1, Math.min(3600, Math.round((drag.clip.duration + delta) * 100) / 100));
    else clip.at = Math.max(0, Math.min(86400, Math.round((drag.clip.at + delta) * 100) / 100));
    renderTimeline();
  });
  window.addEventListener('pointerup', event => finishTextDrag(event));
  window.addEventListener('pointercancel', event => finishTextDrag(event, true));
}
