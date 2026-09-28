import robotsParser from 'robots-parser';
import { fetchPage } from './http.js';

export const CRAWLER_UA = 'SiteAuditStudio';
export const AI_CRAWLERS = ['GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'];

// A 200 response that is really an HTML page (a soft 404) does not count as a text file.
const looksLikeHtml = (text) => /^\s*<(!doctype|html|head|body)/i.test(text || '');

export function parseRobots(url, text) {
  const parser = robotsParser(url, text || '');
  return {
    parser,
    sitemaps: parser.getSitemaps(),
    isAllowed: (target, ua = CRAWLER_UA) => parser.isAllowed(target, ua) !== false,
  };
}

export async function loadRobots(origin) {
  const url = `${origin}/robots.txt`;
  const res = await fetchPage(url, { timeout: 10000, maxBytes: 512 * 1024 });
  const found = res.status === 200 && !looksLikeHtml(res.body);
  const text = found ? res.body : '';
  const { isAllowed, sitemaps } = parseRobots(url, text);
  const home = `${origin}/`;
  return {
    url,
    status: found ? 'found' : res.error ? 'error' : 'missing',
    httpStatus: res.status,
    error: res.error,
    sitemaps,
    isAllowed,
    blocksAll: found && !isAllowed(home, '*') && !isAllowed(home),
    blockedAiCrawlers: found ? AI_CRAWLERS.filter((ua) => !isAllowed(home, ua)) : [],
  };
}

export async function loadLlmsTxt(origin) {
  const res = await fetchPage(`${origin}/llms.txt`, { timeout: 8000, maxBytes: 256 * 1024 });
  return { found: res.status === 200 && !looksLikeHtml(res.body) && Boolean(res.body?.trim()), httpStatus: res.status };
}
