// @ts-check
// The one place build mode talks to Claude. Every call asks for structured output (a JSON schema the API enforces), streams so a
// long brief never hits a request timeout, and opts into the server-side refusal fallback. Tests pass their own `client`.
// Credentials: ANTHROPIC_API_KEY (server/.env) or any source the SDK resolves; none = a 503 that says so, never a crash.

export const BUILD_MODEL = (process.env.SAS_BUILD_MODEL ?? '').trim() || 'claude-sonnet-5-5';
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class LlmError extends Error {
  /** @param {string} message @param {number} status @param {string} code */
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** @type {Promise<any> | null} */
let sdk = null;
export const loadSdk = () => (sdk ??= import('@anthropic-ai/sdk').then((m) => m.default));

/**
 * Turns an SDK error into one the API can answer with: what went wrong, in words, and whether retrying can help.
 * @param {any} err
 * @param {any} Anthropic  the SDK's default export (error classes)
 */
export function explainError(err, Anthropic) {
  if (err instanceof LlmError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new LlmError('Claude rejected the credentials. Check ANTHROPIC_API_KEY in server/.env.', 503, 'llm-unavailable');
  }
  if (err instanceof Anthropic.RateLimitError) return new LlmError('Claude is rate limiting this key. Try again in a minute.', 429, 'llm-rate-limited');
  if (err instanceof Anthropic.APIConnectionError) return new LlmError('Could not reach the Claude API.', 503, 'llm-unreachable');
  if (err instanceof Anthropic.APIError) return new LlmError(`Claude API error ${err.status}: ${err.message}`, 502, 'llm-error');
  if (err instanceof Anthropic.AnthropicError) {
    // Raised before any request, e.g. no credentials anywhere.
    return new LlmError(`Claude is not set up on this server (${err.message.replace(/\.$/, '')}). Put ANTHROPIC_API_KEY in server/.env.`, 503, 'llm-unavailable');
  }
  return err;
}

/**
 * @typedef {{ system: string, user: string, schema: object, effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max', maxTokens?: number }} StructuredCall
 * @typedef {{ data: any, model: string, usage: any }} StructuredResult
 * @typedef {{ structured: (call: StructuredCall) => Promise<StructuredResult>, model: string }} Llm
 */

/**
 * @param {{ client?: any, model?: string }} [o]  client: an Anthropic client (tests pass a fake with the same shape)
 * @returns {Llm}
 */
export function createLlm({ client, model = BUILD_MODEL } = {}) {
  /** @type {any} */
  let instance = client ?? null;
  return {
    model,
    async structured({ system, user, schema, effort, maxTokens = 32000 }) {
      const Anthropic = await loadSdk();
      let message;
      try {
        instance ??= new Anthropic();
        message = await instance.beta.messages.stream({
          model,
          max_tokens: maxTokens,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          output_config: { effort, format: { type: 'json_schema', schema } },
          system,
          messages: [{ role: 'user', content: user }],
        }).finalMessage();
      } catch (err) {
        throw explainError(err, Anthropic);
      }
      if (message.stop_reason === 'refusal') {
        throw new LlmError(`Claude declined this request${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}.`, 422, 'llm-refused');
      }
      if (message.stop_reason === 'max_tokens') throw new LlmError('The answer was longer than allowed; try a shorter request.', 502, 'llm-too-long');
      const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      try {
        return { data: JSON.parse(text), model: message.model, usage: message.usage };
      } catch {
        throw new LlmError('Claude answered in an unexpected format.', 502, 'llm-bad-output');
      }
    },
  };
}
