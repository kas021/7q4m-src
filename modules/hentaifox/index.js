"use strict";

(() => {
  // HentaiFox — adult doujinshi/manga gallery catalogue on hentaifox.com.
  //
  // Cloudflare fronts every HTML route, so all page reads go through the pagev2
  // WebView bridge (a real page load with real cookies). Plain fetchv2 is used
  // only for image bytes, and only on the rare fallback path where the reader
  // page does not expose its page metadata.
  //
  // URL shapes, all verified against the live site and the fixtures in
  // modules/hentaifox/fixtures/:
  //   /                        latest galleries (20 cards) + popular parodies
  //                            + "Weekly Featured" / "Daily Top Rated" sidebar
  //   /page/2/ then /pag/<n>/  latest, deeper pages (the listing switches
  //                            template after page 2; /page/3/ is a 404)
  //   /search/?q=<q>           search (20 cards); &page=<n> for deeper pages
  //   /tag/<slug>/             tag browse; /tag/<slug>/pag/<n>/ for later pages
  //   /gallery/<id>/           details: title, cover, tags, artists, pages
  //   /g/<id>/<n>/             reader: exactly one full-size image per page
  //
  // Two things worth stating because they differ from the obvious guess:
  //   * /paginated/search|tag/... answers HTTP 404. Endless scroll is driven by
  //     the paths above (/page/N/ and /tag/<slug>/pag/N/), which are the exact
  //     links the site renders in its own pagination bar.
  //   * The reader is a one-image-per-page viewer, so the gallery's images
  //     cannot be scraped from a single <img> list. The reader HTML carries the
  //     full page table instead: #pages, #image_dir, #gallery_id, #unique_id
  //     and a `g_th` JSON blob ({"1":"w,1046,1500"} = ext code, width, height).
  //     The site's own reader.min.js builds
  //     `//<imgHost>/<image_dir>/<gallery_id>/<n>.<ext>` from that table; this
  //     module builds the same URLs, so one page load yields every image.
  const BASE_URL = "https://hentaifox.com";
  const HOME_PATH = "/";
  const MAX_ATTEMPTS = 3;
  const MAX_HTML_CHARS = 1_500_000;
  const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
  const MAX_CARDS = 80;
  const MAX_IMAGES = 400;
  const CACHE_TTL_MS = 300_000;
  const CACHE_LIMIT = 24;
  const SETTLE_MS = 140;

  // Extension codes used by the reader's g_th table.
  const EXTENSIONS = { j: "jpg", p: "png", b: "bmp", g: "gif", w: "webp" };

  // Home-page tag sections. The home markup itself ships no /tag/ links (only
  // gallery, parody and category links), so these are the fallback set: three
  // real, high-volume tag slugs taken from the live tag lists. Sections are
  // fetched lazily and isolated — a failing tag simply yields no section.
  const HOME_TAG_SECTIONS = [
    { slug: "big-breasts", title: "Popular: Big Breasts" },
    { slug: "sole-female", title: "Popular: Sole Female" },
    { slug: "schoolgirl-uniform", title: "Popular: Schoolgirl Uniform" },
  ];

  const CHALLENGE_PATTERN =
    /just a moment|cf-browser-verification|cf_chl_opt|attention required|checking your browser before accessing|enable javascript and cookies to continue|ddos protection by/i;
  const MISSING_PATTERN = /<title>\s*(?:🐴\s*)?404\b[^<]{0,40}?not found/i;

  const cache = new Map();

  function sleep(milliseconds) {
    return new Promise((resolve) => {
      if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(resolve, milliseconds);
      else Promise.resolve().then(resolve);
    });
  }

  function asError(value, fallback) {
    if (value instanceof Error) return value;
    const message = String(value == null ? "" : value).trim();
    return new Error(message || fallback);
  }

  function nonEmpty(value) {
    return String(value == null ? "" : value).trim();
  }

  function decodeEntities(value) {
    const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
    return String(value || "")
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
      .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] || match);
  }

  function stripTags(value) {
    return decodeEntities(
      String(value || "")
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<br\s*\/?\s*>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/\s+/g, " ")
      .trim();
  }

  // HentaiFox mixes attribute quoting styles between templates (the tag and
  // details templates emit single quotes, the home/search templates double
  // quotes) and sometimes omits the space between attributes, so every reader
  // here is quote-agnostic and does not assume separators.
  function attrValue(fragment, name) {
    const source = String(fragment || "");
    const pattern = new RegExp(
      "(?:^|[\\s\"'/<])" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))",
      "i",
    );
    const match = source.match(pattern);
    if (!match) return "";
    return decodeEntities(match[1] != null ? match[1] : match[2] != null ? match[2] : match[3] || "");
  }

  function absoluteURL(value) {
    const raw = nonEmpty(value);
    if (!raw) return "";
    if (/^data:/i.test(raw)) return "";
    if (/^https?:\/\//i.test(raw)) return raw.replace(/^http:/i, "https:");
    if (raw.startsWith("//")) return `https:${raw}`;
    if (raw.startsWith("/")) return `${BASE_URL}${raw}`;
    return "";
  }

  function urlHost(value) {
    const match = String(value || "").match(/^https?:\/\/([^/?#]+)/i);
    return match ? match[1].toLowerCase() : "";
  }

  function isHentaiFoxImage(value) {
    const raw = nonEmpty(value);
    if (!/^https:\/\//i.test(raw)) return false;
    const host = urlHost(raw);
    return host === "hentaifox.com" ? false : host.endsWith(".hentaifox.com");
  }

  function galleryID(value) {
    const raw = nonEmpty(value);
    if (!raw) throw new Error("Invalid HentaiFox gallery identifier.");
    if (/^https?:\/\//i.test(raw) || raw.startsWith("/")) {
      const match = raw.match(/\/(?:gallery|g)\/(\d{1,12})(?:[/?#]|$)/i);
      if (!match) throw new Error("Invalid HentaiFox gallery identifier.");
      return match[1];
    }
    if (!/^\d{1,12}$/.test(raw)) throw new Error("Invalid HentaiFox gallery identifier.");
    return raw;
  }

  function detailsPathFor(id) {
    return `/gallery/${id}/`;
  }

  function readerPathFor(id, pageNumber) {
    return `/g/${id}/${Math.max(1, Math.floor(Number(pageNumber) || 1))}/`;
  }

  function tagSlug(value) {
    const slug = nonEmpty(value)
      .toLowerCase()
      .replace(/&amp;/g, "&")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    if (!slug || !/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug)) {
      throw new Error("Invalid HentaiFox tag name.");
    }
    return slug;
  }

  function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return "";
    if (Date.now() - entry.at > CACHE_TTL_MS) {
      cache.delete(key);
      return "";
    }
    return entry.html;
  }

  function cacheSet(key, html) {
    if (!html) return;
    cache.set(key, { html, at: Date.now() });
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  function snapshotHTML(snapshot) {
    if (!snapshot) return "";
    if (typeof snapshot.html === "string" && snapshot.html.trim()) return snapshot.html;
    if (snapshot.html && typeof snapshot.html.html === "string" && snapshot.html.html.trim()) {
      return snapshot.html.html;
    }
    if (typeof snapshot.evaluatedData === "string" && snapshot.evaluatedData.trim()) {
      return snapshot.evaluatedData;
    }
    if (typeof snapshot.body === "string" && snapshot.body.trim()) return snapshot.body;
    return "";
  }

  function looksChallenged(html) {
    if (!html || html.length < 2000) return true;
    return CHALLENGE_PATTERN.test(html);
  }

  function looksMissing(html) {
    return MISSING_PATTERN.test(html);
  }

  async function fetchPageHTML(url, options = {}) {
    const cached = cacheGet(url);
    if (cached) return cached;
    if (typeof globalThis.pagev2 !== "function") {
      throw new Error("HentaiFox requires the pagev2 WebView bridge.");
    }
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(900 * attempt + Math.round(Math.random() * 250));
      let snapshot = null;
      try {
        snapshot = await globalThis.pagev2({
          url,
          headers: {
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            Referer: `${BASE_URL}/`,
          },
          userAgent: null,
          timeoutMilliseconds: 30_000,
          settleMilliseconds: SETTLE_MS,
          includeHTML: true,
          captureResponseBodies: false,
          maxEntries: 16,
          maxResponseCharacters: MAX_HTML_CHARS,
          actionScript: null,
          waitForSelector: "body",
          returnScript: "document.documentElement.outerHTML",
        });
      } catch (error) {
        lastError = asError(error, "HentaiFox page load failed.");
        continue;
      }

      const html = snapshotHTML(snapshot);
      if (!html) {
        lastError = new Error("HentaiFox returned an empty page.");
        continue;
      }
      if (looksChallenged(html)) {
        lastError = new Error(
          "HentaiFox served a Cloudflare challenge instead of the page. Open the site once in the browser and retry.",
        );
        continue;
      }
      if (looksMissing(html)) {
        if (options.allowMissing) return "";
        throw new Error(`HentaiFox has no page at ${url}.`);
      }
      cacheSet(url, html);
      return html;
    }
    throw lastError || new Error("HentaiFox page load failed.");
  }

  // ---------------------------------------------------------------- listings

  function cleanTitleMarkup(value) {
    return stripTags(
      String(value || "").replace(/<span[^>]*class\s*=\s*["']t_badge["'][^>]*>[\s\S]*?<\/span>/gi, " "),
    );
  }

  function firstImage(tagHTML) {
    const tag = String(tagHTML || "");
    const candidate = attrValue(tag, "data-src") || attrValue(tag, "src");
    return absoluteURL(candidate);
  }

  // The home, search, tag and /page/N/ listings all render <div class="thumb">
  // cards. Parody cards and sidebar items reuse the class but link to
  // /parody/<name>/ instead of /gallery/<id>/, so requiring a gallery link
  // filters them out without needing region-specific selectors.
  function parseGalleryCards(html) {
    const source = String(html || "");
    const marker = /<div\b[^>]*class\s*=\s*["']thumb["'][^>]*>/gi;
    const starts = [];
    let match;
    while ((match = marker.exec(source))) {
      starts.push({ start: match.index, end: marker.lastIndex });
    }
    const items = [];
    const seen = new Set();
    for (let index = 0; index < starts.length; index += 1) {
      const chunk = source.slice(
        starts[index].end,
        index + 1 < starts.length ? starts[index + 1].start : Math.min(source.length, starts[index].end + 4000),
      );
      // The card's own heading anchor decides identity: gallery cards link to
      // /gallery/<id>/, while parody cards (g_title_popular) link to /parody/…
      // and sidebar blocks carry no heading at all. Requiring both keeps the
      // last chunk's wider window from picking up a neighbouring link.
      const heading = chunk.match(/<h2\b[^>]*class\s*=\s*["']g_title(?:_popular)?["'][^>]*>([\s\S]*?)<\/h2>/i);
      if (!heading) continue;
      const anchorTag = heading[1].match(/<a\b[^>]*>/i);
      if (!anchorTag) continue;
      const link = attrValue(anchorTag[0], "href").match(/\/gallery\/(\d{1,12})\/?/i);
      if (!link) continue;
      const id = link[1];
      if (seen.has(id)) continue;

      const imageTag = chunk.match(/<img\b[^>]*>/i);
      const image = imageTag ? firstImage(imageTag[0]) : "";
      const category = chunk.match(/class\s*=\s*["']t_cat["'][^>]*>([\s\S]*?)<\/a>/i);
      const ribbon = chunk.match(/class\s*=\s*["']ribbon[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);

      const title = cleanTitleMarkup(heading[1]);
      if (!title) continue;
      const subtitleParts = [];
      if (category) {
        const label = stripTags(category[1]);
        if (label) subtitleParts.push(label);
      }
      if (ribbon) {
        const label = stripTags(ribbon[1]);
        if (label) subtitleParts.push(label);
      }
      seen.add(id);
      const href = `${BASE_URL}/gallery/${id}/`;
      const item = { id, href, url: href, title, image };
      if (subtitleParts.length) item.subtitle = subtitleParts.join(" · ");
      items.push(item);
      if (items.length >= MAX_CARDS) break;
    }
    return items;
  }

  // Pagination markup: <li class="page-item"><a class="page-link" href="…">Next</a></li>.
  // The last page renders "Next" as a disabled item pointing at "#", and
  // single-page results render no pagination list at all.
  function paginationHasNext(html) {
    const block = String(html || "").match(/<ul\b[^>]*class\s*=\s*["']pagination["'][^>]*>([\s\S]*?)<\/ul>/i);
    if (!block) return false;
    const inner = block[1];
    const items = inner.match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) || [];
    for (const item of items) {
      if (/\bdisabled\b/i.test(attrValue(item, "class") || "")) continue;
      const anchor = item.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
      if (!anchor) continue;
      const label = stripTags(anchor[1]);
      if (/^(?:next|next\s*›|›|»|→)$/i.test(label)) {
        const href = attrValue(anchor[0], "href");
        if (!href || href === "#") continue;
        return true;
      }
    }
    return false;
  }

  function parseSidebarBlock(html, blockPattern, itemPattern) {
    const source = String(html || "");
    const block = source.match(blockPattern);
    if (!block) return [];
    const body = block[1];
    const items = [];
    const seen = new Set();
    let match;
    while ((match = itemPattern.exec(body))) {
      const href = absoluteURL(attrValue(match[0], "href"));
      const idMatch = href.match(/\/gallery\/(\d{1,12})\//);
      if (!idMatch) continue;
      const id = idMatch[1];
      if (seen.has(id)) continue;
      const imageTag = match[0].match(/<img\b[^>]*>/i);
      const title = imageTag ? decodeEntities(attrValue(imageTag[0], "alt")) : "";
      if (!title) continue;
      seen.add(id);
      const canonical = `${BASE_URL}/gallery/${id}/`;
      items.push({
        id,
        href: canonical,
        url: canonical,
        title,
        image: imageTag ? firstImage(imageTag[0]) : "",
      });
    }
    return items;
  }

  function parseWeeklyFeatured(html) {
    return parseSidebarBlock(
      html,
      /<div\b[^>]*class\s*=\s*["']middle_sidebar["'][^>]*>([\s\S]*?)<div\b[^>]*class\s*=\s*["']bottom_sidebar["']/i,
      /<div\b[^>]*class\s*=\s*["']item["'][^>]*>[\s\S]*?<\/a>\s*<\/div>\s*<\/div>/gi,
    ).slice(0, 20);
  }

  function parseDailyTop(html) {
    const source = String(html || "");
    const block = source.match(/id\s*=\s*["']main_top_daily["'][^>]*>([\s\S]*?)<\/div>/i);
    if (!block) return [];
    const items = [];
    const anchors = block[1].match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [];
    for (const anchor of anchors) {
      const anchorID = attrValue(anchor, "id");
      const href = absoluteURL(attrValue(anchor, "href"));
      const idMatch = href.match(/\/gallery\/(\d{1,12})\//);
      if (!idMatch) continue;
      const imageTag = anchor.match(/<img\b[^>]*>/i);
      const title = imageTag ? decodeEntities(attrValue(imageTag[0], "alt")) : "";
      if (!title) continue;
      const id = idMatch[1];
      const canonical = `${BASE_URL}/gallery/${id}/`;
      const item = {
        id,
        href: canonical,
        url: canonical,
        title,
        image: imageTag ? firstImage(imageTag[0]) : "",
      };
      if (anchorID === "today_content") item.subtitle = "Today";
      else if (anchorID === "yesterday_content") item.subtitle = "Yesterday";
      items.push(item);
    }
    return items;
  }

  // ------------------------------------------------------------------ feeds

  function normalizeFeedID(value) {
    const raw = nonEmpty(value).replace(/^__feed:/i, "");
    if (!raw) return "latest";
    if (/^tag:/i.test(raw)) return `tag:${tagSlug(raw.slice(4))}`;
    if (/^search:/i.test(raw)) return `search:${raw.slice(7).trim()}`;
    return raw.toLowerCase();
  }

  function feedURLs(feedID, page) {
    const id = normalizeFeedID(feedID);
    const pageNumber = Math.max(1, Math.floor(Number(page) || 1));
    if (id === "latest" || id === "new" || id === "home" || id === "popular") {
      // "popular" has no dedicated listing page; the home grid is its shelf, so
      // load-more continues there instead of dead-ending on an unknown feed.
      if (pageNumber === 1) return [`${BASE_URL}${HOME_PATH}`];
      // The home listing changes template after page 2: page 2 lives at
      // /page/2/ and everything deeper at /pag/N/ (/page/3/ is a 404). The
      // alternate form is only tried when the first one 404s.
      if (pageNumber === 2) return [`${BASE_URL}/page/2/`, `${BASE_URL}/pag/2/`];
      return [`${BASE_URL}/pag/${pageNumber}/`, `${BASE_URL}/page/${pageNumber}/`];
    }
    if (id.startsWith("tag:")) {
      const slug = id.slice(4);
      if (!slug) return [];
      return pageNumber === 1
        ? [`${BASE_URL}/tag/${slug}/`]
        : [`${BASE_URL}/tag/${slug}/pag/${pageNumber}/`];
    }
    if (id.startsWith("search:")) {
      const text = id.slice(7);
      if (!text) return [];
      const encoded = encodeURIComponent(text).replace(/%20/g, "+");
      return pageNumber === 1
        ? [`${BASE_URL}/search/?q=${encoded}`]
        : [`${BASE_URL}/search/?q=${encoded}&page=${pageNumber}`];
    }
    return [];
  }

  async function discoveryFeed(feedID, page = 1) {
    for (const url of feedURLs(feedID, page)) {
      const html = await fetchPageHTML(url, { allowMissing: true });
      if (!html) continue;
      return { items: parseGalleryCards(html), hasMore: paginationHasNext(html) };
    }
    return { items: [], hasMore: false };
  }

  function normalizeSearchInput(query) {
    if (typeof query === "string") return { text: query.trim(), tag: "" };
    if (query && typeof query === "object") {
      const tag = nonEmpty(
        query.tag || (Array.isArray(query.tags) ? query.tags[0] : "") || "",
      );
      const text = nonEmpty(query.text || query.query || "");
      return { text, tag };
    }
    return { text: "", tag: "" };
  }

  async function searchResults(query, page = 1) {
    const { text, tag } = normalizeSearchInput(query);
    const pageNumber = Math.max(1, Math.floor(Number(page) || 1));
    if (/^__feed:/i.test(text)) return discoveryFeed(text, pageNumber);
    if (/^tag:/i.test(text)) return discoveryFeed(text, pageNumber);
    if (tag) return discoveryFeed(`tag:${tag}`, pageNumber);
    if (!text) {
      // Empty query scrolls the latest feed, which paginates through /page/N/.
      return discoveryFeed("latest", pageNumber);
    }
    return discoveryFeed(`search:${text}`, pageNumber);
  }

  // ---------------------------------------------------------------- details

  function infoList(html, className) {
    const pattern = new RegExp(
      `<ul\\b[^>]*class\\s*=\\s*["']${className}["'][^>]*>([\\s\\S]*?)<\\/ul>`,
      "i",
    );
    const block = String(html || "").match(pattern);
    if (!block) return [];
    const entries = [];
    const seen = new Set();
    const anchorPattern = /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorPattern.exec(block[1]))) {
      const name = cleanTitleMarkup(match[2]);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const href = absoluteURL(match[1]);
      const slugMatch = href.match(/\/(?:tag|artist|group|language|category)\/([^/]+)\//);
      entries.push({ name, href, slug: slugMatch ? slugMatch[1] : "" });
    }
    return entries;
  }

  function firstHeading(html) {
    const block = String(html || "").match(
      /<div\b[^>]*class\s*=\s*["']display_gallery["'][^>]*>([\s\S]*?)<\/div>\s*<div\b[^>]*class\s*=\s*["']gallery_bottom["']/i,
    );
    const scope = block ? block[1] : String(html || "");
    const heading = scope.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    return heading ? stripTags(heading[1]) : "";
  }

  function coverImage(html) {
    const block = String(html || "").match(
      /<div\b[^>]*class\s*=\s*["']cover["'][^>]*>([\s\S]*?)<\/div>/i,
    );
    if (block) {
      const imageTag = block[1].match(/<img\b[^>]*>/i);
      if (imageTag) {
        const url = firstImage(imageTag[0]);
        if (isHentaiFoxImage(url)) return url;
      }
    }
    const meta = String(html || "").match(
      /<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]*>/i,
    );
    if (meta) {
      const url = absoluteURL(attrValue(meta[0], "content"));
      if (isHentaiFoxImage(url)) return url;
    }
    return "";
  }

  function metaDescription(html) {
    const meta = String(html || "").match(/<meta\b[^>]*name\s*=\s*["']description["'][^>]*>/i);
    if (!meta) return "";
    return decodeEntities(attrValue(meta[0], "content"));
  }

  function pageCount(html) {
    const source = String(html || "");
    const labelled = source.match(/class\s*=\s*["']i_text\s+pages["'][^>]*>\s*Pages?\s*:\s*([0-9,]+)/i);
    if (labelled) {
      const value = Number(labelled[1].replace(/,/g, ""));
      if (Number.isFinite(value) && value > 0) return value;
    }
    const readerPages = source.match(/id\s*=\s*["']pages["'][^>]*>/i);
    if (readerPages) {
      const value = Number(attrValue(readerPages[0], "value"));
      if (Number.isFinite(value) && value > 0) return value;
    }
    return 0;
  }

  function postedLabel(html) {
    const match = String(html || "").match(/class\s*=\s*["']i_text\s+pages["'][^>]*>\s*Posted\s*:\s*([^<]+)</i);
    return match ? stripTags(match[1]) : "";
  }

  function titleCase(value) {
    const text = nonEmpty(value);
    if (!text) return "";
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function parseDetails(html, id) {
    const source = String(html || "");
    const galleryInput = source.match(/<input\b[^>]*\bid\s*=\s*["']gallery_id["'][^>]*>/i);
    if (!galleryInput) {
      throw new Error("HentaiFox returned an unexpected gallery page.");
    }
    const declaredID = attrValue(galleryInput[0], "value");
    if (declaredID && declaredID !== id) {
      throw new Error("HentaiFox returned details for a different gallery.");
    }

    const title = firstHeading(source);
    if (!title) throw new Error("HentaiFox returned a gallery page without a title.");

    const tags = infoList(source, "tags");
    const artists = infoList(source, "artists");
    const languages = infoList(source, "languages");
    const categories = infoList(source, "categories");
    const pages = pageCount(source);

    const authors = [];
    const seen = new Set();
    for (const artist of artists) {
      const key = artist.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      authors.push(artist.name);
    }

    const languageNames = languages.map((entry) => entry.name);
    const language = languageNames.some((name) => /^en/i.test(name)) ? "en" : "";
    const category = categories.length ? titleCase(categories[0].name) : "";

    const explicit = source.match(
      /<(?:div|p)\b[^>]*class\s*=\s*["'](?:g_desc|gallery_desc|description)["'][^>]*>([\s\S]*?)<\/(?:div|p)>/i,
    );
    const description = explicit ? stripTags(explicit[1]) : metaDescription(source);

    const href = `${BASE_URL}${detailsPathFor(id)}`;
    return {
      id,
      href,
      url: href,
      title,
      description,
      image: coverImage(source),
      authors,
      author: authors[0] || "",
      artists: authors,
      genres: tags.map((entry) => entry.name),
      tags: tags.map((entry) => entry.slug).filter(Boolean),
      pageCount: pages,
      language,
      languages: languageNames,
      category,
      posted: postedLabel(source),
    };
  }

  async function extractDetails(id) {
    const gallery = galleryID(id);
    const html = await fetchPageHTML(`${BASE_URL}${detailsPathFor(gallery)}`);
    return parseDetails(html, gallery);
  }

  async function extractChapters(id) {
    const gallery = galleryID(id);
    const html = await fetchPageHTML(`${BASE_URL}${detailsPathFor(gallery)}`);
    const pages = pageCount(html);
    const readerPath = readerPathFor(gallery, 1);
    const readerURL = `${BASE_URL}${readerPath}`;
    // A gallery is a single logical "chapter": the reader pages the whole set.
    return [
      {
        id: gallery,
        href: readerURL,
        url: readerURL,
        title: pages > 0 ? `Full gallery (${pages} pages)` : "Full gallery",
        number: 1,
        pageCount: pages,
        language: "en",
      },
    ];
  }

  // ----------------------------------------------------------------- reader

  function inputValue(html, id) {
    const pattern = new RegExp(`<input\\b[^>]*\\bid\\s*=\\s*["']${id}["'][^>]*>`, "i");
    const match = String(html || "").match(pattern);
    return match ? attrValue(match[0], "value") : "";
  }

  function readerPageTable(html) {
    const match = String(html || "").match(
      /var\s+g_th\s*=\s*\$\.parseJSON\(\s*(['"])([\s\S]*?)\1\s*\)/i,
    );
    if (!match) return null;
    const raw = match[2].replace(/\\'/g, "'").replace(/\\"/g, '"');
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function extensionFor(table, pageNumber, fallback) {
    if (table) {
      const value = table[String(pageNumber)];
      if (typeof value === "string" && value) {
        const code = value.split(",")[0].trim().toLowerCase();
        if (EXTENSIONS[code]) return EXTENSIONS[code];
      }
    }
    return fallback;
  }

  // Fallback only: when a reader page does not expose g_th the per-page
  // extension is unknown, so probe the first image with fetchv2 (image hosts
  // are not behind Cloudflare). WebP is the current default, JPEG the legacy
  // one; PNG is checked last for older scans.
  async function probeImageExtension(baseURLWithoutExtension) {
    if (typeof globalThis.fetchv2 !== "function") return null;
    for (const extension of ["webp", "jpg", "png"]) {
      const url = `${baseURLWithoutExtension}.${extension}`;
      let response = null;
      try {
        response = await globalThis.fetchv2(
          url,
          { Accept: "image/avif,image/webp,image/*,*/*", Referer: `${BASE_URL}/` },
          "HEAD",
          null,
          { followRedirects: true, maxBytesHint: MAX_IMAGE_BYTES, responseClass: "binary" },
        );
      } catch (_) {
        response = null;
      }
      let status = Number((response && response.status) || 0);
      if (!status && !(response && response.ok === true)) {
        try {
          response = await globalThis.fetchv2(
            url,
            { Accept: "image/avif,image/webp,image/*,*/*", Referer: `${BASE_URL}/` },
            "GET",
            null,
            { followRedirects: true, maxBytesHint: MAX_IMAGE_BYTES, responseClass: "binary" },
          );
          status = Number((response && response.status) || 0);
        } catch (_) {
          continue;
        }
      }
      if (response && response.ok !== false && (!status || (status >= 200 && status < 300))) {
        return { extension, url };
      }
    }
    return null;
  }

  function normalizeChapterID(value) {
    const raw = nonEmpty(value);
    if (!raw) throw new Error("Invalid HentaiFox chapter identifier.");
    if (/^https?:\/\//i.test(raw) || raw.startsWith("/")) {
      const match = raw.match(/\/(?:g|gallery)\/(\d{1,12})(?:\/(\d{1,6}))?\/?/i);
      if (!match) throw new Error("Invalid HentaiFox chapter identifier.");
      return { gallery: match[1], page: Number(match[2] || 1) || 1 };
    }
    const parts = raw.split(":");
    if (/^\d{1,12}$/.test(parts[0])) {
      const page = parts.length > 1 ? Number(parts[1]) : 1;
      return { gallery: parts[0], page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1 };
    }
    throw new Error("Invalid HentaiFox chapter identifier.");
  }

  async function buildReaderImages(html, gallery, options = {}) {
    const source = String(html || "");
    if (!source) throw new Error("HentaiFox returned an empty reader page.");

    const imgTag = source.match(/<img\b[^>]*\bid\s*=\s*["']gimg["'][^>]*>/i);
    const firstImageURL = imgTag ? firstImage(imgTag[0]) : "";
    if (firstImageURL && !isHentaiFoxImage(firstImageURL)) {
      throw new Error("HentaiFox reader returned an unexpected image host.");
    }

    const table = readerPageTable(source);
    const declaredPages = Number(inputValue(source, "pages")) || 0;
    const tablePages = table ? Math.max(0, ...Object.keys(table).map((key) => Number(key) || 0)) : 0;
    const totalPages = Math.max(declaredPages, tablePages, options.pageCount || 0);

    const directory = inputValue(source, "image_dir") || inputValue(source, "dir");
    const folder = inputValue(source, "gallery_id") || inputValue(source, "load_id");
    if (!/^[A-Za-z0-9]{1,8}$/.test(directory) || !/^\d{1,12}$/.test(folder)) {
      throw new Error("HentaiFox reader did not expose its image directory.");
    }
    if (!totalPages) {
      throw new Error("HentaiFox reader did not expose a page count.");
    }

    // The site picks i3 for galleries above a fixed id threshold and i / i2
    // otherwise, at random. Reuse the host of the page-1 image the reader
    // actually rendered, so every URL points at the same backend the site uses.
    let host = urlHost(firstImageURL);
    if (!host || !host.endsWith(".hentaifox.com")) {
      const uniqueID = Number(inputValue(source, "unique_id")) || 0;
      host = uniqueID > 140236 ? "i3.hentaifox.com" : "i.hentaifox.com";
    }

    const base = `https://${host}/${directory}/${folder}`;
    let firstExtension = "";
    if (firstImageURL) {
      const extMatch = firstImageURL.match(/\.([a-z0-9]{2,5})(?:[?#].*)?$/i);
      if (extMatch) firstExtension = extMatch[1].toLowerCase();
    }

    let defaultExtension = firstExtension || "jpg";
    if (!table && !firstExtension) {
      const probe = await probeImageExtension(`${base}/1`);
      if (probe) {
        defaultExtension = probe.extension;
        firstExtension = probe.extension;
      }
    }

    const limit = Math.min(totalPages, MAX_IMAGES);
    const images = [];
    const seen = new Set();
    for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
      const extension = extensionFor(table, pageNumber, defaultExtension);
      const candidate =
        pageNumber === 1 && firstImageURL
          ? firstImageURL
          : `${base}/${pageNumber}.${extension}`;
      const url = candidate.replace(/^http:/i, "https:");
      if (!isHentaiFoxImage(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      images.push({
        url,
        headers: { Accept: "image/avif,image/webp,image/*,*/*", Referer: `${BASE_URL}/` },
      });
    }

    if (!images.length) {
      throw new Error("HentaiFox returned no readable page images for this gallery.");
    }
    return images;
  }

  async function extractImages(chapterId) {
    const { gallery } = normalizeChapterID(chapterId);
    const readerURL = `${BASE_URL}${readerPathFor(gallery, 1)}`;
    const html = await fetchPageHTML(readerURL);
    try {
      return await buildReaderImages(html, gallery);
    } catch (firstError) {
      // A reader page that renders without its metadata is usually still
      // settling inside the WebView; reload once before surfacing the error.
      cache.delete(readerURL);
      let retryHTML = "";
      try {
        retryHTML = await fetchPageHTML(readerURL);
      } catch (_) {
        throw asError(firstError, "HentaiFox reader returned no images.");
      }
      if (!retryHTML) throw asError(firstError, "HentaiFox reader returned no images.");
      return buildReaderImages(retryHTML, gallery);
    }
  }

  // -------------------------------------------------------------- discovery

  async function discoveryHome() {
    const sections = [];
    let homeHTML = "";
    try {
      homeHTML = await fetchPageHTML(`${BASE_URL}${HOME_PATH}`);
    } catch (_) {
      homeHTML = "";
    }

    if (homeHTML) {
      const latest = parseGalleryCards(homeHTML);
      if (latest.length) sections.push({ id: "latest", title: "Newest Galleries", items: latest });

      // "Weekly Featured" and "Daily Top Rated" only carry cover art + alt
      // text, so their titles come from the alt attribute.
      const featured = parseWeeklyFeatured(homeHTML);
      if (featured.length) sections.push({ id: "featured", title: "Weekly Featured", items: featured });

      const daily = parseDailyTop(homeHTML);
      if (daily.length) sections.push({ id: "daily", title: "Daily Top Rated", items: daily });
    }

    for (const tag of HOME_TAG_SECTIONS) {
      let items = [];
      try {
        const html = await fetchPageHTML(`${BASE_URL}/tag/${tag.slug}/`, { allowMissing: true });
        if (html) items = parseGalleryCards(html).slice(0, 24);
      } catch (_) {
        items = [];
      }
      if (items.length) sections.push({ id: `tag:${tag.slug}`, title: tag.title, items });
    }

    return { sections };
  }

  const handlers = {
    discoveryHome,
    discoveryFeed,
    searchResults,
    extractDetails,
    extractChapters,
    extractImages,
  };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
