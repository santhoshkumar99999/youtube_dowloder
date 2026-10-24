import { useEffect, useRef, useState, type FormEvent } from "react";
import { languages, translate, type Language, type MessageKey } from "./i18n";
import { ReportPage, SiteHeader, TermsPage } from "./SitePages";

type Format = { id: string; ext: string; height: number | null; hasVideo: boolean; hasAudio: boolean; size: number | null };
type VideoInfo = { title: string; thumbnail: string | null; duration: number | null; uploader: string; views: number | null; formats: Format[]; metadataOnly?: boolean };
type HistoryItem = { title: string; url: string; format: string; date: string };
type DownloadFormat = "mp4" | "mp3" | "m4a" | "thumbnail" | "srt" | "txt";
type SearchPlatform = "youtube" | "instagram" | "tiktok";
type SearchItem = {
  id: string;
  platform: SearchPlatform;
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
type DiscoveryMode = "search" | "trending";

const platformNames: Record<SearchPlatform, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
};

function detectPlatform(input: string): string | null {
  try {
    const host = new URL(input).hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtube.com" || host === "youtu.be") return "YouTube";
    if (host === "instagram.com") return "Instagram";
    if (host === "tiktok.com") return "TikTok";
  } catch {
    return null;
  }
  return null;
}

function formatDuration(seconds: number | null) {
  if (seconds === null) return "—";
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const formattedSeconds = String(totalSeconds % 60).padStart(2, "0");
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const formattedMinutes = String(minutes % 60).padStart(2, "0");
    return `${hours}:${formattedMinutes}:${formattedSeconds}`;
  }
  return `${String(minutes).padStart(2, "0")}:${formattedSeconds}`;
}

function proxyImageUrl(url: string | null) {
  if (!url) return null;
  return url.startsWith("/api/") ? url : `/api/image?url=${encodeURIComponent(url)}`;
}

function readPreference(name: string): string | null {
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
}

