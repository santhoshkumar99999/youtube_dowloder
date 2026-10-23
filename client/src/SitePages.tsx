import { useState, type FormEvent } from "react";
import { languages, translate, type Language } from "./i18n";

type Theme = "light" | "dark";
type SiteHeaderProps = {
  language: Language;
  setLanguage: (language: Language) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  backendOnline: boolean | null;
};

export function SiteHeader({ language, setLanguage, theme, setTheme, backendOnline }: SiteHeaderProps) {
  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="OpenClip home">
        <span className="brand-mark">O</span> openclip<span className="brand-period">.</span>
      </a>
      <nav className="site-nav" aria-label="Main navigation">
        <a href="/docs">{translate(language, "apiDocs")}</a>
        <a href="/terms">{translate(language, "terms")}</a>
        <a href="/report">{translate(language, "reportContent")}</a>
      </nav>
      <div className="site-controls">
        <label className="sr-only" htmlFor="language-select">Language</label>
        <select id="language-select" className="language-select" value={language} onChange={(event) => setLanguage(event.target.value as Language)}>
          {Object.entries(languages).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select>
        <button className="theme-button" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}>
          {theme === "light" ? "☾" : "☼"}
        </button>
        <div className={`backend-status ${backendOnline ? "online" : backendOnline === false ? "offline" : "checking"}`} role="status">
          <span className="status-dot" />
          {backendOnline ? "Backend connected" : backendOnline === false ? "Backend not connected" : "Checking backend"}
        </div>
      </div>
    </header>
  );
}

type PageProps = Pick<SiteHeaderProps, "language" | "setLanguage" | "theme" | "setTheme" | "backendOnline">;

export function TermsPage(props: PageProps) {
  return (
    <main className={`page-shell theme-${props.theme}`}>
      <SiteHeader {...props} />
      <article className="legal-page">
        <p className="eyebrow">OPENCLIP · RESPONSIBLE USE</p>
        <h1>Terms &amp; disclaimer</h1>
        <p className="legal-lead">OpenClip is a tool for saving and discovering public videos. Use it lawfully and respect the people who make them.</p>
        <h2>Only download when authorized</h2>
        <p>You must own the content or have permission to download it. You are responsible for following the platform’s terms, applicable copyright law, privacy law, and other rules in your location.</p>
        <h2>Public content only</h2>
        <p>OpenClip does not bypass DRM, paywalls, private-account controls, age gates, sign-in requirements, or other access restrictions. A video being publicly visible does not mean it is free to download, reuse, or redistribute.</p>
        <h2>Keep creator credits and watermarks</h2>
        <p>OpenClip does not remove watermarks or creator credits. Do not present someone else’s work as your own or redistribute it without permission.</p>
        <h2>Third-party platforms</h2>
        <p>YouTube, Instagram, and TikTok control the availability of their content and APIs. Content can become unavailable at any time. Search and trending features require official API access and configured server-side credentials.</p>
        <h2>Self-hosting and responsibility</h2>
        <p>OpenClip is provided “as is,” without a guarantee of availability or fitness for a particular purpose. Operators are responsible for configuring their deployments, API credentials, limits, and any local obligations.</p>
        <a className="legal-back" href="/">← Back to OpenClip</a>
      </article>
    </main>
  );
}

export function ReportPage(props: PageProps) {
  const [url, setUrl] = useState("");
  const [category, setCategory] = useState("copyright");
  const [details, setDetails] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submitReport(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSuccess("");
    setSubmitting(true);
    try {
      const response = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, category, details }),
        signal: AbortSignal.timeout(15_000),
      });
      const result = await response.json().catch(() => ({})) as { error?: string; message?: string; id?: string };
      if (!response.ok) throw new Error(result.error ?? `Report failed (HTTP ${response.status}).`);
      setSuccess(`${result.message ?? "Report received."} Reference: ${result.id}`);
      setUrl("");
      setDetails("");
    } catch (cause) {
      setError(cause instanceof TypeError
        ? "The OpenClip backend is offline. Check the connection and retry."
        : cause instanceof Error ? cause.message : "Unable to submit the report.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className={`page-shell theme-${props.theme}`}>
      <SiteHeader {...props} />
      <article className="legal-page report-page">
        <p className="eyebrow">HELP KEEP OPENCLIP RESPONSIBLE</p>
        <h1>Report content</h1>
        <p className="legal-lead">Send a public video link and explain a copyright, privacy, or safety concern. Reports are stored for the self-hosted instance administrator; OpenClip does not automatically remove content.</p>
        {error && <div className="error-banner" role="alert"><div><strong>Report not sent</strong><p>{error}</p></div><button className="retry-button" onClick={() => document.querySelector<HTMLButtonElement>(".report-submit")?.click()}>Retry</button></div>}
        {success && <p className="report-success" role="status">{success}</p>}
        <form className="report-form" onSubmit={submitReport}>
          <label>Public video URL<input type="url" required maxLength={2048} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" /></label>
          <label>Reason<select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="copyright">Copyright</option><option value="privacy">Privacy</option><option value="safety">Safety</option><option value="other">Other</option>
          </select></label>
          <label>Details<textarea required minLength={10} maxLength={2000} rows={6} value={details} onChange={(event) => setDetails(event.target.value)} placeholder="Describe the concern (10–2000 characters)." /></label>
          <p className="report-privacy-note">Do not include passwords, access tokens, or other sensitive personal information. Reports are stored locally on this server for administrator review.</p>
          <button className="download-button report-submit" type="submit" disabled={submitting}>{submitting ? "Sending…" : "Send report"} <span>→</span></button>
        </form>
        <a className="legal-back" href="/">← Back to OpenClip</a>
      </article>
    </main>
  );
}
