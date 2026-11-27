(function (global) {
  const CACHE_NAME = 'frame-ffmpeg-runtime-v1';
  const VERSION = '0.12.10';
  let pending = null;
  let prepared = null;
  const listeners = new Set();
  const report = detail => {
    for (const listener of listeners) listener({ progress: 4, message: 'Loading Frame Studio video engine…', detail });
  };

  async function cacheStore() {
    try { return await global.caches?.open(CACHE_NAME); } catch { return null; }
  }

  async function validate(bytes, asset) {
    if (!bytes.byteLength || (asset?.size && bytes.byteLength !== asset.size)) {
      throw new Error('Incomplete engine download');
    }
    if (asset?.sha256) {
      const digest = await global.crypto.subtle.digest('SHA-256', bytes);
      const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      if (hash !== asset.sha256) throw new Error('Engine download checksum mismatch');
    }
  }

  // Cache only complete, verified responses. A failed transfer retries this
  // part, while successful parts survive both a failed export and page reload.
  async function download(url, asset = null, { optional = false, fresh = false } = {}) {
    const cache = await cacheStore();
    const readCache = async () => {
      try {
        const response = await cache?.match(url);
        if (response) {
          const bytes = await response.arrayBuffer();
          await validate(bytes, asset);
          return bytes;
        }
      } catch { await cache?.delete(url).catch(() => {}); }
      return null;
    };
    if (!fresh) {
      const bytes = await readCache();
      if (bytes) return bytes;
    }
    let failure;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      let timeout;
      const resetTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => controller.abort(), 30000);
      };
      resetTimeout();
      try {
        const response = await fetch(url, { signal: controller.signal, cache: attempt || fresh ? 'reload' : 'default' });
        if (optional && response.status === 404) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if ((response.headers.get('content-type') || '').includes('text/html')) throw new Error('Received HTML instead of engine data');
        let bytes;
        if (response.body?.getReader) {
          const reader = response.body.getReader();
          const chunks = [];
          try {
            while (true) {
              resetTimeout();
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
            }
            bytes = await new Blob(chunks).arrayBuffer();
          } finally { reader.releaseLock(); }
        } else {
          bytes = await response.arrayBuffer();
        }
        await validate(bytes, asset);
        try { await cache?.put(url, new Response(bytes)); } catch { /* Storage may be disabled or full. */ }
        return bytes;
      } catch (error) {
        failure = error;
      } finally {
        clearTimeout(timeout);
      }
      if (attempt < 2) {
        report(`Connection interrupted. Retrying download (${attempt + 2}/3)…`);
        await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
      }
    }
    if (fresh) {
      const bytes = await readCache();
      if (bytes) return bytes;
    }
    throw new Error(`Could not download ${new URL(url).pathname.split('/').pop()}: ${failure?.message || failure}`);
  }

  function installWrapper(url) {
    if (global.FFmpegWASM?.FFmpeg) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const finish = error => {
        clearTimeout(timeout);
        script.remove();
        if (error) reject(error); else resolve();
      };
      const timeout = setTimeout(() => finish(new Error('Video engine script timed out')), 15000);
      script.src = url;
      script.onload = () => finish(global.FFmpegWASM?.FFmpeg ? null : new Error('Invalid video engine script'));
      script.onerror = () => finish(new Error('Video engine script could not load'));
      document.head.append(script);
    });
  }

  async function prepareSource(source) {
    const urls = [];
    const blobURL = (bytes, type) => {
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      urls.push(url);
      return url;
    };
    try {
      const asset = async name => {
        const info = source.manifest?.assets[name];
        const base = name === 'ffmpeg-core.js' ? source.core : source.wrapper;
        return download(new URL(info?.file || name, base).href, info);
      };
      await installWrapper(blobURL(await asset('ffmpeg.js'), 'text/javascript'));
      const classWorkerURL = blobURL(await asset('814.ffmpeg.js'), 'text/javascript');
      const coreURL = blobURL(await asset('ffmpeg-core.js'), 'text/javascript');
      let wasm;
      if (source.manifest) {
        const parts = [];
        let loaded = 0;
        for (const part of source.manifest.parts) {
          parts.push(await download(new URL(part.file, source.core).href, part));
          loaded += part.size;
          for (const listener of listeners) listener({
            progress: 4 + Math.round(10 * loaded / source.manifest.size),
            message: 'Loading Frame Studio video engine…',
            detail: `${(loaded / 1048576).toFixed(1)} / ${(source.manifest.size / 1048576).toFixed(1)} MB ready`
          });
        }
        if (loaded !== source.manifest.size) throw new Error('Incomplete engine manifest');
        wasm = new Blob(parts, { type: 'application/wasm' });
      } else {
        report('Downloading video engine from backup source (31 MB)…');
        wasm = await download(new URL('ffmpeg-core.wasm', source.core).href);
        const header = new Uint8Array(wasm, 0, Math.min(4, wasm.byteLength));
        if (header.join(',') !== '0,97,115,109') throw new Error('Invalid WebAssembly download');
      }
      const wasmURL = blobURL(wasm, 'application/wasm');
      return { FFmpeg: global.FFmpegWASM.FFmpeg, loadConfig: { classWorkerURL, coreURL, wasmURL }, dispose: () => urls.forEach(url => URL.revokeObjectURL(url)) };
    } catch (error) {
      urls.forEach(url => URL.revokeObjectURL(url));
      throw error;
    }
  }

  async function prepare(onProgress) {
    if (onProgress) listeners.add(onProgress);
    try {
      if (!pending) pending = (async () => {
        const base = new URL('./vendor/ffmpeg/', global.location.href).href;
        const manifestBytes = await download(new URL('runtime.json', base).href, null, { optional: true, fresh: true });
        if (manifestBytes) {
          const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
          if (manifest.version !== 1 || !manifest.parts?.length || !manifest.assets || !manifest.size) throw new Error('Invalid engine manifest');
          // Do not restart a failed part as a 31 MB CDN request. The next
          // export resumes from the verified parts already in browser storage.
          return prepareSource({ wrapper: base, core: base, manifest });
        }
        const failures = [];
        for (const cdn of ['https://cdn.jsdelivr.net/npm/', 'https://unpkg.com/']) {
          try {
            return await prepareSource({ wrapper: `${cdn}@ffmpeg/ffmpeg@${VERSION}/dist/umd/`, core: `${cdn}@ffmpeg/core@${VERSION}/dist/esm/` });
          } catch (error) { failures.push(error.message); }
        }
        throw new Error(failures.join('; '));
      })().then(engine => { prepared = engine; return engine; }).catch(error => {
        pending = null;
        console.error('Frame video engine loading failed:', error);
        throw Object.assign(new Error('The video engine could not download. Check your connection and retry Export; completed download parts are saved when browser storage is available.'), { status: 503, cause: error });
      });
      return await pending;
    } finally {
      if (onProgress) listeners.delete(onProgress);
    }
  }

  global.FrameFFmpegLoader = {
    prepare,
    get ready() { return Boolean(prepared); },
    invalidate() { prepared?.dispose(); prepared = null; pending = null; }
  };
})(window);
