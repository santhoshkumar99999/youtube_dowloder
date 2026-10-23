import { z } from "zod";

const allowedHosts = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "instagram.com",
  "www.instagram.com",
  "tiktok.com",
  "www.tiktok.com",
  "m.tiktok.com",
]);
const allowedThumbnailDomains = [
  "ytimg.com",
  "ggpht.com",
  "googleusercontent.com",
  "cdninstagram.com",
  "fbcdn.net",
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "tiktokcdn-eu.com",
  "byteoversea.com",
  "muscdn.com",
];

export function validateVideoUrl(input: unknown): URL {
  if (typeof input !== "string" || input.length > 2048) {
    throw new Error("Enter a valid YouTube, Instagram, or TikTok link.");
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Enter a valid YouTube, Instagram, or TikTok link.");
  }

  if (
    parsed.protocol !== "https:" ||
    !allowedHosts.has(parsed.hostname.toLowerCase()) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("Only public YouTube, Instagram, and TikTok URLs are supported.");
  }

  return parsed;
}

export function validateThumbnailUrl(input: unknown): URL {
  if (typeof input !== "string" || input.length > 2048) {
    throw new Error("Invalid thumbnail URL.");
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Invalid thumbnail URL.");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443") ||
    !allowedThumbnailDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))
  ) {
    throw new Error("Thumbnail host is not allowed.");
  }
  return parsed;
}

export const infoRequestSchema = z.object({
  url: z.string().min(1).max(2048),
});

export const batchInfoRequestSchema = z.object({
  urls: z.array(z.string().min(1).max(2048)).min(1).max(25),
});

export const playlistInfoRequestSchema = z.object({
  url: z.string().min(1).max(2048),
});

export const imageRequestSchema = z.object({
  url: z.string().min(1).max(2048),
});

export const platformSchema = z.enum(["youtube", "tiktok", "instagram"]);
export const sortSchema = z.enum(["views", "date", "likes"]);

export const searchRequestSchema = z.object({
  platform: platformSchema,
  q: z.string().trim().min(1).max(200),
  sort: sortSchema.default("views"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  pageToken: z.string().max(500).optional(),
  date: z.enum(["any", "day", "week", "month", "year"]).default("any"),
  duration: z.enum(["any", "short", "medium", "long"]).default("any"),
});

export const trendingRequestSchema = z.object({
  platform: platformSchema,
  region: z.string().trim().length(2).regex(/^[A-Za-z]{2}$/).default("US"),
});

export const downloadQuerySchema = z.object({
  url: z.string().min(1).max(2048),
  format: z.enum(["mp4", "mp3", "m4a", "thumbnail", "srt", "txt"]),
  quality: z.enum(["360", "480", "720", "1080", "best"]).default("best"),
});

export const gifRequestSchema = z.object({
  url: z.string().min(1).max(2048),
  start: z.coerce.number().finite().min(0),
  end: z.coerce.number().finite().positive(),
  width: z.coerce.number().int().min(120).max(480).default(360),
}).refine(({ start, end }) => end > start && end - start <= 15, {
  message: "GIF clips must be between 0 and 15 seconds long.",
  path: ["end"],
});

export const reportRequestSchema = z.object({
  url: z.string().min(1).max(2048),
  category: z.enum(["copyright", "privacy", "safety", "other"]),
  details: z.string().trim().min(10).max(2000),
});
