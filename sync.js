const ftp = require("basic-ftp");
const path = require("path");
const crypto = require("crypto");

const need = ["FTP_HOST", "FTP_USER", "FTP_PASSWORD", "GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"];
for (const k of need) if (!process.env[k]) throw new Error("Missing environment variable: " + k);

const env = process.env;
const FTP_ROOT = (env.FTP_ROOT || "/htdocs").replace(/\/+$/, "") || "/";
const OWNER = env.GITHUB_OWNER;
const REPO = env.GITHUB_REPO;
const BRANCH = env.GITHUB_BRANCH || "main";
const SUBPATH = (env.GITHUB_SUBPATH || "").replace(/^\/+|\/+$/g, "");
const DELETE_REMOTE = String(env.DELETE_REMOTE_FILES || "false").toLowerCase() === "true";
const MAX_BYTES = Number(env.MAX_FILE_BYTES || 25 * 1024 * 1024);

// Conservative parallelism. Each worker has its own FTP connection.
const WORKERS = Math.max(1, Math.min(6, Number(env.FTP_WORKERS || 4)));
const skipDirs = new Set([".git", ".svn", "node_modules", ".cache", "logs", "tmp", "temp", "admin-backups"]);
const skipFiles = new Set([".env", ".env.local", ".env.production", ".ftpquota", "htdocs-github-sync.php", "config.private.php"]);
const skipParts = ["secret", "password", "credential", "private-key", "id_rsa"];
const skipExt = new Set([".log", ".bak", ".swp", ".tmp"]);

function skip(name, dir) {
  const n = String(name || "").toLowerCase();
  return !name || name === "." || name === ".." ||
    (dir && skipDirs.has(n)) || skipFiles.has(n) ||
    skipParts.some(s => n.includes(s)) ||
    (!dir && skipExt.has(path.extname(n)));
}

function api(pathPart) {
  return `https://api.github.com/repos/${encodeURIComponent(OWNER)}/${encodeURIComponent(REPO)}${pathPart}`;
}
async function gh(pathPart, opts = {}) {
  const r = await fetch(api(pathPart), {
    ...opts,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {})
    }
  });
  const t = await r.text();
  let data = {};
  try { data = t ? JSON.parse(t) : {}; } catch { data = { raw: t }; }
  if (!r.ok) throw new Error(`GitHub API ${r.status}: ${JSON.stringify(data).slice(0, 1000)}`);
  return data;
}

async function connectFtp() {
  const client = new ftp.Client(60000);
  client.ftp.verbose = false;
  await client.access({
    host: env.FTP_HOST,
    port: Number(env.FTP_PORT || 21),
    user: env.FTP_USER,
    password: env.FTP_PASSWORD,
    secure: String(env.FTP_SECURE || "false").toLowerCase() === "true"
  });
  return client;
}

// Create a full, fresh FTP inventory before touching GitHub.
// Any listing error aborts the sync, protecting against incomplete inventory.
async function listTree(client, remoteDir, relDir, out) {
  const entries = await client.list(remoteDir);
  for (const e of entries) {
    if (skip(e.name, e.isDirectory)) {
      if (e.isDirectory || skip(e.name, false)) console.log("SKIP", relDir ? `${relDir}/${e.name}` : e.name);
      continue;
    }
    const rp = `${remoteDir.replace(/\/+$/, "")}/${e.name}`;
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isDirectory) {
      await listTree(client, rp, rel, out);
    } else if (e.isFile) {
      if (e.size > MAX_BYTES) {
        console.warn("SKIP large file:", rel, e.size);
        continue;
      }
      out.push({ remotePath: rp, relativePath: rel, size: e.size });
    }
  }
}

async function readFtpFile(client, remotePath) {
  const chunks = [];
  const { Writable } = require("stream");
  const sink = new Writable({
    write(chunk, enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    }
  });
  await client.downloadTo(sink, remotePath);
  return Buffer.concat(chunks);
}

