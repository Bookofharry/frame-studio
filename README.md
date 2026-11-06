# Frame — local video studio

Double-click **Start Frame.cmd** in this folder to open the editor in your browser. Node.js is required and is already installed on this computer. The first installation needs internet access to download FFmpeg. After that, editing works offline.

Alternatively, run `npm install` once, then `npm start`, and open http://127.0.0.1:4317. The server only listens on this computer. **Stop Frame.cmd** stops the server started by the launcher (finish your export first). For a terminal-started server, press Ctrl+C in that terminal.

## Editing a video

For faster playback, select a clip and choose **Audio → Playback speed → 7×**. This changes both the preview and export speed; a seven-second clip becomes approximately one second. The edited duration updates in the timeline and library, and the setting is retained in saved projects.

1. Click **Import** and select multiple files, or drop files onto the import area. Every imported video is appended to the timeline. Drag a library thumbnail onto the timeline to insert another copy at a particular position. Search finds videos by filename. Each project has its own media library. **New** starts with an empty library and timeline; **Open** restores a saved project's media and edits.
2. Select a clip on the full-width timeline. Drag its left or right edge to trim; the player and library show the change immediately. Drag the middle of a clip to reorder it. Neighboring clips stay connected. Use the ruler or drag the white playhead to seek. The zoom slider and **Fit** control how much of the timeline you see.
3. Use **Video**, **Audio**, **Adjust**, and **Text** in the right inspector for exact trim values, crop/canvas settings, original audio volume, speed, color, and the global title. **Crop** in the timeline toolbar opens the draggable crop selection. Original canvas uses the first clip's cropped dimensions; other canvas shapes fit cropped clips with padding where needed.
4. Click the single **Export** button in the top right, choose quality and resolution, and wait for rendering. Click **Download MP4** to save every timeline clip as one video.

Space plays or pauses; Left/Right step through time (Shift steps ten frames). Ctrl+B splits at the playhead, Delete removes the selected clip, and Ctrl+D duplicates it. Ctrl+Z undoes; Ctrl+Shift+Z or Ctrl+Y redoes. Home/End go to the beginning/end. Projects automatically save in this browser. **Save project** downloads a project JSON file; **Open** restores it on this computer. Existing project files are compatible with the redesigned workspace.

The left library stays synchronized with the timeline. Each clip row shows its edited playback duration, source in/out times, and trim/crop/color/audio/speed status. Split clips and repeated uses of a video have separate rows; click a row to select that exact timeline clip. The thumbnail duration follows the selected clip, or shows the combined duration for multiple unselected clips. Original duration remains labeled in the source details. Undo, removal, reordering, and reopening a project update these rows automatically. **Add original to timeline** adds a fresh copy of the full source video.

## Joining two or more videos

Videos join automatically in timeline order. Drag clips to arrange them, or use the left/right arrows in the toolbar. **Add from library** also lets you select multiple existing videos in order. The selections append after the existing timeline and preserve your edits. **Play all** previews the complete sequence from the beginning. **Export** saves every clip as one MP4. A batch addition or drag operation can be undone in one step.

## Adding music and sound effects

Open **Audio** in the left sidebar and click **Import audio**, or use **+ Add music** above the timeline. MP3, WAV, M4A, AAC, FLAC, and OGG files are supported. You can import music before or after adding videos. Files stay on this computer.

Imported audio appears on separate green timeline lanes, starting at the playhead. A batch of audio files is added consecutively. Use **Add at playhead** to reuse a sound from the audio library. Select a music clip to adjust its timeline start, source trim in/out, and volume in the inspector. Drag the middle to move it, or drag its edges to trim. **Remove music clip** or Delete removes the selected music; Undo restores it. Up to 20 music clips can overlap.

Music plays alongside the video's original sound and keeps its own speed when you change a video's speed. Select a video clip and use its Audio controls to lower or mute its original sound. Playback, pause, and seeking keep music aligned with the video. Export mixes both into the MP4 and limits peaks; music is cut off when the video ends. The music lanes do not extend the exported video's duration. Preview mixing may differ slightly at very high combined volumes.

Music edits and source references are included in automatic saving and **Save project**. **New** clears the music library and lanes; **Open** restores them. Keep the app's data folder with your saved project files.

## Quality and limitations

- Exports use FFmpeg, H.264 video, AAC audio, and adjustable CRF quality. Excellent uses CRF 18. Source resolution and frame rate (up to 60 fps) are the defaults. 720p, 1080p, and 4K options refer to the short edge, respecting the canvas orientation.
- Increasing resolution cannot recreate detail missing from a source. This version exports standard 8-bit SDR; it does not implement HDR tone mapping or professional color management.
- Browser color/text preview is approximate. Export uses FFmpeg's color and text filters. Audio speed changes preserve pitch.
- Browser playback depends on supported codecs. H.264 MP4 works best. FFmpeg can import/export additional formats whose browser preview may be unavailable.
- Maximum import: 20 files at a time, 8 GB per file. One export runs at a time. Large/4K exports require free disk space and may take time.
- This version supports sequential clips, original audio, a global title, cuts, trim, crop, speed, and basic color. It also supports imported music and sound effects with independent placement, trim, and volume. It does not yet include transitions, animated titles, or automatic captions.

## Files and privacy

Videos and audio are copied into `data/media`; exports are stored in `data/exports`. Project files store their own media IDs and do not embed the videos. Starting a new project clears the visible library and timeline without deleting source files used by saved projects. Save before starting a new project if you want to reopen the previous edit later. Keep the `data` folder when moving/backing up the app. No video uploads to an external service are used. Imported media and exports remain until you remove them from the data folder while the app is stopped. Temporary export files are removed after rendering.

## Verification

`npm test` generates small video fixtures and checks importing, invalid input handling, cross-origin request blocking, and a real MP4 export with trim, speed, text, colors, mixed orientation, and audio/silent clips. It checks the output codec, resolution, duration, frame rate, and audio track. Test data uses an isolated temporary directory.

Crop tests also decode the exported pixels to verify that discarded content is removed, and reject crops outside the source frame. Run `npm run test:browser` after `npm test` to check editing activation, crop dragging/resizing, presets, cancel, undo, save/reopen, playback, download, and mobile layout in Microsoft Edge. Browser tests use an isolated library.

Join tests export three different colored videos and check frames from the beginning, middle, and end to verify all three appear in the selected order. Browser checks cover batch import, later imports, multi-selection order, reordering, cancellation, batch undo, Play all, and export. The studio checks exercise real pointer dragging on both trim handles, dragging clips to reorder, media insertion, ruler/playhead seeking, zoom, search, keyboard split/duplicate, undo/redo, inspector tabs, and desktop/mobile layout.

The workspace redesign was informed by CapCut's official [editing guide](https://www.capcut.com/resource/free-video-edit) and [desktop workflow](https://www.capcut.com/resource/how-to-use-capcut). It uses a media/player/inspector layout with direct timeline editing; the supported feature list above defines Frame's current scope.

FFmpeg filter reference: https://ffmpeg.org/ffmpeg-filters.html

Run `npm run test:music` after `npm test` for music import, drag/trim/volume controls, preview synchronization across video cuts and speed changes, project persistence, export, and mobile layout. Backend music tests decode exported samples and measure frequencies to verify source sound, music timing, trim, volume, mute, and the video end boundary.
# opensourceVideoEditot
