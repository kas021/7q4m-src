#!/usr/bin/env node
// nhentai module self-test.
//
//   node fixtures/self-test.mjs          offline, deterministic (fixtures via a fetchv2 shim)
//   node fixtures/self-test.mjs --live   real https://nhentai.net/api/v2 requests
//
// Both modes load modules/nhentai/index.js inside a vm context with the same
// fetchv2 bridge shape the app runtime uses, so the module under test is the
// shipping script, not a copy.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(here, "../index.js");
const LIVE = process.argv.includes("--live");

const results = [];

function check(name, fn) {
  return { name, fn };
}

async function run(tests) {
  for (const test of tests) {
    try {
      const note = await test.fn();
      results.push({ ok: true, name: test.name, note: note || "" });
      console.log(`PASS  ${test.name}${note ? ` — ${note}` : ""}`);
    } catch (error) {
      results.push({ ok: false, name: test.name, note: error && error.message });
      console.log(`FAIL  ${test.name} — ${error && error.message}`);
      if (process.env.SELFTEST_VERBOSE) console.error(error);
    }
    // nhentai rate-limits bursts; pace the live run like a real client would.
    if (LIVE) await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

async function readFixture(name) {
  return JSON.parse(await readFile(path.join(here, name), "utf8"));
}

async function loadModuleAsync(fetchv2) {
  const context = vm.createContext({
    AbortController,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    clearTimeout,
    console,
    setTimeout,
    fetchv2,
  });
  context.globalThis = context;
  const code = await readFile(modulePath, "utf8");
  new vm.Script(code, { filename: modulePath }).runInContext(context);
  assert.equal(typeof context.SynthetiqModule, "object", "module did not export SynthetiqModule");
  for (const handler of [
    "searchResults",
    "extractDetails",
    "extractChapters",
    "extractImages",
    "discoveryHome",
    "discoveryFeed",
  ]) {
    assert.equal(typeof context[handler], "function", `handler ${handler} missing from globalThis`);
  }
  return context;
}

function jsonResponse(payload, status = 200, contentType = "application/json") {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { "content-type": contentType },
    finalUrl: "",
    body,
    bodyDropped: false,
    bodyBytes: body.length,
    contentType,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

/* ------------------------------------------------------------------ */
/* Offline harness                                                     */
/* ------------------------------------------------------------------ */

async function offlineShim() {
  const [popular, newest, search, tagged1, tagged2, tagMeta, galleryPages, gallery2, emptySearch, cdn, random] =
    await Promise.all([
      readFixture("popular.json"),
      readFixture("newest.json"),
      readFixture("search.json"),
      readFixture("tagged-page1.json"),
      readFixture("tagged-page2.json"),
      readFixture("tag-meta.json"),
      readFixture("gallery-pages.json"),
      readFixture("gallery-2.json"),
      readFixture("empty-search.json"),
      readFixture("cdn.json"),
      readFixture("random.json"),
    ]);
  const notFound = { error: "Gallery not found" };
  const randomCycle = ["177148", "1", String(random.id)];
  let randomCursor = 0;
  const calls = [];

  const languageEnglish = { ...tagMeta, id: 12227, type: "language", name: "english", slug: "english" };

  function galleryDetail(id) {
    if (id === "177148") return gallery2;
    if (id === "1") return galleryPages;
    // Random ids have no captured page; reuse a real payload with the id swapped.
    return { ...JSON.parse(JSON.stringify(gallery2)), id: Number(id), media_id: "988112" };
  }

  async function fetchv2(url, headers, method, body, options) {
    calls.push({ url, headers, method, options });
    assert.equal(method, "GET");
    assert.equal(body, null);
    assert.equal(headers.Accept, "application/json");
    assert.match(headers["User-Agent"] || "", /^SynthetiqBooks\/1\.0/);
    assert.equal(options.responseClass, "json");

    const parsed = new URL(url);
    assert.equal(parsed.host, "nhentai.net", `offline shim saw a non-nhentai host: ${url}`);
    const page = Number(parsed.searchParams.get("page") || 1);

    if (parsed.pathname === "/api/v2/cdn") return jsonResponse(cdn);
    if (parsed.pathname === "/api/v2/galleries/popular") return jsonResponse(popular);
    if (parsed.pathname === "/api/v2/galleries/random") {
      const id = randomCycle[randomCursor % randomCycle.length];
      randomCursor += 1;
      return jsonResponse({ id: Number(id) });
    }
    if (parsed.pathname === "/api/v2/galleries/tagged") {
      return jsonResponse(page >= 2 ? tagged2 : tagged1);
    }
    if (parsed.pathname === "/api/v2/tags/tag/big-breasts") return jsonResponse(tagMeta);
    if (parsed.pathname === "/api/v2/tags/language/english") return jsonResponse(languageEnglish);
    if (parsed.pathname === "/api/v2/tags/tag/does-not-exist") return jsonResponse(notFound, 404);
    if (parsed.pathname === "/api/v2/search") {
      if (parsed.searchParams.get("query") === "zzzz-no-match") return jsonResponse(emptySearch);
      return jsonResponse(search);
    }
    if (parsed.pathname === "/api/v2/galleries") {
      if (page >= 2) return jsonResponse(tagged2);
      return jsonResponse(newest);
    }
    const detail = parsed.pathname.match(/^\/api\/v2\/galleries\/(\d+)$/);
    if (detail) {
      if (detail[1] === "999999999") return jsonResponse(notFound, 404);
      return jsonResponse(galleryDetail(detail[1]));
    }
    throw new Error(`offline shim has no route for ${url}`);
  }

  return { fetchv2, calls };
}

async function offlineTests() {
  const shim = await offlineShim();
  const mod = await loadModuleAsync(shim.fetchv2);

  const tests = [];

  tests.push(
    check("discoveryHome returns Popular / New / Random picks with items", async () => {
      const home = await mod.discoveryHome();
      assert.equal(Array.isArray(home.sections), true);
      assert.deepEqual(
        JSON.parse(JSON.stringify(home.sections.map((s) => s.id))),
        ["popular", "new", "random"],
      );
      for (const section of home.sections) {
        assert.ok(section.items.length > 0, `${section.id} section was empty`);
        for (const item of section.items) {
          assert.match(item.id, /^\d{1,9}$/);
          assert.equal(item.href, `https://nhentai.net/g/${item.id}/`);
          assert.equal(item.url, item.href);
          assert.ok(item.title.length > 0);
          assert.match(item.image, /^https:\/\/[it]\d\.nhentai\.net\/galleries\//);
        }
      }
      return home.sections.map((s) => `${s.id}=${s.items.length}`).join(" ");
    }),
  );

  tests.push(
    check("discoveryFeed('popular'|'new') paginates honestly", async () => {
      const popular = await mod.discoveryFeed("popular", 1);
      assert.ok(popular.items.length > 0);
      assert.equal(popular.hasMore, false);
      const popularPage2 = await mod.discoveryFeed("popular", 2);
      assert.deepEqual(JSON.parse(JSON.stringify(popularPage2)), { items: [], hasMore: false });

      const fresh = await mod.discoveryFeed("new", 1);
      assert.ok(fresh.items.length > 0);
      assert.equal(fresh.hasMore, true);
      const second = await mod.discoveryFeed("new", 2);
      assert.ok(second.items.length > 0);
      assert.notEqual(second.items[0].id, fresh.items[0].id);

      const unknown = await mod.discoveryFeed("nope", 1);
      assert.deepEqual(JSON.parse(JSON.stringify(unknown)), { items: [], hasMore: false });
      return `popular=${popular.items.length} new=${fresh.items.length}/${second.items.length} hasMore=${fresh.hasMore}`;
    }),
  );

  tests.push(
    check("searchResults('tag:big breasts') browses the tag across pages", async () => {
      const first = await mod.searchResults("tag:big breasts", 1);
      assert.ok(first.items.length > 0, "tag page 1 was empty");
      assert.equal(first.hasMore, true);
      const second = await mod.searchResults("tag:big breasts", 2);
      assert.ok(second.items.length > 0, "tag page 2 was empty");
      assert.notEqual(second.items[0].id, first.items[0].id, "pagination repeated page 1");
      return `${first.items.length} items, hasMore=${first.hasMore}, page2=${second.items.length}`;
    }),
  );

  tests.push(
    check("searchResults('language:english') resolves the language tag", async () => {
      const page = await mod.searchResults("language:english", 1);
      assert.ok(page.items.length > 0);
      assert.equal(page.hasMore, true);
      return `${page.items.length} items, hasMore=${page.hasMore}`;
    }),
  );

  tests.push(
    check("searchResults('') returns the newest galleries", async () => {
      const page = await mod.searchResults("", 1);
      assert.ok(page.items.length > 0);
      assert.equal(page.hasMore, true);
      assert.match(page.items[0].href, /^https:\/\/nhentai\.net\/g\/\d+\/$/);
      return `${page.items.length} items, hasMore=${page.hasMore}`;
    }),
  );

  tests.push(
    check("searchResults('big breasts') uses free-text search", async () => {
      const page = await mod.searchResults("big breasts", 1);
      assert.ok(page.items.length > 0);
      assert.equal(page.hasMore, true);
      const none = await mod.searchResults("zzzz-no-match", 1);
      assert.deepEqual(JSON.parse(JSON.stringify(none)), { items: [], hasMore: false });
      return `${page.items.length} items; empty query -> ${none.items.length}`;
    }),
  );

  tests.push(
    check("unknown tag resolves to an empty page, not an error", async () => {
      const page = await mod.searchResults("tag:does not exist", 1);
      assert.deepEqual(JSON.parse(JSON.stringify(page)), { items: [], hasMore: false });
    }),
  );

  tests.push(
    check("extractDetails accepts id, g<id> and /g/<id>/", async () => {
      const first = await mod.extractDetails("177148");
      assert.equal(first.id, "177148");
      assert.match(first.title, /Mahou Shoujo Crisis/);
      assert.equal(first.pageCount, 19);
      assert.ok(first.authors.length > 0, "no artists extracted");
      assert.ok(first.genres.length > 0, "no genres extracted");
      assert.equal(first.language, "english");
      // Covers are served by the thumbnail servers, never the page servers.
      assert.match(first.image, /^https:\/\/t\d\.nhentai\.net\/galleries\/\d+\/cover\.jpg$/);
      assert.match(first.description, /Artists: /);

      const byG = await mod.extractDetails("g177148");
      const byHref = await mod.extractDetails("https://nhentai.net/g/177148/");
      assert.equal(byG.title, first.title);
      assert.equal(byHref.title, first.title);
      return `${first.authors.length} artists, ${first.genres.length} genres, ${first.pageCount} pages`;
    }),
  );

  tests.push(
    check("extractChapters returns exactly one round-tripping chapter", async () => {
      const chapters = await mod.extractChapters("177148");
      assert.equal(chapters.length, 1);
      assert.equal(chapters[0].id, "177148");
      assert.equal(chapters[0].number, 1);
      assert.equal(chapters[0].href, "https://nhentai.net/g/177148/");
      assert.match(chapters[0].title, /^Full gallery \(19 pages\)$/);
      assert.equal(chapters[0].language, "english");

      const images = await mod.extractImages(chapters[0].id);
      assert.equal(images.length, 19);
      return `1 chapter, title="${chapters[0].title}"`;
    }),
  );

  tests.push(
    check("extractImages is ordered, absolute and rotates CDN servers", async () => {
      const images = await mod.extractImages("177148");
      assert.equal(images.length, 19);
      const seen = new Set();
      for (const image of images) {
        assert.match(image.url, /^https:\/\/i\d\.nhentai\.net\/galleries\/988112\/\d+\.(jpg|jpeg|png|webp)$/);
        assert.equal(image.headers.Accept, "image/*");
        assert.equal(image.headers.Referer, "https://nhentai.net/");
        assert.ok(!seen.has(image.url), `duplicate image URL ${image.url}`);
        seen.add(image.url);
      }
      const numbers = images.map((image) => Number(image.url.match(/\/(\d+)\.\w+$/)[1]));
      assert.deepEqual(numbers.slice().sort((a, b) => a - b), numbers, "pages are not ascending");
      const hosts = new Set(images.map((image) => new URL(image.url).host));
      assert.ok(hosts.size > 1, "image servers were not rotated");
      return `${images.length} pages, ${numbers[0]}..${numbers[numbers.length - 1]}, hosts=${[...hosts].sort().join(",")}`;
    }),
  );

  tests.push(
    check("malformed and unknown galleries throw descriptive errors", async () => {
      await assert.rejects(() => mod.extractDetails("abc"), /Invalid nhentai gallery identifier/);
      await assert.rejects(() => mod.extractDetails("abcdefghij"), /Invalid nhentai gallery identifier/);
      await assert.rejects(() => mod.extractImages("../../etc/passwd"), /Invalid nhentai gallery identifier/);
      await assert.rejects(() => mod.extractDetails("999999999"), /404/);
    }),
  );

  tests.push(
    check("image servers are never hardcoded (bad CDN list is rejected)", async () => {
      const { fetchv2 } = await offlineShim();
      const broken = async (url, headers, method, body, options) => {
        if (url.includes("/api/v2/cdn")) {
          return jsonResponse({ image_servers: ["https://evil.example"], thumb_servers: ["https://evil.example"] });
        }
        return fetchv2(url, headers, method, body, options);
      };
      const hostile = await loadModuleAsync(broken);
      await assert.rejects(() => hostile.extractImages("177148"), /unexpected image server host/);
    }),
  );

  tests.push(
    check("transient 500s are retried before failing", async () => {
      const { fetchv2 } = await offlineShim();
      let failures = 2;
      let attempts = 0;
      const flaky = async (url, headers, method, body, options) => {
        if (/\/api\/v2\/galleries\/177148/.test(url)) {
          attempts += 1;
          if (failures > 0) {
            failures -= 1;
            return jsonResponse({ error: "boom" }, 500);
          }
        }
        return fetchv2(url, headers, method, body, options);
      };
      const module = await loadModuleAsync(flaky);
      const details = await module.extractDetails("177148");
      assert.equal(details.id, "177148");
      assert.equal(attempts, 3, "expected one attempt plus two retries");
      return `succeeded after ${attempts} attempts`;
    }),
  );

  tests.push(
    check("requests stay on nhentai.net with the required headers", async () => {
      const hosts = new Set(shim.calls.map((call) => new URL(call.url).host));
      assert.deepEqual([...hosts], ["nhentai.net"]);
      assert.ok(shim.calls.length >= 20);
      return `${shim.calls.length} requests, hosts=${[...hosts].join(",")}`;
    }),
  );

  await run(tests);
}

/* ------------------------------------------------------------------ */
/* Live harness                                                        */
/* ------------------------------------------------------------------ */

function liveFetchv2(url, headers, method, body, options) {
  return (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {
        body: body || undefined,
        headers,
        method: method || "GET",
        redirect: options && options.followRedirects === false ? "manual" : "follow",
        signal: controller.signal,
      });
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        finalUrl: response.url,
        body: text,
        bodyDropped: false,
        bodyBytes: Buffer.byteLength(text),
        contentType: response.headers.get("content-type") || "",
        text: async () => text,
        json: async () => JSON.parse(text),
      };
    } finally {
      clearTimeout(timer);
    }
  })();
}

