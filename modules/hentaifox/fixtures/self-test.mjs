// Deterministic self-test for modules/hentaifox/index.js.
//
// The captured fixtures are real pages:
//   home.html    https://hentaifox.com/
//   search.html  https://hentaifox.com/search/?q=big+breasts
//   details.html https://hentaifox.com/gallery/177148/
//
// fixtures/reader.html is the 404 page the site returns for the guessed reader
// path (/gallery/177148/1/), so the reader fixture below reproduces the markup
// the real reader at /g/177148/1/ serves: the #pages / #image_dir / #gallery_id
// / #unique_id hidden inputs, the #gimg element and the g_th page table that
// the site's own reader.min.js uses to build image URLs.
//
// Run: node modules/hentaifox/fixtures/self-test.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(here, "..", "index.js");
const readFixture = (name) => readFile(path.join(here, name), "utf8");

const HOME = await readFixture("home.html");
const SEARCH = await readFixture("search.html");
const DETAILS = await readFixture("details.html");

const EXT_CODES = { jpg: "j", png: "p", bmp: "b", gif: "g", webp: "w" };

// Values crossing out of the vm context have that realm's prototypes, so every
// structural comparison goes through JSON first (same trick the repository's
// tests use).
const plain = (value) => JSON.parse(JSON.stringify(value));

function readerHTML({
  pages = 24,
  dir = "005",
  folder = "4318403",
  unique = "177148",
  ext = "webp",
  host = "i3.hentaifox.com",
  includeTable = true,
  includeImage = true,
} = {}) {
  const table = {};
  for (let index = 1; index <= pages; index += 1) table[index] = `${EXT_CODES[ext] || "w"},1046,1500`;
  const image = includeImage
    ? `<a class="next_img"><img id="gimg" class="lazy preloader image_1" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='5 0 70 70'%3E%3C/svg%3E" data-src="https://${host}/${dir}/${folder}/1.${ext}" alt="Dendenden Bu page 1 full" /></a>`
    : '<a class="next_img"></a>';
  const padding = `<div class="pad">${"<!-- filler -->".repeat(180)}</div>`;
  return [
    '<!DOCTYPE html><html xmlns="https://www.w3.org/1999/xhtml" lang="en"><head>',
    "<title>🐴 Dendenden Bu - Page 1 - HentaiFox</title></head><body>",
    '<div class="overlay"><div class="wrap"><div class="row browse_gallery">',
    '<div class="col-md-12 gview">',
    `<input type="hidden" name="pages" id="pages" value="${pages}" />`,
    `<input type="hidden" name="image_dir" id="image_dir" value="${dir}" />`,
    `<input type="hidden" name="gallery_id" id="gallery_id" value="${folder}" />`,
    `<input type="hidden" name="unique_id" id="unique_id" value="${unique}" />`,
    '<div class="gallery_pagination col-md-12">',
    `<button onclick="jumpPage(${pages});" class="jump_pages"><span class="current">1</span> <span class="separator">of</span> <span class="total_pages">${pages}</span></button>`,
    "</div>",
    '<div class="full_image" style="max-width:1046px;">',
    '<a class="prev_nav page_prev"></a>',
    image,
    '<a class="next_nav page_next"></a>',
    "</div>",
    '<div class="browse_buttons"><a href="/gallery/177148/">Back to gallery</a></div>',
    "</div></div></div></div>",
    padding,
    includeTable ? `<script type="text/javascript">\nvar g_th = $.parseJSON('${JSON.stringify(table)}');\n</script>` : "",
    "</body></html>",
  ].join("\n");
}

const NOT_FOUND = [
  '<!DOCTYPE html><html lang="en"><head><title>🐴 404 Not Found - HentaiFox</title></head><body>',
  '<div class="galleries_overview">',
  '<div class="thumb"><div class="inner_thumb"><a href="/gallery/121051/"><img data-src="https://i3.hentaifox.com/002/321/thumb.jpg"></a></div>',
  '<div class="caption"><h2 class="g_title"><a href="/gallery/121051/">Sidebar</a></h2></div></div>',
  "</div>",
  `<div>${"<!-- filler -->".repeat(180)}</div>`,
  "</body></html>",
].join("\n");

