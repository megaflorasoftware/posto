import { useEffect, useState } from "react";
import { Alert, Button } from "@mantine/core";

import { CachedImage } from "@posto/editor";
import { invoke } from "@posto/ipc";
import { mediaInputPath, type MediaEntry } from "@posto/core/pagescms/config";

// Search/social previews built from the *rendered* page's <head> — fetched
// from the dev server and parsed here, so whatever the layout injects is what
// the cards show.

interface SeoData {
  title: string | null;
  description: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  ogUrl: string | null;
  ogSiteName: string | null;
  twitterCard: string | null;
  twitterTitle: string | null;
  twitterDescription: string | null;
  twitterImage: string | null;
  canonical: string | null;
  favicon: string | null;
}

function parseSeo(html: string): SeoData {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const meta = (selector: string) =>
    doc.querySelector<HTMLMetaElement>(selector)?.content?.trim() || null;
  return {
    title: doc.querySelector("title")?.textContent?.trim() || null,
    description: meta('meta[name="description"]'),
    ogTitle: meta('meta[property="og:title"]'),
    ogDescription: meta('meta[property="og:description"]'),
    ogImage: meta('meta[property="og:image"]'),
    ogUrl: meta('meta[property="og:url"]'),
    ogSiteName: meta('meta[property="og:site_name"]'),
    twitterCard: meta('meta[name="twitter:card"]'),
    twitterTitle: meta('meta[name="twitter:title"]'),
    twitterDescription: meta('meta[name="twitter:description"]'),
    twitterImage: meta('meta[name="twitter:image"]'),
    canonical:
      doc.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.getAttribute("href") || null,
    favicon:
      doc
        .querySelector<HTMLLinkElement>('link[rel="icon"], link[rel="shortcut icon"]')
        ?.getAttribute("href") || null,
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

/**
 * Resolves a page-relative or absolute asset URL to something the webview can
 * load. Meta tags usually carry production URLs, so only the path matters.
 * Files resolve from the media source first, then the site's `public` folder,
 * and are displayed through the shared thumbnail cache. The dev-server URL
 * remains as the non-Tauri (mock) fallback.
 */
interface LocalAsset {
  path: string | null;
  fallbackSrc: string | null;
}

function localAsset(
  src: string | null,
  root: string,
  media: MediaEntry | null,
  port: number,
): LocalAsset {
  if (!src) return { path: null, fallbackSrc: null };
  let pathname: string;
  try {
    pathname = new URL(src, `http://localhost:${port}`).pathname;
  } catch {
    return { path: null, fallbackSrc: null };
  }
  const absolute = media ? mediaInputPath(root, media, pathname) : null;
  return {
    path: absolute || root + "/public" + pathname,
    fallbackSrc: `http://localhost:${port}${pathname}`,
  };
}

function CardImage(props: { source: LocalAsset; modifier: string }) {
  const hasSource = !!(props.source.path || props.source.fallbackSrc);
  const fallback = (
    <div className={`seo-card-image seo-card-image-empty ${props.modifier}`}>
      {hasSource ? null : "No image"}
    </div>
  );
  return (
    <CachedImage
      className={`seo-card-image ${props.modifier}`}
      path={props.source.path}
      fallbackSrc={props.source.fallbackSrc}
      fallback={fallback}
      thumbnailWidth={640}
      thumbnailHeight={360}
      alt=""
    />
  );
}

export function SeoPreview(props: {
  route: string;
  root: string;
  /** First media source, if any — resolves image paths stored in content. */
  media: MediaEntry | null;
  port: number;
  refreshKey: number;
}) {
  const [seo, setSeo] = useState<SeoData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [refetchTick, setRefetchTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const route = props.route;
    void (async () => {
      // Give the dev server a beat to rebuild after a save before asking for
      // the fresh head.
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        const data = parseSeo(await invoke<string>("fetch_page", { route }));
        if (!cancelled) {
          setSeo(data);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.route, props.refreshKey, refetchTick]);

  const displayUrl = (() => {
    const canonical = seo?.canonical ?? seo?.ogUrl;
    if (canonical) {
      try {
        const url = new URL(canonical);
        const path = url.pathname === "/" ? "" : url.pathname.replace(/\//g, " › ");
        return { host: url.hostname, breadcrumb: url.hostname + path, full: canonical };
      } catch {
        // fall through to localhost display
      }
    }
    return {
      host: "localhost",
      breadcrumb: "localhost" + (props.route === "/" ? "" : props.route.replace(/\//g, " › ")),
      full: `http://localhost:${props.port}${props.route}`,
    };
  })();

  const googleTitle = seo?.title ?? seo?.ogTitle;
  const googleDescription = seo?.description ?? seo?.ogDescription;
  const cardTitle = seo?.twitterTitle ?? seo?.ogTitle ?? seo?.title;
  const cardDescription = seo?.twitterDescription ?? seo?.ogDescription ?? seo?.description;
  const cardImage = localAsset(
    seo?.twitterImage ?? seo?.ogImage ?? null,
    props.root,
    props.media,
    props.port,
  );
  const favicon = localAsset(seo?.favicon ?? "/favicon.ico", props.root, props.media, props.port);
  const fbTitle = seo?.ogTitle ?? seo?.title;
  const fbDescription = seo?.ogDescription ?? seo?.description;

  const missing = (what: string) => <span className="seo-missing">Missing {what}</span>;

  const cardImageArea = (modifier: string) => <CardImage source={cardImage} modifier={modifier} />;

  return (
    <div className="seo-preview">
      <div className="seo-toolbar">
        <span className="seo-route">{props.route}</span>
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          onClick={() => setRefetchTick((t) => t + 1)}
        >
          Refresh
        </Button>
      </div>

      {error != null && (
        <Alert color="yellow">Could not load page metadata: {String(error)}</Alert>
      )}

      {seo && (
        <>
          <section className="seo-section">
            <h3 className="seo-heading">Google</h3>
            <div className="seo-google">
              <div className="seo-google-site">
                {(favicon.path || favicon.fallbackSrc) && (
                  <CachedImage
                    className="seo-google-favicon"
                    path={favicon.path}
                    fallbackSrc={favicon.fallbackSrc}
                    thumbnailWidth={64}
                    thumbnailHeight={64}
                    alt=""
                  />
                )}
                <div className="seo-google-source">
                  <div className="seo-google-name">{seo.ogSiteName ?? displayUrl.host}</div>
                  <div className="seo-google-url">{displayUrl.breadcrumb}</div>
                </div>
              </div>
              <div className="seo-google-title">
                {googleTitle ? truncate(googleTitle, 60) : missing("<title>")}
              </div>
              <div className="seo-google-desc">
                {googleDescription ? truncate(googleDescription, 160) : missing("meta description")}
              </div>
            </div>
          </section>

          <section className="seo-section">
            <h3 className="seo-heading">
              Twitter / X — large card
              {seo.twitterCard && seo.twitterCard !== "summary_large_image" && (
                <span className="seo-note">(twitter:card is "{seo.twitterCard}")</span>
              )}
            </h3>
            <div className="seo-card seo-card-large">
              {cardImageArea("seo-card-image-large")}
              <div className="seo-card-text">
                <div className="seo-card-domain">{displayUrl.host}</div>
                <div className="seo-card-title">
                  {cardTitle ? truncate(cardTitle, 70) : missing("og:title")}
                </div>
                <div className="seo-card-desc">
                  {cardDescription ? truncate(cardDescription, 125) : missing("og:description")}
                </div>
              </div>
            </div>
          </section>

          <section className="seo-section">
            <h3 className="seo-heading">Twitter / X — small card</h3>
            <div className="seo-card seo-card-small">
              {cardImageArea("seo-card-image-small")}
              <div className="seo-card-text">
                <div className="seo-card-domain">{displayUrl.host}</div>
                <div className="seo-card-title">
                  {cardTitle ? truncate(cardTitle, 70) : missing("og:title")}
                </div>
                <div className="seo-card-desc">
                  {cardDescription ? truncate(cardDescription, 125) : missing("og:description")}
                </div>
              </div>
            </div>
          </section>

          <section className="seo-section">
            <h3 className="seo-heading">Facebook / Open Graph</h3>
            <div className="seo-card seo-card-facebook">
              {cardImageArea("seo-card-image-large")}
              <div className="seo-card-text seo-facebook-text">
                <div className="seo-facebook-domain">{displayUrl.host.toUpperCase()}</div>
                <div className="seo-facebook-title">
                  {fbTitle ? truncate(fbTitle, 90) : missing("og:title")}
                </div>
                <div className="seo-card-desc">
                  {fbDescription ? truncate(fbDescription, 110) : missing("og:description")}
                </div>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