function saveBlob(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

async function responseError(response: Response) {
  const body = await response.json().catch(() => ({}));
  return typeof body.error === "string" ? body.error : `Request failed (${response.status}).`;
}

function downloadExtension(format: DownloadFormat, response: Response) {
  if (format !== "thumbnail") return format;
  const extensions: Record<string, string> = {
    "image/avif": "avif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0].toLowerCase();
  return extensions[contentType ?? ""] ?? "jpg";
}

export default function App() {
  const [language, setLanguage] = useState<Language>(() => {
    const saved = readPreference("openclip-language");
    return saved && saved in languages ? saved as Language : "en";
  });
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    readPreference("openclip-theme") === "dark" ? "dark" : "light",
  );
  const [url, setUrl] = useState("");
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [format, setFormat] = useState<DownloadFormat>("mp4");
  const [quality, setQuality] = useState("best");
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [retryAction, setRetryAction] = useState<"info" | "download" | "health" | "paste" | null>(null);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("openclip-history") ?? "[]") as HistoryItem[];
    } catch {
      return [];
    }
  });
  const [searchPlatform, setSearchPlatform] = useState<SearchPlatform>("youtube");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchSort, setSearchSort] = useState<"views" | "date" | "likes">("views");
  const [dateFilter, setDateFilter] = useState("any");
  const [durationFilter, setDurationFilter] = useState("any");
  const [region, setRegion] = useState("US");
  const [discoveryMode, setDiscoveryMode] = useState<DiscoveryMode | null>(null);
  const [discoveryResults, setDiscoveryResults] = useState<SearchItem[]>([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState("");
  const [missingApiKeyPlatform, setMissingApiKeyPlatform] = useState<SearchPlatform | null>(null);
  const [discoveryNotice, setDiscoveryNotice] = useState("");
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [batchText, setBatchText] = useState("");
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [batchItems, setBatchItems] = useState<Array<{
    url: string;
    title: string;
    duration: number | null;
    selected: boolean;
    consent: boolean;
    error?: string;
  }>>([]);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchError, setBatchError] = useState("");
  const [batchProgress, setBatchProgress] = useState("");
  const [gifStart, setGifStart] = useState("0");
  const [gifEnd, setGifEnd] = useState("5");
  const [gifConsent, setGifConsent] = useState(false);
  const [gifLoading, setGifLoading] = useState(false);
  const [gifError, setGifError] = useState("");
  const controllerRef = useRef<AbortController | null>(null);
  const retryRef = useRef<(() => void) | null>(null);
  const discoveryRetryRef = useRef<(() => void) | null>(null);
  const cancelBatchRef = useRef(false);
  const platform = detectPlatform(url);
  const t = (key: MessageKey) => translate(language, key);

  async function checkHealth() {
    try {
      const response = await fetch("/api/health", { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Health check failed (${response.status})`);
      setBackendOnline(true);
      setError((current) => current.startsWith("Backend is offline") ? "" : current);
      setRetryAction((current) => current === "health" ? null : current);
    } catch {
      setBackendOnline(false);
      setError("Backend is offline. Start the OpenClip API server, then retry.");
      setRetryAction("health");
    }
  }

  useEffect(() => {
    void checkHealth();
    const interval = window.setInterval(checkHealth, 15_000);
    return () => {
      window.clearInterval(interval);
      controllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("openclip-history", JSON.stringify(history.slice(0, 20)));
    } catch (cause) {
      setError(cause instanceof Error ? `Download history could not be saved locally: ${cause.message}` : "Download history could not be saved locally.");
    }
  }, [history]);

  useEffect(() => {
    try {
      localStorage.setItem("openclip-language", language);
    } catch {
      setError("The language preference could not be saved in this browser.");
    }
  }, [language]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("openclip-theme", theme);
    } catch {
      setError("The theme preference could not be saved in this browser.");
    }
  }, [theme]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js").catch((cause: unknown) => {
      setError(cause instanceof Error
        ? `Offline support could not be enabled: ${cause.message}`
        : "Offline support could not be enabled.");
      setRetryAction("info");
      retryRef.current = () => void navigator.serviceWorker.register("/sw.js");
    });
  }, []);

  async function fetchInfo(link: string) {
    setError("");
    setVideo(null);
    setLoading(true);
    try {
      const response = await fetch("/api/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: link }),
        signal: AbortSignal.timeout(130_000),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setVideo(await response.json() as VideoInfo);
    } catch (cause) {
      setError(cause instanceof TypeError
        ? "Backend is not reachable. Check the OpenClip API connection and retry."
        : cause instanceof Error ? cause.message : "Unable to fetch video information.");
    } finally {
      setLoading(false);
    }
  }

  async function handleLookup(event?: FormEvent) {
    event?.preventDefault();
    setRetryAction("info");
    retryRef.current = () => void handleLookup();
    setError("");
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      setError("Enter a valid public YouTube, Instagram, or TikTok URL.");
      return;
    }
    if (!detectPlatform(parsed.toString())) {
      setError("Only public YouTube, Instagram, and TikTok links are supported.");
      return;
    }
    if (parsed.protocol !== "https:") {
      setError("Use a secure HTTPS link from YouTube, Instagram, or TikTok.");
      return;
    }
    const normalized = parsed.toString();
    setUrl(normalized);
    setRetryAction("info");
    retryRef.current = () => void fetchInfo(normalized);
    await fetchInfo(normalized);
  }

  async function pasteLink() {
    setRetryAction("paste");
    retryRef.current = () => void pasteLink();
    setError("");
    try {
      setUrl(await navigator.clipboard.readText());
    } catch {
      setError("Clipboard access was blocked. Paste the link into the box manually.");
    }
  }

  async function loadDiscovery(mode: DiscoveryMode, append = false) {
    if (mode === "search" && !searchQuery.trim()) {
      setDiscoveryError("Enter a search phrase first.");
      return;
    }
    setDiscoveryMode(mode);
    setDiscoveryError("");
    setDiscoveryNotice("");
    setMissingApiKeyPlatform(null);
    setDiscoveryLoading(true);
    discoveryRetryRef.current = () => void loadDiscovery(mode, append);
    const params = new URLSearchParams({
      platform: searchPlatform,
      sort: searchSort,
      limit: "20",
      date: dateFilter,
      duration: durationFilter,
    });
    if (mode === "search") params.set("q", searchQuery.trim());
    else params.set("region", region);
    if (append && nextPageToken) params.set("pageToken", nextPageToken);
    try {
      const response = await fetch(`/api/${mode}?${params}`, { signal: AbortSignal.timeout(30_000) });
      const body = await response.json().catch(() => ({})) as {
        error?: string;
        platform?: SearchPlatform;
        items?: SearchItem[];
        nextPageToken?: string | null;
      };
      if (!response.ok) {
        if (body.error === "API_KEY_MISSING") {
          const missingPlatform = body.platform ?? searchPlatform;
          setMissingApiKeyPlatform(missingPlatform);
          setDiscoveryError(`Add your ${platformNames[missingPlatform]} API key in .env to use discovery.`);
        } else {
          setDiscoveryError(body.error ?? `Request failed (${response.status}).`);
        }
        if (!append) setDiscoveryResults([]);
        setNextPageToken(null);
        return;
      }
      const received = Array.isArray(body.items) ? body.items : [];
      setDiscoveryResults((current) => append ? [...current, ...received] : received);
      setNextPageToken(body.nextPageToken ?? null);
    } catch (cause) {
      setDiscoveryError(cause instanceof TypeError
        ? "Backend is not reachable. Check the OpenClip API connection and retry."
        : cause instanceof Error ? cause.message : "Video discovery failed.");
    } finally {
      setDiscoveryLoading(false);
    }
  }

  async function copyOriginalLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setDiscoveryNotice("Link copied to clipboard.");
      setDiscoveryError("");
    } catch {
      setDiscoveryError("Clipboard access was blocked. Copy the original link manually.");
    }
  }

  async function prepareResultDownload(item: SearchItem) {
    if (!item.downloadable) {
      setDiscoveryError("The official Instagram API did not provide a downloadable media URL for this post.");
      return;
    }
    setUrl(item.url);
    setRetryAction("info");
    retryRef.current = () => void fetchInfo(item.url);
    await fetchInfo(item.url);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function startDownload() {
    setError("");
    if (!video || !consent) {
      setError("Confirm that you have permission to download this content before continuing.");
      return;
    }
    const link = url;
    const selectedFormat = format;
    const selectedQuality = quality;
    setRetryAction("download");
    retryRef.current = () => void performDownload(link, selectedFormat, selectedQuality);
    await performDownload(link, selectedFormat, selectedQuality);
  }

  async function performDownload(link: string, selectedFormat: DownloadFormat, selectedQuality: string) {
    const controller = new AbortController();
    controllerRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(new Error("Download timed out after two minutes.")), 120_000);
    setDownloadProgress(0);
    setConsent(false);
    try {
      const params = new URLSearchParams({ url: link, format: selectedFormat, quality: selectedQuality });
      const response = await fetch(`/api/download?${params}`, { signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response));
      if (!response.body) throw new Error("The backend returned an empty download.");
      const total = Number(response.headers.get("Content-Length")) || 0;
      const reader = response.body.getReader();
      const chunks: ArrayBuffer[] = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          const copy = new Uint8Array(value.byteLength);
          copy.set(value);
          chunks.push(copy.buffer);
          received += value.byteLength;
          setDownloadProgress(total > 0 ? Math.min(99, Math.round(received * 100 / total)) : -1);
        }
      }
      if (received === 0) throw new Error("The backend returned an empty download.");
      const blob = new Blob(chunks);
      const extension = downloadExtension(selectedFormat, response);
      saveBlob(blob, `${(video?.title ?? "openclip-video").replace(/[\\/:*?"<>|]/g, "_")}.${extension}`);
      setDownloadProgress(100);
      setHistory((items) => [
        { title: video?.title ?? "Video", url: link, format: selectedFormat.toUpperCase(), date: new Date().toISOString() },
        ...items,
      ].slice(0, 20));
    } catch (cause) {
      const reason = controller.signal.aborted
        ? (controller.signal.reason instanceof Error ? controller.signal.reason.message : "Download canceled.")
        : cause instanceof TypeError
          ? "Backend is not reachable. Check the OpenClip API connection and retry."
          : cause instanceof Error ? cause.message : "Download failed.";
      setError(reason);
    } finally {
      window.clearTimeout(timeout);
      controllerRef.current = null;
      window.setTimeout(() => setDownloadProgress(null), 1200);
    }
  }

  function cancelDownload() {
    controllerRef.current?.abort(new Error("Download canceled."));
  }

  async function loadPlaylist() {
    setBatchError("");
    setBatchItems([]);
    setBatchLoading(true);
    try {
      const response = await fetch("/api/playlist/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: playlistUrl.trim() }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = await response.json().catch(() => ({})) as {
        error?: string;
        title?: string;
        truncated?: boolean;
        items?: Array<{ url: string; title: string; duration: number | null }>;
      };
      if (!response.ok) throw new Error(body.error ?? `Playlist request failed (${response.status}).`);
      setBatchItems((body.items ?? []).map((item) => ({
        ...item,
        selected: false,
        consent: false,
      })));
      if (body.truncated) setBatchError("Playlist list reached the configured item limit.");
    } catch (cause) {
      setBatchError(cause instanceof TypeError
        ? "Backend is not reachable. Check the OpenClip API connection and retry."
        : cause instanceof Error ? cause.message : "Unable to load the playlist.");
    } finally {
      setBatchLoading(false);
    }
  }

  async function analyzeBatchLinks() {
    const urls = [...new Set(batchText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
    if (!urls.length) {
      setBatchError("Paste one or more video links, one per line.");
      return;
    }
    if (urls.length > 25) {
      setBatchError("Analyze at most 25 video links at a time.");
      return;
    }
    setBatchError("");
    setBatchItems([]);
    setBatchLoading(true);
    try {
      const response = await fetch("/api/batch/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls }),
        signal: AbortSignal.timeout(300_000),
      });
      const body = await response.json().catch(() => ({})) as {
        error?: string;
        items?: Array<{ url: string; info?: { title: string; duration: number | null }; error?: string }>;
      };
      if (!response.ok) throw new Error(body.error ?? `Batch request failed (${response.status}).`);
      setBatchItems((body.items ?? []).map((item) => ({
        url: item.url,
        title: item.info?.title ?? item.url,
        duration: item.info?.duration ?? null,
        selected: false,
        consent: false,
        error: item.error,
      })));
    } catch (cause) {
      setBatchError(cause instanceof TypeError
        ? "Backend is not reachable. Check the OpenClip API connection and retry."
        : cause instanceof Error ? cause.message : "Unable to analyze these links.");
    } finally {
      setBatchLoading(false);
    }
  }

  async function downloadSelectedBatch() {
    const selected = batchItems.filter((item) => item.selected);
    if (!selected.length) {
      setBatchError("Select at least one video from the checklist.");
      return;
    }
    if (selected.some((item) => !item.consent)) {
      setBatchError("Confirm permission individually for every selected video.");
      return;
    }
    setBatchError("");
    cancelBatchRef.current = false;
    for (let index = 0; index < selected.length; index += 1) {
      if (cancelBatchRef.current) break;
      const item = selected[index];
      setBatchProgress(`Downloading ${index + 1} of ${selected.length}: ${item.title}`);
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        const params = new URLSearchParams({ url: item.url, format: "mp4", quality: "best" });
        const response = await fetch(`/api/download?${params}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await responseError(response));
        const blob = await response.blob();
        if (!blob.size) throw new Error("The backend returned an empty download.");
        saveBlob(blob, `${item.title.replace(/[\\/:*?"<>|]/g, "_")}.mp4`);
        setHistory((items) => [
          { title: item.title, url: item.url, format: "MP4", date: new Date().toISOString() },
          ...items,
        ].slice(0, 20));
      } catch (cause) {
        const message = controller.signal.aborted
          ? "Download canceled."
          : cause instanceof TypeError
            ? "Backend is not reachable."
            : cause instanceof Error ? cause.message : "Download failed.";
        setBatchItems((items) => items.map((entry) => entry.url === item.url ? { ...entry, error: message } : entry));
      }
      if (controller.signal.aborted) break;
    }
    controllerRef.current = null;
    setBatchProgress("");
  }

  async function createGif() {
    setGifError("");
    if (!url || !video) {
      setGifError("Fetch public video information first using the video link above.");
      return;
    }
    if (video.metadataOnly) {
      setGifError("This server can show public YouTube metadata, but cannot access the video media for GIF conversion.");
      return;
    }
    if (!gifConsent) {
      setGifError("Confirm permission to create a GIF from this video.");
      return;
    }
    setGifLoading(true);
    const controller = new AbortController();
    controllerRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(new Error("GIF creation timed out after three minutes.")), 180_000);
    try {
      const response = await fetch("/api/gif", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, start: Number(gifStart), end: Number(gifEnd), width: 360 }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await responseError(response));
      const blob = await response.blob();
      if (!blob.size) throw new Error("The backend returned an empty GIF.");
      saveBlob(blob, `${video.title.replace(/[\\/:*?"<>|]/g, "_")}.gif`);
      setHistory((items) => [
        { title: video.title, url, format: "GIF", date: new Date().toISOString() },
        ...items,
      ].slice(0, 20));
      setGifConsent(false);
    } catch (cause) {
      setGifError(cause instanceof TypeError
        ? "Backend is not reachable. Check the OpenClip API connection and retry."
        : cause instanceof Error ? cause.message : "GIF creation failed.");
    } finally {
      window.clearTimeout(timeout);
      setGifLoading(false);
      controllerRef.current = null;
    }
  }

  const pageProps = { language, setLanguage, theme, setTheme, backendOnline };
  if (window.location.pathname === "/terms") return <TermsPage {...pageProps} />;
  if (window.location.pathname === "/report") return <ReportPage {...pageProps} />;

  return (
    <main className={`page-shell theme-${theme}`}>
      <SiteHeader {...pageProps} />

      <section className="hero">
        <p className="eyebrow"><span /> {t("officialDiscovery")}</p>
        <h1>{t("headlineFirst")}<br /><span>{t("headlineSecond")}</span></h1>
        <p className="hero-copy">{t("heroCopy")}</p>

        {error && (
          <div className="error-banner" role="alert">
            <div><strong>Something went wrong</strong><p>{error}</p></div>
            {retryAction && <button className="retry-button" onClick={() => {
              if (retryAction === "health") void checkHealth();
              else if (retryAction === "download" && !consent) setError("Please confirm permission before retrying this download.");
              else retryRef.current?.();
            }}>Retry</button>}
            <button className="dismiss-button" aria-label="Dismiss error" onClick={() => setError("")}>×</button>
          </div>
        )}

        <form className="url-form" onSubmit={handleLookup}>
          <label className="sr-only" htmlFor="video-url">Video URL</label>
          <span className="link-icon" aria-hidden="true">↗</span>
          <input
            id="video-url"
            type="url"
            placeholder={t("urlPlaceholder")}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            required
          />
          <button className="paste-button" type="button" onClick={pasteLink}>{t("paste")}</button>
          <button className="lookup-button" type="submit" disabled={loading || backendOnline === false}>
            {loading ? t("looking") : t("getVideo")}
            {!loading && <span aria-hidden="true">→</span>}
          </button>
        </form>
        <div className="form-footnote">
          <span>{platform ? `${t("detected")}: ${platform}` : "YouTube · Instagram · TikTok"}</span>
          <span>{t("publicOnly")}</span>
        </div>

        {loading && <div className="skeleton-card" aria-label="Loading video details"><div className="skeleton-image" /><div className="skeleton-lines"><i /><i /><i /></div></div>}

        {video && !loading && (
          <article className="video-card">
            <div className="video-preview">
              {video.thumbnail ? <img src={video.thumbnail} alt="" onError={() => {
                setError("The thumbnail could not be loaded through the OpenClip backend.");
                setRetryAction("info");
                retryRef.current = () => void fetchInfo(url);
              }} /> : <div className="thumbnail-empty">▶</div>}
              <span className="duration">{formatDuration(video.duration)}</span>
            </div>
            <div className="video-details">
              <div className="video-platform">{platform ?? "VIDEO"} <span>·</span> PUBLIC CONTENT</div>
              <h2>{video.title}</h2>
              <p className="video-meta">{video.uploader} <span>·</span> {video.views?.toLocaleString() ?? "—"} views</p>
              {video.metadataOnly && <p className="metadata-notice" role="status">Public metadata only: this server cannot access the video media, so downloads and GIF creation are unavailable.</p>}
              <div className="download-controls">
                <label>
                  <span>{t("format")}</span>
                  <select value={format} onChange={(event) => setFormat(event.target.value as DownloadFormat)}>
                    <option value="mp4">MP4 video</option>
                    <option value="mp3">MP3 audio</option>
                    <option value="m4a">M4A audio</option>
                    <option value="thumbnail">Thumbnail</option>
                    <option value="srt">Subtitles (SRT)</option>
                    <option value="txt">Subtitles (TXT)</option>
                  </select>
                </label>
                {format === "mp4" && <label>
                  <span>{t("quality")}</span>
                  <select value={quality} onChange={(event) => setQuality(event.target.value)}>
                    {["360", "480", "720", "1080", "best"].map((value) => <option key={value} value={value}>{value === "best" ? "Best available" : `${value}p`}</option>)}
                  </select>
                </label>}
                <button className="download-button" onClick={startDownload} disabled={downloadProgress !== null || video.metadataOnly}>
                  {t("download")} <span aria-hidden="true">↓</span>
                </button>
              </div>
              <label className="consent-label">
                <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
                <span>{t("consent")}</span>
              </label>
              {downloadProgress !== null && (
                <div className="progress-wrap">
                  <div className="progress-track"><span style={{ width: downloadProgress === 0 ? "4%" : downloadProgress === -1 ? "35%" : `${downloadProgress}%` }} /></div>
                  <span>{downloadProgress === 100 ? "Ready" : downloadProgress === 0 ? "Preparing…" : downloadProgress === -1 ? "Downloading…" : `${downloadProgress}%`}</span>
                  {downloadProgress !== 100 && <button onClick={cancelDownload}>Cancel</button>}
                </div>
              )}
            </div>
          </article>
        )}
      </section>

      <section className="extras-section">
        <div className="section-heading"><div><p className="eyebrow">MORE TOOLS</p><h2>More ways to save</h2></div><a href="/docs">API docs ↗</a></div>
        <div className="extras-grid">
          <article className="extra-card">
            <h3>YouTube playlist &amp; channel checklist</h3>
            <p>Load a public YouTube playlist or channel. Select only the videos you have permission to save.</p>
            <label className="extra-field">Playlist or channel URL<input type="url" value={playlistUrl} onChange={(event) => setPlaylistUrl(event.target.value)} placeholder="https://youtube.com/playlist?list=…" /></label>
            <button className="secondary-button" onClick={() => void loadPlaylist()} disabled={batchLoading || !playlistUrl.trim()}>{batchLoading ? "Loading…" : "Load checklist"}</button>
          </article>
          <article className="extra-card">
            <h3>Batch links</h3>
            <p>Check up to 25 public video links, one per line.</p>
            <label className="extra-field">Video URLs<textarea value={batchText} onChange={(event) => setBatchText(event.target.value)} rows={4} placeholder={"https://youtu.be/…\nhttps://www.instagram.com/reel/…"} maxLength={60_000} /></label>
            <button className="secondary-button" onClick={() => void analyzeBatchLinks()} disabled={batchLoading || !batchText.trim()}>{batchLoading ? "Checking…" : "Check links"}</button>
          </article>
          <article className="extra-card gif-card">
            <h3>Trim a video to GIF</h3>
            <p>Make a short GIF clip from the video loaded above (maximum 15 seconds).</p>
            <div className="gif-fields">
              <label className="extra-field">Start (seconds)<input type="number" min="0" step="0.1" value={gifStart} onChange={(event) => setGifStart(event.target.value)} /></label>
              <label className="extra-field">End (seconds)<input type="number" min="0.1" step="0.1" value={gifEnd} onChange={(event) => setGifEnd(event.target.value)} /></label>
            </div>
            <label className="consent-label extra-consent"><input type="checkbox" checked={gifConsent} onChange={(event) => setGifConsent(event.target.checked)} /><span>{t("consent")}</span></label>
            <div className="gif-actions"><button className="secondary-button" onClick={() => void createGif()} disabled={gifLoading || Boolean(video?.metadataOnly)}>{gifLoading ? "Creating GIF…" : "Create GIF"}</button>
              {gifLoading && <button className="cancel-gif-button" onClick={() => controllerRef.current?.abort(new Error("GIF creation canceled."))}>Cancel</button>}
            </div>
          </article>
        </div>
        {batchError && <div className="error-banner" role="alert"><div><strong>Batch task failed</strong><p>{batchError}</p></div><button className="dismiss-button" aria-label="Dismiss batch error" onClick={() => setBatchError("")}>×</button></div>}
        {gifError && <div className="error-banner" role="alert"><div><strong>GIF task failed</strong><p>{gifError}</p></div><button className="retry-button" onClick={() => void createGif()}>Retry</button><button className="dismiss-button" aria-label="Dismiss GIF error" onClick={() => setGifError("")}>×</button></div>}
        {batchProgress && <div className="batch-progress"><span className="progress-track"><span /></span><span>{batchProgress}</span><button onClick={() => {
          cancelBatchRef.current = true;
          controllerRef.current?.abort(new Error("Download canceled."));
        }}>Cancel batch</button></div>}
        {batchItems.length > 0 && <div className="batch-checklist">
          <div className="batch-heading"><strong>Video checklist</strong><button className="download-button" onClick={() => void downloadSelectedBatch()} disabled={batchLoading || Boolean(batchProgress)}>Download selected</button></div>
          {batchItems.map((item) => <div className="batch-item" key={item.url}>
            <label className="batch-select"><input type="checkbox" checked={item.selected} disabled={Boolean(item.error)} onChange={(event) => setBatchItems((items) => items.map((entry) => entry.url === item.url ? { ...entry, selected: event.target.checked } : entry))} /><span>{item.title}{item.duration !== null ? ` · ${formatDuration(item.duration)}` : ""}</span></label>
            {item.error ? <span className="batch-item-error">{item.error}</span> : item.selected && <label className="batch-consent"><input type="checkbox" checked={item.consent} onChange={(event) => setBatchItems((items) => items.map((entry) => entry.url === item.url ? { ...entry, consent: event.target.checked } : entry))} /><span>{t("consent")}</span></label>}
          </div>)}
        </div>}
      </section>

      <section className="discovery-section" aria-labelledby="discovery-title">
        <div className="section-heading">
          <div><p className="eyebrow">{t("officialDiscovery")}</p><h2 id="discovery-title">{t("findSomethingGood")}</h2></div>
          <span>{t("officialApiVideos")}</span>
        </div>
        <div className="discovery-toolbar">
          <label><span>{t("platform")}</span><select value={searchPlatform} onChange={(event) => {
            setSearchPlatform(event.target.value as SearchPlatform);
            setNextPageToken(null);
          }}>
            <option value="youtube">YouTube</option><option value="instagram">Instagram</option><option value="tiktok">TikTok</option>
          </select></label>
          <label className="discovery-query"><span>{t("search")}</span><input
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setNextPageToken(null);
            }}
            onKeyDown={(event) => { if (event.key === "Enter") void loadDiscovery("search"); }}
            placeholder={searchPlatform === "instagram" ? "Try a hashtag, e.g. travel" : "Search public videos"}
            maxLength={200}
          /></label>
          <label><span>{t("sortBy")}</span><select value={searchSort} onChange={(event) => {
            setSearchSort(event.target.value as "views" | "date" | "likes");
            setNextPageToken(null);
          }}>
            <option value="views">{t("views")}</option><option value="date">{t("date")}</option><option value="likes">{t("likes")}</option>
          </select></label>
          <button className="discover-button" onClick={() => void loadDiscovery("search")} disabled={discoveryLoading}>{t("search")} <span>→</span></button>
        </div>
        <div className="discovery-filters">
          <label><span>{t("dateFilter")}</span><select value={dateFilter} onChange={(event) => {
            setDateFilter(event.target.value);
            setNextPageToken(null);
          }}>
            <option value="any">{t("anyTime")}</option><option value="day">{t("pastDay")}</option><option value="week">{t("pastWeek")}</option><option value="month">{t("pastMonth")}</option><option value="year">{t("pastYear")}</option>
          </select></label>
          <label><span>{t("duration")}</span><select value={durationFilter} disabled={searchPlatform === "instagram"} onChange={(event) => {
            setDurationFilter(event.target.value);
            setNextPageToken(null);
          }}>
            <option value="any">{t("anyLength")}</option><option value="short">{t("underFourMinutes")}</option><option value="medium">{t("fourToTwentyMinutes")}</option><option value="long">{t("overTwentyMinutes")}</option>
          </select></label>
          <label><span>{t("region")}</span><select value={region} onChange={(event) => {
            setRegion(event.target.value);
            setNextPageToken(null);
          }}>
            <option value="US">United States</option><option value="IN">India</option><option value="GB">United Kingdom</option><option value="CA">Canada</option><option value="AU">Australia</option>
          </select></label>
          <button className="trending-button" onClick={() => void loadDiscovery("trending")} disabled={discoveryLoading}>↗ {t("topVideos")}</button>
          {searchPlatform === "instagram" && <span className="filter-note">Instagram Graph API does not expose video duration.</span>}
        </div>

        {discoveryError && <div className="error-banner discovery-error" role="alert">
          <div><strong>Discovery failed</strong><p>{discoveryError}</p>
            {missingApiKeyPlatform && <a href="#api-keys">See API key setup steps</a>}
          </div>
          {discoveryRetryRef.current && <button className="retry-button" onClick={() => discoveryRetryRef.current?.()}>Retry</button>}
          <button className="dismiss-button" aria-label="Dismiss discovery error" onClick={() => setDiscoveryError("")}>×</button>
        </div>}
        {discoveryNotice && <p className="discovery-notice" role="status">{discoveryNotice}</p>}

        {discoveryLoading && <div className="result-grid" aria-label="Loading video results">
          {Array.from({ length: 3 }, (_, index) => <div className="result-skeleton" key={index}><div /><i /><i /></div>)}
        </div>}
        {!discoveryLoading && discoveryResults.length > 0 && <div className="result-grid">
          {discoveryResults.map((item) => {
            const image = proxyImageUrl(item.thumbnail);
            return <article className="result-card" key={`${item.platform}-${item.id || item.url}`}>
              <div className="result-image">
                {image ? <img src={image} alt="" loading="lazy" onError={() => {
                  setDiscoveryError("A thumbnail could not be loaded through the OpenClip backend.");
                  discoveryRetryRef.current = () => void loadDiscovery(discoveryMode ?? "search");
                }} /> : <span>▶</span>}
                {item.duration !== null && <span className="result-duration">{formatDuration(item.duration)}</span>}
              </div>
              <div className="result-copy">
                <div className="result-platform">{item.platform} <span>·</span> {item.publishedAt ? new Date(item.publishedAt).toLocaleDateString() : "date unavailable"}</div>
                <h3>{item.title}</h3>
                <p>{item.channel} <span>·</span> {item.views?.toLocaleString() ?? "—"} views</p>
                <div className="result-actions">
                  <button onClick={() => void prepareResultDownload(item)} disabled={!item.downloadable || discoveryLoading} title={!item.downloadable ? "Official API did not provide media for download" : undefined}>
                    {item.downloadable ? "Download" : "Unavailable"}
                  </button>
                  <button onClick={() => void copyOriginalLink(item.url)}>Copy link</button>
                  <a href={item.url} target="_blank" rel="noreferrer">Open original ↗</a>
                </div>
              </div>
            </article>;
          })}
        </div>}
        {!discoveryLoading && discoveryMode && !discoveryError && discoveryResults.length === 0 && <p className="empty-discovery">No videos found. Try another query or platform.</p>}
        {!discoveryLoading && nextPageToken && <button className="load-more-button" onClick={() => discoveryMode && void loadDiscovery(discoveryMode, true)}>{t("loadMore")}</button>}
        {discoveryMode === "trending" && searchPlatform === "instagram" && <p className="filter-note trending-note">Instagram does not provide a public global trending feed through its Graph API. Search a hashtag instead.</p>}
      </section>

      <section className="api-key-section" id="api-keys">
        <p className="eyebrow">BACKEND-ONLY CREDENTIALS</p>
        <h2>{t("apiSetup")}</h2>
        <p>Copy <code>.env.example</code> to <code>.env</code> and add credentials on the server only. OpenClip never sends API keys to your browser.</p>
        <ul>
          <li><strong>YouTube:</strong> enable YouTube Data API v3 in Google Cloud Console and set <code>YOUTUBE_API_KEY</code>.</li>
          <li><strong>TikTok:</strong> apply for restricted Research API access and set <code>TIKTOK_CLIENT_KEY</code> and <code>TIKTOK_ACCESS_TOKEN</code>.</li>
          <li><strong>Instagram:</strong> enable approved hashtag search and set <code>INSTAGRAM_TOKEN</code> and <code>INSTAGRAM_USER_ID</code>.</li>
        </ul>
        <p>Instagram Graph API has no public global trending feed; search a hashtag instead. Full setup steps and official links are in the README.</p>
      </section>

      <section className="trust-strip" aria-label="OpenClip principles">
        <div><span className="trust-icon">◉</span><span><strong>Creator first</strong><small>Permission before download</small></span></div>
        <div><span className="trust-icon">⌁</span><span><strong>Private by design</strong><small>No accounts or link tracking</small></span></div>
        <div><span className="trust-icon">♡</span><span><strong>Free & open source</strong><small>Built for your own content</small></span></div>
      </section>

      <section className="history-section">
        <div className="section-heading"><div><p className="eyebrow">YOUR DEVICE, YOUR HISTORY</p><h2>{t("recent")}</h2></div><span>{history.length ? `${history.length} ${history.length === 1 ? "item" : "items"}` : t("localOnly")}</span></div>
        {history.length ? (
          <ul className="history-list">
            {history.map((item, index) => <li key={`${item.date}-${index}`}>
              <div className="history-icon">↓</div>
              <div className="history-title"><strong>{item.title}</strong><small>{new URL(item.url).hostname.replace(/^www\./, "")} · {new Date(item.date).toLocaleDateString()}</small></div>
              <span className="history-format">{item.format}</span>
              <a href={item.url} target="_blank" rel="noreferrer" aria-label={`Open original: ${item.title}`}>↗</a>
            </li>)}
          </ul>
        ) : <p className="empty-history">Your recent downloads will appear here and stay only in this browser.</p>}
      </section>

      <footer><span>Made with care for the things you’re allowed to keep.</span><span>OpenClip · Respect creators. Respect the rules.</span><div className="footer-links"><a href="/terms">{t("terms")}</a><a href="/report">{t("reportContent")}</a><a href="/docs">{t("apiDocs")}</a></div></footer>
    </main>
  );
}
