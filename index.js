// Bin Sync — link a Premiere bin to a folder on disk, then pull in only new files.
const ppro = require("premierepro");
const uxp = require("uxp");
const lfs = uxp.storage.localFileSystem;

// ---------- settings ----------
const MEDIA_EXTS = new Set([
  // video
  "mov", "mp4", "m4v", "mxf", "avi", "mts", "m2ts", "mkv", "webm", "r3d", "braw", "crm", "mpg", "mpeg", "3gp",
  // audio
  "wav", "aif", "aiff", "mp3", "m4a", "aac", "bwf", "flac",
  // stills / graphics
  "png", "jpg", "jpeg", "tif", "tiff", "psd", "ai", "gif", "heic", "exr", "dpx", "bmp", "svg",
  // captions
  "srt", "scc",
]);
const SKIP_FOLDERS = new Set([
  "adobe premiere pro auto-save", "adobe premiere pro video previews", "adobe premiere pro audio previews",
  "media cache", "media cache files", "peak files", ".ds_store",
]);
const STABILITY_WAIT_MS = 2000; // a file whose size changes in this window is still copying
const STORE_KEY = "binsync.links.v1";

// ---------- logging ----------
function log(msg, cls) {
  const el = document.getElementById("log");
  if (!el) { console.log(msg); return; }
  const line = document.createElement("div");
  if (cls) line.className = cls;
  const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  line.textContent = `${t}  ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// ---------- link storage (per project) ----------
function loadAll() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch (e) { return {}; }
}
function saveAll(data) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) { log("Couldn't save links: " + e, "err"); }
}
function linksFor(project) {
  return loadAll()[project.path] || [];
}
function setLinksFor(project, links) {
  const all = loadAll();
  all[project.path] = links;
  saveAll(all);
}

// ---------- project helpers ----------
async function getProject() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No project is open.");
  return project;
}

function asFolder(item) {
  try { return ppro.FolderItem.cast(item); } catch (e) { return null; }
}
function asClip(item) {
  try { return ppro.ClipProjectItem.cast(item); } catch (e) { return null; }
}
function asProjectItem(folder) {
  try { return ppro.ProjectItem.cast(folder) || folder; } catch (e) { return folder; }
}

// Walk the whole project once: every bin (id -> {folder, path}) and every media path already imported.
async function scanProject(project) {
  const root = await project.getRootItem();
  const bins = new Map();
  const mediaPaths = new Set();
  const queue = [{ folder: root, path: "" }];
  while (queue.length) {
    const { folder, path } = queue.shift();
    const items = await folder.getItems();
    for (const item of items) {
      const sub = asFolder(item);
      if (sub) {
        const subPath = path ? `${path}/${item.name}` : item.name;
        bins.set(item.getId(), { folder: sub, path: subPath, name: item.name });
        queue.push({ folder: sub, path: subPath });
        continue;
      }
      const clip = asClip(item);
      if (clip) {
        try {
          const p = await clip.getMediaFilePath();
          if (p) mediaPaths.add(normalize(p));
        } catch (e) { /* sequences etc. have no media path */ }
      }
    }
  }
  return { root, bins, mediaPaths };
}

function normalize(p) {
  return String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// Figure out which bin the user means: a selected bin, or the bin holding a selected clip.
async function getSelectedBin(project, scan) {
  const selection = await ppro.ProjectUtils.getSelection(project);
  const items = await selection.getItems();
  if (!items || !items.length) return null;
  const item = items[0];
  if (scan.bins.has(item.getId())) return { id: item.getId(), ...scan.bins.get(item.getId()) };
  // a clip is selected — use its parent bin
  try {
    const parent = item.getParentBin();
    const pid = parent && ppro.ProjectItem.cast(parent).getId();
    if (pid && scan.bins.has(pid)) return { id: pid, ...scan.bins.get(pid) };
  } catch (e) { /* fall through */ }
  return null;
}

function findLinkedBin(link, scan) {
  if (link.binId && scan.bins.has(link.binId)) return { id: link.binId, ...scan.bins.get(link.binId) };
  for (const [id, b] of scan.bins) if (b.path === link.binPath) return { id, ...b };
  return null;
}

function createChildBin(project, parentFolder, name) {
  let ok = false;
  project.lockedAccess(() => {
    ok = project.executeTransaction((compound) => {
      compound.addAction(parentFolder.createBinAction(name, false));
    }, `Bin Sync: create ${name}`);
  });
  return ok;
}

async function getOrCreateChildBin(project, parentFolder, name) {
  const findIt = async () => {
    for (const item of await parentFolder.getItems()) {
      const f = asFolder(item);
      if (f && item.name === name) return f;
    }
    return null;
  };
  let bin = await findIt();
  if (bin) return bin;
  createChildBin(project, parentFolder, name);
  bin = await findIt();
  if (!bin) throw new Error(`Couldn't create bin "${name}".`);
  return bin;
}

