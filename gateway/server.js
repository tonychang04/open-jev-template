'use strict';

// One decision endpoint, many backends:
//   POST /api/decide {state, questions:[{type:"noul"|"choice"|"score", instructions, options?}], backend?}
//   backend "jev"  -> TypeSafe Jev via Vercel AI Gateway. Caller key per request via
//                     X-Gateway-Key (or Authorization: Bearer vck_...), never stored;
//                     falls back to the AI_GATEWAY_API_KEY env.
//   other backends -> proxied to self-hosted /decide services from the OPEN_BACKENDS
//                     env, a JSON map like {"semif":"http://localhost:8080/decide"}.

const express = require('express');

const PORT = process.env.PORT || 8090;
const GATEWAY_MODEL = process.env.JEV_GATEWAY_MODEL || 'typesafe-ai/jev';
const OPEN_BACKENDS = JSON.parse(process.env.OPEN_BACKENDS || '{}');

const aiP = import('ai');
const evaluateP = aiP.then((m) => m.experimental_evaluate);
const createGatewayP = aiP.then((m) => m.createGateway);

const app = express();
app.use(express.json({ limit: '256kb' }));

function callerKey(req) {
  const h = req.headers['x-gateway-key'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  const m = (req.headers.authorization || '').match(/^Bearer\s+(vck_\S+)$/i);
  return m ? m[1] : null;
}

async function askJev(state, q, key) {
  const evaluate = await evaluateP;
  let model = GATEWAY_MODEL;
  if (key) model = (await createGatewayP)({ apiKey: key }).evaluationModel(GATEWAY_MODEL);
  const question = q.type === 'noul'
    ? { type: 'boolean', instructions: q.instructions, criteria: { true: 'yes', false: 'no' } }
    : { type: 'choice', instructions: q.instructions, criteria: Object.fromEntries(q.options.map((o) => [String(o), String(o)])) };
  const res = await evaluate({ model, state, questions: { q: question } });
  const a = res.answers?.q ?? res.q;
  if (q.type === 'noul') {
    let p = a.probabilities ? Number(a.probabilities.true ?? a.probabilities.yes) : NaN;
    if (!Number.isFinite(p) && typeof a.probability === 'number') p = a.answer === false ? 1 - a.probability : a.probability;
    return { noul: p };
  }
  const probs = a.probabilities || {};
  if (q.type === 'score') {
    const opts = q.options.map(String);
    return { score: opts.reduce((s, o, i) => s + i * (probs[o] ?? 0), 0), probabilities: probs, confidence: Math.max(...Object.values(probs)) };
  }
  return { choice: a.choice, probabilities: probs, confidence: Math.max(...Object.values(probs)) };
}

app.post('/api/decide', async (req, res) => {
  const backend = req.body.backend || 'jev';
  const state = typeof req.body.state === 'string' ? req.body.state.trim() : '';
  const questions = Array.isArray(req.body.questions) ? req.body.questions : [];
  if (!state || state.length > 30000) return res.status(400).json({ error: 'state must be 1-30,000 characters' });
  if (!questions.length || questions.length > 10) return res.status(400).json({ error: '1-10 questions per call' });

  try {
    if (OPEN_BACKENDS[backend]) {
      const r = await fetch(OPEN_BACKENDS[backend], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state, questions }),
        signal: AbortSignal.timeout(120_000),
      });
      return res.status(r.status).json({ backend, ...(await r.json()) });
    }
    if (backend !== 'jev') return res.status(400).json({ error: `unknown backend; use jev or one of: ${Object.keys(OPEN_BACKENDS).join(', ') || '(none configured)'}` });

    for (const q of questions) {
      if (q.type !== 'noul' && (!Array.isArray(q.options) || q.options.length < 2)) {
        return res.status(400).json({ error: 'choice/score questions need 2+ options' });
      }
    }
    const key = callerKey(req);
    const t0 = Date.now();
    const answers = [];
    for (const q of questions) answers.push(await askJev(state, q, key));
    res.json({ backend: 'jev', keySource: key ? 'caller' : 'server', answers, latency_ms: Date.now() - t0 });
  } catch (err) {
    const limited = /rate.?limit/i.test(String(err));
    res.status(limited ? 429 : 502).json({ error: limited ? 'Gateway rate limit - bring your own key via X-Gateway-Key.' : String(err).slice(0, 200) });
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true, serverKey: !!process.env.AI_GATEWAY_API_KEY, openBackends: Object.keys(OPEN_BACKENDS) }));

app.listen(PORT, () => console.log(`open-jev gateway on :${PORT} (backends: jev${Object.keys(OPEN_BACKENDS).map((b) => ', ' + b).join('')})`));