const CHALLENGE = [
  "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>",
  '<div id="cf-browser-verification">Checking your browser before accessing hentaifox.com</div>',
  `<div>${"<!-- filler -->".repeat(180)}</div>`,
  "</body></html>",
].join("\n");

// The same listing with a pager that has no live Next link.
const SEARCH_LAST_PAGE = SEARCH.replace(
  /<ul class="pagination">[\s\S]*?<\/ul>/,
  '<ul class="pagination"><li class="page-item disabled"><a class="page-link" href="#" tabindex="-1">Next</a></li></ul>',
);

function route(url, state) {
  const { pathname, searchParams } = new URL(url);
  if (state.mode === "challenge") return CHALLENGE;
  if (state.mode === "empty") return "<html><body>ok</body></html>";
  if (state.override) {
    const overridden = state.override(url);
    if (overridden != null) return overridden;
  }
  if (pathname === "/" || pathname === "/page/2/" || pathname.startsWith("/pag/")) return HOME;
  if (pathname === "/search/") return searchParams.get("q") === "no-more" ? SEARCH_LAST_PAGE : SEARCH;
  if (pathname.startsWith("/tag/")) return SEARCH;
  if (pathname === "/gallery/177148/") return DETAILS;
  if (pathname === "/gallery/999999999/") return NOT_FOUND;
  if (pathname === "/g/177148/1/") return readerHTML();
  if (pathname === "/g/500/1/") return readerHTML({ pages: 500 });
  if (pathname === "/g/900/1/") return readerHTML({ pages: 3, includeTable: false, includeImage: false });
  if (pathname === "/g/54/1/") {
    return readerHTML({ pages: 2, dir: "001", folder: "12791", unique: "54", ext: "jpg", host: "i.hentaifox.com" });
  }
  throw new Error(`Unexpected pagev2 URL: ${url}`);
}

function pagev2Bridge(state) {
  return async (task) => {
    assert.equal(typeof task, "object", "pagev2 receives a task object");
    assert.equal(task.includeHTML, true, "HTML pages request includeHTML");
    assert.equal(task.returnScript, "document.documentElement.outerHTML", "HTML comes from returnScript");
    assert.equal(task.captureResponseBodies, false);
    assert.equal(task.userAgent, null);
    assert.equal(task.actionScript, null);
    assert.ok(task.maxResponseCharacters >= 1_000_000, "page HTML budget is generous");
    state.pagev2.push({ url: task.url });
    return { finalURL: task.url, title: "", html: route(task.url, state), events: [], cookies: {}, evaluatedData: null };
  };
}

function fetchv2Bridge(state) {
  return async (url, headers, method, body, options) => {
    state.fetchv2.push({ url, method, headers, options });
    // Image hosts are plain HTTP; answer like i3.hentaifox.com does (webp only).
    const extension = (String(url).match(/\.([a-z0-9]+)$/i) || [])[1] || "";
    const ok = extension === "webp";
    return { ok, status: ok ? 200 : 404, headers: { "content-type": "image/webp" }, body: ok ? "BYTES" : "" };
  };
}

function loadModule(bridges) {
  const context = vm.createContext({
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    Math,
    Date,
    JSON,
    console,
    // Keep retry backoff instant; the challenge test would otherwise sleep.
    setTimeout: (callback) => {
      queueMicrotask(callback);
      return 0;
    },
    clearTimeout: () => {},
    ...bridges,
  });
  context.globalThis = context;
  return readFile(modulePath, "utf8").then((source) => {
    new vm.Script(source, { filename: modulePath }).runInContext(context);
    return context;
  });
}

async function fresh(bridges = {}) {
  const state = { pagev2: [], fetchv2: [] };
  const module = await loadModule({
    pagev2: pagev2Bridge(state),
    fetchv2: fetchv2Bridge(state),
    ...(bridges.pagev2 ? { pagev2: bridges.pagev2 } : {}),
    ...(bridges.fetchv2 ? { fetchv2: bridges.fetchv2 } : {}),
  });
  return { module, state };
}

