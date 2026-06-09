'use strict';

const net = require('node:net');

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const DUCKDUCKGO_ENDPOINT = 'https://html.duckduckgo.com/html/';
const DEFAULT_SEARCH_COUNT = 8;
const MAX_SEARCH_COUNT = 20;
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_TIMEOUT_MS = 45000;
const DEFAULT_MAX_CHARS = 12000;
const MAX_CHARS_PER_PAGE = 40000;
const DEFAULT_MAX_PAGES = 5;
const MAX_PAGES = 10;
const DEFAULT_MAX_LINKS = 40;

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function cleanText(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_match, code) => {
      const parsed = Number(code);
      return Number.isInteger(parsed) ? String.fromCodePoint(parsed) : _match;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
      const parsed = Number.parseInt(code, 16);
      return Number.isInteger(parsed) ? String.fromCodePoint(parsed) : _match;
    });
}

function stripTags(value) {
  const decoded = decodeHtmlEntities(value);
  return cleanText(decodeHtmlEntities(decoded.replace(/<[^>]*>/g, ' ')));
}

function truncateText(value, maxChars) {
  const text = cleanText(value);
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, maxChars).trimEnd(), truncated: true };
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isObviousPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }

  if (net.isIPv4(host)) {
    return isPrivateIpv4(host);
  }

  if (net.isIPv6(host)) {
    return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
  }

  return false;
}

function normalizeHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('URL must be a non-empty string.');
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol for ${value}. Only http and https are allowed.`);
  }

  if (isObviousPrivateHost(parsed.hostname)) {
    throw new Error(`Refusing to scrape private or localhost URL: ${value}`);
  }

  parsed.hash = '';
  return parsed.toString();
}

function getFetch(context) {
  const fetchImpl = context && (context.fetchImpl || context.fetch);
  if (typeof fetchImpl === 'function') {
    return fetchImpl;
  }
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis);
  }
  throw new Error('No fetch implementation is available. Use Node.js 18 or newer.');
}

function getBraveApiKey(context) {
  const key = context && typeof context.braveSearchApiKey === 'string'
    ? context.braveSearchApiKey
    : process.env.BRAVE_SEARCH_API_KEY;
  if (!key || !key.trim()) {
    throw new Error('BRAVE_SEARCH_API_KEY is required to use web.searchBrave.');
  }
  return key.trim();
}

function normalizeBraveResults(payload) {
  const webResults = payload && payload.web && Array.isArray(payload.web.results) ? payload.web.results : [];
  return webResults
    .filter(result => result && typeof result.url === 'string')
    .map(result => ({
      title: cleanText(result.title || result.profile?.name || result.url),
      url: result.url,
      description: cleanText(result.description || result.extra_snippets?.join(' ') || ''),
      age: typeof result.age === 'string' ? result.age : undefined
    }));
}

function extractAttribute(html, name) {
  const pattern = new RegExp(`${name}\\s*=\\s*(["'])(.*?)\\1`, 'i');
  const match = String(html || '').match(pattern);
  return match ? decodeHtmlEntities(match[2]) : '';
}

function normalizeDuckDuckGoUrl(href) {
  const decoded = decodeHtmlEntities(href || '').trim();
  if (!decoded) {
    return '';
  }

  try {
    const absolute = new URL(decoded, 'https://duckduckgo.com');
    const uddg = absolute.searchParams.get('uddg');
    if (uddg) {
      return decodeURIComponent(uddg);
    }
    return absolute.toString();
  } catch {
    return decoded;
  }
}

function parseDuckDuckGoResults(html, maxResults) {
  const results = [];
  const blocks = String(html || '').split(/<div[^>]+class=["'][^"']*\bresult\b[^"']*["'][^>]*>/i).slice(1);

  for (const block of blocks) {
    const titleMatch = block.match(/<a[^>]+class=["'][^"']*\bresult__a\b[^"']*["'][^>]*>[\s\S]*?<\/a>/i);
    if (!titleMatch) {
      continue;
    }

    const anchor = titleMatch[0];
    const url = normalizeDuckDuckGoUrl(extractAttribute(anchor, 'href'));
    if (!url || !/^https?:\/\//i.test(url)) {
      continue;
    }

    const snippetMatch = block.match(/<a[^>]+class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>[\s\S]*?<\/a>|<div[^>]+class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>[\s\S]*?<\/div>/i);
    const result = {
      title: stripTags(anchor),
      url,
      description: snippetMatch ? stripTags(snippetMatch[0]) : ''
    };
    if (result.title) {
      results.push(result);
    }
    if (results.length >= maxResults) {
      break;
    }
  }

  return results;
}

async function searchBrave(context, input) {
  if (typeof input.query !== 'string' || !input.query.trim()) {
    throw new Error('web.searchBrave requires a non-empty query.');
  }

  const count = clampInteger(input.count, DEFAULT_SEARCH_COUNT, 1, MAX_SEARCH_COUNT);
  const searchUrl = new URL(BRAVE_ENDPOINT);
  searchUrl.searchParams.set('q', input.query.trim());
  searchUrl.searchParams.set('count', String(count));
  searchUrl.searchParams.set('country', typeof input.country === 'string' && input.country.trim() ? input.country.trim() : 'us');
  searchUrl.searchParams.set('search_lang', typeof input.searchLang === 'string' && input.searchLang.trim() ? input.searchLang.trim() : 'en');
  searchUrl.searchParams.set('spellcheck', '1');
  if (typeof input.freshness === 'string' && input.freshness.trim()) {
    searchUrl.searchParams.set('freshness', input.freshness.trim());
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await getFetch(context)(searchUrl.toString(), {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': getBraveApiKey(context)
      },
      signal: controller.signal
    });

    if (!response || typeof response.ok !== 'boolean') {
      throw new Error('Brave Search returned an invalid response.');
    }
    if (!response.ok) {
      const status = response.status ? `HTTP ${response.status}` : 'non-OK response';
      throw new Error(`Brave Search request failed with ${status}.`);
    }

    const payload = await response.json();
    return {
      query: input.query.trim(),
      source: 'brave',
      results: normalizeBraveResults(payload)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function searchDuckDuckGo(context, input) {
  if (typeof input.query !== 'string' || !input.query.trim()) {
    throw new Error('web.searchDuckDuckGo requires a non-empty query.');
  }

  const count = clampInteger(input.count, DEFAULT_SEARCH_COUNT, 1, MAX_SEARCH_COUNT);
  const searchUrl = new URL(DUCKDUCKGO_ENDPOINT);
  searchUrl.searchParams.set('q', input.query.trim());

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await getFetch(context)(searchUrl.toString(), {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; SpilliWebResearchAgent/0.1; +https://github.com/synaptrixai/agent-starter-kit)'
      },
      signal: controller.signal
    });

    if (!response || typeof response.ok !== 'boolean') {
      throw new Error('DuckDuckGo returned an invalid response.');
    }
    if (!response.ok) {
      const status = response.status ? `HTTP ${response.status}` : 'non-OK response';
      throw new Error(`DuckDuckGo search request failed with ${status}.`);
    }

    const html = await response.text();
    return {
      query: input.query.trim(),
      source: 'duckduckgo-html',
      results: parseDuckDuckGoResults(html, count)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function getPlaywright(context) {
  if (context && context.playwright && context.playwright.chromium) {
    return context.playwright;
  }

  try {
    return require('playwright');
  } catch (error) {
    throw new Error(`Playwright is required for web.scrapePages. Run npm install and npm run install-browser. ${error.message}`);
  }
}

async function closeQuietly(target) {
  if (target && typeof target.close === 'function') {
    try {
      await target.close();
    } catch {
      // Best-effort cleanup.
    }
  }
}

async function newBrowser(context) {
  if (context && typeof context.browserFactory === 'function') {
    return context.browserFactory();
  }
  const playwright = getPlaywright(context);
  return playwright.chromium.launch({ headless: true });
}

async function extractPageData(page, sourceUrl, maxChars) {
  const evaluated = await page.evaluate(() => {
    const metaDescription = document.querySelector('meta[name="description"], meta[property="og:description"]');
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .map(element => ({
        level: element.tagName.toLowerCase(),
        text: element.innerText || element.textContent || ''
      }))
      .filter(heading => heading.text.trim())
      .slice(0, 40);
    const links = Array.from(document.querySelectorAll('a[href]'))
      .map(anchor => ({
        text: anchor.innerText || anchor.textContent || '',
        href: anchor.href
      }))
      .filter(link => link.href)
      .slice(0, 80);
    const body = document.body ? document.body.innerText || document.body.textContent || '' : '';
    return {
      title: document.title || '',
      description: metaDescription ? metaDescription.getAttribute('content') || '' : '',
      headings,
      links,
      text: body
    };
  });

  const truncated = truncateText(evaluated.text, maxChars);
  return {
    url: sourceUrl,
    finalUrl: typeof page.url === 'function' ? page.url() : sourceUrl,
    ok: true,
    rendered: true,
    title: cleanText(evaluated.title),
    description: cleanText(evaluated.description),
    headings: evaluated.headings.map(heading => ({
      level: heading.level,
      text: cleanText(heading.text)
    })).filter(heading => heading.text),
    text: truncated.text,
    textTruncated: truncated.truncated,
    links: evaluated.links.map(link => ({
      text: cleanText(link.text),
      href: link.href
    })).filter(link => link.href).slice(0, DEFAULT_MAX_LINKS)
  };
}

async function scrapeOnePage(browser, inputUrl, options) {
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (compatible; SpilliWebResearchAgent/0.1; +https://github.com/synaptrixai/agent-starter-kit)'
  });

  try {
    await page.goto(inputUrl, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    if (options.waitForSelector) {
      await page.waitForSelector(options.waitForSelector, { timeout: Math.min(options.timeoutMs, 10000) });
    } else if (typeof page.waitForLoadState === 'function') {
      try {
        await page.waitForLoadState('networkidle', { timeout: Math.min(options.timeoutMs, 6000) });
      } catch {
        // Dynamic sites often keep connections open; scrape whatever has rendered.
      }
    }
    return await extractPageData(page, inputUrl, options.maxCharsPerPage);
  } catch (error) {
    return {
      url: inputUrl,
      finalUrl: typeof page.url === 'function' ? page.url() : inputUrl,
      ok: false,
      rendered: true,
      error: error && error.message ? error.message : String(error)
    };
  } finally {
    await closeQuietly(page);
  }
}

async function scrapePages(context, input) {
  const rawUrls = Array.isArray(input.urls) ? input.urls : [];
  if (!rawUrls.length) {
    throw new Error('web.scrapePages requires at least one URL.');
  }

  const urls = rawUrls.slice(0, MAX_PAGES).map(normalizeHttpUrl);
  const timeoutMs = clampInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, 3000, MAX_TIMEOUT_MS);
  const maxCharsPerPage = clampInteger(input.maxCharsPerPage, DEFAULT_MAX_CHARS, 1000, MAX_CHARS_PER_PAGE);
  const waitForSelector = typeof input.waitForSelector === 'string' && input.waitForSelector.trim()
    ? input.waitForSelector.trim()
    : undefined;

  context.reportStatus?.({
    phase: 'waiting',
    message: 'Launching browser.',
    detail: `Preparing Chromium to scrape ${urls.length} page${urls.length === 1 ? '' : 's'}.`
  });

  const browser = await newBrowser(context);
  try {
    const pages = [];
    for (let index = 0; index < urls.length; index += 1) {
      context.reportStatus?.({
        phase: 'tool',
        message: 'Scraping rendered page.',
        detail: urls[index],
        progress: urls.length > 0 ? index / urls.length : undefined,
        toolName: 'web.scrapePages'
      });
      pages.push(await scrapeOnePage(browser, urls[index], { timeoutMs, maxCharsPerPage, waitForSelector }));
    }
    return {
      pages,
      truncatedInputUrls: rawUrls.length > urls.length
    };
  } finally {
    await closeQuietly(browser);
  }
}

const toolModule = {
  id: 'web-research-tools',
  tools: [
    {
      contract: {
        name: 'web.searchBrave',
        description: 'Search the web using Brave Search and return normalized candidate pages.',
        args: '{"query": string, "count"?: number, "country"?: string, "searchLang"?: string, "freshness"?: string}',
        returns: '{"query": string, "source": "brave", "results": Array<{title, url, description, age?}>}',
        notes: 'Requires BRAVE_SEARCH_API_KEY. The API key is never returned.',
        includeByDefault: true,
        keywords: ['web', 'search', 'brave', 'research']
      },
      createTool: context => ({
        async invoke(input) {
          return JSON.stringify(await searchBrave(context || {}, input || {}));
        }
      })
    },
    {
      contract: {
        name: 'web.searchDuckDuckGo',
        description: 'Search the web using DuckDuckGo HTML results without an API key.',
        args: '{"query": string, "count"?: number}',
        returns: '{"query": string, "source": "duckduckgo-html", "results": Array<{title, url, description}>}',
        notes: 'Keyless fallback. More fragile than Brave Search because it parses public HTML results.',
        includeByDefault: true,
        keywords: ['web', 'search', 'duckduckgo', 'fallback', 'free', 'research']
      },
      createTool: context => ({
        async invoke(input) {
          return JSON.stringify(await searchDuckDuckGo(context || {}, input || {}));
        }
      })
    },
    {
      contract: {
        name: 'web.scrapePages',
        description: 'Render and scrape HTTP(S) pages with Playwright Chromium after JavaScript has loaded.',
        args: '{"urls": string[], "timeoutMs"?: number, "waitForSelector"?: string, "maxCharsPerPage"?: number}',
        returns: '{"pages": Array<{url, finalUrl, ok, title?, description?, headings?, text?, links?, rendered, error?}>}',
        notes: 'Only http and https URLs are allowed. Obvious localhost/private-network targets are rejected.',
        includeByDefault: true,
        keywords: ['web', 'scrape', 'browser', 'playwright', 'render', 'javascript']
      },
      createTool: context => ({
        async invoke(input) {
          return JSON.stringify(await scrapePages(context || {}, input || {}));
        }
      })
    }
  ]
};

module.exports = toolModule;
module.exports.toolModule = toolModule;
module.exports.default = toolModule;
module.exports._private = {
  cleanText,
  isObviousPrivateHost,
  normalizeBraveResults,
  normalizeDuckDuckGoUrl,
  normalizeHttpUrl,
  parseDuckDuckGoResults,
  scrapePages,
  searchDuckDuckGo,
  searchBrave,
  truncateText
};