// ---------- disk helpers ----------
async function getLinkedFolderEntry(link) {
  if (link.token) {
    try { return await lfs.getEntryForPersistentToken(link.token); } catch (e) { /* try path */ }
  }
  try { return await lfs.getEntryWithUrl("file:" + link.folderPath); } catch (e) { return null; }
}

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

// Returns [{relDir: "Day 1/A-Cam" or "", files: [entry, ...]}]
async function collectFiles(folderEntry, mirrorSubfolders) {
  const groups = [];
  const walk = async (entry, relDir) => {
    const files = [];
    for (const child of await entry.getEntries()) {
      if (child.name.startsWith(".")) continue;
      if (child.isFolder) {
        if (SKIP_FOLDERS.has(child.name.toLowerCase())) continue;
        if (mirrorSubfolders) await walk(child, relDir ? `${relDir}/${child.name}` : child.name);
        continue;
      }
      if (MEDIA_EXTS.has(extOf(child.name))) files.push(child);
    }
    if (files.length) groups.push({ relDir, files });
  };
  await walk(folderEntry, "");
  return groups;
}

async function sizeOf(entry) {
  try { return (await entry.getMetadata()).size; } catch (e) { return -1; }
}

// Drop any files that are still being copied.
async function onlyFinishedFiles(entries) {
  if (!entries.length) return { ready: [], copying: [] };
  const before = await Promise.all(entries.map(sizeOf));
  await new Promise((r) => setTimeout(r, STABILITY_WAIT_MS));
  const after = await Promise.all(entries.map(sizeOf));
  const ready = [], copying = [];
  entries.forEach((e, i) => (before[i] === after[i] && after[i] > 0 ? ready : copying).push(e));
  return { ready, copying };
}

// ---------- core actions ----------
async function syncLink(project, link, scan) {
  const bin = findLinkedBin(link, scan);
  if (!bin) { log(`Bin "${link.binPath}" no longer exists — unlink it or link again.`, "err"); return 0; }
  const folderEntry = await getLinkedFolderEntry(link);
  if (!folderEntry) { log(`Can't reach folder for "${bin.name}". Is the drive mounted?`, "err"); return 0; }

  const groups = await collectFiles(folderEntry, link.mirrorSubfolders !== false);
  let imported = 0, copyingTotal = 0;

  for (const group of groups) {
    const fresh = group.files.filter((f) => !scan.mediaPaths.has(normalize(f.nativePath)));
    if (!fresh.length) continue;
    const { ready, copying } = await onlyFinishedFiles(fresh);
    copyingTotal += copying.length;
    if (!ready.length) continue;

    let target = bin.folder;
    if (group.relDir) {
      for (const part of group.relDir.split("/")) target = await getOrCreateChildBin(project, target, part);
    }
    const paths = ready.map((f) => f.nativePath);
    const ok = await project.importFiles(paths, true, asProjectItem(target), false);
    if (ok) {
      paths.forEach((p) => scan.mediaPaths.add(normalize(p)));
      imported += paths.length;
      log(`+${paths.length} → ${bin.name}${group.relDir ? "/" + group.relDir : ""}`, "ok");
    } else {
      log(`Premiere refused some files in ${group.relDir || bin.name} (unsupported format?).`, "warn");
    }
  }
  if (copyingTotal) log(`${copyingTotal} file(s) still copying — sync again when they finish.`, "warn");
  if (!imported && !copyingTotal) log(`"${bin.name}" is already up to date.`);
  link.lastSync = Date.now();
  return imported;
}

let busy = false;
async function guarded(fn) {
  if (busy) { log("Already working — one sec.", "warn"); return; }
  busy = true;
  try { await fn(); } catch (e) { log(String(e.message || e), "err"); }
  finally { busy = false; renderLinks().catch(() => {}); }
}

