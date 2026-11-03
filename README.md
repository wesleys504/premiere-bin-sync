# Bin Sync for Premiere Pro (Beta)

Link a bin to a folder on disk. Later, select the bin and hit **Sync**: only files that aren't already in the project get imported, into that bin. Subfolders become sub-bins (optional).

**Requires:** Premiere Pro 25.2 or newer. Tested on Premiere Pro Beta on macOS.

## Install (Mac, Premiere Pro Beta)

1. **Turn on developer mode.** In Premiere Pro Beta: Settings > Plugins > Enable developer mode. Restart Premiere.
2. **Get the UXP Developer Tool.** Creative Cloud app > Apps > search "UXP Developer Tools" > Install.
3. **Put this folder somewhere permanent**, e.g. `Documents/Premiere Plugins/BinSync`.
4. **Load it.** Open UXP Developer Tool (Premiere Beta should be listed on the left). Click **Add Plugin**, pick `manifest.json` in this folder, then click **Load** on the plugin row.
5. **Open the panel:** Window > UXP Plugins > Bin Sync. Dock it next to your Project panel.

Note: a plugin loaded through the Developer Tool has to be re-loaded (step 4's Load button) after you restart Premiere. To install it permanently, click the plugin's ••• menu in the Developer Tool > **Package**, then double-click the `.ccx` file it makes.

## Using it

- **Link Folder…** Select a bin (or any clip inside it) in the Project panel, click Link Folder…, pick the folder on disk. It does a first sync right away.
- **Sync Selected Bin** Select the bin (or a clip in it) and click. Also available as a menu item: Window > UXP Plugins > Bin Sync > Sync Selected Bin.
- **Sync All** Syncs every linked bin in the current project.
- **Unlink** Removes the link only. Clips already imported stay.

Details:
- Checks the whole project for duplicates, so moving a clip to another bin won't make it re-import.
- Files still copying are skipped (it waits 2 seconds and checks whether the size changed). Sync again when the copy finishes.
- Hidden files, auto-save folders and cache folders are ignored.
- Links are saved per project file. If you rename a linked bin, just link it again.
- File types it picks up are listed at the top of `index.js` (`MEDIA_EXTS`). Add any extension you need.

## Renamed or moved files (new in 1.1)

Bin Sync never imports a second copy of a file it already brought in. Instead it relinks the clip, so your edits in the timeline keep working:

- **Renamed or moved in Premiere** (new name, different bin): nothing changes. The clip is still recognized.
- **Renamed or moved in Finder:** the clip goes offline in Premiere. On the next sync, Bin Sync finds the file by its size (recorded when it was imported) and relinks the clip to the new name or folder.
- **Drive came back with a different name** (for example "Media 1" instead of "Media"): every clip is relinked to the new drive. Nothing is imported twice.
- **Same file name in two folders** (like `A001.mov` on two camera cards): both are kept as separate clips.
- **Not sure?** If a new file could belong to more than one offline clip, Bin Sync doesn't guess. It skips the file and tells you, so you can relink it yourself.

Clips imported with version 1.0 get their sizes recorded the first time you sync with 1.1, so sync once before renaming files on disk.

## Test checklist

A good way to check it on your own setup. Each step should show no duplicate clips:

1. Link a folder with subfolders, then sync twice.
2. Rename a clip and move it to another bin in Premiere, then sync.
3. Add a file with the same name as an existing one, in a different subfolder, then sync twice.
4. Rename a file in Finder, then sync: the clip should relink, not duplicate.
5. Move a file to another subfolder in Finder, then sync.

Thanks to the editors who suggested these tests.

## License

MIT. See `LICENSE`.
