# Frame — video editing studio

Frame runs in two interchangeable modes from the same frontend:

1. **Local Desktop Studio (Node.js + native FFmpeg):** Double-click **Start Frame.cmd** in this folder to open the editor in your browser, or run `npm install --prefer-offline` once and `npm start`, then open http://127.0.0.1:4317. The server only listens on this computer and supports files up to 8 GB with native hardware-speed FFmpeg rendering. **Stop Frame.cmd** stops the server started by the launcher (finish your export first).
2. **Static Web Studio (GitHub Pages / Browser Workspace):** Frame also deploys as a 100% static web app (e.g. `https://bookofharry.github.io/frame-studio/`) with zero backend required. When hosted statically (or opened with `?mode=browser`), Frame automatically switches to **Browser Workspace** mode—storing imported videos, audio, and projects locally inside your browser's IndexedDB (`frame-studio-browser-db`) and rendering H.264 MP4 exports in-browser via WebAssembly (`ffmpeg.wasm`).

## Deploying to GitHub Pages

This repository includes an automated GitHub Actions workflow ([.github/workflows/deploy-pages.yml](.github/workflows/deploy-pages.yml)) and static builder ([scripts/build-pages.js](scripts/build-pages.js)):

1. Push your changes to the `main` branch on GitHub (`origin`).
2. In your GitHub repository, open **Settings → Pages**, and under **Build and deployment → Source**, choose **GitHub Actions**.
3. The **Deploy Frame Studio to GitHub Pages** workflow runs `npm test`, bundles `public/`, `hls.js`, generated black-screen media, and same-origin `ffmpeg.wasm` assets into `dist/`, and publishes the live editor at `https://<your-username>.github.io/<repo-name>/`.
4. To build or verify the static GitHub Pages bundle locally, run `npm run build:pages` and `npm run test:pages`.

> **Browser Workspace notes:** In the hosted GitHub Pages version, media stays private inside the visitor's own browser storage (up to 512 MB per video and 150 MB per audio file; 720p/1080p clips work best within WebAssembly memory limits). All 11 bundled starter tracks work out of the box, and visitors can optionally connect their own Epidemic Sound API key in their browser's IndexedDB.

## Editing a video

For faster playback, select a clip and choose **Audio → Playback speed → 7×**. This changes both the preview and export speed; a seven-second clip becomes approximately one second. The edited duration updates in the timeline and library, and the setting is retained in saved projects.

1. Move the playhead to the time where a video should start, then click **Import** and select one or more files. Videos imported through the import area or file picker start at that time. Drag a library thumbnail or a video file onto the timeline for precise placement; the drop marker shows its start time. Inserting inside an existing clip splits that clip and resumes it after the new video. Use **Add at playhead** on a library card to reuse the full source. Search finds videos by filename. Each project has its own media library. **New** starts a separate project with an empty library and timeline; **Projects** lists saved projects so you can switch back to earlier edits.
2. Select a clip on the full-width timeline. Drag its left or right edge to trim; the player and library show the change immediately. Drag the middle of a clip to reorder it. Neighboring clips stay connected. Use the ruler or drag the white playhead to seek. The zoom slider and **Fit** control how much of the timeline you see.
3. Use **Video**, **Audio**, **Adjust**, and **Text** in the right inspector for exact trim values, crop/canvas settings, original audio volume, speed, color, and timed text overlays. **Crop** in the timeline toolbar opens the draggable crop selection. Original canvas uses the first clip's cropped dimensions; other canvas shapes fit cropped clips with padding where needed.
4. Click the single **Export** button in the top right, choose quality and resolution, and wait for rendering. Click **Download MP4**, choose a filename and destination, and save every timeline clip as one video. Use **Save location** in the top bar to choose a default export folder; the naming dialog can override it for one video. Supported browsers remember the folder choice and may ask for write access again later. Browser Downloads remains available. Files saved to a chosen folder receive a numbered suffix if that name already exists.

Use **+ Black screen** above the timeline to insert a silent black clip at the playhead. Choose a duration from 0.1 to 60 seconds. The clip can be trimmed, moved, duplicated, undone, saved with the project, and exported like other video clips. You can also reuse it from Project media.

Use **+ Add text** above the timeline or **Text → Add text at playhead** in the inspector. Choose a duration before adding, then edit the words, start time, and duration in the inspector. Text has its own lane below video: drag the clip to move it, or drag an edge to change when it appears. On the video preview, drag the text to position it or drag its corner handle to resize it; the inspector also has exact position and size controls. Long text wraps into the same lines in preview and export, with text size relative to the video frame. Multiple text clips can overlap; preview and export show them only within their intervals. Older full-video titles become a full-length text clip when opened.

