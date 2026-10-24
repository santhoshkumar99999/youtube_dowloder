# OpenClip

OpenClip is an open-source web app for discovering and saving public videos you own or have permission to download. Respect creators, copyright law, and each platform's terms. The app does not provide login, private-account, paywall, or DRM bypasses.

## Local setup

Requirements: Node.js 20+, npm, Python with the `yt-dlp` executable on `PATH`, and `ffmpeg` on `PATH`. Node.js 22 is recommended. On Windows, add Python's user Scripts directory to `PATH` if `yt-dlp` was installed with `pip install --user yt-dlp`.

1. Copy `.env.example` to `.env` and adjust values if needed.
2. Install dependencies: `npm install`
3. Start the API and web app: `npm run dev`
4. Open the Vite URL shown in the terminal (normally http://localhost:5173).

The React client talks only to the OpenClip backend at `/api/*`; Vite proxies those requests to port 3000 during local development. Set `VITE_API_PROXY_TARGET` if your local API uses a different address. In production, serve the client and API behind the same origin or configure `CORS_ORIGIN`.

## Official discovery API keys

Discovery never scrapes platform pages. Credentials are read by the backend from `.env`; never put them in React or commit `.env`.

- **YouTube:** In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an API key, enable YouTube Data API v3, restrict the key, and set `YOUTUBE_API_KEY`.
- **TikTok:** Apply for the [TikTok Research API](https://developers.tiktok.com/products/research-api/). Access is restricted by TikTok and is not available to every app or user. Set the approved app's `TIKTOK_CLIENT_KEY` and its authorized `TIKTOK_ACCESS_TOKEN`.
- **Instagram:** Use the [Instagram Graph API hashtag-search setup](https://developers.facebook.com/docs/instagram-api/guides/hashtag-search/). It requires an eligible Business/Creator account, approved public-content access, an access token, and the Instagram user ID; set `INSTAGRAM_TOKEN` and `INSTAGRAM_USER_ID`.

Without the required credentials, discovery responds with `API_KEY_MISSING` and the UI links to these setup steps. The Instagram Graph API does not expose a global trending feed; OpenClip reports that limitation instead of scraping.

## API

- `GET /api/health` — backend health status.
- `POST /api/info` with `{"url":"https://..."}` — supported video metadata and available formats.
- `GET /api/download?url=...&format=mp4|mp3|m4a|thumbnail|srt|txt&quality=360|480|720|1080|best` — video, audio, thumbnail, or available subtitle download.
- `GET /api/search?platform=youtube|instagram|tiktok&q=...&sort=views|date|likes&limit=...` — official API video search.
- `GET /api/trending?platform=youtube|tiktok&region=US` — official API top videos. Instagram does not provide a global trending feed.
- `POST /api/playlist/info` — list up to `MAX_PLAYLIST_ITEMS` entries from a public YouTube playlist/channel.
- `POST /api/batch/info` — inspect up to 25 public video links.
- `POST /api/gif` — convert a 0–15 second authorized video segment to a GIF (up to 50 MB).
- `POST /api/report` — save a content report for the self-hosted server administrator.
- `GET /docs` — interactive Swagger/OpenAPI docs; `GET /api/openapi.json` — OpenAPI 3.1 document.

Only HTTPS links on YouTube, Instagram, and TikTok hosts are accepted. Requests are rate-limited. File size, duration, playlist entries, GIF length, and report inbox size are capped. Temporary files are deleted after ten minutes. Subtitles are provided only when the public source makes subtitles available; there is no sign-in or private-content bypass.

## Docker

1. Copy `.env.example` to `.env`; set credentials only for the official discovery APIs you intend to use.
2. Build and start: `docker compose up --build -d`
3. Open http://localhost:3000. Check health at http://localhost:3000/api/health.
4. Stop the service with `docker compose down`. The named `openclip-reports` volume keeps administrator report files.

The Docker image installs Node.js, `yt-dlp`, and `ffmpeg` and serves the compiled React app and API from one origin. Do not publish API keys or expose a self-hosted instance to the public internet without an HTTPS reverse proxy and appropriate access controls.

## MCP server

OpenClip includes an MCP server using the official TypeScript SDK and stdio transport. Build it with `npm run build --workspace mcp`. Start the OpenClip API first, then copy `mcp/claude_desktop_config.json` into Claude Desktop's MCP configuration and replace the example project and download paths with absolute paths on your computer. Restart Claude Desktop after saving the file.

The server reads `OPENCLIP_API_URL` (default `http://localhost:3000`) and `OPENCLIP_DOWNLOAD_DIR` (default `./downloads`). Its four tools call the same OpenClip `/api/*` backend. `download_video` requires an explicit `consent: true` confirmation and saves the returned file to the configured download folder.

## Optional deployment

OpenClip requires `yt-dlp` and `ffmpeg`, so choose a deployment image/runtime where both can be installed; verify free-tier CPU, memory, disk, networking, and usage limits before deploying.

- **Vercel + Render:** Vercel serves the React client and proxies `/api/*` and `/docs` to the Docker API on Render. The repository includes `vercel.json` and `render.yaml` for this split deployment. Deploy the Render Blueprint first, confirm the API health check at `/api/health`, then import the same GitHub repository into the Vercel project. If Render assigns a different service hostname, update the destinations in `vercel.json` before deploying the client. Render's free service can sleep while idle, has ephemeral storage, and may not have enough resources for large video conversions; use a suitable paid instance and persistent disk for reliable downloads and report retention.
- **Render:** create a Docker web service from this repository, add only the needed API secrets as environment variables, and use a persistent disk if you need to retain content reports.
- **Railway:** deploy using the `Dockerfile`, configure the variables from `.env.example` in the service settings, and attach a volume for `REPORTS_FILE` if reports must persist.
- **Home server:** use Docker Compose behind an HTTPS reverse proxy. Keep API keys server-side, expose only HTTPS, back up the report volume as appropriate, and monitor resource use.

Free hosting is provider-dependent and may sleep, throttle, or limit persistent storage. OpenClip does not promise a free-tier deployment will be available.

## Extra tools and privacy

The UI includes English, Hindi, Telugu, and Kannada controls; a persisted light/dark theme; a PWA shell that never caches `/api/*`; local browser download history; per-video batch consent; and a bounded GIF trimmer. Content reports are written to `REPORTS_FILE` as JSON Lines for the instance administrator, capped at 5 MB and limited to three reports per client IP per 15 minutes. Do not include sensitive personal information in a report.

## Responsible use

Before every download, OpenClip asks the user to confirm that they own the content or have permission and will follow applicable terms and copyright law. That confirmation does not grant rights. Download only when authorized; do not redistribute creators' work without permission.
