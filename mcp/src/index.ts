import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const apiBase = (process.env.OPENCLIP_API_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const downloadDir = path.resolve(process.env.OPENCLIP_DOWNLOAD_DIR ?? path.join(process.cwd(), "downloads"));
const requestTimeout = 180_000;

type ApiFailure = { error?: string; platform?: string };

async function apiFetch(pathname: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${pathname}`, {
      ...init,
      signal: AbortSignal.timeout(requestTimeout),
    });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "OpenClip API request timed out."
      : "OpenClip backend is offline or unreachable.";
    throw new Error(message, { cause: error });
  }
  if (!response.ok) {
    const body: ApiFailure = await response.json().catch(() => ({}));
    if (body.error === "API_KEY_MISSING") {
      throw new Error(`Add your ${body.platform ?? "platform"} API key in the OpenClip backend .env file.`);
    }
    throw new Error(body.error ?? `OpenClip API returned HTTP ${response.status}.`);
  }
  return response;
}

async function apiJson(pathname: string, init?: RequestInit): Promise<unknown> {
  const response = await apiFetch(pathname, init);
  return response.json();
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function toolError(error: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : "OpenClip MCP request failed." }],
  };
}

function safeFilename(header: string | null, title: string, format: string): string {
  const encodedName = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const suggestedName = encodedName ? decodeURIComponent(encodedName) : `${title}.${format}`;
  const basename = path.basename(suggestedName).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 160);
  return basename || `openclip-video.${format}`;
}

const server = new McpServer({ name: "openclip", version: "1.0.0" });

server.registerTool("search_videos", {
  title: "Search public videos",
  description: "Search public videos through the configured official platform API.",
  inputSchema: {
    platform: z.enum(["youtube", "instagram", "tiktok"]),
    query: z.string().trim().min(1).max(200),
    sort: z.enum(["views", "date", "likes"]).default("views"),
    limit: z.number().int().min(1).max(50).default(20),
  },
}, async ({ platform, query, sort, limit }) => {
  try {
    const params = new URLSearchParams({
      platform,
      q: query,
      sort,
      limit: String(limit),
    });
    return textResult(await apiJson(`/api/search?${params}`));
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("get_trending", {
  title: "Get top public videos",
  description: "Get top videos from the configured official API for a platform and region.",
  inputSchema: {
    platform: z.enum(["youtube", "instagram", "tiktok"]),
    region: z.string().length(2).regex(/^[A-Za-z]{2}$/).default("US"),
  },
}, async ({ platform, region }) => {
  try {
    const params = new URLSearchParams({ platform, region });
    return textResult(await apiJson(`/api/trending?${params}`));
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("get_video_info", {
  title: "Get public video information",
  description: "Fetch metadata and available formats for a supported public video URL.",
  inputSchema: { url: z.string().url().max(2048) },
}, async ({ url }) => {
  try {
    return textResult(await apiJson("/api/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }));
  } catch (error) {
    return toolError(error);
  }
});

server.registerTool("download_video", {
  title: "Download a permitted video",
  description: "Download an authorized public video through OpenClip. Confirm permission before every download.",
  inputSchema: {
    url: z.string().url().max(2048),
    format: z.enum(["mp4", "mp3", "m4a", "thumbnail", "srt", "txt"]).default("mp4"),
    quality: z.enum(["360", "480", "720", "1080", "best"]).default("best"),
    consent: z.boolean().describe("Confirm you own this content or have permission and will follow platform terms and copyright law."),
  },
}, async ({ url, format, quality, consent }) => {
  if (!consent) return toolError(new Error("Confirm permission and platform-term compliance before downloading."));
  let outputPath = "";
  let createdOutput = false;
  try {
    const infoResponse = await apiFetch("/api/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const info = await infoResponse.json() as { title?: string };
    const params = new URLSearchParams({ url, format, quality });
    const response = await apiFetch(`/api/download?${params}`);
    const filename = safeFilename(
      response.headers.get("content-disposition"),
      info.title ?? "openclip-video",
      format,
    );
    await mkdir(downloadDir, { recursive: true });
    outputPath = path.join(downloadDir, filename);
    if (!response.body) throw new Error("OpenClip backend returned an empty download.");
    const outputFile = await open(outputPath, "wx");
    createdOutput = true;
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      outputFile.createWriteStream(),
    );
    const bytes = Number(response.headers.get("content-length")) || null;
    return textResult({ savedTo: outputPath, bytes, format });
  } catch (error) {
    if (createdOutput && outputPath) await rm(outputPath, { force: true }).catch((cleanupError) => {
      console.error("Unable to remove incomplete MCP download:", cleanupError);
    });
    return toolError(error);
  }
});

await server.connect(new StdioServerTransport());