Space plays or pauses; Left/Right step through time (Shift steps ten frames). Ctrl+B splits at the playhead, Delete removes the selected clip, and Ctrl+D duplicates it. Ctrl+Z undoes; Ctrl+Shift+Z or Ctrl+Y redoes. Home/End go to the beginning/end. Projects automatically save in this browser. **Save project** saves the current edit to the local project list. **Projects** shows recent projects and lets you open or delete saved edits without losing active work. Use **Download current backup**, **Import project file**, or **Clean up unused files** in that dialog to export/import project JSON backups or reclaim disk space from unreferenced media and old exports. Existing project files remain compatible.

The left library stays synchronized with the timeline. Each clip row shows its edited playback duration, source in/out times, and trim/crop/color/audio/speed status. Split clips and repeated uses of a video have separate rows; click a row to select that exact timeline clip. The thumbnail duration follows the selected clip, or shows the combined duration for multiple unselected clips. Original duration remains labeled in the source details. Undo, removal, reordering, and reopening a project update these rows automatically. **Add at playhead** inserts a fresh copy of the full source video at the selected time.

## Joining two or more videos

Videos join automatically in timeline order. Click **Arrange & join** to review the sequence: drag numbered rows or use the arrows to reorder, remove clips, and choose **Insert after** on a row before adding a video from Project media. Set a project cross dissolve of 0.35, 0.6, or 1 second, or choose a hard cut. To improve one specific join, select the clip before it and choose **Video → Transition to next clip → Smooth dissolve** or **Gentle dissolve**; that choice previews and exports without changing the other joins. The picture and source audio blend during a dissolve, and the overlap shortens the timeline by the shown amount. Very short clips use a shorter dissolve automatically; an exact split of continuous footage remains seamless. Opening the builder never duplicates clips by itself; trims, crop, speed, color and audio settings stay with each clip. Applying the sequence is one undoable action. **Play all** previews the sequence; **Export** saves it as one MP4. Imported music keeps its timeline placement when transitions change.

## Discover music without uploading

Open **Audio > Discover** to browse the bundled starter library. Search by title, instrument, or mood, filter by Emotional, Cinematic, Happy, Suspense, Nature, or Sound Effects, listen with **Preview**, and choose **+ Add** to place a sound at the playhead. The bundled media are served by the local app and work without an internet connection. **Project audio** contains only sources used or imported in the current project; **New** clears that list while the shared Discover catalog stays available.

The collection includes five 60-second Kevin MacLeod music excerpts (CC BY 4.0), three park recordings by Thimras (CC0), and three synthesized Frame Studio effects (CC0). Tracks requiring attribution are labeled. For those tracks, download the credits text beside the completed MP4 and include it in the video description or credits. Credits refer to the exported snapshot, even if the project is edited during rendering. Original sources, license links, modifications, and checksums are recorded in public/audio-catalog/catalog.json and CREDITS.txt. Rebuild bundled assets with npm run catalog:rebuild; this maintainer command needs internet access.

### Provider connections

Open the gear icon beside **Discover / Project audio**.

- **Epidemic Sound:** enter an API key from https://www.epidemicsound.com/tools/api/ and use **Verify & save**. The app checks the key before saving it. Search and HLS previews use the documented API. Development access is preview-only in Frame; adding or exporting requires a production agreement covering this editor's users and local MP4 downloads, recorded using its agreement reference. The app reports preview, download, and export events to the provider. Provider quotas and track download permissions still apply. This adapter is covered by mocked contract tests; live account access has not been tested without credentials.
- Credentials are stored locally in the ignored data/audio-connections.json file, never returned by the status endpoint or saved in project JSON. Protect this folder as private app data. Alternatively set EPIDEMIC_API_KEY and EPIDEMIC_LICENSE_REFERENCE in the server environment; restart after changing them. Disconnect removes saved credentials and blocks new exports of associated paid tracks until the matching license is reconnected.
- **Popular songs / Feed Clips:** onboarding information and links are provided. Playback and importing are not enabled: no partner account or approved agreement is available. Standard terms specify US-only access, clips up to 60 seconds, and restrictions on offline use and external sharing. This local editor needs a provider-approved agreement for its territories, downloadable MP4 workflow, storage, rights checks, reporting, and Content ID before that integration can be activated. This is not a free or working popular-song catalog.

Provider sources: https://developers.epidemicsound.com/docs/api-reference/ and https://www.feed.fm/clips-terms-conditions . No credentials or subscriptions are included with Frame.

## Adding music and sound effects

Open **Audio** in the left sidebar and click **Import audio**, or use **+ Add music** above the timeline. MP3, WAV, M4A, AAC, FLAC, and OGG files are supported. You can import music before or after adding videos. Files stay on this computer.

