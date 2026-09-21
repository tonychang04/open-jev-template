# Open-Jev Template: SemIf as a self-hosted decision API

This fork packages [SemIf](https://github.com/TheoLeeCJ/SemIf) (JevBench's #2 open
Jev-class model) as a deployable, CPU-only, Jev-style typed-decision API — plus a
bring-your-own-key gateway that fronts it together with TypeSafe's real Jev.

What's added on top of upstream:

| Piece | What it does |
| --- | --- |
| `src/semif_phase1/core.py` (patched) | CPU fallback when no CUDA GPU is exposed |
| `deploy/` | FastAPI `/decide` service (persistent model, noul/choice/score contract) + Dockerfile |
| `gateway/` | Node gateway: one `/api/decide` for Jev (caller's own key via `X-Gateway-Key`) and any self-hosted backends |
| `benchmarks-cpu/` | 8-item multi-hop reasoning suite + sample CPU results |

## Quickstart (no GPU anywhere)

```bash
docker build -f deploy/Dockerfile -t open-jev .
docker run -p 8080:8080 -v openjev-weights:/data open-jev
# first boot downloads ~9GB of Qwen3.5-4B weights into the volume

curl -X POST localhost:8080/decide -H "Content-Type: application/json" -d '{
  "state": "Policy: refunds within 30 days. Delivered 45 days ago. Defective items are exempt; this unit arrived cracked.",
  "questions": [{"type": "noul", "instructions": "Is the customer eligible for a refund?"}]
}'
# → {"answers":[{"noul":0.995}], "latency_ms":...}
```

Question types: `noul` (yes/no probability), `choice` (+`options`), `score`
(+ ordered `options`; returns the expected level index).

## Measured on a 4 vCPU / 8GB cloud container (no GPU)

- 1.8–4.6s per decision warm; ~1 min model load after a cold start; 8.5GB RSS
- 8/8 on `benchmarks-cpu/decisions-multihop.jsonl` (rule+exception reasoning
  cases where 400M-class encoder reproductions score 4–5/8); sample outputs in
  `benchmarks-cpu/results-cpu-sample.jsonl`
- Upstream's own caveat applies: probabilities are conditional option scores,
  uncalibrated as decision confidence

## The gateway (bring your own external API)

`gateway/` is a small Node service exposing one `POST /api/decide` that routes by
a `backend` field: `"jev"` calls TypeSafe's Jev through the Vercel AI Gateway —
with the **caller's own key** taken per-request from the `X-Gateway-Key` header
(never stored) or a server-side `AI_GATEWAY_API_KEY` fallback — while any name
listed in the `OPEN_BACKENDS` env (JSON map of name → URL) proxies to a
self-hosted `/decide` service like the one in `deploy/`.

```bash
cd gateway && npm install
OPEN_BACKENDS='{"semif":"http://localhost:8080/decide"}' node server.js
curl -X POST localhost:8090/api/decide -H "X-Gateway-Key: vck_..." \
  -d '{"state":"...","questions":[{"type":"noul","instructions":"..."}]}'
```

Upstream SemIf is MIT-licensed; this fork keeps the license and changes nothing
about the scoring method — same prompts, same single-forward-pass readout.
