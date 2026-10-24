import type { z } from "zod";
import type { searchRequestSchema, trendingRequestSchema } from "./validation.js";

type SearchRequest = z.infer<typeof searchRequestSchema>;
type TrendingRequest = z.infer<typeof trendingRequestSchema>;
export type Platform = "youtube" | "tiktok" | "instagram";

export type VideoResult = {
  id: string;
  platform: Platform;
  url: string;
  title: string;
  thumbnail: string | null;
  channel: string;
  views: number | null;
  likes: number | null;
  publishedAt: string | null;
  duration: number | null;
  downloadable: boolean;
};

export type VideoPage = {
  items: VideoResult[];
  nextPageToken: string | null;
};

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code?: string,
    readonly platform?: Platform,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new ProviderError("The official video API timed out. Please retry.");
    }
    throw new ProviderError(error instanceof Error ? error.message : "Could not reach the official video API.");
  }
  const body: unknown = await response.json().catch(() => null);
  const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  const error = typeof record.error === "object" && record.error !== null
    ? record.error as Record<string, unknown>
    : record;
  const providerCode = typeof error.code === "string" ? error.code : "";
  if (!response.ok || (record.error !== undefined && providerCode && providerCode !== "ok")) {
    const message = typeof error.message === "string"
      ? error.message
      : `The official video API returned HTTP ${response.status}.`;
    throw new ProviderError(message, 502);
  }
  if (typeof body !== "object" || body === null) {
    throw new ProviderError("The official video API returned an invalid response.");
  }
  return body as Record<string, unknown>;
}

function requireYouTubeKey(): string {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key) throw new ProviderError("API_KEY_MISSING", 503, "API_KEY_MISSING", "youtube");
  return key;
}

function dateStart(date: SearchRequest["date"]): string | undefined {
  const days: Record<Exclude<SearchRequest["date"], "any">, number> = {
    day: 1,
    week: 7,
    month: 30,
    year: 365,
  };
  if (date === "any") return undefined;
  return new Date(Date.now() - days[date] * 86_400_000).toISOString();
}

