import cors from "cors";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import dotenv from "dotenv";
import { pipeline } from "node:stream/promises";
import { appendFile, mkdir, readFile, readdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import { ZodError } from "zod";
import { getTrending, ProviderError, searchVideos } from "./discovery.js";
import { openApiDocument } from "./openapi.js";
import {
  downloadQuerySchema,
  batchInfoRequestSchema,
  gifRequestSchema,
  imageRequestSchema,
  infoRequestSchema,
  playlistInfoRequestSchema,
  reportRequestSchema,
  searchRequestSchema,
  trendingRequestSchema,
  validateThumbnailUrl,
  validateVideoUrl,
} from "./validation.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.join(projectRoot, ".env") });
const port = Number(process.env.PORT ?? 3000);
const maxFileMb = Number(process.env.MAX_FILE_MB ?? 500);
const maxDurationSeconds = Number(process.env.MAX_DURATION_SECONDS ?? 7200);
const maxPlaylistItems = Number(process.env.MAX_PLAYLIST_ITEMS ?? 100);
const reportFile = path.resolve(process.env.REPORTS_FILE ?? path.join(projectRoot, "data", "reports.jsonl"));
const rateLimitCount = Number(process.env.RATE_LIMIT ?? 30);
const tempDir = path.join(tmpdir(), "openclip");
const cleanupAfterMs = 10 * 60 * 1000;
const requestTimeoutMs = 120_000;
const activeOutputPrefixes = new Set<string>();
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean)
  : ["http://localhost:5173", "http://localhost:4173"];

if (![port, maxFileMb, maxDurationSeconds, maxPlaylistItems, rateLimitCount].every(Number.isFinite) ||
    port < 1 || maxFileMb < 1 || maxDurationSeconds < 1 || maxPlaylistItems < 1 || rateLimitCount < 1) {
  throw new Error("PORT, MAX_FILE_MB, MAX_DURATION_SECONDS, MAX_PLAYLIST_ITEMS, and RATE_LIMIT must be positive numbers.");
}

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin: corsOrigins }));
app.use(express.json({ limit: "16kb" }));
app.use("/api", rateLimit({
  windowMs: 60_000,
  limit: rateLimitCount,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Rate limit reached. Please wait a minute and try again." },
}));

type YtDlpInfo = {
  title?: string;
  thumbnail?: string;
  duration?: number;
  uploader?: string;
  view_count?: number;
  formats?: Array<{
    format_id?: string;
    ext?: string;
    height?: number;
    vcodec?: string;
    acodec?: string;
    filesize?: number;
    filesize_approx?: number;
  }>;
};