const results = [];
async function check(label, fn) {
  try {
    await fn();
    results.push({ label, ok: true });
    console.log(`PASS  ${label}`);
  } catch (error) {
    results.push({ label, ok: false, error });
    console.log(`FAIL  ${label}\n      ${error && error.message ? error.message : error}`);
  }
}

console.log("HentaiFox self-test — fixtures: home.html, search.html, details.html, live reader markup\n");

await check("home: markup sections + tag sections, all items well formed", async () => {
  const { module } = await fresh();
  const home = await module.discoveryHome();
  assert.deepEqual(
    plain(home.sections.map((section) => section.id)),
    ["latest", "featured", "daily", "tag:big-breasts", "tag:sole-female", "tag:schoolgirl-uniform"],
  );
  for (const section of home.sections) {
    assert.ok(section.title, `section ${section.id} has a title`);
    assert.ok(section.items.length > 0, `section ${section.id} has items`);
    for (const item of section.items) {
      assert.match(item.id, /^\d+$/, "item id is numeric");
      assert.equal(item.href, `https://hentaifox.com/gallery/${item.id}/`);
      assert.equal(item.url, item.href);
      assert.ok(item.title.length > 0);
      assert.match(item.image, /^https:\/\/[a-z0-9]+\.hentaifox\.com\//);
    }
    assert.equal(new Set(section.items.map((item) => item.id)).size, section.items.length, "no duplicate ids");
  }
  console.log(`      sections: ${home.sections.map((s) => `${s.id}(${s.items.length})`).join(", ")}`);
});

await check("home: exact first card (category subtitle + real cover)", async () => {
  const { module } = await fresh();
  const latest = (await module.discoveryHome()).sections.find((section) => section.id === "latest");
  assert.equal(latest.items.length, 20, "20 gallery cards on the home page");
  assert.deepEqual(plain(latest.items[0]), {
    id: "177152",
    href: "https://hentaifox.com/gallery/177152/",
    url: "https://hentaifox.com/gallery/177152/",
    title: "Slut-Only Car ~BITCH ONLY~",
    image: "https://i3.hentaifox.com/005/4318501/thumb.jpg",
    subtitle: "Manga · NEW",
  });
});

await check("home: sidebar sections come from the real markup", async () => {
  const { module } = await fresh();
  const home = await module.discoveryHome();
  const featured = home.sections.find((section) => section.id === "featured");
  const daily = home.sections.find((section) => section.id === "daily");
  assert.equal(featured.items.length, 10);
  assert.deepEqual(plain([featured.items[0].id, featured.items[0].title]), [
    "176752",
    "Deriheru yondara wakareta kanojo no mama ga kita | My Escort Was My Ex's Mom",
  ]);
  assert.equal(daily.items.length, 2);
  assert.deepEqual(plain(daily.items.map((item) => item.subtitle)), ["Today", "Yesterday"]);
  assert.equal(daily.items[0].id, "177048");
  assert.equal(daily.items[0].image, "https://i3.hentaifox.com/005/4315209/thumb.jpg");
});

await check("home: a failing bridge yields sections:[] instead of throwing", async () => {
  const { module } = await fresh({
    pagev2: async () => {
      throw new Error("no WebView");
    },
  });
  assert.deepEqual(plain(await module.discoveryHome()), { sections: [] });
});

await check("home: one failing tag section does not poison the others", async () => {
  const state = { pagev2: [], fetchv2: [], override: (url) => (url.includes("/tag/sole-female/") ? null : undefined) };
  state.override = (url) => {
    if (url.includes("/tag/sole-female/")) throw new Error("tag exploded");
    return undefined;
  };
  const module = await loadModule({ pagev2: pagev2Bridge(state), fetchv2: fetchv2Bridge(state) });
  const home = await module.discoveryHome();
  const ids = plain(home.sections.map((section) => section.id));
  assert.ok(ids.includes("latest"));
  assert.ok(!ids.includes("tag:sole-female"), "failed tag section is dropped");
  assert.ok(ids.includes("tag:big-breasts"), "other tag sections still load");
});

await check("search: plain query hits /search/?q= and reports hasMore", async () => {
  const { module, state } = await fresh();
  const search = await module.searchResults("big breasts", 1);
  assert.equal(state.pagev2.at(-1).url, "https://hentaifox.com/search/?q=big+breasts");
  assert.equal(search.items.length, 20);
  assert.equal(search.hasMore, true);
  assert.deepEqual(plain([search.items[0].id, search.items[0].title]), ["177148", "Dendenden Bu"]);
});

await check("search: deep pages use &page=N (3180 verified live)", async () => {
  const { module, state } = await fresh();
  await module.searchResults("big breasts", 5);
  assert.equal(state.pagev2.at(-1).url, "https://hentaifox.com/search/?q=big+breasts&page=5");
});

await check("search: tag: prefix paginates through /tag/<slug>/pag/N/", async () => {
  const { module, state } = await fresh();
  const tag = await module.searchResults("tag:big breasts", 2);
  assert.equal(state.pagev2.at(-1).url, "https://hentaifox.com/tag/big-breasts/pag/2/");
  assert.equal(tag.items.length, 20);
  assert.equal(tag.hasMore, true);
});

await check("search: object input and first page tag URL", async () => {
  const { module, state } = await fresh();
  await module.searchResults({ tag: "big-breasts" }, 1);
  assert.equal(state.pagev2.at(-1).url, "https://hentaifox.com/tag/big-breasts/");
  await module.searchResults({ text: "big breasts" }, 3);
  assert.equal(state.pagev2.at(-1).url, "https://hentaifox.com/search/?q=big+breasts&page=3");
});

await check("search: empty query scrolls the latest feed (page 1, /page/2/, /pag/N/)", async () => {
  const { module, state } = await fresh();
  const latest = await module.searchResults("", 1);
  assert.equal(state.pagev2.at(-1).url, "https://hentaifox.com/");
  assert.equal(latest.items.length, 20);
  await module.searchResults("", 2);
  assert.equal(state.pagev2.at(-1).url, "https://hentaifox.com/page/2/");
  await module.searchResults("", 3);
  assert.equal(state.pagev2.at(-1).url, "https://hentaifox.com/pag/3/");
});

await check("feeds: a 404 page URL falls back to the alternate path form", async () => {
  const { module, state } = await fresh();
  state.override = (url) => {
    if (url === "https://hentaifox.com/pag/3/") return NOT_FOUND; // /page/3/ is a 404 live
    if (url === "https://hentaifox.com/page/3/") return HOME;
    return undefined;
  };
  const feed = await module.discoveryFeed("latest", 3);
  assert.equal(feed.items.length, 20);
  assert.equal(feed.hasMore, true);
  assert.deepEqual(
    plain(state.pagev2.map((call) => call.url)),
    ["https://hentaifox.com/pag/3/", "https://hentaifox.com/page/3/"],
  );
});

await check("search: hasMore is false when the pager has no live Next link", async () => {
  const { module } = await fresh();
  const search = await module.searchResults("no-more", 1);
  assert.equal(search.items.length, 20);
  assert.equal(search.hasMore, false);
});

await check("feeds: discoveryFeed paginates latest and tags", async () => {
  const { module, state } = await fresh();
  const feed = await module.discoveryFeed("latest", 2);
  assert.equal(state.pagev2.at(-1).url, "https://hentaifox.com/page/2/");
  assert.equal(feed.items.length, 20);
  assert.equal(feed.hasMore, true);
  await module.discoveryFeed("tag:big-breasts", 1);
  assert.equal(state.pagev2.at(-1).url, "https://hentaifox.com/tag/big-breasts/");
  assert.deepEqual(plain(await module.discoveryFeed("nope", 1)), { items: [], hasMore: false });
});

await check("details: title, cover, tags, artists, pages, language", async () => {
  const { module } = await fresh();
  const details = await module.extractDetails("177148");
  assert.equal(details.id, "177148");
  assert.equal(details.href, "https://hentaifox.com/gallery/177148/");
  assert.equal(details.title, "Dendenden Bu");
  assert.equal(details.image, "https://i3.hentaifox.com/005/4318403/cover.jpg");
  assert.equal(details.pageCount, 24);
  assert.deepEqual(plain(details.authors), ["kosuke haruhito"]);
  assert.equal(details.author, "kosuke haruhito");
  assert.deepEqual(plain(details.languages), ["english", "translated"]);
  assert.equal(details.language, "en");
  assert.equal(details.category, "Manga");
  assert.equal(details.genres.length, 16);
  assert.ok(details.genres.includes("big breasts"));
  assert.ok(details.tags.includes("big-breasts"));
  assert.equal(details.posted, "2 minutes ago");
  assert.match(details.description, /Dendenden Bu/);
});

await check("details: identifier validation and missing galleries are descriptive", async () => {
  const { module } = await fresh();
  await assert.rejects(() => module.extractDetails("abc"), /Invalid HentaiFox gallery identifier/);
  await assert.rejects(() => module.extractDetails("12/../x"), /Invalid HentaiFox gallery identifier/);
  await assert.rejects(() => module.extractDetails("999999999"), /no page at/);
  await assert.rejects(() => module.extractDetails(""), /Invalid HentaiFox gallery identifier/);
});

await check("chapters: exactly one chapter, details page fetched once", async () => {
  const { module, state } = await fresh();
  await module.extractDetails("177148");
  const chapters = await module.extractChapters("177148");
  assert.equal(chapters.length, 1);
  assert.deepEqual(plain(chapters[0]), {
    id: "177148",
    href: "https://hentaifox.com/g/177148/1/",
    url: "https://hentaifox.com/g/177148/1/",
    title: "Full gallery (24 pages)",
    number: 1,
    pageCount: 24,
    language: "en",
  });
  const detailCalls = state.pagev2.filter((call) => call.url === "https://hentaifox.com/gallery/177148/");
  assert.equal(detailCalls.length, 1, "details HTML is cached across handlers");
});

await check("images: every full-size page URL, in order, no thumbnails", async () => {
  const { module, state } = await fresh();
  const images = await module.extractImages("177148");
  assert.equal(state.pagev2.at(-1).url, "https://hentaifox.com/g/177148/1/");
  assert.equal(images.length, 24);
  const urls = images.map((image) => image.url);
  assert.deepEqual(
    plain(urls),
    Array.from({ length: 24 }, (_, index) => `https://i3.hentaifox.com/005/4318403/${index + 1}.webp`),
  );
  assert.equal(new Set(urls).size, urls.length, "images are deduped");
  assert.ok(urls.every((url) => /^https:\/\/[a-z0-9]+\.hentaifox\.com\//.test(url)));
  assert.ok(urls.every((url) => !/\/t\d+\.|\/thumb\.|t\.jpg$/.test(url)), "thumbnails excluded");
  assert.deepEqual(plain(images[0].headers), {
    Accept: "image/avif,image/webp,image/*,*/*",
    Referer: "https://hentaifox.com/",
  });
  assert.equal(state.fetchv2.length, 0, "no fetchv2 traffic when the reader exposes g_th");
});

await check("images: chapter id accepts reader and details URLs", async () => {
  const { module } = await fresh();
  assert.equal((await module.extractImages("https://hentaifox.com/g/177148/1/")).length, 24);
  assert.equal((await module.extractImages("https://hentaifox.com/gallery/177148/")).length, 24);
  assert.equal((await module.extractImages("177148:1")).length, 24);
  await assert.rejects(() => module.extractImages("g/abc/1/"), /Invalid HentaiFox chapter identifier/);
  await assert.rejects(() => module.extractImages(""), /Invalid HentaiFox chapter identifier/);
});

await check("images: older galleries keep their jpg extension and i. host", async () => {
  const { module } = await fresh();
  const images = await module.extractImages("54");
  assert.deepEqual(plain(images.map((image) => image.url)), [
    "https://i.hentaifox.com/001/12791/1.jpg",
    "https://i.hentaifox.com/001/12791/2.jpg",
  ]);
});

await check("images: 400 image cap on oversized galleries", async () => {
  const { module } = await fresh();
  const images = await module.extractImages("500");
  assert.equal(images.length, 400);
  assert.equal(images.at(-1).url, "https://i3.hentaifox.com/005/4318403/400.webp");
});

await check("images: no g_th falls back to one fetchv2 extension probe", async () => {
  const { module, state } = await fresh();
  const images = await module.extractImages("900");
  assert.deepEqual(plain(images.map((image) => image.url)), [
    "https://i3.hentaifox.com/005/4318403/1.webp",
    "https://i3.hentaifox.com/005/4318403/2.webp",
    "https://i3.hentaifox.com/005/4318403/3.webp",
  ]);
  assert.equal(state.fetchv2.length, 1, "one probe is enough");
  assert.equal(state.fetchv2[0].method, "HEAD");
  assert.equal(state.fetchv2[0].url, "https://i3.hentaifox.com/005/4318403/1.webp");
  assert.ok(Number(state.fetchv2[0].options.maxBytesHint) <= 12 * 1024 * 1024, "12MB image cap");
});

await check("images: reader without metadata retries once, then throws", async () => {
  let readerCalls = 0;
  const state = { pagev2: [], fetchv2: [] };
  const module = await loadModule({
    pagev2: async (task) => {
      if (new URL(task.url).pathname === "/g/177148/1/") readerCalls += 1;
      return { html: route(task.url, state) };
    },
    fetchv2: fetchv2Bridge(state),
  });
  const stub = readerHTML().replace(/<input[^>]*id="(pages|image_dir|gallery_id)"[^>]*>/g, "");
  state.override = (url) => (url.includes("/g/177148/1/") ? stub : undefined);
  await assert.rejects(() => module.extractImages("177148"), /image directory|page count|no readable page images/);
  assert.equal(readerCalls, 2, "one retry only");
});

await check("challenge: retries three times, then throws a clear error", async () => {
  let calls = 0;
  const module = await loadModule({
    pagev2: async (task) => {
      calls += 1;
      return { finalURL: task.url, html: CHALLENGE, evaluatedData: null };
    },
    fetchv2: fetchv2Bridge({ fetchv2: [] }),
  });
  await assert.rejects(() => module.extractDetails("177148"), /Cloudflare challenge/);
  assert.equal(calls, 3, "three pagev2 attempts before failing");
});

await check("challenge: near-empty HTML is treated as challenged and retried", async () => {
  let calls = 0;
  const module = await loadModule({
    pagev2: async () => {
      calls += 1;
      return { html: "<html><body>ok</body></html>" };
    },
    fetchv2: fetchv2Bridge({ fetchv2: [] }),
  });
  await assert.rejects(() => module.extractDetails("177148"), /Cloudflare challenge/);
  assert.equal(calls, 3);
});

await check("bridge: pagev2 is mandatory for content handlers", async () => {
  const module = await loadModule({ fetchv2: fetchv2Bridge({ fetchv2: [] }) });
  await assert.rejects(() => module.extractDetails("177148"), /pagev2 WebView bridge/);
  await assert.rejects(() => module.searchResults("x", 1), /pagev2 WebView bridge/);
  await assert.rejects(() => module.extractImages("177148"), /pagev2 WebView bridge/);
});

await check("exports: every handler is on SynthetiqModule and globalThis", async () => {
  const { module } = await fresh();
  const expected = ["discoveryHome", "discoveryFeed", "searchResults", "extractDetails", "extractChapters", "extractImages"];
  for (const name of expected) {
    assert.equal(typeof module.SynthetiqModule[name], "function", `SynthetiqModule.${name}`);
    assert.equal(typeof module[name], "function", `globalThis.${name}`);
  }
});

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  for (const entry of failed) console.log(`\n${entry.label}\n${entry.error && entry.error.stack}`);
  process.exitCode = 1;
}
