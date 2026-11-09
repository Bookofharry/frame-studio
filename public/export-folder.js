let defaultExportDirectory = null;
let folderSaving = false;
let exportFolderChanged = false;

function exportFolderDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('frame-studio-preferences', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('settings');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function storedExportDirectory(handle) {
  const database = await exportFolderDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('settings', handle === undefined ? 'readonly' : 'readwrite');
    const request = handle === undefined ? transaction.objectStore('settings').get('export-directory')
      : handle === null ? transaction.objectStore('settings').delete('export-directory')
        : transaction.objectStore('settings').put(handle, 'export-directory');
    request.onsuccess = () => { if (handle === undefined) resolve(request.result || null); };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => { database.close(); if (handle !== undefined) resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
  });
}
function refreshExportFolderUI() {
  const supported = typeof window.showDirectoryPicker === 'function';
  $('default-folder-label').textContent = defaultExportDirectory ? `Default folder: ${defaultExportDirectory.name}` : 'Browser Downloads';
  $('clear-default-folder').hidden = !defaultExportDirectory;
  $('pick-default-folder').disabled = !supported;
  $('folder-settings-status').textContent = supported
    ? 'Your browser remembers the folder here and may ask for access again later. The app sees its name, not its full path.'
    : 'This browser cannot choose a folder here. Videos will use your browser’s Downloads setting.';
  $('export-default-option').hidden = !defaultExportDirectory || !supported;
  $('export-choose-option').disabled = !supported;
  $('export-default-option').textContent = defaultExportDirectory ? `Default folder: ${defaultExportDirectory.name}` : 'Default folder';
}
async function chooseExportDirectory() {
  return window.showDirectoryPicker({ id: 'frame-studio-exports', mode: 'readwrite', startIn: defaultExportDirectory || 'videos' });
}
async function canWriteExportDirectory(directory) {
  const options = { mode: 'readwrite' };
  if (await directory.queryPermission(options) === 'granted') return true;
  return await directory.requestPermission(options) === 'granted';
}
async function unusedExportFilename(directory, requested) {
  const base = FrameExportName.filename(requested).slice(0, -4);
  for (let index = 1; index <= 999; index++) {
    const candidate = index === 1 ? `${base}.mp4` : `${base} (${index}).mp4`;
    try { await directory.getFileHandle(candidate); }
    catch (error) { if (error.name === 'NotFoundError') return candidate; throw error; }
  }
  throw new Error('This folder has too many files with the same name. Choose a different video name.');
}
function downloadToBrowser(name) {
  const link = document.createElement('a');
  link.href = `/api/exports/${jobId}/download?name=${encodeURIComponent(name)}`;
  document.body.append(link); link.click(); link.remove();
  $('filename-dialog').close();
}
async function saveToExportDirectory(directory, requested) {
  if (!await canWriteExportDirectory(directory)) throw new Error('Folder access was not granted. Choose another folder or Browser Downloads.');
  const filename = await unusedExportFilename(directory, requested);
  const response = await fetch(`/api/exports/${jobId}/download?name=${encodeURIComponent(filename)}`);
  if (!response.ok || !response.body) throw new Error('The MP4 could not be opened for saving. Try downloading it again.');
  const file = await directory.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  const reader = response.body.getReader();
  const totalBytes = Number(response.headers.get('content-length')) || 0;
  let written = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      written += value.byteLength;
      if (totalBytes) {
        const percent = Math.min(99, Math.round(written / totalBytes * 100));
        $('folder-save-progress').value = percent;
        $('folder-save-status').textContent = `Saving to ${directory.name}… ${percent}%`;
      } else $('folder-save-status').textContent = `Saving to ${directory.name}… ${(written / 1048576).toFixed(1)} MB`;
    }
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
  $('folder-save-progress').value = 100;
  $('export-message').textContent = `Saved ${filename} in ${directory.name}`;
  $('filename-dialog').close();
}
function setupExportFolders() {
  refreshExportFolderUI();
  storedExportDirectory().then(handle => {
    if (!exportFolderChanged && handle?.kind === 'directory') defaultExportDirectory = handle;
    refreshExportFolderUI();
  }).catch(() => refreshExportFolderUI());
  $('export-folder-settings').onclick = () => { refreshExportFolderUI(); $('export-folder-dialog').showModal(); };
  $('close-export-folder').onclick = $('done-export-folder').onclick = () => $('export-folder-dialog').close();
  $('pick-default-folder').onclick = async () => {
    try {
      const directory = await chooseExportDirectory();
      exportFolderChanged = true;
      defaultExportDirectory = directory;
      let remembered = true;
      try { await storedExportDirectory(directory); } catch { remembered = false; }
      refreshExportFolderUI();
      if (!remembered) $('folder-settings-status').textContent = 'Folder selected for this session. This browser could not remember it after closing.';
    } catch (error) { if (error.name !== 'AbortError') $('folder-settings-status').textContent = `Could not choose folder: ${error.message}`; }
  };
  $('clear-default-folder').onclick = async () => {
    try { await storedExportDirectory(null); exportFolderChanged = true; defaultExportDirectory = null; refreshExportFolderUI(); }
    catch (error) { $('folder-settings-status').textContent = `Could not clear the saved folder: ${error.message}`; }
  };
  $('download-export').onclick = event => {
    event.preventDefault();
    if (!jobId || $('download-export').hidden) return;
    $('export-filename').value = project.name.trim() || 'My video';
    $('export-destination').value = defaultExportDirectory && typeof window.showDirectoryPicker === 'function' ? 'default' : 'downloads';
    $('folder-save-status').textContent = '';
    $('folder-save-progress').hidden = true; $('folder-save-progress').value = 0;
    $('confirm-filename').disabled = false; $('cancel-filename').disabled = false; $('close-filename').disabled = false;
    $('export-filename-preview').textContent = FrameExportName.filename($('export-filename').value);
    refreshExportFolderUI();
    $('filename-dialog').showModal();
    $('export-filename').focus(); $('export-filename').select();
  };
  $('export-filename').oninput = () => { $('export-filename-preview').textContent = FrameExportName.filename($('export-filename').value); };
  $('close-filename').onclick = $('cancel-filename').onclick = () => { if (!folderSaving) $('filename-dialog').close(); };
  $('filename-dialog').addEventListener('cancel', event => { if (folderSaving) event.preventDefault(); });
  $('filename-form').onsubmit = async event => {
    event.preventDefault(); if (folderSaving) return;
    const requested = $('export-filename').value.trim(); if (!requested) { $('export-filename').focus(); return; }
    const destination = $('export-destination').value;
    if (destination === 'downloads') { downloadToBrowser(requested); return; }
    folderSaving = true;
    $('confirm-filename').disabled = true; $('cancel-filename').disabled = true; $('close-filename').disabled = true;
    $('folder-save-progress').hidden = false; $('folder-save-progress').value = 0;
    $('folder-save-status').textContent = 'Opening save folder…';
    try {
      const directory = destination === 'choose' ? await chooseExportDirectory() : defaultExportDirectory;
      if (!directory) throw new Error('Choose a folder or use Browser Downloads.');
      await saveToExportDirectory(directory, requested);
    } catch (error) {
      $('folder-save-progress').hidden = true;
      $('folder-save-status').textContent = error.name === 'AbortError' ? 'Folder selection cancelled.' : `Could not save: ${error.message}`;
    } finally {
      folderSaving = false;
      $('confirm-filename').disabled = false; $('cancel-filename').disabled = false; $('close-filename').disabled = false;
    }
  };
}