function runYtDlp(args: string[], timeout = requestTimeoutMs) {
  return execFileAsync("yt-dlp", args, {
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
}

function publicError(error: unknown): string {
  const detail = error instanceof Error && "stderr" in error && typeof error.stderr === "string"
    ? error.stderr
    : error instanceof Error ? error.message : String(error);
  const message = detail || "The platform could not provide this video.";
  if (/login.?required|login_required|authentication required/i.test(message)) {
    return "Instagram requires a logged-in session for this post. OpenClip supports public content only and will not use account cookies.";
  }
  if (/private|members-only/i.test(message)) return "This video is private or members-only.";
  if (/geo|country|region/i.test(message)) return "This video is unavailable in your region.";
  if (/age|sign in|login/i.test(message)) return "This video is age-restricted or requires sign-in.";
  if (/429|rate.?limit/i.test(message)) return "The platform is rate limiting requests. Please retry shortly.";
  if (/timed out/i.test(message)) return "The platform request timed out. Please retry.";
  if (/max-filesize|file is larger/i.test(message)) return `The file exceeds the ${maxFileMb} MB size limit.`;
  if (/duration/i.test(message)) return `The video exceeds the ${Math.floor(maxDurationSeconds / 60)} minute duration limit.`;
  return message.replace(/^Command failed:.*\n?/, "").trim() || "The platform could not provide this video.";
}

async function getInfo(url: string): Promise<YtDlpInfo> {
  const { stdout } = await runYtDlp([
    "--dump-single-json", "--no-warnings", "--no-playlist", "--socket-timeout", "20", "--", url,
  ]);
  const data = JSON.parse(stdout) as YtDlpInfo;
  if (typeof data.duration === "number" && data.duration > maxDurationSeconds) {
    throw new Error("duration limit exceeded");
  }
  return data;
}

function mapFormats(data: YtDlpInfo) {
  return (data.formats ?? [])
    .filter((format) => format.format_id && format.ext)
    .map((format) => ({
      id: format.format_id!,
      ext: format.ext!,
      height: format.height ?? null,
      hasVideo: format.vcodec !== "none",
      hasAudio: format.acodec !== "none",
      size: format.filesize ?? format.filesize_approx ?? null,
    }));
}

function resolveOutputPath(prefix: string, printedPath: string, allowedExtensions: string[]): string {
  const root = path.resolve(tempDir);
  const fromYtDlp = path.resolve(printedPath);
  if (
    path.dirname(fromYtDlp) === root &&
    path.basename(fromYtDlp).startsWith(prefix) &&
    allowedExtensions.includes(path.extname(fromYtDlp).toLowerCase()) &&
    existsSync(fromYtDlp)
  ) return fromYtDlp;
  return "";
}

async function findOutputByExtension(prefix: string, extensions: string[]): Promise<string> {
  const files = await readdir(tempDir);
  const candidate = files.find((name) =>
    name.startsWith(prefix) && extensions.includes(path.extname(name).toLowerCase()),
  );
  return candidate ? path.join(tempDir, candidate) : "";
}

async function executeYtDlp(args: string[]) {
  return execFileAsync("yt-dlp", args, {
    timeout: requestTimeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
}

async function cleanupOldFiles() {
  await mkdir(tempDir, { recursive: true });
  const now = Date.now();
  for (const name of await readdir(tempDir)) {
    const file = path.join(tempDir, name);
    if ([...activeOutputPrefixes].some((prefix) => name.startsWith(prefix))) continue;
    try {
      if (now - (await stat(file)).mtimeMs > cleanupAfterMs) await unlink(file);
    } catch (error) {
      console.error(`Unable to clean temporary file ${name}:`, error);
    }
  }
}

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

app.get("/api/search", async (req, res, next) => {
  try {
    const query = searchRequestSchema.parse(req.query);
    res.json(await searchVideos(query));
  } catch (error) {
    next(error);
  }
});

app.get("/api/trending", async (req, res, next) => {
  try {
    const query = trendingRequestSchema.parse(req.query);
    res.json(await getTrending(query));
  } catch (error) {
    next(error);
  }
});

app.get("/api/image", async (req, res, next) => {
  try {
    const query = imageRequestSchema.parse(req.query);
    let imageUrl = validateThumbnailUrl(query.url);
    let upstream: globalThis.Response | undefined;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      upstream = await fetch(imageUrl, { signal: AbortSignal.timeout(15_000), redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
      const location = upstream.headers.get("location");
      if (!location || redirects === 3) {
        res.status(502).json({ error: "The thumbnail provider returned too many redirects." });
        return;
      }
      imageUrl = validateThumbnailUrl(new URL(location, imageUrl).toString());
    }
    if (!upstream) throw new Error("Thumbnail provider did not respond.");
    if (!upstream.ok || !upstream.body) {
      res.status(502).json({ error: `Thumbnail provider returned HTTP ${upstream.status}.` });
      return;
    }
    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      res.status(502).json({ error: "The thumbnail provider returned a non-image response." });
      return;
    }
    const maxImageBytes = 5 * 1024 * 1024;
    const declaredSize = Number(upstream.headers.get("content-length"));
    if (declaredSize > maxImageBytes) {
      res.status(413).json({ error: "The thumbnail exceeds the 5 MB size limit." });
      return;
    }
    const reader = upstream.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        size += value.byteLength;
        if (size > maxImageBytes) {
          await reader.cancel();
          res.status(413).json({ error: "The thumbnail exceeds the 5 MB size limit." });
          return;
        }
        chunks.push(value);
      }
    }
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Content-Length", String(size));
    res.type(contentType).send(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  } catch (error) {
    next(error);
  }
});

app.post("/api/info", async (req, res, next) => {
  try {
    const body = infoRequestSchema.parse(req.body);
    const url = validateVideoUrl(body.url).toString();
    const data = await getInfo(url);
    res.json({
      title: data.title ?? "Untitled video",
      thumbnail: data.thumbnail
        ? `/api/image?url=${encodeURIComponent(data.thumbnail)}`
        : null,
      duration: data.duration ?? null,
      uploader: data.uploader ?? "Unknown creator",
      views: data.view_count ?? null,
      formats: mapFormats(data),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/batch/info", async (req, res, next) => {
  try {
    const body = batchInfoRequestSchema.parse(req.body);
    const entries: Array<{ url: string; info?: Record<string, unknown>; error?: string }> = [];
    for (let index = 0; index < body.urls.length; index += 3) {
      const group = body.urls.slice(index, index + 3);
      const results = await Promise.all(group.map(async (input) => {
        try {
          const url = validateVideoUrl(input).toString();
          const data = await getInfo(url);
          return {
            url,
            info: {
              title: data.title ?? "Untitled video",
              thumbnail: data.thumbnail ? `/api/image?url=${encodeURIComponent(data.thumbnail)}` : null,
              duration: data.duration ?? null,
              uploader: data.uploader ?? "Unknown creator",
              views: data.view_count ?? null,
            },
          };
        } catch (error) {
          return { url: input, error: publicError(error) };
        }
      }));
      entries.push(...results);
    }
    res.json({ items: entries });
  } catch (error) {
    next(error);
  }
});

app.post("/api/playlist/info", async (req, res, next) => {
  try {
    const body = playlistInfoRequestSchema.parse(req.body);
    const playlistUrl = validateVideoUrl(body.url);
    if (!["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(playlistUrl.hostname)) {
      res.status(400).json({ error: "Playlist and channel selection is available only for YouTube links." });
      return;
    }
    const { stdout } = await executeYtDlp([
      "--flat-playlist", "--dump-single-json", "--no-warnings",
      "--playlist-end", String(maxPlaylistItems),
      "--socket-timeout", "20", "--", playlistUrl.toString(),
    ]);
    const playlist = JSON.parse(stdout) as {
      title?: string;
      entries?: Array<{ id?: string; title?: string; url?: string; webpage_url?: string; duration?: number } | null>;
    };
    const items = (playlist.entries ?? []).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .flatMap((entry) => {
        const itemUrl = entry.webpage_url
          ?? (entry.id ? `https://www.youtube.com/watch?v=${encodeURIComponent(entry.id)}` : entry.url);
        if (!itemUrl) return [];
        return [{
          url: validateVideoUrl(itemUrl).toString(),
          id: entry.id ?? "",
          title: entry.title ?? "Untitled video",
          duration: entry.duration ?? null,
        }];
      });
    res.json({ title: playlist.title ?? "YouTube playlist", items, truncated: items.length >= maxPlaylistItems });
  } catch (error) {
    next(error);
  }
});

app.post("/api/gif", async (req, res, next) => {
  const prefix = randomUUID();
  let sourcePath = "";
  let gifPath = "";
  let child: ReturnType<typeof execFile> | undefined;
  activeOutputPrefixes.add(prefix);
  res.on("close", () => {
    if (!res.writableEnded && child && !child.killed) child.kill();
  });
  try {
    const request = gifRequestSchema.parse(req.body);
    const url = validateVideoUrl(request.url).toString();
    const info = await getInfo(url);
    if (typeof info.duration === "number" && request.end > info.duration) {
      res.status(400).json({ error: "GIF end time must be within the video's duration." });
      return;
    }
    await mkdir(tempDir, { recursive: true });
    const sourceTemplate = path.join(tempDir, `${prefix}.%(ext)s`);
    const downloadArgs = [
      "--no-warnings", "--no-playlist", "--no-part", "--socket-timeout", "20",
      "--max-filesize", `${maxFileMb}M`,
      "--format", "best[height<=480][ext=mp4]/best[height<=480]",
      "--recode-video", "mp4",
      "--merge-output-format", "mp4",
      "--output", sourceTemplate,
      "--print", "after_move:filepath",
      "--", url,
    ];
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      child = execFile("yt-dlp", downloadArgs, {
        timeout: requestTimeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      }, (error, output, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve({ stdout: output, stderr });
      });
    });
    sourcePath = resolveOutputPath(prefix, stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "", [".mp4"]);
    if (!sourcePath) throw new Error("yt-dlp did not produce a video for GIF conversion.");
    gifPath = path.join(tempDir, `${prefix}.gif`);
    const clipDuration = request.end - request.start;
    const filter = `fps=12,scale=${request.width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`;
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(request.start), "-t", String(clipDuration), "-i", sourcePath,
      "-vf", filter, "-loop", "0", gifPath,
    ], { timeout: requestTimeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    const gifStat = await stat(gifPath);
    if (gifStat.size > Math.min(maxFileMb, 50) * 1024 * 1024) {
      throw new Error("The GIF exceeds the configured 50 MB output limit.");
    }
    res.setHeader("Content-Length", String(gifStat.size));
    res.setHeader("Content-Type", "image/gif");
    res.setHeader("Content-Disposition", `attachment; filename="${prefix}.gif"`);
    await pipeline(createReadStream(gifPath), res);
  } catch (error) {
    if (res.destroyed) return;
    next(error);
  } finally {
    if (child && !child.killed) child.kill();
    activeOutputPrefixes.delete(prefix);
    for (const file of [sourcePath, gifPath]) {
      if (file) await unlink(file).catch((error) => console.error("Unable to remove GIF temporary file:", error));
    }
    for (const name of await readdir(tempDir).catch(() => [])) {
      if (name.startsWith(prefix) && name !== path.basename(sourcePath) && name !== path.basename(gifPath)) {
        await unlink(path.join(tempDir, name)).catch((error) => console.error("Unable to remove GIF temporary file:", error));
      }
    }
  }
});

const reportRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 3,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many content reports. Please try again later." },
});

app.post("/api/report", reportRateLimit, async (req, res, next) => {
  try {
    const report = reportRequestSchema.parse(req.body);
    const url = validateVideoUrl(report.url).toString();
    const maxReportsBytes = 5 * 1024 * 1024;
    const currentSize = await stat(reportFile).then((details) => details.size).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return 0;
      throw error;
    });
    if (currentSize >= maxReportsBytes) {
      res.status(507).json({ error: "The report inbox is full. Please contact the site administrator." });
      return;
    }
    const id = randomUUID();
    await mkdir(path.dirname(reportFile), { recursive: true });
    await appendFile(reportFile, `${JSON.stringify({
      id,
      url,
      category: report.category,
      details: report.details,
      createdAt: new Date().toISOString(),
    })}\n`, { encoding: "utf8", flag: "a" });
    res.status(201).json({ id, message: "Report received by this OpenClip server's administrator." });
  } catch (error) {
    next(error);
  }
});

app.get("/api/openapi.json", (_req, res) => res.json(openApiDocument));
app.use("/docs", helmet({ contentSecurityPolicy: false }), swaggerUi.serve, swaggerUi.setup(openApiDocument));

app.get("/api/download", async (req, res, next) => {
  let child: ReturnType<typeof execFile> | undefined;
  let outputPath = "";
  let outputPrefix = "";
  let keepFileForCleanup = false;
  res.on("close", () => {
    if (!res.writableEnded && child && !child.killed) child.kill();
  });
  try {
    const query = downloadQuerySchema.parse(req.query);
    const url = validateVideoUrl(query.url).toString();
    const data = await getInfo(url);
    if (typeof data.duration === "number" && data.duration > maxDurationSeconds) {
      throw new Error("duration limit exceeded");
    }
    await mkdir(tempDir, { recursive: true });
    const id = randomUUID();
    outputPrefix = id;
    activeOutputPrefixes.add(id);
    const outputTemplate = path.join(tempDir, `${id}.%(ext)s`);
    const args = [
      "--no-warnings", "--no-playlist", "--no-part", "--socket-timeout", "20",
      "--max-filesize", `${maxFileMb}M`,
      "--match-filter", `duration <= ${maxDurationSeconds}`,
      "--output", outputTemplate,
      "--print", "after_move:filepath",
    ];

    if (query.format === "mp3" || query.format === "m4a") {
      args.push("--extract-audio", "--audio-format", query.format);
    } else if (query.format === "thumbnail") {
      args.push("--skip-download", "--write-thumbnail");
    } else if (query.format === "srt" || query.format === "txt") {
      args.push("--skip-download", "--write-subs", "--sub-langs", "all,-live_chat", "--sub-format", "srt/best", "--convert-subs", "srt");
    } else {
      const heights: Record<string, string> = {
        "360": "360", "480": "480", "720": "720", "1080": "1080", best: "99999",
      };
      const height = heights[query.quality];
      args.push(
        "--format", `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`,
        "--merge-output-format", "mp4",
        "--recode-video", "mp4",
      );
    }
    args.push("--", url);

    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      child = execFile("yt-dlp", args, {
        timeout: requestTimeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve({ stdout, stderr });
      });
    });
    const printedPath = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
    const extensions: Record<string, string[]> = {
      mp4: [".mp4"], mp3: [".mp3"], m4a: [".m4a"],
      thumbnail: [".jpg", ".jpeg", ".png", ".webp", ".avif"],
      srt: [".srt"], txt: [".srt"],
    };
    let actualFile = resolveOutputPath(id, printedPath, extensions[query.format]);
    if (!actualFile && query.format === "mp4") {
      actualFile = resolveOutputPath(id, printedPath, [".mp4"]);
    }
    if (!actualFile) {
      const outputFiles = await readdir(tempDir);
      const candidates = outputFiles.filter((name) => {
        const filePath = path.join(tempDir, name);
        return name.startsWith(id) &&
          !name.endsWith(".part") &&
          (query.format === "mp4"
            ? [".mp4", ".mkv", ".webm", ".mov"].includes(path.extname(name).toLowerCase())
            : extensions[query.format].includes(path.extname(name).toLowerCase())) &&
          existsSync(filePath);
      });
      if (candidates.length > 0) {
        console.warn(`yt-dlp reported an unexpected filename for ${query.format}; using its generated output extension.`);
        actualFile = path.join(tempDir, candidates[0]);
      }
    }
    if (query.format === "mp4" && actualFile && path.extname(actualFile).toLowerCase() !== ".mp4") {
      const remuxedPath = path.join(tempDir, `${id}.mp4`);
      await execFileAsync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-i", actualFile,
        "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac",
        "-movflags", "+faststart", remuxedPath,
      ], { timeout: requestTimeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      actualFile = remuxedPath;
    }
    if (!actualFile) {
      if (query.format === "srt" || query.format === "txt") {
        throw new Error("This video does not provide downloadable subtitles.");
      }
      if (query.format === "mp4") {
        const generated = (await readdir(tempDir)).filter((name) => name.startsWith(id));
        const hasImagesOnly = generated.some((name) => [".jpg", ".jpeg", ".png", ".webp", ".avif"].includes(path.extname(name).toLowerCase()));
        if (hasImagesOnly) {
          throw new Error("This Instagram post contains images rather than a video. Use a public Reel or video link.");
        }
        throw new Error("No compatible MP4 video was produced. The public link may not contain a video, or the provider did not expose a downloadable stream.");
      }
      throw new Error("yt-dlp did not produce the requested output file.");
    }
    if (!actualFile || !existsSync(actualFile)) throw new Error("yt-dlp did not produce an output file.");
    let fileStat = await stat(actualFile);
    if (fileStat.size > maxFileMb * 1024 * 1024) {
      await unlink(actualFile);
      throw new Error("The file exceeds the configured size limit.");
    }
    if (query.format === "txt") {
      const subtitle = await readFile(actualFile, "utf8");
      const plainText = subtitle
        .replace(/^\uFEFF/, "")
        .replace(/^\s*\d+\s*$/gm, "")
        .replace(/^\s*\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+.*$/gm, "")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\n{2,}/g, "\n")
        .trim();
      await unlink(actualFile);
      actualFile = path.join(tempDir, `${id}.txt`);
      await writeFile(actualFile, plainText, { flag: "wx" });
      fileStat = await stat(actualFile);
    }
    outputPath = actualFile;
    const safeTitle = (data.title ?? "video").replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 100);
    res.setHeader("Content-Length", String(fileStat.size));
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${safeTitle}.${path.extname(actualFile).slice(1)}`)}`);
    const imageTypes: Record<string, string> = {
      ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
      ".webp": "image/webp", ".avif": "image/avif", ".srt": "text/plain; charset=utf-8",
      ".txt": "text/plain; charset=utf-8",
    };
    res.setHeader("Content-Type", query.format === "thumbnail"
      ? imageTypes[path.extname(actualFile).toLowerCase()] ?? "application/octet-stream"
      : query.format === "mp3" ? "audio/mpeg"
        : query.format === "m4a" ? "audio/mp4"
          : query.format === "srt" || query.format === "txt" ? "text/plain; charset=utf-8" : "video/mp4");
    await pipeline(createReadStream(actualFile), res);
    keepFileForCleanup = true;
  } catch (error) {
    if (res.destroyed) return;
    next(error);
  } finally {
    if (child && !child.killed) child.kill();
    if (outputPrefix) activeOutputPrefixes.delete(outputPrefix);
    if (outputPath && keepFileForCleanup) {
      await utimes(outputPath, new Date(), new Date()).catch((error) => {
        console.error("Unable to refresh temporary file cleanup time:", error);
      });
    }
    if (outputPath && !keepFileForCleanup) await unlink(outputPath).catch((error) => console.error(error));
    if (outputPrefix && !keepFileForCleanup) {
      for (const name of await readdir(tempDir).catch(() => [])) {
        if (name.startsWith(outputPrefix)) {
          await unlink(path.join(tempDir, name)).catch((error) => console.error(error));
        }
      }
    }
  }
});

