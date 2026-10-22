INFINITYFREE -> GITHUB HOURLY SYNC VIA RENDER FREE WEB SERVICE

This version uses a Render Web Service (free web services are supported) and GitHub Actions as the hourly external trigger. Render Cron Jobs are not used.

FLOW
GitHub Actions hourly schedule -> POST to Render /sync with secret -> Render reads InfinityFree FTP -> GitHub repository is updated.

IMPORTANT
- Render free web services sleep after 15 minutes without inbound traffic. The scheduled request wakes the service; cold start may take time. Workflow retries the request. The first run may fail if cold start exceeds the retry window; check Actions logs.
- GitHub scheduled workflows are best-effort and may be delayed; not an exact clock guarantee.
- The Render /sync endpoint is protected by SYNC_SECRET.
- Keep FTP password, GitHub token, and SYNC_SECRET only in Render Environment Variables. Keep the two trigger values as GitHub Actions secrets.
- This is one-way: InfinityFree -> GitHub. It never changes website files on InfinityFree.
- Deletion from GitHub is OFF by default. Keep DELETE_REMOTE_FILES=false for first tests.

1) CREATE A SEPARATE GITHUB REPOSITORY
Create a new repository for this service code, e.g. infinityfree-hourly-sync. Upload:
- package.json
- server.js
- sync.js
- .gitignore
- .github/workflows/hourly-sync.yml

Do not put this code into the website repository unless you intentionally want to mix automation code with site files.

2) CREATE RENDER WEB SERVICE
Render Dashboard -> New + -> Web Service -> connect the sync-code repository.
Build command: npm install
Start command: npm start
Instance type: Free
Deploy.

3) SET RENDER ENVIRONMENT VARIABLES
FTP_HOST=ftpupload.net
FTP_PORT=21
FTP_USER=if0_43231347
FTP_PASSWORD=<your InfinityFree vPanel password>
FTP_ROOT=/htdocs
GITHUB_TOKEN=<your fine-grained GitHub token>
GITHUB_OWNER=togautamji03-coder
GITHUB_REPO=crayons_school
GITHUB_BRANCH=main
GITHUB_SUBPATH=
DELETE_REMOTE_FILES=false
MAX_FILE_BYTES=26214400
SYNC_SECRET=<generate a random secret of at least 32 characters>

Generate a secret locally (do not paste it into chat), for example with a password manager. Use the exact same secret in Render and GitHub Actions. Do not use your GitHub token as SYNC_SECRET.

4) SET GITHUB ACTIONS SECRETS IN THE NEW SYNC-CODE REPOSITORY
Repository -> Settings -> Secrets and variables -> Actions -> New repository secret:
RENDER_SYNC_URL = full Render URL, e.g. https://your-service-name.onrender.com (no /sync suffix)
SYNC_SECRET = the same secret value used in Render

5) TEST
- In Render, open Logs and wait for "Sync web service listening".
- Visit https://YOUR-RENDER-SERVICE.onrender.com/health. It should return {"ok":true,"running":false}. This may take about a minute if service slept.
- In the new sync-code repo, open Actions -> "Hourly InfinityFree to GitHub sync" -> Run workflow to test.
- Inspect Render Logs and the GitHub Actions run logs.
- Keep DELETE_REMOTE_FILES=false until you confirm the repository contents and mirror scope.

FTP_ROOT NOTE
If /htdocs cannot be listed, the FTP server may already start inside htdocs; test with FTP_ROOT=/ and check the listing. Do not assume: verify in Render logs.

SECURITY / EXCLUSIONS
Skips .git, .svn, node_modules, .cache, logs, tmp, temp directories.
Skips .env variants, .ftpquota, htdocs-github-sync.php, config.private.php, names containing secret/password/credential/private-key/id_rsa, and .log/.bak/.swp/.tmp files.
Review for any other secret-bearing files before first sync. Files over 25 MiB are skipped.
FTP on port 21 is plain, unencrypted FTP. Render environment variables protect secrets at rest, but FTP traffic itself is not encrypted.
GitHub API limits may affect large repositories.
