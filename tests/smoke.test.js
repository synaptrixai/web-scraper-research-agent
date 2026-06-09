'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

function loadTools(context = {}) {
  const toolModule = require('../tools/webResearchTools');
  return new Map(toolModule.tools.map(tool => [tool.contract.name, tool.createTool(context)]));
}

test('manifest references files that exist', () => {
  const manifestPath = path.join(repoRoot, 'spilli-agent.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.strictEqual(manifest.schemaVersion, 1);
  assert.strictEqual(manifest.runtimeApiVersion, 1);
  assert.strictEqual(manifest.agent.apiVersion, 1);
  assert.strictEqual(manifest.agent.id, 'spilli-web-scraper');
  assert.strictEqual(manifest.agent.name, 'Web Scraper Research Agent');
  assert.strictEqual(manifest.agent.loopEntry, 'agentLoop.js');
  assert.ok(fs.existsSync(path.join(repoRoot, manifest.agent.loopEntry)));

  for (const entry of manifest.localToolEntries) {
    assert.ok(fs.existsSync(path.join(repoRoot, entry)), `missing local tool entry: ${entry}`);
  }
});

test('runtime executes web search and scrape tool calls before final answer', async () => {
  const { createAgentRuntime } = require('../agentLoop');
  const events = [];
  const statuses = [];
  let modelCalls = 0;

  const runtime = createAgentRuntime({
    runtimeApiVersion: 1,
    manifest: {},
    async runModel() {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          raw: '{"toolName":"web.searchBrave","callId":"search1","args":{"query":"dynamic scraping","count":2}}',
          content: '{"toolName":"web.searchBrave","callId":"search1","args":{"query":"dynamic scraping","count":2}}',
          isHarmony: false
        };
      }
      if (modelCalls === 2) {
        return {
          raw: '{"toolName":"web.scrapePages","callId":"scrape1","args":{"urls":["https://example.com"]}}',
          content: '{"toolName":"web.scrapePages","callId":"scrape1","args":{"urls":["https://example.com"]}}',
          isHarmony: false
        };
      }
      return {
        raw: 'Use Playwright for JavaScript-rendered pages. Source: https://example.com',
        content: 'Use Playwright for JavaScript-rendered pages. Source: https://example.com',
        isHarmony: false
      };
    },
    async parseToolCalls(payload) {
      if (!payload.raw.includes('"toolName"')) {
        return [];
      }
      const parsed = JSON.parse(payload.raw);
      return [{ toolName: parsed.toolName, callId: parsed.callId, args: parsed.args }];
    },
    async executeToolCall(call) {
      return {
        callId: call.callId,
        toolName: call.toolName,
        ok: true,
        result: call.toolName === 'web.searchBrave'
          ? { results: [{ title: 'Example', url: 'https://example.com', description: 'Example domain' }] }
          : { pages: [{ url: 'https://example.com', ok: true, title: 'Example Domain', text: 'Example text' }] }
      };
    }
  });

  const result = await runtime.runTurn(
    {
      model: 'test-model',
      scope: 'public',
      query: 'Research dynamic scraping.',
      conversationId: 'conversation-1',
      iterationSettings: { maxIterations: 4 }
    },
    {
      onToolCall: call => events.push(['call', call.toolName]),
      onToolResult: toolResult => events.push(['result', toolResult.ok]),
      onStatus: status => statuses.push([status.phase, status.message])
    }
  );

  assert.strictEqual(modelCalls, 3);
  assert.deepStrictEqual(events, [
    ['call', 'web.searchBrave'],
    ['result', true],
    ['call', 'web.scrapePages'],
    ['result', true]
  ]);
  assert.ok(statuses.some(([phase]) => phase === 'planning'));
  assert.ok(statuses.some(([phase]) => phase === 'model'));
  assert.ok(statuses.some(([phase]) => phase === 'tool'));
  assert.ok(statuses.some(([phase]) => phase === 'finalizing'));
  assert.strictEqual(result.runtime.mode, 'external');
  assert.strictEqual(result.runtime.agentId, 'spilli-web-scraper');
  assert.ok(result.content.includes('Playwright'));
});

test('runtime rejects unsupported tool calls with structured result', async () => {
  const { createAgentRuntime } = require('../agentLoop');
  const toolResults = [];

  const runtime = createAgentRuntime({
    async runModel() {
      return {
        raw: '{"toolName":"workspace.readFile","callId":"bad1","args":{"path":"README.md"}}',
        content: '{"toolName":"workspace.readFile","callId":"bad1","args":{"path":"README.md"}}',
        isHarmony: false
      };
    },
    async parseToolCalls() {
      return [{ toolName: 'workspace.readFile', callId: 'bad1', args: { path: 'README.md' } }];
    },
    async executeToolCall() {
      throw new Error('executeToolCall should not be called for unsupported tools');
    }
  });

  await runtime.runTurn(
    {
      model: 'test-model',
      scope: 'public',
      query: 'Try unsupported tool.',
      iterationSettings: { maxIterations: 1 }
    },
    {
      onToolResult: result => toolResults.push(result)
    }
  );

  assert.strictEqual(toolResults.length, 1);
  assert.strictEqual(toolResults[0].ok, false);
  assert.match(toolResults[0].error, /web\.searchDuckDuckGo/);
});

