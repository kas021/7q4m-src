"use strict";

(() => {
  // nhentai — the community doujinshi gallery archive. The reader HTML is
  // region-blocked and challenge-prone, but the site's own JSON API v2
  // (nhentai.net/api/v2) is served plainly, so every request in this module
  // goes through fetchv2 against that API and never touches /g/<id>/ pages.
  //
  //   /api/v2/galleries/popular             rich home rail (bare array)
  //   /api/v2/galleries?page&per_page       newest first, paginated
  //   /api/v2/search?query&page&per_page    free-text, paginated
  //   /api/v2/tags/<type>/<slug>            tag metadata (id + count)
  //   /api/v2/galleries/tagged?tag_id       tag/language browse, paginated
  //   /api/v2/galleries/<id>                full detail, page list included
  //   /api/v2/galleries/<id>/related        related galleries, paginated
  //   /api/v2/galleries/random              { id } suggestion
  //   /api/v2/cdn                           image + thumbnail server lists
  //
  // Page paths in the detail payload are RELATIVE ("galleries/9/1.jpg"), so
  // absolute image URLs are built from /api/v2/cdn at read time; the module
  // never hardcodes a CDN hostname. Galleries are single-chapter works: the
  // one chapter id is the gallery id, which round-trips into extractImages.
  const API_URL = "https://nhentai.net";
  const WEBSITE_URL = "https://nhentai.net";
  const CDN_PATH = "/api/v2/cdn";
  const POPULAR_PATH = "/api/v2/galleries/popular";
  const GALLERIES_PATH = "/api/v2/galleries";
  const TAGGED_PATH = "/api/v2/galleries/tagged";
  const RANDOM_PATH = "/api/v2/galleries/random";
  const SEARCH_PATH = "/api/v2/search";
  const TAGS_PATH = "/api/v2/tags";

  const PAGE_SIZE = 25;
  const MAX_PAGE_INDEX = 10000;
  // Home rails beyond the popular/newest shelves: broad tags that always have
  // deep catalogues, so the home grid stays rich on every load.
  const HOME_TAG_RAILS = [
    { id: "rail-big-breasts", title: "Big Breasts", tag: "big breasts" },
    { id: "rail-nakadashi", title: "Nakadashi", tag: "nakadashi" },
    { id: "rail-yuri", title: "Yuri", tag: "yuri" },
    { id: "rail-full-colour", title: "Full Colour", tag: "full color" },
  ];
  const REQUEST_HEADERS = {
    Accept: "application/json",
    "User-Agent": "nhsrc/1.0 (+https://github.com/Sy223271/7q4m-src)",
  };
  const IMAGE_HEADERS = {
    Accept: "image/*",
    Referer: "https://nhentai.net/",
    "User-Agent": "nhsrc/1.0 (+https://github.com/Sy223271/7q4m-src)",
  };
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3; // one attempt plus two retries
  const RETRY_BASE_DELAY = 900;
  const RATE_LIMIT_DELAY = 2500; // nhentai answers bursts with 429; back off harder
  const MAX_RETRY_DELAY = 10000;
  const REQUEST_TIMEOUT = 8000; // milliseconds, per attempt
  const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
  const LIST_BYTE_HINT = 2 * 1024 * 1024;
  const DETAIL_BYTE_HINT = 4 * 1024 * 1024;
  const CDN_TTL = 10 * 60 * 1000;
  const MAX_PAGES = 800;
  const RANDOM_PICK_COUNT = 5;
  const RANDOM_PICK_ATTEMPTS = 8;
  const GALLERY_ID_PATTERN = /^\d{1,9}$/;
  const GALLERY_URL_PATTERN = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*nhentai\.net\/g\/(\d{1,9})(?:[/?#]|$)/i;
  const GALLERY_PATH_PATTERN = /^\/g\/(\d{1,9})(?:[/?#]|$)/;
  const IMAGE_PATH_PATTERN = /^galleries\/\d+\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const HOST_PATTERN = /^nhentai\.net$/;
  const SUBDOMAIN_HOST_PATTERN = /^[a-z0-9-]+\.nhentai\.net$/;
  const TAG_TYPES = new Set([
    "tag",
    "language",
    "artist",
    "group",
    "parody",
    "character",
    "category",
  ]);

  let cdnCache = { at: 0, image: [], thumb: [] };

  function sleep(milliseconds) {
    return new Promise((resolve) => {
      if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(resolve, milliseconds);
      else Promise.resolve().then(resolve);
    });
  }

  function decodeEntities(value) {
    const named = {
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      nbsp: " ",
      quot: '"',
    };
    return String(value == null ? "" : value)
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
      .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] || match);
  }

  function stripHTML(value) {
    return decodeEntities(
      String(value == null ? "" : value)
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<br\s*\/?\s*>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/\s+/g, " ")
      .trim();
  }

  function nonEmpty(value) {
    return String(value == null ? "" : value).trim();
  }

  function cleanText(value) {
    return stripHTML(nonEmpty(value)).replace(/\s+/g, " ").trim();
  }

  function asError(value) {
    return value instanceof Error ? value : new Error(String(value));
  }

  function formatCount(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return "";
    return String(Math.round(number)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function pageNumber(page) {
    const parsed = Math.floor(Number(page));
    if (!Number.isFinite(parsed) || parsed < 1) return 1;
    return Math.min(parsed, MAX_PAGE_INDEX);
  }

  function buildQuery(pairs) {
    const parts = [];
    for (const pair of pairs) {
      if (!Array.isArray(pair)) continue;
      const key = pair[0];
      const value = pair[1];
      if (key == null || key === "" || value == null || value === "") continue;
      parts.push(`${encodeURIComponent(String(key))}=${encodeURIComponent(String(value))}`);
    }
    return parts.join("&");
  }

  async function responseText(response) {
    if (!response) return "";
    if (typeof response.text === "function") {
      const value = await response.text();
      if (typeof value === "string") return value;
    }
    if (typeof response.body === "string") return response.body;
    if (typeof response.data === "string") return response.data;
    if (typeof response.json === "function") return JSON.stringify(await response.json());
    return "";
  }

  function httpErrorMessage(status) {
    if (status === 404) return "nhentai returned HTTP 404 (not found).";
    if (status === 429) return "nhentai rate limited the request (HTTP 429).";
    if (status >= 500) return `nhentai returned a server error (HTTP ${status}).`;
    return `nhentai request failed with HTTP ${status || "error"}.`;
  }

  async function requestWithTimeout(url, maxBytesHint) {
    const call = globalThis.fetchv2(url, REQUEST_HEADERS, "GET", null, {
      followRedirects: true,
      maxBytesHint: maxBytesHint || LIST_BYTE_HINT,
      responseClass: "json",
    });
    if (typeof globalThis.setTimeout !== "function") return call;
    const controller =
      typeof globalThis.AbortController === "function" ? new globalThis.AbortController() : null;
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = globalThis.setTimeout(() => {
        if (controller) {
          try {
            controller.abort();
          } catch {
            // Bridge signals are advisory; the race below still settles.
          }
        }
        reject(new Error(`nhentai request timed out after ${REQUEST_TIMEOUT} ms.`));
      }, REQUEST_TIMEOUT);
    });
    try {
      return await Promise.race([call, deadline]);
    } finally {
      if (timer !== null && typeof globalThis.clearTimeout === "function") {
        globalThis.clearTimeout(timer);
      }
    }
  }

  function retryAfterMilliseconds(response) {
    const headers = (response && response.headers) || {};
    const raw =
      headers["retry-after"] ?? headers["Retry-After"] ?? (typeof headers.get === "function" ? headers.get("retry-after") : null);
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.min(seconds * 1000, MAX_RETRY_DELAY);
  }

  function retryDelay(attempt, status, response) {
    if (status === 429) {
      return retryAfterMilliseconds(response) || Math.min(RATE_LIMIT_DELAY * attempt, MAX_RETRY_DELAY);
    }
    return RETRY_BASE_DELAY * attempt;
  }

  async function fetchDirect(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error("nhentai requires the fetchv2 bridge.");
    }
    const maxBytesHint = options.maxBytesHint || LIST_BYTE_HINT;
    let lastError = null;
    let delay = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(delay || RETRY_BASE_DELAY * (attempt - 1));

      let response = null;
      try {
        response = await requestWithTimeout(url, maxBytesHint);
      } catch (error) {
        // Bridge failures (timeouts, aborted sockets, DNS) are transient.
        lastError = asError(error);
        delay = RETRY_BASE_DELAY * attempt;
        continue;
      }

      if (response && response.bodyDropped === true) {
        throw new Error(
          `nhentai response exceeded the ${Math.round(MAX_RESPONSE_BYTES / (1024 * 1024))} MB limit.`,
        );
      }

      const status = Number((response && response.status) || 0);
      if ((response && response.ok === false) || (status && (status < 200 || status >= 300))) {
        lastError = new Error(httpErrorMessage(status));
        lastError.status = status;
        if (status && !RETRYABLE_STATUS.has(status)) throw lastError;
        delay = retryDelay(attempt, status, response);
        continue;
      }

      const body = await responseText(response);
      if (body && body.length > MAX_RESPONSE_BYTES) {
        throw new Error(
          `nhentai response exceeded the ${Math.round(MAX_RESPONSE_BYTES / (1024 * 1024))} MB limit.`,
        );
      }
      if (body) return body;
      lastError = new Error("nhentai returned an empty response body.");
    }
    throw lastError || new Error("nhentai request failed.");
  }

  async function fetchJSON(url, maxBytesHint) {
    const body = await fetchDirect(url, { maxBytesHint: maxBytesHint || LIST_BYTE_HINT });
    let data = null;
    try {
      data = JSON.parse(body);
    } catch {
      if (body.trimStart().startsWith("<")) {
        throw new Error("nhentai returned an HTML page instead of JSON.");
      }
      throw new Error("nhentai returned an unparseable JSON response.");
    }
    if (data === null || (typeof data !== "object" && !Array.isArray(data))) {
      throw new Error("nhentai returned an unexpected JSON payload.");
    }
    return data;
  }

  function httpHost(value) {
    const match = String(value == null ? "" : value).match(/^https:\/\/([^/?#]+)(?:[/?#]|$)/i);
    return match ? match[1].toLowerCase() : "";
  }

  function isAllowedHost(value) {
    const host = httpHost(value);
    if (!host) return false;
    return HOST_PATTERN.test(host) || SUBDOMAIN_HOST_PATTERN.test(host);
  }

  function imagePath(value) {
    const raw = nonEmpty(value).replace(/^\/+/, "");
    if (!raw) return "";
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return "";
    if (raw.includes("..") || raw.includes("\\")) return "";
    if (!IMAGE_PATH_PATTERN.test(raw)) return "";
    return raw;
  }

  function normalizeGalleryID(value) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) throw new Error("Invalid nhentai gallery identifier.");
    if (/^https?:\/\//i.test(raw)) {
      const match = raw.match(GALLERY_URL_PATTERN);
      if (!match) throw new Error("Invalid nhentai gallery identifier.");
      return match[1];
    }
    if (raw.startsWith("/")) {
      const match = raw.match(GALLERY_PATH_PATTERN);
      if (!match) throw new Error("Invalid nhentai gallery identifier.");
      return match[1];
    }
    const prefixed = raw.match(/^g(\d{1,9})$/i);
    if (prefixed) return prefixed[1];
    if (!GALLERY_ID_PATTERN.test(raw)) throw new Error("Invalid nhentai gallery identifier.");
    return raw;
  }

  function normalizeSlug(value) {
    return nonEmpty(value)
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120);
  }

  function parseTagQuery(spec, defaultType) {
    const parts = String(spec == null ? "" : spec).split(":");
    let type = defaultType;
    if (parts.length > 1 && TAG_TYPES.has(parts[0].trim().toLowerCase())) {
      type = parts.shift().trim().toLowerCase();
    }
    const name = parts.join(":").trim();
    return { type, name, slug: normalizeSlug(name) };
  }

  function searchQuery(input) {
    if (typeof input === "string") return input.trim();
    if (input && typeof input === "object") {
      return String(input.text || input.query || input.q || "").trim();
    }
    return "";
  }

  function serverList(values, label) {
    const list = Array.isArray(values) ? values : [];
    const servers = [];
    for (const value of list) {
      const raw = nonEmpty(value).replace(/\/+$/, "");
      if (!raw || !isAllowedHost(raw) || !/^https:\/\//i.test(raw)) {
        throw new Error(`nhentai returned an unexpected ${label} server host.`);
      }
      servers.push(raw);
    }
    if (!servers.length) {
      throw new Error(`nhentai returned no ${label} servers.`);
    }
    return servers;
  }

  async function cdnConfig() {
    const now = Date.now();
    if (cdnCache.image.length && now - cdnCache.at < CDN_TTL) return cdnCache;
    const payload = await fetchJSON(`${API_URL}${CDN_PATH}`, LIST_BYTE_HINT);
    const image = serverList(payload.image_servers, "image");
    const thumb = serverList(payload.thumb_servers, "thumbnail");
    cdnCache = { at: now, image, thumb };
    return cdnCache;
  }

  async function optionalCdn() {
    try {
      return await cdnConfig();
    } catch {
      // A CDN outage must not empty the catalogue; items simply lose art.
      return null;
    }
  }

  function buildImageURL(servers, path, index) {
    if (!Array.isArray(servers) || !servers.length) {
      throw new Error("nhentai image servers are unavailable.");
    }
    const server = servers[index % servers.length];
    const url = `${server}/${path}`;
    if (!isAllowedHost(url)) {
      throw new Error("nhentai returned a page image on an unexpected host.");
    }
    return url;
  }

  function galleryTitle(payload) {
    const title = (payload && payload.title) || {};
    return (
      cleanText(title.pretty) ||
      cleanText(title.english) ||
      cleanText(title.japanese) ||
      ""
    );
  }

  function tagList(payload) {
    return Array.isArray(payload && payload.tags) ? payload.tags : [];
  }

  function tagNames(tags, types) {
    const allowed = new Set(types);
    const names = [];
    const seen = new Set();
    for (const tag of tags) {
      if (!tag || typeof tag !== "object") continue;
      if (!allowed.has(nonEmpty(tag.type).toLowerCase())) continue;
      const name = cleanText(tag.name);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
    return names;
  }

  function galleryLanguage(tags) {
    const names = tagNames(tags, ["language"]);
    const explicit = names.find((name) => name.toLowerCase() !== "translated");
    return (explicit || names[0] || "").toLowerCase();
  }

  function galleryCover(payload) {
    // Covers and thumbnails live on the thumbnail servers (t1-t4); the page
    // image servers (i1-i4) only serve full-size page files.
    const cover = (payload && payload.cover) || {};
    const thumbnail = (payload && payload.thumbnail) || {};
    const path = imagePath(cover.path) || imagePath(thumbnail.path);
    if (!path) return "";
    if (!cdnCache.thumb.length) return "";
    return buildImageURL(cdnCache.thumb, path, 0);
  }

  function listItem(entry, thumbServers, index) {
    if (!entry || typeof entry !== "object") return null;
    const id = nonEmpty(entry.id);
    if (!GALLERY_ID_PATTERN.test(id)) return null;
    const href = `${WEBSITE_URL}/g/${id}/`;
    const path = imagePath(entry.thumbnail);
    let image = "";
    if (path && Array.isArray(thumbServers) && thumbServers.length) {
      try {
        image = buildImageURL(thumbServers, path, index);
      } catch {
        image = "";
      }
    }
    const pages = Number(entry.num_pages);
    const favorites = Number(entry.num_favorites);
    const details = [];
    if (Number.isFinite(pages) && pages > 0) details.push(`${pages} page${pages === 1 ? "" : "s"}`);
    if (Number.isFinite(favorites) && favorites > 0) details.push(`${formatCount(favorites)} favourites`);
    const title =
      cleanText(entry.english_title) || cleanText(entry.japanese_title) || `nhentai gallery ${id}`;
    return {
      id,
      href,
      url: href,
      title,
      image,
      subtitle: details.join(" · "),
    };
  }

  function buildItems(list, thumbServers) {
    const items = [];
    const seen = new Set();
    for (let index = 0; index < list.length; index += 1) {
      const item = listItem(list[index], thumbServers, index);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    return items;
  }

  function summarizeResults(payload, thumbServers, currentPage) {
    const list = Array.isArray(payload && payload.result) ? payload.result : [];
    const items = buildItems(list, thumbServers);
    const numPages = Number(payload && payload.num_pages);
    let hasMore;
    if (Number.isFinite(numPages) && numPages > 0) {
      hasMore = currentPage < numPages;
    } else {
      // Without a page count the only safe signal is a completely full page.
      hasMore = currentPage < MAX_PAGE_INDEX && list.length >= PAGE_SIZE && items.length > 0;
    }
    return { items, hasMore };
  }

  async function newestResults(currentPage) {
    const payload = await fetchJSON(
      `${API_URL}${GALLERIES_PATH}?${buildQuery([
        ["page", currentPage],
        ["per_page", PAGE_SIZE],
      ])}`,
      LIST_BYTE_HINT,
    );
    const cdn = await optionalCdn();
    return summarizeResults(payload, cdn ? cdn.thumb : [], currentPage);
  }

  async function searchText(query, currentPage) {
    const payload = await fetchJSON(
      `${API_URL}${SEARCH_PATH}?${buildQuery([
        ["query", query],
        ["page", currentPage],
        ["per_page", PAGE_SIZE],
      ])}`,
      LIST_BYTE_HINT,
    );
    const cdn = await optionalCdn();
    return summarizeResults(payload, cdn ? cdn.thumb : [], currentPage);
  }

  async function tagResults(spec, defaultType, currentPage) {
    const { type, name, slug } = parseTagQuery(spec, defaultType);
    if (!name || !slug) return { items: [], hasMore: false };

    let meta = null;
    try {
      meta = await fetchJSON(
        `${API_URL}${TAGS_PATH}/${encodeURIComponent(type)}/${encodeURIComponent(slug)}`,
        LIST_BYTE_HINT,
      );
    } catch (error) {
      // An unknown tag is a legitimate empty result, not a transport failure.
      if (error && error.status === 404) return { items: [], hasMore: false };
      throw error;
    }

    const tagID = nonEmpty(meta && meta.id);
    if (!/^\d{1,9}$/.test(tagID)) {
      throw new Error("nhentai returned malformed tag metadata.");
    }

    const payload = await fetchJSON(
      `${API_URL}${TAGGED_PATH}?${buildQuery([
        ["tag_id", tagID],
        ["page", currentPage],
        ["per_page", PAGE_SIZE],
        ["sort", "date"],
      ])}`,
      LIST_BYTE_HINT,
    );
    const cdn = await optionalCdn();
    return summarizeResults(payload, cdn ? cdn.thumb : [], currentPage);
  }

  async function searchResults(query, page = 1) {
    const text = searchQuery(query);
    const currentPage = pageNumber(page);

    if (/^__feed:/i.test(text)) {
      return discoveryFeed(text.slice("__feed:".length), currentPage);
    }
    if (/^tag:/i.test(text)) {
      return tagResults(text.slice("tag:".length), "tag", currentPage);
    }
    if (/^language:/i.test(text)) {
      return tagResults(text.slice("language:".length), "language", currentPage);
    }
    const bare = text.match(/^(artist|group|parody|character|category):(.+)$/i);
    if (bare) {
      return tagResults(bare[2], bare[1].toLowerCase(), currentPage);
    }
    if (!text) return newestResults(currentPage);
    return searchText(text, currentPage);
  }

  async function fetchGallery(galleryID, includePages) {
    const id = normalizeGalleryID(galleryID);
    const suffix = includePages ? "?include=pages" : "";
    const payload = await fetchJSON(
      `${API_URL}${GALLERIES_PATH}/${encodeURIComponent(id)}${suffix}`,
      DETAIL_BYTE_HINT,
    );
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("nhentai returned malformed gallery details.");
    }
    if (nonEmpty(payload.id) !== id) {
      throw new Error("nhentai returned details for a different gallery.");
    }
    if (payload.error) {
      throw new Error(`nhentai gallery unavailable: ${cleanText(payload.error)}`);
    }
    return payload;
  }

  async function extractDetails(galleryID) {
    const id = normalizeGalleryID(galleryID);
    const payload = await fetchGallery(id, false);
    const tags = tagList(payload);

    const authors = tagNames(tags, ["artist"]);
    const groups = tagNames(tags, ["group"]);
    const genres = tagNames(tags, ["tag", "group", "artist"]);
    const categories = tagNames(tags, ["category"]);
    const parodies = tagNames(tags, ["parody"]);
    const characters = tagNames(tags, ["character"]);
    const language = galleryLanguage(tags);
    const pages = Number(payload.num_pages);

    if (!cdnCache.thumb.length) await optionalCdn();

    const descriptionParts = [];
    if (categories.length) descriptionParts.push(categories.join(", "));
    if (parodies.length) descriptionParts.push(`Parody: ${parodies.join(", ")}`);
    if (characters.length) descriptionParts.push(`Characters: ${characters.join(", ")}`);
    if (genres.length) descriptionParts.push(genres.join(", "));
    if (authors.length) descriptionParts.push(`Artists: ${authors.join(", ")}`);
    if (groups.length) descriptionParts.push(`Groups: ${groups.join(", ")}`);
    if (language) descriptionParts.push(`Language: ${language}`);
    const scanlator = cleanText(payload.scanlator);
    if (scanlator) descriptionParts.push(`Scanlator: ${scanlator}`);
    const favorites = Number(payload.num_favorites);
    if (Number.isFinite(favorites) && favorites > 0) {
      descriptionParts.push(`${formatCount(favorites)} favourites`);
    }

    return {
      id,
      href: `${WEBSITE_URL}/g/${id}/`,
      url: `${WEBSITE_URL}/g/${id}/`,
      title: galleryTitle(payload) || `nhentai gallery ${id}`,
      description: descriptionParts.join("\n"),
      image: galleryCover(payload),
      authors,
      author: authors[0] || "",
      genres,
      language,
      pageCount: Number.isFinite(pages) && pages > 0 ? pages : 0,
    };
  }

  async function extractChapters(galleryID) {
    const id = normalizeGalleryID(galleryID);
    const payload = await fetchGallery(id, false);
    const pages = Number(payload.num_pages);
    const pageCount = Number.isFinite(pages) && pages > 0 ? pages : 0;
    const href = `${WEBSITE_URL}/g/${id}/`;
    return [
      {
        id,
        href,
        url: href,
        title: pageCount ? `Full gallery (${pageCount} pages)` : "Full gallery",
        number: 1,
        language: galleryLanguage(tagList(payload)),
      },
    ];
  }

  async function extractImages(chapterID) {
    const id = normalizeGalleryID(chapterID);
    const payload = await fetchGallery(id, true);
    const rawPages = Array.isArray(payload.pages) ? payload.pages : [];
    if (!rawPages.length) {
      throw new Error("nhentai returned no page images for this gallery.");
    }
    if (rawPages.length > MAX_PAGES) {
      throw new Error(
        `nhentai gallery has ${rawPages.length} pages, which exceeds the ${MAX_PAGES} page limit.`,
      );
    }

    const cdn = await cdnConfig();
    const ordered = rawPages
      .slice()
      .sort((left, right) => Number((left && left.number) || 0) - Number((right && right.number) || 0));

    const seen = new Set();
    const output = [];
    for (const page of ordered) {
      const number = Number((page && page.number) || 0);
      if (seen.has(number)) continue;
      const path = imagePath(page && page.path);
      if (!path) {
        throw new Error(`nhentai returned an unexpected page path for page ${number || "?"}.`);
      }
      const url = buildImageURL(cdn.image, path, output.length);
      if (!/^https:\/\/[a-z0-9.-]+\.nhentai\.net\/galleries\//i.test(url)) {
        throw new Error("nhentai returned a page image on an unexpected host.");
      }
      seen.add(number);
      output.push({ url, headers: { ...IMAGE_HEADERS } });
    }

    if (!output.length) {
      throw new Error("nhentai returned no readable page images for this gallery.");
    }
    return output;
  }

  function detailItem(payload) {
    const id = nonEmpty(payload && payload.id);
    if (!GALLERY_ID_PATTERN.test(id)) return null;
    const href = `${WEBSITE_URL}/g/${id}/`;
    const pages = Number(payload.num_pages);
    const subtitle = Number.isFinite(pages) && pages > 0 ? `${pages} page${pages === 1 ? "" : "s"}` : "";
    return {
      id,
      href,
      url: href,
      title: galleryTitle(payload) || `nhentai gallery ${id}`,
      image: galleryCover(payload),
      subtitle,
    };
  }

  async function randomPicks() {
    const items = [];
    const seen = new Set();
    // Cover URLs need the CDN server list; never hardcode a host.
    await optionalCdn();
    for (let attempt = 0; attempt < RANDOM_PICK_ATTEMPTS && items.length < RANDOM_PICK_COUNT; attempt += 1) {
      const suggestion = await fetchJSON(`${API_URL}${RANDOM_PATH}`, LIST_BYTE_HINT);
      const id = nonEmpty(suggestion && suggestion.id);
      if (!GALLERY_ID_PATTERN.test(id) || seen.has(id)) continue;
      seen.add(id);
      let payload = null;
      try {
        payload = await fetchGallery(id, false);
      } catch {
        continue;
      }
      const item = detailItem(payload);
      if (item) items.push(item);
    }
    return items;
  }

  async function popularItems(currentPage) {
    // Page 1 is the site's daily popular shelf, which the API publishes as one
    // fixed list with no page parameter. Deeper pages therefore continue on the
    // newest feed so the grid keeps scrolling instead of dead-ending at 25.
    if (currentPage > 1) {
      const deeper = await fetchJSON(
        `${API_URL}${GALLERIES_PATH}?${buildQuery([
          ["page", currentPage],
          ["per_page", PAGE_SIZE],
        ])}`,
        LIST_BYTE_HINT,
      );
      const cdn = await optionalCdn();
      return summarizeResults(deeper, cdn ? cdn.thumb : [], currentPage);
    }
    const payload = await fetchJSON(`${API_URL}${POPULAR_PATH}`, LIST_BYTE_HINT);
    const list = Array.isArray(payload) ? payload : Array.isArray(payload && payload.result) ? payload.result : [];
    if (!list.length) throw new Error("nhentai returned no popular galleries.");
    const cdn = await optionalCdn();
    const items = buildItems(list, cdn ? cdn.thumb : []);
    if (!items.length) throw new Error("nhentai popular galleries were malformed.");
    return { items, hasMore: currentPage < MAX_PAGE_INDEX };
  }

  async function discoveryFeed(feedID, page = 1) {
    const id = nonEmpty(feedID).toLowerCase();
    const currentPage = pageNumber(page);
    if (id === "popular") return popularItems(currentPage);
    if (id === "new" || id === "newest" || id === "latest") return newestResults(currentPage);
    if (!id) return newestResults(currentPage);
    return { items: [], hasMore: false };
  }

  async function section(id, title, loader) {
    try {
      const items = await loader();
      return { id, title, items: Array.isArray(items) ? items : [] };
    } catch {
      return { id, title, items: [] };
    }
  }

  async function discoveryHome() {
    const sections = [];
    sections.push(
      await section("popular", "Popular", async () => {
        const { items } = await popularItems(1);
        return items;
      }),
    );
    sections.push(
      await section("new", "New", async () => {
        const { items } = await newestResults(1);
        return items;
      }),
    );
    sections.push(await section("random", "Random picks", randomPicks));
    for (const rail of HOME_TAG_RAILS) {
      sections.push(
        await section(rail.id, rail.title, async () => {
          const { items } = await tagResults(rail.tag, "tag", 1);
          return items;
        }),
      );
    }
    return { sections };
  }

  const handlers = {
    searchResults,
    extractDetails,
    extractChapters,
    extractImages,
    discoveryHome,
    discoveryFeed,
  };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