// Git's blob SHA-1, calculated locally without an API request.
function gitBlobSha(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\\0`);
  return crypto.createHash("sha1").update(header).update(buffer).digest("hex");
}

async function mapLimit(items, limit, worker) {
  let next = 0;
  const results = new Array(items.length);
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runSync() {
  const started = Date.now();
  const listingClient = new ftp.Client(60000);
  const ftpClients = [];
  let listingComplete = false;

  try {
    console.log(`FTP connect ${env.FTP_HOST}:${env.FTP_PORT || 21}; root=${FTP_ROOT}`);
    await listingClient.access({
      host: env.FTP_HOST,
      port: Number(env.FTP_PORT || 21),
      user: env.FTP_USER,
      password: env.FTP_PASSWORD,
      secure: String(env.FTP_SECURE || "false").toLowerCase() === "true"
    });

    const listStarted = Date.now();
    const files = [];
    await listTree(listingClient, FTP_ROOT, "", files);
    listingComplete = true;
    console.log(`FTP inventory complete: ${files.length} files in ${((Date.now() - listStarted) / 1000).toFixed(1)}s`);

    if (!files.length) throw new Error("No eligible files found; check FTP_ROOT. Refusing to sync.");

    const ghStarted = Date.now();
    const ref = await gh(`/git/ref/heads/${encodeURIComponent(BRANCH)}`);
    const parentSha = ref.object.sha;
    const parent = await gh(`/git/commits/${parentSha}`);
    const tree = await gh(`/git/trees/${parent.tree.sha}?recursive=1`);
    if (tree.truncated) throw new Error("GitHub tree truncated; refusing to sync.");

    const prefix = SUBPATH ? `${SUBPATH}/` : "";
    const remote = new Map();
    for (const x of tree.tree || []) {
      if (x.type === "blob" && x.path.startsWith(prefix)) {
        const rel = x.path.slice(prefix.length);
        if (rel) remote.set(rel, x);
      }
    }
    console.log(`GitHub inventory complete: ${remote.size} files in ${((Date.now() - ghStarted) / 1000).toFixed(1)}s`);

    // Create dedicated FTP sessions for parallel downloads.
    const connectionCount = Math.min(WORKERS, files.length);
    for (let i = 0; i < connectionCount; i++) ftpClients.push(await connectFtp());

    const localSet = new Set(files.map(f => f.relativePath));
    const entriesByPath = new Map();
    let added = 0, updated = 0, unchanged = 0, deleted = 0, failedDownloads = 0;
    let processed = 0;
    const downloadStarted = Date.now();

    await mapLimit(files, connectionCount, async (f, index) => {
      const client = ftpClients[index % connectionCount];
      let content;
      try {
        content = await readFtpFile(client, f.remotePath);
      } catch (err) {
        failedDownloads++;
        localSet.delete(f.relativePath);
        console.warn("SKIP FTP file unavailable during download:", f.relativePath, err?.message || err);
        return;
      }

      const sha = gitBlobSha(content);
      const old = remote.get(f.relativePath);
      if (old && old.sha === sha) {
        unchanged++;
      } else {
        // Upload only changed/new content; unchanged files avoid GitHub blob API calls.
        const blob = await gh("/git/blobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: content.toString("base64"), encoding: "base64" })
        });
        entriesByPath.set(f.relativePath, {
          path: prefix + f.relativePath,
          mode: "100644",
          type: "blob",
          sha: blob.sha
        });
        if (old) updated++; else added++;
      }

      processed++;
      if (processed % 25 === 0 || processed === files.length) {
        console.log(`Progress: ${processed}/${files.length} files processed`);
      }
    });

    console.log(`File processing finished in ${((Date.now() - downloadStarted) / 1000).toFixed(1)}s; failed downloads=${failedDownloads}`);

    // Only perform deletions when user enabled them, the FTP inventory succeeded,
    // AND every listed file downloaded successfully. This avoids destructive
    // deletes from a transient/stale FTP listing or a race with admin deletion.
    if (DELETE_REMOTE && listingComplete && failedDownloads === 0) {
      for (const [rel] of remote) {
        if (!localSet.has(rel)) {
          entriesByPath.set(rel, { path: prefix + rel, mode: "100644", type: "blob", sha: null });
          deleted++;
        }
      }
    } else if (DELETE_REMOTE && failedDownloads > 0) {
      console.warn(`Deletion protection active: ${failedDownloads} FTP file(s) failed download; no GitHub deletions will be applied.`);
    }

    const entries = [...entriesByPath.values()];
    console.log(`Summary added=${added} updated=${updated} unchanged=${unchanged} deletions=${deleted}`);
    if (!entries.length) {
      console.log("No changes.");
      return { changed: false, added, updated, unchanged, deleted };
    }

    const commitStarted = Date.now();
    const newTree = await gh("/git/trees", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_tree: parent.tree.sha, tree: entries })
    });
    const now = new Date().toISOString();
    const commit = await gh("/git/commits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Admin Update Website Sync ${now}`,
        tree: newTree.sha,
        parents: [parentSha],
        author: {
          name: env.COMMIT_AUTHOR_NAME || "Website Sync",
          email: env.COMMIT_AUTHOR_EMAIL || "website-sync@users.noreply.github.com",
          date: now
        }
      })
    });
    await gh(`/git/refs/heads/${encodeURIComponent(BRANCH)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: commit.sha, force: false })
    });
    console.log(`GitHub commit/branch update completed in ${((Date.now() - commitStarted) / 1000).toFixed(1)}s`);
    console.log("SUCCESS commit:", commit.sha);
    console.log(`https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`);
    console.log(`Total sync duration: ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return { changed: true, added, updated, unchanged, deleted, commit: commit.sha };
  } finally {
    listingClient.close();
    for (const c of ftpClients) c.close();
  }
}

module.exports = { runSync };
