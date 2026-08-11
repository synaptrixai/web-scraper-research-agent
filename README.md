# Web Scraper Research Agent

Installable external agent for the Spilli VS Code extension. It searches the web with Brave Search or a keyless DuckDuckGo fallback, then scrapes pages with Playwright-rendered Chromium so JavaScript-loaded content has time to appear before extraction.

## Requirements

- Node.js 18 or newer.
- Optional: a Brave Search API key in `BRAVE_SEARCH_API_KEY`. If it is not set, the agent can use the keyless DuckDuckGo fallback tool.
- Chromium installed for Playwright.

## Setup

```sh
npm install
npm run install-browser
export BRAVE_SEARCH_API_KEY="your-brave-search-key" # optional, but recommended
```

## Scripts

```sh
npm test
npm run smoke
npm run install-browser
```

`npm run smoke` only verifies the runtime entrypoint loads. `npm test` uses mocked search and browser dependencies, so it does not require live internet access or a real Chromium launch.

## Tools

- `web.searchBrave`: searches Brave Search and returns normalized result titles, URLs, descriptions, and ages.
- `web.searchDuckDuckGo`: searches DuckDuckGo HTML results without an API key. This is useful as a fallback, but it is more fragile than the Brave API because it parses public HTML.
- `web.scrapePages`: opens HTTP(S) URLs in headless Chromium, waits for rendered content, and extracts title, meta description, headings, visible text, and links.

The scraper rejects obvious localhost and private-network targets, clamps page counts, clamps timeouts, and never returns the Brave API key.

## Conversation Context

The SpiLLI extension hydrates prior conversation messages into SpiLLIHost and sends strict deltas after that. This agent sends only the current user request on its first model call, then only the newly completed web-tool results on each later call. It intentionally does not prepend `conversationSummary`, `recentMessages`, the original request, or older research results, because replaying those values would duplicate host-managed history.

Each main or sub-agent chat context is identified by the extension's `contextId` and may share a model/network allocation with other contexts without sharing history. The agent keeps no process-global transcript state.

## Example Prompts

- `Research the latest guidance on structured data for product pages and cite sources.`
- `Scrape https://example.com and summarize the main content.`
- `Find three authoritative sources on browser automation for dynamic pages, then compare their recommendations.`

## Limitations

Some sites block automated browsers, require login, show CAPTCHAs, or gate content behind paywalls. The agent should report those failures instead of guessing. Always use this agent in ways that respect website terms, copyright, privacy, and applicable law.
