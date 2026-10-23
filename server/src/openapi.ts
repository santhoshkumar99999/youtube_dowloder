export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "OpenClip API",
    version: "1.0.0",
    description: "Backend-only API for public video metadata, official API discovery, authorized downloads, and content reports.",
  },
  servers: [{ url: "/" }],
  paths: {
    "/api/health": {
      get: {
        summary: "Check backend health",
        responses: { "200": { description: "Backend is healthy." } },
      },
    },
    "/api/info": {
      post: {
        summary: "Get public video metadata",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/VideoUrl" } } },
        },
        responses: {
          "200": { description: "Video metadata and available formats." },
          "400": { description: "Invalid or unsupported URL." },
          "502": { description: "Video provider error." },
        },
      },
    },
    "/api/download": {
      get: {
        summary: "Stream a file for an authorized public video",
        parameters: [
          { name: "url", in: "query", required: true, schema: { type: "string", format: "uri" } },
          { name: "format", in: "query", required: true, schema: { type: "string", enum: ["mp4", "mp3", "m4a", "thumbnail", "srt", "txt"] } },
          { name: "quality", in: "query", schema: { type: "string", enum: ["360", "480", "720", "1080", "best"], default: "best" } },
        ],
        responses: {
          "200": { description: "Download stream." },
          "400": { description: "Invalid URL or parameters." },
          "502": { description: "Video is unavailable or the provider returned an error." },
        },
      },
    },
    "/api/search": {
      get: {
        summary: "Search videos using official platform APIs",
        parameters: [
          { name: "platform", in: "query", required: true, schema: { type: "string", enum: ["youtube", "tiktok", "instagram"] } },
          { name: "q", in: "query", required: true, schema: { type: "string", minLength: 1, maxLength: 200 } },
          { name: "sort", in: "query", schema: { type: "string", enum: ["views", "date", "likes"] } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50 } },
          { name: "pageToken", in: "query", schema: { type: "string" } },
          { name: "date", in: "query", schema: { type: "string", enum: ["any", "day", "week", "month", "year"] } },
          { name: "duration", in: "query", schema: { type: "string", enum: ["any", "short", "medium", "long"] } },
        ],
        responses: {
          "200": { description: "Official API video results." },
          "503": {
            description: "API key missing.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/MissingApiKey" },
              },
            },
          },
        },
      },
    },
    "/api/trending": {
      get: {
        summary: "Get official API top videos",
        parameters: [
          { name: "platform", in: "query", required: true, schema: { type: "string", enum: ["youtube", "tiktok", "instagram"] } },
          { name: "region", in: "query", schema: { type: "string", minLength: 2, maxLength: 2, default: "US" } },
        ],
        responses: {
          "200": { description: "Top videos from the official API." },
          "422": { description: "Platform does not offer a global trending feed." },
          "503": { description: "API key missing." },
        },
      },
    },
    "/api/playlist/info": {
      post: {
        summary: "List videos in a bounded YouTube playlist or channel",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/VideoUrl" } } },
        },
        responses: { "200": { description: "Playlist entries, capped by MAX_PLAYLIST_ITEMS." } },
      },
    },
    "/api/batch/info": {
      post: {
        summary: "Get metadata for up to 25 public video URLs",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["urls"],
                properties: { urls: { type: "array", minItems: 1, maxItems: 25, items: { type: "string", format: "uri" } } },
              },
            },
          },
        },
        responses: { "200": { description: "Metadata or an item-specific error for each link." } },
      },
    },
    "/api/gif": {
      post: {
        summary: "Create a short video-to-GIF clip",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["url", "start", "end"],
                properties: {
                  url: { type: "string", format: "uri" },
                  start: { type: "number", minimum: 0 },
                  end: { type: "number", exclusiveMinimum: 0 },
                  width: { type: "integer", minimum: 120, maximum: 480, default: 360 },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Animated GIF stream, maximum 15 seconds and 50 MB." } },
      },
    },
    "/api/report": {
      post: {
        summary: "Report content for administrator review",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["url", "category", "details"],
                properties: {
                  url: { type: "string", format: "uri" },
                  category: { type: "string", enum: ["copyright", "privacy", "safety", "other"] },
                  details: { type: "string", minLength: 10, maxLength: 2000 },
                },
              },
            },
          },
        },
        responses: { "201": { description: "Report saved to the local administrator inbox." } },
      },
    },
  },
  components: {
    schemas: {
      VideoUrl: {
        type: "object",
        required: ["url"],
        properties: { url: { type: "string", format: "uri", maxLength: 2048 } },
      },
      MissingApiKey: {
        type: "object",
        required: ["error", "platform"],
        properties: {
          error: { type: "string", const: "API_KEY_MISSING" },
          platform: { type: "string", enum: ["youtube", "tiktok", "instagram"] },
        },
      },
    },
  },
} as const;
