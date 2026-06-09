'use strict';

const DEFAULT_MAX_ITERATIONS = 6;
const AGENT_ID = 'spilli-web-scraper';
const ALLOWED_TOOL_NAMES = new Set(['web.searchBrave', 'web.searchDuckDuckGo', 'web.scrapePages']);

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function makeCallId(iteration, index) {
  return `web-scraper-${iteration}-${index}-${Date.now().toString(36)}`;
}

function extractJsonObjects(text) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start < 0) {
      if (char === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function localFallbackParseToolCalls(raw) {
  const calls = [];
  const text = typeof raw === 'string' ? raw : '';

  for (const objectText of extractJsonObjects(text)) {
    try {
      const parsed = JSON.parse(objectText);
      const candidates = Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [parsed];
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object' || typeof candidate.toolName !== 'string') {
          continue;
        }
        calls.push({
          toolName: candidate.toolName,
          callId: typeof candidate.callId === 'string' ? candidate.callId : makeCallId(0, calls.length + 1),
          args: asRecord(candidate.args)
        });
      }
    } catch {
      // Ignore malformed JSON fragments. The shared extension parser is preferred.
    }
  }

  return calls;
}

async function parseToolCalls(context, modelRun, model) {
  if (context && typeof context.parseToolCalls === 'function') {
    try {
      return await context.parseToolCalls({
        raw: modelRun.raw,
        content: modelRun.content,
        model
      });
    } catch {
      return localFallbackParseToolCalls(modelRun.raw);
    }
  }
  return localFallbackParseToolCalls(modelRun.raw);
}

function hasUrl(text) {
  return /\bhttps?:\/\/[^\s<>)"']+/i.test(text || '');
}

function summarizeRecentMessages(request) {
  const recent = Array.isArray(request.recentMessages) ? request.recentMessages.slice(-6) : [];
  if (!recent.length && !request.conversationSummary) {
    return '';
  }

  const lines = [];
  if (request.conversationSummary) {
    lines.push(`Conversation summary: ${request.conversationSummary}`);
  }
  for (const message of recent) {
    if (!message || typeof message.content !== 'string') {
      continue;
    }
    const role = typeof message.role === 'string' ? message.role : 'message';
    lines.push(`${role}: ${message.content.slice(0, 1000)}`);
  }

  return lines.join('\n');
}

function buildSystemPrompt(request) {
  const host = request.hostEnvironment || {};
  const hasBraveKey = Boolean(process.env.BRAVE_SEARCH_API_KEY && process.env.BRAVE_SEARCH_API_KEY.trim());
  return [
    'You are the Web Scraper Research Agent for the Spilli VS Code extension.',
    '',
    'Your job is to research topics and answer user requests using current web evidence.',
    '',
    'Available local tools:',
    '- web.searchBrave: search the web with Brave Search. Use this first when a Brave API key is configured.',
    '- web.searchDuckDuckGo: keyless fallback search using DuckDuckGo HTML results. Use this when Brave is unavailable, missing a key, or fails.',
    '- web.scrapePages: render and scrape one or more HTTP(S) pages with Playwright Chromium. Use this for user-provided URLs and for promising search results.',
    '',
    'Tool-call JSON shape:',
    '{"toolName":"web.searchBrave","callId":"call1","args":{"query":"topic","count":8}}',
    '{"toolName":"web.searchDuckDuckGo","callId":"call1b","args":{"query":"topic","count":8}}',
    '{"toolName":"web.scrapePages","callId":"call2","args":{"urls":["https://example.com"],"maxCharsPerPage":12000}}',
    '',
    'Research policy:',
    '- If the user provides one or more URLs, scrape those URLs directly before answering.',
    '- If the user asks to research a topic, search first, then scrape the most relevant trustworthy results.',
    `- Brave API key configured: ${hasBraveKey ? 'yes' : 'no'}. ${hasBraveKey ? 'Prefer web.searchBrave for search.' : 'Use web.searchDuckDuckGo for search unless the user specifically wants Brave.'}`,
    '- Prefer primary sources, official documentation, standards, and reputable publications.',
    '- Use multiple sources when the question needs corroboration or is time-sensitive.',
    '- Clearly mention pages that failed to load when those failures affect confidence.',
    '- Final answers must cite the URLs used. Include concise source titles or domains when useful.',
    '- Do not invent facts that are not supported by tool results.',
    '- Respect paywalls, login walls, CAPTCHAs, robots/terms signals, and user privacy.',
    '',
    'Tool discipline:',
    '- Only request web.* tools.',
    '- Keep search result counts and scrape page counts modest unless the user asks for broad coverage.',
    '- After enough evidence is gathered, produce a final answer instead of continuing to browse.',
    '',
    `Host platform: ${host.platform || 'unknown'}`,
    `Preferred shell: ${host.preferredShell || 'unknown'}`
  ].join('\n');
}

