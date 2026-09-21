"""Persistent Jev-style /decide API over SemIf (Qwen3.5-4B, CPU).

Same request contract as the openjev and laya services:
POST /decide {"state": "...", "questions": [{"type": "noul"|"choice"|"score", "instructions": "...", "options"?: [...]}]}
Probabilities are SemIf's conditional option scores - uncalibrated as confidence, per upstream.
"""
import threading
import time

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

MODEL = "Qwen/Qwen3.5-4B"
REVISION = "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a"

app = FastAPI()
state_lock = threading.Lock()
model = tokenizer = metadata = None
load_seconds = None


def _load():
    global model, tokenizer, metadata, load_seconds
    t0 = time.time()
    from semif_phase1.core import load_causal_model

    m, tok, meta = load_causal_model(MODEL, REVISION)
    load_seconds = round(time.time() - t0, 1)
    model, tokenizer, metadata = m, tok, meta
    print(f"SemIf model loaded in {load_seconds}s")


threading.Thread(target=_load, daemon=True).start()


class Req(BaseModel):
    state: str
    questions: list


def to_row(q, idx):
    t = q.get("type")
    instructions = q["instructions"]
    if t == "noul":
        options = [
            {"id": "yes", "description": "Yes - the statement holds."},
            {"id": "no", "description": "No - the statement does not hold."},
        ]
        return {"id": f"q{idx}", "state": None, "question": instructions, "options": options}
    if t in ("choice", "score"):
        options = [{"id": str(o), "description": str(o)} for o in q["options"]]
        return {"id": f"q{idx}", "state": None, "question": instructions, "options": options}
    raise ValueError(f"unknown question type {t}")


@app.get("/healthz")
def healthz():
    return {"ok": True, "model_loaded": model is not None, "load_seconds": load_seconds,
            "model": f"SemIf direct mode on {MODEL} (bf16, CPU)"}


@app.post("/decide")
def decide(r: Req):
    if model is None:
        return JSONResponse({"error": "model still loading (~2 min after cold start)"}, status_code=503)
    from semif_phase1.direct import score

    t0 = time.time()
    answers = []
    for i, q in enumerate(r.questions):
        row = to_row(q, i)
        row["state"] = r.state
        with state_lock:
            res = score(model, tokenizer, row, metadata)
        probs = dict(zip(res["option_ids"], res["probabilities"]))
        t = q.get("type")
        if t == "noul":
            answers.append({"noul": probs["yes"]})
        elif t == "choice":
            best = max(probs, key=probs.get)
            answers.append({"choice": best, "probabilities": probs, "confidence": probs[best]})
        else:  # score: expected index over ordered options
            opts = [str(o) for o in q["options"]]
            expected = sum(idx * probs[o] for idx, o in enumerate(opts))
            answers.append({"score": expected, "probabilities": probs, "confidence": max(probs.values())})
    ms = round((time.time() - t0) * 1000, 1)
    return {"answers": answers, "latency_ms": ms,
            "probability_status": "conditional option score; uncalibrated as decision confidence"}