Imported audio appears on separate green timeline lanes, starting at the playhead. A batch of audio files is added consecutively. Use **Add at playhead** to reuse a sound from the audio library. Select a music clip to adjust its timeline start, source trim in/out, and volume in the inspector. Drag the middle to move it, or drag its edges to trim. **Remove music clip** or Delete removes the selected music; Undo restores it. Up to 20 music clips can overlap.

Music plays alongside the video's original sound and keeps its own speed when you change a video's speed. Select a video clip and use its Audio controls to lower or mute its original sound. Playback, pause, and seeking keep music aligned with the video. Export mixes both into the MP4 and limits peaks; music is cut off when the video ends. The music lanes do not extend the exported video's duration. Preview mixing may differ slightly at very high combined volumes.

Music edits and source references are included in automatic saving and **Save project**. **New** clears the music library and lanes; **Open** restores them. Keep the app's data folder with your saved project files.

## Quality and limitations

- Exports use FFmpeg, browser-compatible H.264 `yuv420p` video, AAC audio, and adjustable CRF quality. Excellent uses CRF 18. Source resolution and frame rate (up to 60 fps) are the defaults. 720p, 1080p, and 4K options refer to the short edge, respecting the canvas orientation. Completed MP4 and music-credits download links continue to work after restarting the local app while the export files remain in `data/exports`.
- Increasing resolution cannot recreate detail missing from a source. This version exports standard 8-bit SDR; it does not implement HDR tone mapping or professional color management.
- Browser color/text preview is approximate. Export uses FFmpeg's color and text filters. Audio speed changes preserve pitch.
- Browser playback depends on supported codecs. H.264 MP4 works best. FFmpeg can import/export additional formats whose browser preview may be unavailable.
- Maximum import: 20 files at a time, 8 GB per file. One export runs at a time. Large/4K exports require free disk space and may take time.
- This version supports sequential clips, cross dissolves, original audio, timed text clips, cuts, trim, crop, speed, and basic color. It also supports imported music and sound effects with independent placement, trim, and volume. It does not yet include animated titles or automatic captions.

## Files and privacy

Videos and audio are copied into `data/media`; rendered exports are stored in `data/exports`, and saving to a chosen folder writes another copy there. Project snapshots are saved in this browser and store media IDs rather than embedding video files. Starting a new project creates a separate entry in **Projects** and clears the visible library and timeline without deleting source files used by earlier projects. Keep the `data` folder when moving or backing up the app; download project backups from **Projects** too. No video uploads to an external service are used. Imported media and exports remain until you remove them from the data folder while the app is stopped. Temporary export files are removed after rendering.

## Verification

`npm test` generates small video fixtures and checks importing, invalid input handling, cross-origin request blocking, and a real MP4 export with trim, speed, text, colors, mixed orientation, and audio/silent clips. It checks the output codec, resolution, duration, frame rate, and audio track. Test data uses an isolated temporary directory.

Crop tests also decode the exported pixels to verify that discarded content is removed, and reject crops outside the source frame. Run `npm run test:browser` after `npm test` to check editing activation, crop dragging/resizing, presets, cancel, undo, save/reopen, playback, download, and mobile layout in Microsoft Edge. Browser tests use an isolated library.

Join tests export three different colored videos and check frames from the beginning, middle, and end to verify all three appear in the selected order. Browser checks cover batch import, later imports, multi-selection order, reordering, cancellation, batch undo, Play all, and export. The studio checks exercise real pointer dragging on both trim handles, dragging clips to reorder, media insertion, ruler/playhead seeking, zoom, search, keyboard split/duplicate, undo/redo, inspector tabs, and desktop/mobile layout.

Run `npm run test:transition` to verify a late cut near 1:49 only blends decoded, playing frames, completes the clip handoff, and accepts a longer dissolve on one cut.

The workspace redesign was informed by CapCut's official [editing guide](https://www.capcut.com/resource/free-video-edit) and [desktop workflow](https://www.capcut.com/resource/how-to-use-capcut). It uses a media/player/inspector layout with direct timeline editing; the supported feature list above defines Frame's current scope.

FFmpeg filter reference: https://ffmpeg.org/ffmpeg-filters.html

Run `npm run test:music` after `npm test` for music import, drag/trim/volume controls, preview synchronization across video cuts and speed changes, project persistence, export, and mobile layout. Backend music tests decode exported samples and measure frequencies to verify source sound, music timing, trim, volume, mute, and the video end boundary.

Catalog checks: npm test covers bundled audio integrity, search, attribution, deduplicated imports, export credits, and provider credentials/licensing/reporting with mocked API responses. npm run test:catalog checks the browser discovery flow, real preview playback, addition/export/credits, connection states, and mobile layout.
