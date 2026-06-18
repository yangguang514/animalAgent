import { fetchWithTimeout } from "../utils/fetchWithTimeout.js";

export const WEB_SEARCH_TOOL = "web_search";

const DEFAULT_TAVILY_DOMAINS = [
  "iucnredlist.org",
  "animaldiversity.org",
  "itis.gov",
  "gbif.org",
  "eol.org",
  "nationalgeographic.com",
  "britannica.com",
  "smithsonianmag.com",
  "worldwildlife.org"
];

function parseBooleanEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function parseListEnv(name, fallback = []) {
  const value = process.env[name];
  if (!value) return fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// Tavily 的 search_depth 有固定取值，这里做一次白名单校验。
function parseSearchDepth() {
  const value = (process.env.TAVILY_SEARCH_DEPTH || "advanced").trim().toLowerCase();
  return ["basic", "advanced", "fast", "ultra-fast"].includes(value) ? value : "advanced";
}

// Tavily topic 只支持少量类型，避免把错误环境变量直接传给搜索 API。
function parseTopic() {
  const value = (process.env.TAVILY_TOPIC || "general").trim().toLowerCase();
  return ["general", "news", "finance"].includes(value) ? value : "general";
}

// Tavily include_answer 支持布尔值，也支持 basic/advanced 字符串模式。
function parseIncludeAnswer() {
  const value = (process.env.TAVILY_INCLUDE_ANSWER || "false").trim().toLowerCase();
  if (["basic", "advanced"].includes(value)) return value;
  return /^(1|true|yes|on)$/i.test(value);
}

// Tavily include_raw_content 支持布尔值，也支持 markdown/text 格式。
function parseRawContent() {
  const value = (process.env.TAVILY_INCLUDE_RAW_CONTENT || "false").trim().toLowerCase();
  if (["markdown", "text"].includes(value)) return value;
  return /^(1|true|yes|on)$/i.test(value);
}

// 根据环境变量组装 Tavily 请求体，集中处理高级检索参数。
function buildTavilyPayload(query, config) {
  const searchDepth = parseSearchDepth();
  const topic = parseTopic();
  const payload = {
    query,
    max_results: config.maxResults,
    search_depth: searchDepth,
    topic,
    include_answer: parseIncludeAnswer(),
    include_raw_content: parseRawContent(),
    include_images: parseBooleanEnv("TAVILY_INCLUDE_IMAGES", true),
    include_image_descriptions: parseBooleanEnv("TAVILY_INCLUDE_IMAGE_DESCRIPTIONS", true),
    include_favicon: true,
    include_usage: true
  };

  if (searchDepth === "advanced") {
    payload.chunks_per_source = Math.max(1, Math.min(Number(process.env.TAVILY_CHUNKS_PER_SOURCE || 3), 3));
  }

  if (parseBooleanEnv("TAVILY_AUTO_PARAMETERS", false)) {
    payload.auto_parameters = true;
  }

  const includeDomains = parseListEnv(
    "TAVILY_INCLUDE_DOMAINS",
    parseBooleanEnv("TAVILY_USE_TRUSTED_DOMAINS", false) ? DEFAULT_TAVILY_DOMAINS : []
  );
  const excludeDomains = parseListEnv("TAVILY_EXCLUDE_DOMAINS");
  if (includeDomains.length) payload.include_domains = includeDomains;
  if (excludeDomains.length) payload.exclude_domains = excludeDomains;

  const timeRange = (process.env.TAVILY_TIME_RANGE || "").trim();
  const country = (process.env.TAVILY_COUNTRY || "").trim();
  if (timeRange) payload.time_range = timeRange;
  if (country && topic === "general") payload.country = country;

  return payload;
}

async function searchWithTavily(query, config) {
  // config.signal 由 HTTP 请求入口一路透传，浏览器断开时终止正在进行的外部检索。
  const response = await fetchWithTimeout(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.key}` },
      signal: config.signal,
      body: JSON.stringify(buildTavilyPayload(query, config))
    },
    config.timeoutMs
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `Tavily search failed: HTTP ${response.status}`);
  return {
    results: Array.isArray(data.results) ? data.results : [],
    images: Array.isArray(data.images) ? data.images : []
  };
}

async function searchWithSerper(query, config) {
  const searchResponse = await fetchWithTimeout(
    "https://google.serper.dev/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": config.key },
      signal: config.signal,
      body: JSON.stringify({ q: query, num: config.maxResults })
    },
    config.timeoutMs
  );
  const data = await searchResponse.json().catch(() => ({}));
  if (!searchResponse.ok) throw new Error(data?.message || `Serper search failed: HTTP ${searchResponse.status}`);

  let images = [];
  try {
    const imageResponse = await fetchWithTimeout(
      "https://google.serper.dev/images",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": config.key },
        signal: config.signal,
        body: JSON.stringify({ q: query, num: Math.max(3, Math.min(config.maxImages || 4, 10)) })
      },
      config.timeoutMs
    );
    const imageData = await imageResponse.json().catch(() => ({}));
    if (imageResponse.ok && Array.isArray(imageData.images)) images = imageData.images;
  } catch {
    images = [];
  }

  return {
    results: Array.isArray(data.organic) ? data.organic : [],
    images
  };
}

async function searchWithBrave(query, config) {
  const params = new URLSearchParams({ q: query, count: String(config.maxResults) });
  const searchResponse = await fetchWithTimeout(
    `https://api.search.brave.com/res/v1/web/search?${params}`,
    { headers: { Accept: "application/json", "X-Subscription-Token": config.key }, signal: config.signal },
    config.timeoutMs
  );
  const data = await searchResponse.json().catch(() => ({}));
  if (!searchResponse.ok) throw new Error(data?.message || `Brave search failed: HTTP ${searchResponse.status}`);

  let images = [];
  try {
    const imageParams = new URLSearchParams({ q: query, count: String(Math.max(3, Math.min(config.maxImages || 4, 10))) });
    const imageResponse = await fetchWithTimeout(
      `https://api.search.brave.com/res/v1/images/search?${imageParams}`,
      { headers: { Accept: "application/json", "X-Subscription-Token": config.key }, signal: config.signal },
      config.timeoutMs
    );
    const imageData = await imageResponse.json().catch(() => ({}));
    if (imageResponse.ok && Array.isArray(imageData?.results)) images = imageData.results;
  } catch {
    images = [];
  }

  return {
    results: Array.isArray(data?.web?.results) ? data.web.results : [],
    images
  };
}

async function runProviderSearch(query, config) {
  if (config.provider === "tavily") return searchWithTavily(query, config);
  if (config.provider === "serper") return searchWithSerper(query, config);
  if (config.provider === "brave") return searchWithBrave(query, config);
  throw new Error(`Unsupported SEARCH_PROVIDER: ${config.provider}`);
}

export const webSearchTool = {
  name: WEB_SEARCH_TOOL,
  description: "Search the web through the configured provider and return raw provider results.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" }
    }
  },
  async execute(input, context) {
    const query = String(input?.query || "").trim();
    const config = context.searchConfig;
    if (!query) throw new Error("web_search requires a non-empty query.");
    if (!config) throw new Error("web_search requires searchConfig in context.");

    const searchResult = await runProviderSearch(query, config);
    const results = Array.isArray(searchResult) ? searchResult : searchResult?.results;
    const images = Array.isArray(searchResult?.images) ? searchResult.images : [];
    return {
      provider: config.provider,
      query,
      results: Array.isArray(results) ? results : [],
      images
    };
  }
};
