INFINITYFREE -> GITHUB HOURLY SYNC (RENDER CRON JOB)

This job reads website files from InfinityFree FTP and pushes changes to GitHub.
It never changes files on InfinityFree. Default is ADD/UPDATE only; deletions from GitHub are disabled by default.

DEPLOY
1. Create a NEW GitHub repository for this sync code, separate from the website repo.
2. Upload package.json, sync.js, .gitignore.
3. Render dashboard -> New + -> Cron Job -> connect the sync-code repository.
4. Build Command: npm install
5. Start Command: npm start
6. Schedule: 0 * * * * (hourly, UTC).
7. Add environment variables in Render. Never commit secrets.

ENVIRONMENT VARIABLES
FTP_HOST=ftpupload.net
FTP_PORT=21
FTP_USER=if0_43231347
FTP_PASSWORD=your_vPanel_password
FTP_ROOT=/htdocs
GITHUB_TOKEN=your_fine_grained_token
GITHUB_OWNER=togautamji03-coder
GITHUB_REPO=crayons_school
GITHUB_BRANCH=main
GITHUB_SUBPATH=
DELETE_REMOTE_FILES=false
MAX_FILE_BYTES=26214400

FTP_ROOT may differ by account. If listing /htdocs fails, check FTP client's initial directory and adjust FTP_ROOT. Do not share FTP password or token.

SECURITY / SAFETY
- Fine-grained GitHub token: only select crayons_school, Repository permissions -> Contents: Read and write.
- This is one-way: InfinityFree -> GitHub. It does not deploy GitHub changes back to the website.
- DELETE_REMOTE_FILES=false is safest. Set true only if the chosen repo/path is dedicated to mirroring htdocs; it can delete GitHub-only files such as README.md.
- Exclusions: .git/.svn/node_modules/.cache/logs/tmp/temp dirs; .env variants, .ftpquota, htdocs-github-sync.php, config.private.php; filenames containing secret/password/credential/private-key/id_rsa; .log/.bak/.swp/.tmp files.
- Review for any other secret-bearing files before first run.
- Files over 25 MiB are skipped by default.
- GitHub API rate/size limits may affect very large sites.
- FTP port 21 is plain FTP, not encrypted. Use the account password only in Render Environment Variables and rotate it if exposed.