function parseDuration(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

function durationMatches(seconds: number | null, duration: SearchRequest["duration"]): boolean {
  if (duration === "any" || seconds === null) return true;
  if (duration === "short") return seconds < 240;
  if (duration === "medium") return seconds >= 240 && seconds <= 1200;
  return seconds > 1200;
}

type YouTubeSearchItem = { id?: { videoId?: string } };
type YouTubeSearchResponse = { items?: YouTubeSearchItem[]; nextPageToken?: string };
type YouTubeVideo = {
  id?: string;
  snippet?: {
    title?: string;
    channelTitle?: string;
    publishedAt?: string;
    thumbnails?: Record<string, { url?: string }>;
  };
  statistics?: { viewCount?: string; likeCount?: string };
  contentDetails?: { duration?: string };
};

export async function getYouTubeOEmbed(url: string): Promise<{
  title: string;
  uploader: string;
  thumbnail: string | null;
}> {
  const query = new URLSearchParams({ url, format: "json" });
  const body = await fetchJson(`https://www.youtube.com/oembed?${query}`);
  if (typeof body.title !== "string" || typeof body.author_name !== "string") {
    throw new ProviderError("YouTube returned incomplete public video metadata.");
  }
  return {
    title: body.title,
    uploader: body.author_name,
    thumbnail: typeof body.thumbnail_url === "string" ? body.thumbnail_url : null,
  };
}

async function youtubeVideos(ids: string[], key: string): Promise<YouTubeVideo[]> {
  if (!ids.length) return [];
  const query = new URLSearchParams({
    part: "snippet,statistics,contentDetails",
    id: ids.join(","),
    key,
    maxResults: String(ids.length),
  });
  const body = await fetchJson(`https://www.googleapis.com/youtube/v3/videos?${query}`);
  return Array.isArray(body.items) ? body.items as YouTubeVideo[] : [];
}

async function searchYouTube(request: SearchRequest): Promise<VideoPage> {
  const key = requireYouTubeKey();
  const query = new URLSearchParams({
    part: "snippet",
    type: "video",
    maxResults: String(request.limit),
    q: request.q,
    order: request.sort === "date" ? "date" : request.sort === "views" ? "viewCount" : "relevance",
    key,
  });
  const publishedAfter = dateStart(request.date);
  if (publishedAfter) query.set("publishedAfter", publishedAfter);
  if (request.duration !== "any") query.set("videoDuration", request.duration);
  if (request.pageToken) query.set("pageToken", request.pageToken);
  const search = await fetchJson(`https://www.googleapis.com/youtube/v3/search?${query}`) as YouTubeSearchResponse;
  const ids = (search.items ?? []).map((item) => item.id?.videoId).filter((id): id is string => Boolean(id));
  const videos = await youtubeVideos(ids, key);
  const items = videos.map((video): VideoResult => {
    const snippet = video.snippet ?? {};
    const thumbnails = snippet.thumbnails ?? {};
    const thumbnail = thumbnails.high?.url ?? thumbnails.medium?.url ?? thumbnails.default?.url ?? null;
    return {
      id: video.id ?? "",
      platform: "youtube",
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id ?? "")}`,
      title: snippet.title ?? "Untitled video",
      thumbnail,
      channel: snippet.channelTitle ?? "Unknown channel",
      views: video.statistics?.viewCount ? Number(video.statistics.viewCount) : null,
      likes: video.statistics?.likeCount ? Number(video.statistics.likeCount) : null,
      publishedAt: snippet.publishedAt ?? null,
      duration: parseDuration(video.contentDetails?.duration),
      downloadable: true,
    };
  }).filter((video) => durationMatches(video.duration, request.duration));
  if (request.sort === "likes") items.sort((a, b) => (b.likes ?? -1) - (a.likes ?? -1));
  return { items, nextPageToken: search.nextPageToken ?? null };
}

function requireTikTokCredentials(): { clientKey: string; accessToken: string } {
  const clientKey = process.env.TIKTOK_CLIENT_KEY?.trim();
  const accessToken = process.env.TIKTOK_ACCESS_TOKEN?.trim();
  if (!clientKey || !accessToken) {
    throw new ProviderError("API_KEY_MISSING", 503, "API_KEY_MISSING", "tiktok");
  }
  return { clientKey, accessToken };
}

type TikTokVideo = {
  id?: string;
  video_description?: string;
  username?: string;
  create_time?: number;
  view_count?: number;
  like_count?: number;
  video_duration?: number;
  cover_image_url?: string;
};

async function searchTikTok(request: SearchRequest | TrendingRequest): Promise<VideoPage> {
  const { clientKey, accessToken } = requireTikTokCredentials();
  void clientKey;
  const isSearch = "q" in request;
  const region = isSearch ? "US" : request.region.toUpperCase();
  const queryAnd: Array<Record<string, unknown>> = [
    { operation: "EQ", field_name: "region_code", field_values: [region] },
  ];
  const startDays = isSearch
    ? request.date === "any" ? 30 : ({ day: 1, week: 7, month: 30, year: 365 } as const)[request.date]
    : 7;
  if (isSearch && request.q) {
    queryAnd.push({ operation: "CONTAINS", field_name: "video_description", field_values: [request.q] });
  }
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - startDays * 86_400_000);
  const fields = "id,video_description,create_time,region_code,username,view_count,like_count,video_duration,cover_image_url";
  const body: Record<string, unknown> = {
    query: { and: queryAnd },
    start_date: startDate.toISOString().slice(0, 10).replaceAll("-", ""),
    end_date: endDate.toISOString().slice(0, 10).replaceAll("-", ""),
    max_count: isSearch ? request.limit : 50,
    sort_field: isSearch && request.sort === "date" ? "create_time" : "view_count",
    sort_order: "DESC",
  };
  if (isSearch && request.pageToken) body.cursor = Number(request.pageToken) || 0;
  const response = await fetchJson(
    `https://open.tiktokapis.com/v2/research/video/query/?fields=${encodeURIComponent(fields)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const data = typeof response.data === "object" && response.data !== null
    ? response.data as Record<string, unknown>
    : {};
  const videos = Array.isArray(data.videos) ? data.videos as TikTokVideo[] : [];
  const items = videos.map((video): VideoResult => {
    const id = video.id ?? "";
    const username = (video.username ?? "").replace(/[^a-zA-Z0-9._]/g, "");
    return {
      id,
      platform: "tiktok",
      url: `https://www.tiktok.com/@${username}/video/${encodeURIComponent(id)}`,
      title: video.video_description ?? "TikTok video",
      thumbnail: video.cover_image_url ?? null,
      channel: username ? `@${username}` : "TikTok creator",
      views: video.view_count ?? null,
      likes: video.like_count ?? null,
      publishedAt: typeof video.create_time === "number" ? new Date(video.create_time * 1000).toISOString() : null,
      duration: video.video_duration ?? null,
      downloadable: true,
    };
  }).filter((video) => isSearch ? durationMatches(video.duration, request.duration) : true);
  if (isSearch && request.sort === "likes") items.sort((a, b) => (b.likes ?? -1) - (a.likes ?? -1));
  const cursor = typeof data.cursor === "number" ? String(data.cursor) : null;
  return { items, nextPageToken: data.has_more === true ? cursor : null };
}

function requireInstagramCredentials(): { token: string; userId: string } {
  const token = process.env.INSTAGRAM_TOKEN?.trim();
  const userId = process.env.INSTAGRAM_USER_ID?.trim();
  if (!token || !userId) {
    throw new ProviderError("API_KEY_MISSING", 503, "API_KEY_MISSING", "instagram");
  }
  return { token, userId };
}

type InstagramMedia = {
  id?: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  thumbnail_url?: string;
};

async function searchInstagram(request: SearchRequest): Promise<VideoPage> {
  const { token, userId } = requireInstagramCredentials();
  const hashtag = request.q.replace(/^#/, "").trim();
  if (!/^[\p{L}\p{N}_]{1,100}$/u.test(hashtag)) {
    throw new ProviderError("Instagram hashtag search requires one hashtag without spaces.");
  }
  const version = process.env.META_GRAPH_API_VERSION ?? "v22.0";
  const search = new URLSearchParams({ user_id: userId, q: hashtag, access_token: token });
  const tags = await fetchJson(`https://graph.facebook.com/${version}/ig_hashtag_search?${search}`);
  const tagId = Array.isArray(tags.data) && typeof tags.data[0] === "object" && tags.data[0] !== null
    ? (tags.data[0] as Record<string, unknown>).id
    : null;
  if (typeof tagId !== "string") return { items: [], nextPageToken: null };
  const edge = request.sort === "date" ? "recent_media" : "top_media";
  const params = new URLSearchParams({
    user_id: userId,
    fields: "id,caption,media_type,media_url,permalink,timestamp,like_count,thumbnail_url",
    limit: String(request.limit),
    access_token: token,
  });
  if (request.pageToken) params.set("after", request.pageToken);
  const mediaResponse = await fetchJson(`https://graph.facebook.com/${version}/${tagId}/${edge}?${params}`);
  const media = Array.isArray(mediaResponse.data) ? mediaResponse.data as InstagramMedia[] : [];
  const cutoff = dateStart(request.date);
  const items = media.filter((item) => item.media_type === "VIDEO").map((item): VideoResult => ({
    id: item.id ?? "",
    platform: "instagram",
    url: item.permalink ?? "",
    title: item.caption?.slice(0, 180) || "Instagram video",
    thumbnail: item.thumbnail_url ?? item.media_url ?? null,
    channel: "Instagram creator",
    views: null,
    likes: item.like_count ?? null,
    publishedAt: item.timestamp ?? null,
    duration: null,
    downloadable: Boolean(item.media_url),
  })).filter((item) => {
    if (!cutoff || !item.publishedAt) return true;
    return new Date(item.publishedAt).getTime() >= new Date(cutoff).getTime();
  });
  if (request.sort === "likes") items.sort((a, b) => (b.likes ?? -1) - (a.likes ?? -1));
  const paging = typeof mediaResponse.paging === "object" && mediaResponse.paging !== null
    ? mediaResponse.paging as Record<string, unknown>
    : {};
  const cursors = typeof paging.cursors === "object" && paging.cursors !== null
    ? paging.cursors as Record<string, unknown>
    : {};
  return { items, nextPageToken: typeof cursors.after === "string" ? cursors.after : null };
}

export async function searchVideos(request: SearchRequest): Promise<VideoPage> {
  if (request.platform === "youtube") return searchYouTube(request);
  if (request.platform === "tiktok") return searchTikTok(request);
  return searchInstagram(request);
}

export async function getTrending(request: TrendingRequest): Promise<VideoPage> {
  if (request.platform === "youtube") {
    const key = requireYouTubeKey();
    const query = new URLSearchParams({
      part: "snippet,statistics,contentDetails",
      chart: "mostPopular",
      regionCode: request.region.toUpperCase(),
      maxResults: "24",
      key,
    });
    const body = await fetchJson(`https://www.googleapis.com/youtube/v3/videos?${query}`);
    const videos = Array.isArray(body.items) ? body.items as YouTubeVideo[] : [];
    const items = videos.map((video): VideoResult => {
      const snippet = video.snippet ?? {};
      const thumbnails = snippet.thumbnails ?? {};
      const thumbnail = thumbnails.high?.url ?? thumbnails.medium?.url ?? thumbnails.default?.url ?? null;
      return {
        id: video.id ?? "",
        platform: "youtube",
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id ?? "")}`,
        title: snippet.title ?? "Untitled video",
        thumbnail,
        channel: snippet.channelTitle ?? "Unknown channel",
        views: video.statistics?.viewCount ? Number(video.statistics.viewCount) : null,
        likes: video.statistics?.likeCount ? Number(video.statistics.likeCount) : null,
        publishedAt: snippet.publishedAt ?? null,
        duration: parseDuration(video.contentDetails?.duration),
        downloadable: true,
      };
    });
    return { items, nextPageToken: null };
  }
  if (request.platform === "tiktok") return searchTikTok(request);
  throw new ProviderError(
    "Instagram Graph API does not provide a public global trending feed. Search a hashtag instead.",
    422,
    "TRENDING_NOT_SUPPORTED",
    "instagram",
  );
}