const clientDist = path.join(projectRoot, "client", "dist");
app.use(express.static(clientDist, { index: false }));
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api/") || req.path === "/api") {
    next();
    return;
  }
  res.sendFile(path.join(clientDist, "index.html"), (error) => {
    if (error) next(error);
  });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.destroyed) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof ProviderError) {
    if (error.code === "API_KEY_MISSING" && error.platform) {
      res.status(error.status).json({ error: "API_KEY_MISSING", platform: error.platform });
      return;
    }
    res.status(error.status).json({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.platform ? { platform: error.platform } : {}),
    });
    return;
  }
  const status = error instanceof ZodError ? 400
    : error instanceof Error && error.message.startsWith("Only public") ? 400
      : error instanceof Error && (error.message.startsWith("Enter a valid") || error.message.startsWith("Invalid thumbnail")) ? 400 : 502;
  const message = publicError(error);
  console.error("API request failed:", message);
  res.status(status).json({ error: message });
});

await cleanupOldFiles();
setInterval(() => void cleanupOldFiles(), 60_000).unref();
const server = app.listen(port, () => {
  console.log(`OpenClip API listening on port ${port}`);
  execFile("yt-dlp", ["-U"], { timeout: 30_000, windowsHide: true }, (error, stdout, stderr) => {
    if (error) console.error("yt-dlp update check failed:", error.message);
    else console.log("yt-dlp update check:", (stdout || stderr || "up to date").trim());
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
