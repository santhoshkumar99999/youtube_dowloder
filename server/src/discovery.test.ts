import assert from "node:assert/strict";
import test from "node:test";
import { getYouTubeOEmbed, ProviderError, searchVideos } from "./discovery.js";
import { searchRequestSchema } from "./validation.js";

test("YouTube oEmbed provides public metadata without media extraction", async () => {
  const originalFetch = globalThis.fetch;
  let requested: URL | undefined;
  globalThis.fetch = async (input) => {
    requested = new URL(String(input));
    return new Response(JSON.stringify({
      title: "Public video title",
      author_name: "Public channel",
      thumbnail_url: "https://i.ytimg.com/vi/video-1/hqdefault.jpg",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await getYouTubeOEmbed("https://youtu.be/video-1");
    assert.equal(requested?.origin, "https://www.youtube.com");
    assert.equal(requested?.pathname, "/oembed");
    assert.equal(requested?.searchParams.get("url"), "https://youtu.be/video-1");
    assert.deepEqual(result, {
      title: "Public video title",
      uploader: "Public channel",
      thumbnail: "https://i.ytimg.com/vi/video-1/hqdefault.jpg",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("YouTube search uses official search and video details APIs", async () => {
  const previousKey = process.env.YOUTUBE_API_KEY;
  const originalFetch = globalThis.fetch;
  const requested: URL[] = [];
  process.env.YOUTUBE_API_KEY = "test-key";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requested.push(url);
    if (url.pathname.endsWith("/search")) {
      return new Response(JSON.stringify({
        items: [{ id: { videoId: "video-1" } }],
        nextPageToken: "next-page",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      items: [{
        id: "video-1",
        snippet: {
          title: "Lofi study music",
          channelTitle: "Creator",
          publishedAt: "2026-01-01T00:00:00Z",
          thumbnails: { high: { url: "https://i.ytimg.com/vi/video-1/hqdefault.jpg" } },
        },
        statistics: { viewCount: "1234", likeCount: "56" },
        contentDetails: { duration: "PT3M10S" },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await searchVideos(searchRequestSchema.parse({
      platform: "youtube",
      q: "lofi",
      sort: "views",
      limit: 20,
    }));
    assert.equal(requested.length, 2);
    assert.equal(requested[0].searchParams.get("q"), "lofi");
    assert.equal(requested[0].searchParams.get("order"), "viewCount");
    assert.equal(requested[0].searchParams.get("key"), "test-key");
    assert.equal(requested[1].pathname, "/youtube/v3/videos");
    assert.equal(result.items[0].views, 1234);
    assert.equal(result.items[0].duration, 190);
    assert.equal(result.nextPageToken, "next-page");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = previousKey;
  }
});

test("discovery reports a structured missing YouTube key error", async () => {
  const previousKey = process.env.YOUTUBE_API_KEY;
  delete process.env.YOUTUBE_API_KEY;
  try {
    await assert.rejects(
      searchVideos(searchRequestSchema.parse({ platform: "youtube", q: "lofi" })),
      (error: unknown) => error instanceof ProviderError &&
        error.code === "API_KEY_MISSING" &&
        error.platform === "youtube" &&
        error.status === 503,
    );
  } finally {
    if (previousKey !== undefined) process.env.YOUTUBE_API_KEY = previousKey;
  }
});