async function liveTests() {
  const mod = await loadModuleAsync(liveFetchv2);
  const tests = [];

  let sampleGallery = "";

  tests.push(
    check("live discoveryHome", async () => {
      const home = await mod.discoveryHome();
      assert.equal(home.sections.length, 3);
      for (const section of home.sections) {
        assert.ok(section.items.length > 0, `${section.id} was empty live`);
      }
      const popular = home.sections.find((s) => s.id === "popular");
      sampleGallery = popular.items[0].id;
      return home.sections.map((s) => `${s.id}=${s.items.length}`).join(" ") + ` (first=${sampleGallery})`;
    }),
  );

  tests.push(
    check("live tag browse 'tag:big breasts' pages 1 and 2", async () => {
      const first = await mod.searchResults("tag:big breasts", 1);
      const second = await mod.searchResults("tag:big breasts", 2);
      assert.ok(first.items.length > 0);
      assert.equal(first.hasMore, true);
      assert.ok(second.items.length > 0);
      assert.notEqual(second.items[0].id, first.items[0].id);
      return `page1=${first.items.length} page2=${second.items.length} hasMore=${first.hasMore}`;
    }),
  );

  tests.push(
    check("live language browse 'language:english'", async () => {
      const page = await mod.searchResults("language:english", 1);
      assert.ok(page.items.length > 0);
      return `${page.items.length} items, hasMore=${page.hasMore}`;
    }),
  );

  tests.push(
    check("live free-text search and empty query", async () => {
      const text = await mod.searchResults("yuri", 1);
      const newest = await mod.searchResults("", 1);
      assert.ok(text.items.length > 0);
      assert.ok(newest.items.length > 0);
      return `search=${text.items.length} newest=${newest.items.length}`;
    }),
  );

  tests.push(
    check("live details + chapters + ordered images", async () => {
      assert.ok(sampleGallery, "no sample gallery from discoveryHome");
      const details = await mod.extractDetails(sampleGallery);
      assert.ok(details.title.length > 0);
      assert.ok(details.pageCount > 0);
      const chapters = await mod.extractChapters(details.id);
      assert.equal(chapters.length, 1);
      const images = await mod.extractImages(chapters[0].id);
      assert.equal(images.length, details.pageCount);
      const numbers = images.map((image) => Number(new URL(image.url).pathname.match(/\/(\d+)\.\w+$/)[1]));
      assert.deepEqual(numbers.slice().sort((a, b) => a - b), numbers);
      for (const image of images) {
        assert.match(image.url, /^https:\/\/[a-z0-9.-]+\.nhentai\.net\/galleries\//);
      }
      return `${details.id} "${details.title.slice(0, 44)}" ${details.pageCount}p, first=${images[0].url}`;
    }),
  );

  tests.push(
    check("live cover and first page image download with module headers", async () => {
      const details = await mod.extractDetails(sampleGallery);
      const images = await mod.extractImages(sampleGallery);
      const cover = await fetch(details.image, { headers: images[0].headers });
      const page = await fetch(images[0].url, { headers: images[0].headers });
      const coverBytes = (await cover.arrayBuffer()).byteLength;
      const pageBytes = (await page.arrayBuffer()).byteLength;
      assert.equal(cover.ok, true, `cover failed: ${details.image}`);
      assert.equal(page.ok, true, `page failed: ${images[0].url}`);
      assert.match(cover.headers.get("content-type") || "", /^image\//);
      assert.match(page.headers.get("content-type") || "", /^image\//);
      assert.ok(coverBytes > 1000 && pageBytes > 1000);
      return `cover ${cover.status} ${cover.headers.get("content-type")} ${coverBytes}B; page ${page.status} ${page.headers.get("content-type")} ${pageBytes}B`;
    }),
  );

  tests.push(
    check("live unknown gallery throws", async () => {
      await assert.rejects(() => mod.extractDetails("999999999"), /404|not found/i);
      await assert.rejects(() => mod.extractDetails("not-an-id"), /Invalid nhentai gallery identifier/);
    }),
  );

  await run(tests);
}

/* ------------------------------------------------------------------ */

(async () => {
  console.log(`nhentai self-test — ${LIVE ? "LIVE against https://nhentai.net/api/v2" : "offline fixtures"}`);
  if (LIVE) await liveTests();
  else await offlineTests();
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    for (const failure of failed) console.log(`  - ${failure.name}: ${failure.note}`);
    process.exitCode = 1;
  }
})().catch((error) => {
  console.error("self-test crashed:", error);
  process.exitCode = 1;
});