test('runtime rejects unknown web tool names', async () => {
  const { createAgentRuntime } = require('../agentLoop');
  const toolResults = [];

  const runtime = createAgentRuntime({
    async runModel() {
      return {
        raw: '{"toolName":"web.unknown","callId":"bad2","args":{}}',
        content: '{"toolName":"web.unknown","callId":"bad2","args":{}}',
        isHarmony: false
      };
    },
    async parseToolCalls() {
      return [{ toolName: 'web.unknown', callId: 'bad2', args: {} }];
    },
    async executeToolCall() {
      throw new Error('executeToolCall should not be called for unknown web tools');
    }
  });

  await runtime.runTurn(
    {
      model: 'test-model',
      scope: 'public',
      query: 'Try unknown tool.',
      iterationSettings: { maxIterations: 1 }
    },
    {
      onToolResult: result => toolResults.push(result)
    }
  );

  assert.strictEqual(toolResults.length, 1);
  assert.strictEqual(toolResults[0].ok, false);
  assert.strictEqual(toolResults[0].toolName, 'web.unknown');
});

test('web.searchBrave errors clearly when API key is missing', async () => {
  const original = process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  try {
    const tools = loadTools({
      async fetchImpl() {
        throw new Error('fetch should not run without an API key');
      }
    });
    await assert.rejects(
      () => tools.get('web.searchBrave').invoke({ query: 'spilli', count: 2 }),
      /BRAVE_SEARCH_API_KEY is required/
    );
  } finally {
    if (original === undefined) {
      delete process.env.BRAVE_SEARCH_API_KEY;
    } else {
      process.env.BRAVE_SEARCH_API_KEY = original;
    }
  }
});

test('web.searchBrave normalizes mocked Brave response', async () => {
  const tools = loadTools({
    braveSearchApiKey: 'test-key',
    async fetchImpl(url, options) {
      assert.ok(url.startsWith('https://api.search.brave.com/res/v1/web/search?'));
      assert.strictEqual(options.headers['X-Subscription-Token'], 'test-key');
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            web: {
              results: [
                {
                  title: '  Example Result  ',
                  url: 'https://example.com/',
                  description: '  First result.  ',
                  age: '2 days ago'
                }
              ]
            }
          };
        }
      };
    }
  });

  const result = JSON.parse(await tools.get('web.searchBrave').invoke({ query: 'example', count: 50 }));
  assert.strictEqual(result.query, 'example');
  assert.strictEqual(result.source, 'brave');
  assert.deepStrictEqual(result.results, [
    {
      title: 'Example Result',
      url: 'https://example.com/',
      description: 'First result.',
      age: '2 days ago'
    }
  ]);
});

test('web.searchDuckDuckGo normalizes mocked HTML response without API key', async () => {
  const tools = loadTools({
    async fetchImpl(url, options) {
      assert.ok(url.startsWith('https://html.duckduckgo.com/html/?'));
      assert.ok(url.includes('q=example'));
      assert.ok(options.headers['User-Agent'].includes('SpilliWebResearchAgent'));
      return {
        ok: true,
        status: 200,
        async text() {
          return `
            <div class="result results_links">
              <h2 class="result__title">
                <a class="result__a" href="/l/?kh=-1&amp;uddg=https%3A%2F%2Fexample.com%2Fdocs%3Fx%3D1%26y%3D2"> Example &amp; Docs </a>
              </h2>
              <a class="result__snippet">Useful &lt;b&gt;example&lt;/b&gt; documentation.</a>
            </div>
          `;
        }
      };
    }
  });

  const result = JSON.parse(await tools.get('web.searchDuckDuckGo').invoke({ query: 'example', count: 3 }));
  assert.strictEqual(result.query, 'example');
  assert.strictEqual(result.source, 'duckduckgo-html');
  assert.deepStrictEqual(result.results, [
    {
      title: 'Example & Docs',
      url: 'https://example.com/docs?x=1&y=2',
      description: 'Useful example documentation.'
    }
  ]);
});

test('web.scrapePages rejects invalid and private URLs', async () => {
  const tools = loadTools({
    async browserFactory() {
      throw new Error('browser should not launch for rejected URLs');
    }
  });

  await assert.rejects(
    () => tools.get('web.scrapePages').invoke({ urls: ['file:///tmp/test.html'] }),
    /Only http and https are allowed/
  );
  await assert.rejects(
    () => tools.get('web.scrapePages').invoke({ urls: ['http://localhost:3000'] }),
    /private or localhost/
  );
  await assert.rejects(
    () => tools.get('web.scrapePages').invoke({ urls: ['http://192.168.1.20'] }),
    /private or localhost/
  );
});

test('web.scrapePages supports injected fake browser without network or Chromium', async () => {
  const closed = [];
  const fakePage = {
    async goto(url) {
      assert.strictEqual(url, 'https://example.com/');
    },
    async waitForLoadState() {},
    async evaluate() {
      return {
        title: 'Example Domain',
        description: 'An example page',
        headings: [{ level: 'h1', text: 'Example Domain' }],
        links: [{ text: 'More', href: 'https://example.com/more' }],
        text: 'Example Domain\nThis domain is for examples.'
      };
    },
    url() {
      return 'https://example.com/';
    },
    async close() {
      closed.push('page');
    }
  };
  const fakeBrowser = {
    async newPage(options) {
      assert.ok(options.userAgent.includes('SpilliWebResearchAgent'));
      return fakePage;
    },
    async close() {
      closed.push('browser');
    }
  };

  const tools = loadTools({
    async browserFactory() {
      return fakeBrowser;
    }
  });

  const result = JSON.parse(await tools.get('web.scrapePages').invoke({
    urls: ['https://example.com'],
    maxCharsPerPage: 1000
  }));

  assert.deepStrictEqual(closed, ['page', 'browser']);
  assert.strictEqual(result.pages.length, 1);
  assert.strictEqual(result.pages[0].ok, true);
  assert.strictEqual(result.pages[0].title, 'Example Domain');
  assert.strictEqual(result.pages[0].rendered, true);
  assert.ok(result.pages[0].text.includes('examples'));
});
