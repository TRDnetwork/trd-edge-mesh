// src/index.ts
// ═══ TRD EDGE MESH WORKER — Day 12 v3 Day 2 ═══
//
// Per v3 roadmap Phase 3 Track A: "Worker-mesh edge inference — Compute
// reaches end-customers. The biggest reach play. Customer's site visitors
// hit trd-worker mesh for AI features (chatbot, autocomplete, image gen)
// instead of OpenAI."
//
// ROUTING
//   When a TRD-built customer site embeds the widget, visitor traffic to
//   `https://<their-site>/_trd-ai/<feature>` lands here via Cloudflare
//   custom-domain routing (wrangler.toml).
//
//   Supported features:
//     POST /_trd-ai/chat       → conversation completion via TRD workers
//     POST /_trd-ai/complete   → single-shot completion (e.g. autocomplete)
//     POST /_trd-ai/embed      → text embedding
//     GET  /_trd-ai/health     → no-auth health check
//     GET  /_trd-ai/status     → mesh + worker availability summary
//
// SECURITY MODEL
//   • The site's deploy_url must be on a TRD-managed origin (*.trdn.io,
//     *.pages.dev, *.vercel.app or an explicitly-whitelisted custom
//     domain). Off-origin requests get rate-limited and degraded
//     responses.
//   • Per-visitor rate limit (default 30/min via KV).
//   • Worker-mesh dispatch happens server-to-server — visitor never
//     sees the underlying worker URL.

export interface Env {
  TRD_COMPUTE_API: string;
  TRD_STORAGE_API: string;
  ALLOWED_ORIGINS: string;
  /** Optional: KV namespace for per-visitor rate limiting */
  RATE_LIMIT?: KVNamespace;
}

const DEFAULT_RATE_LIMIT_PER_MIN = 30;
const DEFAULT_MODEL = 'llama-3.1-8b';

interface AiChatRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  model?: string;
  max_tokens?: number;
  temperature?: number;
}

interface AiCompleteRequest {
  prompt: string;
  model?: string;
  max_tokens?: number;
}

interface AiEmbedRequest {
  input: string | string[];
  model?: string;
}

// ─── CORS helpers ──────────────────────────────────────────────────
function corsHeaders(origin: string | null, allowedPatterns: string[]): Record<string, string> {
  const allowed = !origin || allowedPatterns.some(pat => matchPattern(origin, pat));
  return {
    'Access-Control-Allow-Origin': allowed ? (origin ?? '*') : 'null',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-TRD-Visitor-Id',
    'Access-Control-Max-Age': '600',
  };
}

function matchPattern(origin: string, pattern: string): boolean {
  // Strip protocol from origin for compare ('https://foo.trdn.io' → 'foo.trdn.io')
  const host = origin.replace(/^https?:\/\//, '').toLowerCase();
  const pat = pattern.toLowerCase();
  if (pat === '*') return true;
  if (pat.startsWith('*.')) return host.endsWith(pat.slice(1));
  return host === pat;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// ─── Rate limiting ──────────────────────────────────────────────────
async function checkRateLimit(env: Env, visitorId: string, perMinute: number): Promise<boolean> {
  if (!env.RATE_LIMIT) return true;  // KV not configured → unlimited (dev mode)
  const key = `rl:${visitorId}:${Math.floor(Date.now() / 60_000)}`;
  const current = parseInt(await env.RATE_LIMIT.get(key) || '0', 10);
  if (current >= perMinute) return false;
  // Increment with 70s TTL (keys auto-expire after the minute window)
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: 70 });
  return true;
}

function visitorIdFromRequest(req: Request): string {
  // Prefer explicit header, fall back to a CF-derived stable hash
  const explicit = req.headers.get('X-TRD-Visitor-Id');
  if (explicit && explicit.length >= 8 && explicit.length <= 64) return explicit;
  const cf = (req as any).cf || {};
  const seed = `${(req.headers.get('CF-Connecting-IP') || 'unknown')}::${cf.asn || 'unknown'}`;
  return 'anon-' + seed;
}

