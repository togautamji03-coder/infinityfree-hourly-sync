const ftp = require("basic-ftp");
const path = require("path");

const need = ["FTP_HOST","FTP_USER","FTP_PASSWORD","GITHUB_TOKEN","GITHUB_OWNER","GITHUB_REPO"];
for (const k of need) if (!process.env[k]) throw new Error("Missing environment variable: " + k);

const env = process.env;
const FTP_ROOT = (env.FTP_ROOT || "/htdocs").replace(/\/+$/, "") || "/";
const OWNER = env.GITHUB_OWNER, REPO = env.GITHUB_REPO, BRANCH = env.GITHUB_BRANCH || "main";
const SUBPATH = (env.GITHUB_SUBPATH || "").replace(/^\/+|\/+$/g, "");
const DELETE_REMOTE = String(env.DELETE_REMOTE_FILES || "false").toLowerCase() === "true";
const MAX_BYTES = Number(env.MAX_FILE_BYTES || 25 * 1024 * 1024);
const skipDirs = new Set([".git",".svn","node_modules",".cache","logs","tmp","temp"]);
const skipFiles = new Set([".env",".env.local",".env.production",".ftpquota","htdocs-github-sync.php","config.private.php"]);
const skipParts = ["secret","password","credential","private-key","id_rsa"];
const skipExt = new Set([".log",".bak",".swp",".tmp"]);

function skip(name, dir) {
  const n = name.toLowerCase();
  return !name || name === "." || name === ".." ||
    (dir && skipDirs.has(n)) || skipFiles.has(n) ||
    skipParts.some(s => n.includes(s)) ||
    (!dir && skipExt.has(path.extname(n)));
}
function api(pathPart) { return `https://api.github.com/repos/${encodeURIComponent(OWNER)}/${encodeURIComponent(REPO)}${pathPart}`; }
async function gh(pathPart, opts = {}) {
  const r = await fetch(api(pathPart), { ...opts, headers: {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...(opts.headers || {})
  }});
  const t = await r.text(); let data = {};
  try { data = t ? JSON.parse(t) : {}; } catch { data = { raw: t }; }
  if (!r.ok) throw new Error(`GitHub API ${r.status}: ${JSON.stringify(data).slice(0,1000)}`);
  return data;
}
async function listTree(client, remoteDir, relDir, out) {
  const entries = await client.list(remoteDir);
  for (const e of entries) {
    if (skip(e.name, e.isDirectory)) { console.log("SKIP", e.name); continue; }
    const rp = `${remoteDir.replace(/\/+$/,"")}/${e.name}`;
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isDirectory) await listTree(client, rp, rel, out);
    else if (e.isFile) {
      if (e.size > MAX_BYTES) { console.warn("SKIP large file:", rel, e.size); continue; }
      out.push({ remotePath: rp, relativePath: rel });
    }
  }
}
async function readFtpFile(client, remotePath) {
  const chunks = [];
  const { Writable } = require("stream");
  const sink = new Writable({ write(chunk, enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  await client.downloadTo(sink, remotePath);
  return Buffer.concat(chunks);
}
async function runSync() {
  const client = new ftp.Client(30000);
  try {
    console.log(`FTP connect ${env.FTP_HOST}:${env.FTP_PORT || 21}; root=${FTP_ROOT}`);
    await client.access({ host: env.FTP_HOST, port: Number(env.FTP_PORT || 21), user: env.FTP_USER, password: env.FTP_PASSWORD, secure: false });
    await client.list(FTP_ROOT);
    const files = [];
    await listTree(client, FTP_ROOT, "", files);
    if (!files.length) throw new Error("No eligible files found; check FTP_ROOT. Refusing to sync.");
    console.log(`Found ${files.length} files.`);

    const ref = await gh(`/git/ref/heads/${encodeURIComponent(BRANCH)}`);
    const parentSha = ref.object.sha;
    const parent = await gh(`/git/commits/${parentSha}`);
    const tree = await gh(`/git/trees/${parent.tree.sha}?recursive=1`);
    if (tree.truncated) throw new Error("GitHub tree truncated; refusing to sync.");

    const prefix = SUBPATH ? `${SUBPATH}/` : "";
    const remote = new Map();
    for (const x of tree.tree || []) if (x.type === "blob" && x.path.startsWith(prefix)) {
      const rel = x.path.slice(prefix.length); if (rel) remote.set(rel, x);
    }

    const entries = [];
    const localSet = new Set();
    let added=0, updated=0, unchanged=0, deleted=0;
    for (const f of files) {
      localSet.add(f.relativePath);
      const content = await readFtpFile(client, f.remotePath);
      const blob = await gh("/git/blobs", { method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ content: content.toString("base64"), encoding:"base64" }) });
      const old = remote.get(f.relativePath);
      if (old && old.sha === blob.sha) { unchanged++; continue; }
      entries.push({ path: prefix + f.relativePath, mode:"100644", type:"blob", sha:blob.sha });
      if (old) updated++; else added++;
    }
    if (DELETE_REMOTE) for (const [rel] of remote) if (!localSet.has(rel)) {
      entries.push({ path:prefix+rel, mode:"100644", type:"blob", sha:null }); deleted++;
    }
    console.log(`Summary added=${added} updated=${updated} unchanged=${unchanged} deletions=${deleted}`);
    if (!entries.length) { console.log("No changes."); return { changed:false, added, updated, unchanged, deleted }; }

    const newTree = await gh("/git/trees", { method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ base_tree:parent.tree.sha, tree:entries }) });
    const now = new Date().toISOString();
    const commit = await gh("/git/commits", { method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ message:`Hourly InfinityFree sync ${now}`, tree:newTree.sha, parents:[parentSha],
        author:{name:env.COMMIT_AUTHOR_NAME || "Hourly Website Sync", email:env.COMMIT_AUTHOR_EMAIL || "hourly-sync@users.noreply.github.com", date:now} }) });
    await gh(`/git/refs/heads/${encodeURIComponent(BRANCH)}`, { method:"PATCH", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({sha:commit.sha, force:false}) });
    console.log("SUCCESS commit:", commit.sha);
    console.log(`https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`);
    return { changed:true, added, updated, unchanged, deleted, commit:commit.sha };
  } finally { client.close(); }
}
module.exports = { runSync };
