// trd-ai.js — TRD Edge Mesh customer-site widget · v0.1.0
// ═══════════════════════════════════════════════════════════════════
// Drop-in client for TRD-built customer sites to invoke AI features
// through the trd-edge-mesh worker. Routes visitor traffic to TRD's
// worker mesh instead of OpenAI/Anthropic — same shape, lower cost,
// signed receipts on every call.
//
// EMBED
//   <script src="https://trd-edge-mesh.ndusadftb.workers.dev/widget/trd-ai.js"></script>
//   <script>
//     TRD.chat({ messages: [{role:'user', content:'Hello'}] })
//       .then(r => console.log(r.choices[0].message.content));
//   </script>
//
// OPTIONAL — override endpoint before loading the script:
//   <script>window.TRD_ENDPOINT = 'https://custom.workers.dev';</script>
//
// API
//   TRD.chat({ messages, model?, max_tokens?, temperature? })
//   TRD.complete({ prompt, model?, max_tokens? })
//   TRD.embed({ input: string | string[], model? })
//   TRD.status()  → mesh + upstream health
//   TRD.health()  → no-auth probe
//   TRD.visitorId → stable visitor identifier (read-only)

(function () {
  if (typeof window === 'undefined') return;
  if (window.TRD) return; // idempotent

  var ENDPOINT_BASE = window.TRD_ENDPOINT || 'https://trd-edge-mesh.ndusadftb.workers.dev';

  function getOrMakeVisitorId() {
    try {
      var KEY = 'trd_vid';
      var v = window.localStorage.getItem(KEY);
      if (!v || v.length < 8) {
        v = 'v-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        window.localStorage.setItem(KEY, v);
      }
      return v;
    } catch (_) {
      return 'v-eph-' + Math.random().toString(36).slice(2, 12);
    }
  }
  var visitorId = getOrMakeVisitorId();

  function call(path, body) {
    return fetch(ENDPOINT_BASE + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TRD-Visitor-Id': visitorId
      },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.text().then(function (text) {
        var parsed;
        try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text }; }
        if (!res.ok) {
          var err = new Error((parsed && parsed.error) || ('http_' + res.status));
          err.status = res.status;
          err.body = parsed;
          throw err;
        }
        return parsed;
      });
    });
  }

  function getJson(path) {
    return fetch(ENDPOINT_BASE + path).then(function (r) { return r.json(); });
  }

  window.TRD = {
    visitorId: visitorId,
    endpoint: ENDPOINT_BASE,
    chat:     function (req) { return call('/_trd-ai/chat',     req); },
    complete: function (req) { return call('/_trd-ai/complete', req); },
    embed:    function (req) { return call('/_trd-ai/embed',    req); },
    status:   function ()    { return getJson('/_trd-ai/status'); },
    health:   function ()    { return getJson('/_trd-ai/health'); }
  };
})();
