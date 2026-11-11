// @ts-check
// What build mode costs, in dollars, and the two limits on it: one build (BUILD_BUDGET.perBuildUsd, enforced by the agent loop
// after every turn) and one owner's day (perOwnerDayUsd: the plan's model steps, a repeat build's new design and every agent
// turn add to it; a new plan or build is refused once it is reached, and a running build stops when it gets there). Turn and
// token counts only stand in for cost: about half of a build is the history read again every turn (cache writes and reads,
// priced differently), half what it writes, so the dollar figure, worked out from each answer's `usage`, is what the limits
// watch. Old screenshots are not cleared from the history: they are cache reads at a tenth of the input price, and clearing
// them would make every later turn write the cache again, which costs more than it saves on a build of this length (14-turn
// run: output $0.39, cache writes $0.24, cache reads $0.13). The day is the UTC day; the record is data/buildmode/spend.json.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config/paths.js';
import { LlmError } from './llm.js';

export const SPEND_FILE = path.join(DATA_DIR, 'buildmode', 'spend.json');

/** Dollars per million tokens (Anthropic's API prices; a cache write is the 5-minute one, 1.25× input). */
export const PRICES = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};
/** A model the table does not know (SAS_BUILD_MODEL, or a refusal fallback) is priced as the dearest one: never under-counted. */
const UNKNOWN = Object.values(PRICES).reduce((a, b) => (b.output > a.output ? b : a));

const usd = (/** @type {string | undefined} */ v, /** @type {number} */ fallback) => {
  const n = Number(v);
  return v != null && v.trim() !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
};
export const BUILD_BUDGET = {
  perBuildUsd: usd(process.env.SAS_BUILD_MAX_USD, 3),
  perOwnerDayUsd: usd(process.env.SAS_BUILD_DAILY_USD, 10),
};

/** The price row of a model; dated or suffixed ids (`claude-sonnet-5-5-…`) take their base model's. */
export function priceOf(/** @type {string | undefined} */ model) {
  const id = String(model ?? '');
  const key = Object.keys(PRICES).find((k) => id === k || id.startsWith(`${k}-`));
  return key ? PRICES[/** @type {keyof typeof PRICES} */ (key)] : UNKNOWN;
}

/** Dollars of one answer's (or a summed) usage. */
export function costOf(/** @type {any} */ usage, /** @type {string | undefined} */ model) {
  if (!usage) return 0;
  const p = priceOf(model);
  return ((usage.input_tokens ?? 0) * p.input + (usage.output_tokens ?? 0) * p.output
    + (usage.cache_read_input_tokens ?? 0) * p.cacheRead + (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite) / 1e6;
}

/** Cents, rounded up: what the app shows and the record keeps. */
export const roundUsd = (/** @type {number} */ n) => Math.ceil(n * 100 - 1e-9) / 100;

const today = () => new Date().toISOString().slice(0, 10);
const keyOf = (/** @type {string | null | undefined} */ ownerId) => ownerId ?? 'local';

async function readSpend(file = SPEND_FILE) {
  const stored = await readFile(file, 'utf8').then(JSON.parse, () => null);
  return stored?.day === today() && stored.owners && typeof stored.owners === 'object' ? stored : { day: today(), owners: {} };
}

/** Dollars an owner (null: this server without accounts) has spent today. */
export async function spentToday(/** @type {string | null | undefined} */ ownerId, file = SPEND_FILE) {
  await writing.catch(() => {});
  return (await readSpend(file)).owners[keyOf(ownerId)] ?? 0;
}

/** Dollars an owner can still spend today (0 when the day's limit is reached). */
export async function leftToday(/** @type {string | null | undefined} */ ownerId, file = SPEND_FILE, limit = BUILD_BUDGET.perOwnerDayUsd) {
  return Math.max(0, limit - await spentToday(ownerId, file));
}

let writing = Promise.resolve();
/** Adds dollars to an owner's day; one write at a time, the file replaced whole. Only yesterday's record is ever dropped. */
export function recordSpend(/** @type {string | null | undefined} */ ownerId, /** @type {number} */ amount, file = SPEND_FILE) {
  if (!(amount > 0)) return writing;
  writing = writing.catch(() => {}).then(async () => {
    const spend = await readSpend(file);
    const key = keyOf(ownerId);
    spend.owners[key] = (spend.owners[key] ?? 0) + amount;
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(spend, null, 2));
    await rename(tmp, file);
  });
  return writing;
}

/** Refuses a plan or a build when the owner's day is used up (429, said in dollars). */
export async function checkDailyBudget(/** @type {string | null | undefined} */ ownerId, file = SPEND_FILE, limit = BUILD_BUDGET.perOwnerDayUsd) {
  if (await leftToday(ownerId, file, limit) > 0) return;
  throw new LlmError(`Today's build-mode budget ($${limit.toFixed(2)}) is used up. It starts again at midnight UTC.`, 429, 'daily-budget');
}
