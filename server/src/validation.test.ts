import assert from "node:assert/strict";
import test from "node:test";
import {
  gifRequestSchema,
  reportRequestSchema,
  validateThumbnailUrl,
  validateVideoUrl,
} from "./validation.js";

test("accepts supported public platform hosts", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=abc",
    "https://youtu.be/abc",
    "https://www.instagram.com/reel/abc/",
    "https://www.tiktok.com/@creator/video/123",
  ]) {
    assert.doesNotThrow(() => validateVideoUrl(url));
  }
});

test("rejects unsupported, insecure, and deceptive hosts", () => {
  for (const url of [
    "http://youtube.com/watch?v=abc",
    "https://youtube.com.attacker.example/watch?v=abc",
    "https://example.com/video",
    "https://user:pass@youtube.com/watch?v=abc",
  ]) {
    assert.throws(() => validateVideoUrl(url));
  }
});

test("allows only known platform thumbnail CDN hosts", () => {
  assert.doesNotThrow(() => validateThumbnailUrl("https://i.ytimg.com/vi/example/hqdefault.jpg"));
  assert.throws(() => validateThumbnailUrl("https://example.com/image.jpg"));
  assert.throws(() => validateThumbnailUrl("http://i.ytimg.com/vi/example/hqdefault.jpg"));
});

test("limits GIF clips and validates bounded content reports", () => {
  assert.equal(gifRequestSchema.safeParse({
    url: "https://www.youtube.com/watch?v=abc",
    start: 2,
    end: 15,
  }).success, true);
  assert.equal(gifRequestSchema.safeParse({
    url: "https://www.youtube.com/watch?v=abc",
    start: 0,
    end: 16,
  }).success, false);
  assert.equal(reportRequestSchema.safeParse({
    url: "https://www.instagram.com/reel/abc/",
    category: "privacy",
    details: "This public post contains identifying information.",
  }).success, true);
});