function buildUserQuery(request, toolResults) {
  const context = summarizeRecentMessages(request);
  const hints = [];
  if (hasUrl(request.query)) {
    hints.push('The user included URL(s); scrape them before answering.');
  } else {
    const searchTool = process.env.BRAVE_SEARCH_API_KEY && process.env.BRAVE_SEARCH_API_KEY.trim()
      ? 'web.searchBrave'
      : 'web.searchDuckDuckGo';
    hints.push(`The user did not include an obvious URL; use ${searchTool} to find relevant pages before scraping.`);
  }

  const parts = [];
  if (context) {
    parts.push('Conversation context:', context);
  }
  parts.push('User request:', request.query || '');
  parts.push('Agent hint:', hints.join(' '));

  if (toolResults.length) {
    parts.push('Tool results so far:', safeJson(toolResults));
    parts.push('Use these results to decide the next web.* tool call or produce the final cited answer.');
  }

  return parts.join('\n\n');
}

function normalizeResult(modelRun, runtime) {
  return {
    raw: typeof modelRun.raw === 'string' ? modelRun.raw : '',
    content: typeof modelRun.content === 'string' ? modelRun.content : String(modelRun.raw || ''),
    isHarmony: modelRun.isHarmony === true,
    runtime
  };
}

function getIterationLimit(request) {
  const settings = request.iterationSettings || {};
  if (settings.ignoreMaxIterations === true) {
    return Number.POSITIVE_INFINITY;
  }

  const configured = Number(settings.maxIterations);
  if (Number.isInteger(configured) && configured > 0) {
    return configured;
  }

  return DEFAULT_MAX_ITERATIONS;
}

async function executeAllowedTool(context, call) {
  if (!ALLOWED_TOOL_NAMES.has(call.toolName)) {
    return {
      callId: call.callId,
      toolName: call.toolName,
      ok: false,
      error: `Unsupported tool "${call.toolName}". This agent only executes web.searchBrave, web.searchDuckDuckGo, and web.scrapePages.`
    };
  }

  return context.executeToolCall(call);
}

function createAgentRuntime(context) {
  if (!context || typeof context.runModel !== 'function' || typeof context.executeToolCall !== 'function') {
    throw new Error('Spilli runtime context must provide runModel() and executeToolCall().');
  }

  async function runTurn(request, hooks = {}) {
    const maxIterations = getIterationLimit(request || {});
    const toolResults = [];
    let lastModelRun = { raw: '', content: '', isHarmony: false };

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      hooks.onStatus?.({
        phase: 'planning',
        message: toolResults.length ? 'Reviewing web results.' : 'Planning web research.',
        iteration
      });

      const prompt = buildSystemPrompt(request || {});
      const query = buildUserQuery(request || {}, toolResults);

      if (typeof hooks.onModelRequest === 'function') {
        hooks.onModelRequest({ iteration, prompt, query });
      }

      hooks.onStatus?.({
        phase: 'model',
        message: 'Waiting for model response.',
        detail: 'Asking the selected model to choose the next research step.',
        iteration
      });

      lastModelRun = await context.runModel({
        prompt,
        query,
        model: request.model,
        scope: request.scope,
        team: request.team
      });

      if (typeof hooks.onModelResponse === 'function') {
        hooks.onModelResponse({
          iteration,
          raw: lastModelRun.raw,
          content: lastModelRun.content,
          isHarmony: lastModelRun.isHarmony === true
        });
      }

      hooks.onStatus?.({
        phase: 'working',
        message: 'Checking for web tool calls.',
        iteration
      });

      const parsedCalls = await parseToolCalls(context, lastModelRun, request.model);
      const toolCalls = Array.isArray(parsedCalls) ? parsedCalls : [];
      if (!toolCalls.length) {
        hooks.onStatus?.({
          phase: 'finalizing',
          message: 'Preparing final answer.',
          iteration
        });
        return normalizeResult(lastModelRun, { mode: 'external', agentId: AGENT_ID });
      }

      for (let index = 0; index < toolCalls.length; index += 1) {
        const call = {
          toolName: String(toolCalls[index].toolName || ''),
          callId: toolCalls[index].callId || makeCallId(iteration, index + 1),
          args: asRecord(toolCalls[index].args)
        };

        if (typeof hooks.onToolCall === 'function') {
          hooks.onToolCall(call);
        }

        hooks.onStatus?.({
          phase: 'tool',
          message: ALLOWED_TOOL_NAMES.has(call.toolName) ? 'Running web tool.' : 'Rejecting unsupported tool.',
          iteration,
          toolName: call.toolName,
          progress: toolCalls.length > 0 ? index / toolCalls.length : undefined
        });

        const result = await executeAllowedTool(context, call);
        toolResults.push(result);

        if (typeof hooks.onToolResult === 'function') {
          hooks.onToolResult(result);
        }

        hooks.onStatus?.({
          phase: 'working',
          message: 'Tool result received.',
          iteration,
          toolName: call.toolName,
          progress: toolCalls.length > 0 ? (index + 1) / toolCalls.length : undefined
        });
      }
    }

    return normalizeResult(
      {
        raw: lastModelRun.raw,
        content: [
          lastModelRun.content || lastModelRun.raw,
          '',
          'Reached the configured iteration boundary and returned control to the extension. Continue if you want the agent to research another cycle.'
        ].join('\n').trim(),
        isHarmony: lastModelRun.isHarmony === true
      },
      { mode: 'external', agentId: AGENT_ID }
    );
  }

  return { runTurn };
}

module.exports = {
  createAgentRuntime,
  _private: {
    buildSystemPrompt,
    buildUserQuery,
    executeAllowedTool,
    getIterationLimit,
    localFallbackParseToolCalls
  }
};