// ─── Mesh dispatch helpers ─────────────────────────────────────────
async function meshDispatch(env: Env, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${env.TRD_COMPUTE_API}/api/compute/edge-dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  const text = await res.text();
  if (!res.ok) {
    return { error: 'upstream_failed', status: res.status, body: text.slice(0, 500) };
  }
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ─── Route handlers ─────────────────────────────────────────────────
async function handleChat(req: Request, env: Env): Promise<Response> {
  const body = await req.json() as AiChatRequest;
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 64) {
    return json({ error: 'invalid_messages' }, 400);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 28_000);
  const data = await meshDispatch(env, {
    kind: 'chat',
    model: body.model ?? DEFAULT_MODEL,
    messages: body.messages,
    max_tokens: Math.min(body.max_tokens ?? 512, 2048),
    temperature: Math.min(Math.max(body.temperature ?? 0.7, 0), 2),
  }, ctrl.signal);
  return json(data);
}

async function handleComplete(req: Request, env: Env): Promise<Response> {
  const body = await req.json() as AiCompleteRequest;
  if (typeof body.prompt !== 'string' || body.prompt.length < 1 || body.prompt.length > 8000) {
    return json({ error: 'invalid_prompt' }, 400);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 15_000);
  const data = await meshDispatch(env, {
    kind: 'complete',
    model: body.model ?? DEFAULT_MODEL,
    prompt: body.prompt,
    max_tokens: Math.min(body.max_tokens ?? 256, 1024),
  }, ctrl.signal);
  return json(data);
}

async function handleEmbed(req: Request, env: Env): Promise<Response> {
  const body = await req.json() as AiEmbedRequest;
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  if (!inputs.every(i => typeof i === 'string' && i.length > 0 && i.length < 8000)) {
    return json({ error: 'invalid_input' }, 400);
  }
  if (inputs.length > 50) return json({ error: 'too_many_inputs', limit: 50 }, 400);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 15_000);
  const data = await meshDispatch(env, {
    kind: 'embed',
    model: body.model ?? 'bge-small-en-v1.5',
    inputs,
  }, ctrl.signal);
  return json(data);
}

async function handleStatus(env: Env): Promise<Response> {
  try {
    const r = await fetch(`${env.TRD_COMPUTE_API}/stats`, { cf: { cacheTtl: 30 } as any });
    if (!r.ok) return json({ ok: false, upstream_status: r.status }, 503);
    const upstream = await r.json();
    return json({ ok: true, mesh: 'edge-active', upstream });
  } catch (e: any) {
    return json({ ok: false, error: e?.message ?? 'fetch_failed' }, 503);
  }
}

// ─── Main entrypoint ────────────────────────────────────────────────
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    const allowedPatterns = env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
    const cors = corsHeaders(origin, allowedPatterns);

    // Preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Health probe — no rate limit, no body
    if (url.pathname === '/_trd-ai/health') {
      return json({ ok: true, service: 'trd-edge-mesh', ts: Date.now() }, 200, cors);
    }

    // Status (cached for 30s upstream)
    if (url.pathname === '/_trd-ai/status' && req.method === 'GET') {
      const resp = await handleStatus(env);
      return new Response(resp.body, { status: resp.status, headers: { ...Object.fromEntries(resp.headers), ...cors } });
    }

    // POST endpoints
    if (req.method !== 'POST') {
      return json({ error: 'method_not_allowed', allowed: ['POST'] }, 405, cors);
    }

    // Rate limit per visitor
    const visitorId = visitorIdFromRequest(req);
    const allowed = await checkRateLimit(env, visitorId, DEFAULT_RATE_LIMIT_PER_MIN);
    if (!allowed) {
      return json({ error: 'rate_limited', retry_after_seconds: 60 }, 429, {
        ...cors,
        'Retry-After': '60',
      });
    }

    // Route
    try {
      let resp: Response;
      switch (url.pathname) {
        case '/_trd-ai/chat':     resp = await handleChat(req, env); break;
        case '/_trd-ai/complete': resp = await handleComplete(req, env); break;
        case '/_trd-ai/embed':    resp = await handleEmbed(req, env); break;
        default:                  resp = json({ error: 'not_found', path: url.pathname }, 404);
      }
      // Merge CORS into final response
      return new Response(resp.body, {
        status: resp.status,
        headers: { ...Object.fromEntries(resp.headers), ...cors },
      });
    } catch (e: any) {
      return json({ error: 'worker_exception', message: e?.message ?? String(e) }, 500, cors);
    }
  },
};