function linkFolder() {
  return guarded(async () => {
    const project = await getProject();
    const scan = await scanProject(project);
    const bin = await getSelectedBin(project, scan);
    if (!bin) { log("Select a bin (or a clip inside one) in the Project panel first.", "warn"); return; }
    const folder = await lfs.getFolder();
    if (!folder) return;
    let token = null;
    try { token = await lfs.createPersistentToken(folder); } catch (e) { /* path fallback */ }
    const links = linksFor(project).filter((l) => l.binId !== bin.id && l.binPath !== bin.path);
    const link = {
      binId: bin.id,
      binPath: bin.path,
      folderPath: folder.nativePath,
      token,
      mirrorSubfolders: document.getElementById("optSubfolders").checked,
    };
    links.push(link);
    setLinksFor(project, links);
    log(`Linked "${bin.name}" ↔ ${folder.nativePath}`, "ok");
    const n = await syncLink(project, link, scan);
    setLinksFor(project, links);
    if (n) log(`Imported ${n} file(s).`, "ok");
  });
}

function syncSelected() {
  return guarded(async () => {
    const project = await getProject();
    const scan = await scanProject(project);
    const bin = await getSelectedBin(project, scan);
    if (!bin) { log("Select a linked bin (or a clip inside one) first.", "warn"); return; }
    const links = linksFor(project);
    const link = links.find((l) => l.binId === bin.id || l.binPath === bin.path);
    if (!link) { log(`"${bin.name}" isn't linked yet — use Link Folder…`, "warn"); return; }
    await syncLink(project, link, scan);
    setLinksFor(project, links);
  });
}

function syncAll() {
  return guarded(async () => {
    const project = await getProject();
    const links = linksFor(project);
    if (!links.length) { log("No linked bins in this project yet.", "warn"); return; }
    const scan = await scanProject(project);
    let total = 0;
    for (const link of links) total += await syncLink(project, link, scan);
    setLinksFor(project, links);
    log(`Sync All done — ${total} new file(s).`, total ? "ok" : undefined);
  });
}

function syncOne(index) {
  return guarded(async () => {
    const project = await getProject();
    const links = linksFor(project);
    const scan = await scanProject(project);
    await syncLink(project, links[index], scan);
    setLinksFor(project, links);
  });
}

function unlinkSelected() {
  return guarded(async () => {
    const project = await getProject();
    const scan = await scanProject(project);
    const bin = await getSelectedBin(project, scan);
    if (!bin) { log("Select the bin to unlink first.", "warn"); return; }
    const links = linksFor(project);
    const kept = links.filter((l) => l.binId !== bin.id && l.binPath !== bin.path);
    if (kept.length === links.length) { log(`"${bin.name}" wasn't linked.`); return; }
    setLinksFor(project, kept);
    log(`Unlinked "${bin.name}". Clips already imported stay put.`);
  });
}

function unlinkIndex(index) {
  return guarded(async () => {
    const project = await getProject();
    const links = linksFor(project);
    const [gone] = links.splice(index, 1);
    setLinksFor(project, links);
    if (gone) log(`Unlinked "${gone.binPath}".`);
  });
}

// ---------- panel UI ----------
async function renderLinks() {
  const box = document.getElementById("links");
  if (!box) return;
  let project;
  try { project = await ppro.Project.getActiveProject(); } catch (e) { project = null; }
  if (!project) { box.innerHTML = '<div class="empty">Open a project to see links.</div>'; return; }
  const links = linksFor(project);
  box.innerHTML = "";
  if (!links.length) {
    box.innerHTML = '<div class="empty">None yet. Select a bin, then Link Folder…</div>';
    return;
  }
  links.forEach((l, i) => {
    const div = document.createElement("div");
    div.className = "link";
    const when = l.lastSync ? new Date(l.lastSync).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "never";
    div.innerHTML = `<div class="bin"></div><div class="folder"></div>
      <div class="row"><button class="small primary">Sync</button><button class="small">Unlink</button>
      <span style="color:#888;font-size:10.5px;align-self:center">last: ${when}</span></div>`;
    div.querySelector(".bin").textContent = l.binPath;
    div.querySelector(".folder").textContent = l.folderPath + (l.mirrorSubfolders === false ? "  (top level only)" : "");
    const [s, u] = div.querySelectorAll("button");
    s.addEventListener("click", () => syncOne(i));
    u.addEventListener("click", () => unlinkIndex(i));
    box.appendChild(div);
  });
}

function wireUI() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("click", fn); };
  on("btnLink", linkFolder);
  on("btnSync", syncSelected);
  on("btnSyncAll", syncAll);
  on("btnUnlink", unlinkSelected);
  renderLinks().catch(() => {});
}

// ---------- entrypoints (panel + Window ▸ UXP Plugins ▸ Bin Sync menu commands) ----------
uxp.entrypoints.setup({
  commands: {
    syncSelectedBin: () => syncSelected(),
    syncAllBins: () => syncAll(),
  },
  panels: {
    binSyncPanel: {
      show() { renderLinks().catch(() => {}); },
    },
  },
});

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireUI);
else wireUI();
