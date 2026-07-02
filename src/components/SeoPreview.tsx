import { Show, createEffect, createResource, createSignal, on } from "solid-js";

import { invoke } from "../ipc";

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

/** Loads a page-relative or absolute asset URL through the local dev server. */
function localAsset(src: string | null, port: number): string | null {
  if (!src) return null;
  try {
    const url = new URL(src, `http://localhost:${port}`);
    return `http://localhost:${port}${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

export function SeoPreview(props: { route: string; port: number; refreshKey: number }) {
  const [seo, { refetch }] = createResource(
    () => ({ route: props.route, key: props.refreshKey }),
    async ({ route }) => {
      // Give the dev server a beat to rebuild after a save before asking for
      // the fresh head.
      await new Promise((resolve) => setTimeout(resolve, 500));
      return parseSeo(await invoke<string>("fetch_page", { route }));
    },
  );

  const displayUrl = () => {
    const s = seo();
    const canonical = s?.canonical ?? s?.ogUrl;
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
  };

  const googleTitle = () => seo()?.title ?? seo()?.ogTitle;
  const googleDescription = () => seo()?.description ?? seo()?.ogDescription;
  const cardTitle = () => seo()?.twitterTitle ?? seo()?.ogTitle ?? seo()?.title;
  const cardDescription = () =>
    seo()?.twitterDescription ?? seo()?.ogDescription ?? seo()?.description;
  const cardImage = () => localAsset(seo()?.twitterImage ?? seo()?.ogImage ?? null, props.port);
  const favicon = () => localAsset(seo()?.favicon ?? "/favicon.ico", props.port);

  const missing = (what: string) => <span class="seo-missing">Missing {what}</span>;

  function CardImage(imgProps: { src: string | null; modifier: string }) {
    const [failed, setFailed] = createSignal(false);
    createEffect(on(() => imgProps.src, () => setFailed(false), { defer: true }));
    return (
      <Show
        when={imgProps.src && !failed() ? imgProps.src : null}
        fallback={
          <div class={`seo-card-image seo-card-image-empty ${imgProps.modifier}`}>
            {imgProps.src ? "Image failed to load" : "No image"}
          </div>
        }
      >
        {(src) => (
          <img
            class={`seo-card-image ${imgProps.modifier}`}
            src={src()}
            alt=""
            onError={() => setFailed(true)}
          />
        )}
      </Show>
    );
  }

  const cardImageArea = (modifier: string) => (
    <CardImage src={cardImage()} modifier={modifier} />
  );

  return (
    <div class="seo-preview">
      <div class="seo-toolbar">
        <span class="seo-route">{props.route}</span>
        <wa-button attr:size="s" attr:appearance="plain" onClick={() => void refetch()}>
          Refresh
        </wa-button>
      </div>

      <Show when={seo.error}>
        <wa-callout variant="warning">Could not load page metadata: {String(seo.error)}</wa-callout>
      </Show>

      <Show when={seo()}>
        <section class="seo-section">
          <h3 class="seo-heading">Google</h3>
          <div class="seo-google">
            <div class="seo-google-site">
              <Show when={favicon()}>
                {(src) => <img class="seo-google-favicon" src={src()} alt="" />}
              </Show>
              <div class="seo-google-source">
                <div class="seo-google-name">{seo()?.ogSiteName ?? displayUrl().host}</div>
                <div class="seo-google-url">{displayUrl().breadcrumb}</div>
              </div>
            </div>
            <div class="seo-google-title">
              {googleTitle() ? truncate(googleTitle()!, 60) : missing("<title>")}
            </div>
            <div class="seo-google-desc">
              {googleDescription()
                ? truncate(googleDescription()!, 160)
                : missing("meta description")}
            </div>
          </div>
        </section>

        <section class="seo-section">
          <h3 class="seo-heading">
            Twitter / X — large card
            <Show when={seo()?.twitterCard && seo()?.twitterCard !== "summary_large_image"}>
              <span class="seo-note">(twitter:card is "{seo()?.twitterCard}")</span>
            </Show>
          </h3>
          <div class="seo-card seo-card-large">
            {cardImageArea("seo-card-image-large")}
            <div class="seo-card-text">
              <div class="seo-card-domain">{displayUrl().host}</div>
              <div class="seo-card-title">
                {cardTitle() ? truncate(cardTitle()!, 70) : missing("og:title")}
              </div>
              <div class="seo-card-desc">
                {cardDescription()
                  ? truncate(cardDescription()!, 125)
                  : missing("og:description")}
              </div>
            </div>
          </div>
        </section>

        <section class="seo-section">
          <h3 class="seo-heading">Twitter / X — small card</h3>
          <div class="seo-card seo-card-small">
            {cardImageArea("seo-card-image-small")}
            <div class="seo-card-text">
              <div class="seo-card-domain">{displayUrl().host}</div>
              <div class="seo-card-title">
                {cardTitle() ? truncate(cardTitle()!, 70) : missing("og:title")}
              </div>
              <div class="seo-card-desc">
                {cardDescription()
                  ? truncate(cardDescription()!, 125)
                  : missing("og:description")}
              </div>
            </div>
          </div>
        </section>

        <section class="seo-section">
          <h3 class="seo-heading">Facebook / Open Graph</h3>
          <div class="seo-card seo-card-facebook">
            {cardImageArea("seo-card-image-large")}
            <div class="seo-card-text seo-facebook-text">
              <div class="seo-facebook-domain">{displayUrl().host.toUpperCase()}</div>
              <div class="seo-facebook-title">
                {(seo()?.ogTitle ?? seo()?.title)
                  ? truncate((seo()?.ogTitle ?? seo()?.title)!, 90)
                  : missing("og:title")}
              </div>
              <div class="seo-card-desc">
                {(seo()?.ogDescription ?? seo()?.description)
                  ? truncate((seo()?.ogDescription ?? seo()?.description)!, 110)
                  : missing("og:description")}
              </div>
            </div>
          </div>
        </section>
      </Show>
    </div>
  );
}
