"""
spam_server.py
==============
Local FastAPI server that classifies email text as SPAM or LEGITIMATE
using the fine-tuned BERT model:
    https://huggingface.co/SGHOSH1999/bert-email-spam-classifier_tuned

Usage:
    python spam_server.py          # starts on http://127.0.0.1:5001

Endpoints:
    GET  /health           → { "status": "ok", "model_loaded": true }
    POST /classify         → { "label": "SPAM"|"LEGITIMATE", "score": 0.97 }
    POST /classify_batch   → [{ "id": "…", "label": "…", "score": 0.97 }, …]
"""

import logging
import sys
from contextlib import asynccontextmanager
from typing import Optional

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    pipeline,
)

# ── Config ────────────────────────────────────────────────────────────────────

PORT       = 5001
HOST       = "127.0.0.1"
MODEL_ID   = "SGHOSH1999/bert-email-spam-classifier_tuned"
MAX_LENGTH = 512   # BERT token cap
BATCH_SIZE = 16    # Reduce if you hit OOM on CPU

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger(__name__)

# ── Global classifier (loaded once at startup) ────────────────────────────────

classifier = None


def normalise_label(raw: str) -> str:
    """
    Map the model's raw output label to 'SPAM' or 'LEGITIMATE'.

    The HuggingFace model may use:
        LABEL_1 / LABEL_0   — generic HF convention (1 = spam)
        spam    / ham        — classic email convention
        SPAM    / LEGITIMATE — explicit labels
    """
    r = raw.strip().upper()
    if r in ("SPAM", "LABEL_1"):
        return "SPAM"
    if r in ("HAM", "LEGITIMATE", "LABEL_0"):
        return "LEGITIMATE"
    # Fallback: treat unknown labels as legitimate to avoid false positives
    log.warning("Unknown label from model: %r — defaulting to LEGITIMATE", raw)
    return "LEGITIMATE"


# ── Lifespan (replaces deprecated @app.on_event) ─────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load the model at startup; nothing to clean up on shutdown."""
    global classifier

    log.info("Loading model: %s", MODEL_ID)
    device     = 0 if torch.cuda.is_available() else -1
    device_str = "GPU (CUDA)" if device == 0 else "CPU"
    log.info("Inference device: %s", device_str)

    try:
        tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
        model     = AutoModelForSequenceClassification.from_pretrained(MODEL_ID)
        classifier = pipeline(
            "text-classification",
            model=model,
            tokenizer=tokenizer,
            device=device,
            truncation=True,
            max_length=MAX_LENGTH,
            batch_size=BATCH_SIZE,
        )
        log.info("Model ready ✓")
    except Exception as exc:
        log.error("Failed to load model: %s", exc)
        raise RuntimeError(f"Model load failed: {exc}") from exc

    yield  # Server runs here


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Gmail Spam Classifier",
    description="Local BERT-based spam classifier for the Gmail Declutterer extension.",
    version="1.0.0",
    lifespan=lifespan,
)

# Allow requests from Chrome extensions and local dev tools
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"chrome-extension://.*|http://127\.0\.0\.1.*|http://localhost.*",
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


# ── Pydantic models ───────────────────────────────────────────────────────────

class ClassifyRequest(BaseModel):
    text: str = Field(..., description="Email subject + body text to classify")


class ClassifyResponse(BaseModel):
    label: str  = Field(..., description="'SPAM' or 'LEGITIMATE'")
    score: float = Field(..., description="Confidence score 0–1")


class BatchItem(BaseModel):
    id:   str = Field(..., description="Caller-supplied message ID (passed through)")
    text: str = Field(..., description="Email text to classify")


class BatchResultItem(BaseModel):
    id:    str
    label: str
    score: float


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health", response_model=dict, tags=["Meta"])
async def health():
    """Quick liveness check — the extension polls this before classifying."""
    return {"status": "ok", "model_loaded": classifier is not None}


@app.post("/classify", response_model=ClassifyResponse, tags=["Classification"])
async def classify(req: ClassifyRequest):
    """Classify a single email text snippet."""
    if classifier is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    if not req.text.strip():
        raise HTTPException(status_code=422, detail="text must not be empty")

    result = classifier(req.text)[0]
    return ClassifyResponse(
        label=normalise_label(result["label"]),
        score=round(float(result["score"]), 4),
    )


@app.post("/classify_batch", response_model=list[BatchResultItem], tags=["Classification"])
async def classify_batch(items: list[BatchItem]):
    """
    Classify a batch of emails in one call.
    Accepts up to 500 items; each item must have an 'id' and 'text'.
    """
    if classifier is None:
        raise HTTPException(status_code=503, detail="Model not loaded yet")

    if not items:
        return []

    if len(items) > 500:
        raise HTTPException(status_code=422, detail="Maximum 500 items per batch")

    texts = [item.text for item in items]

    # Run inference — the pipeline handles internal batching via batch_size
    raw_results = classifier(texts)

    return [
        BatchResultItem(
            id=item.id,
            label=normalise_label(res["label"]),
            score=round(float(res["score"]), 4),
        )
        for item, res in zip(items, raw_results)
    ]


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    log.info("Starting Gmail Spam Classifier on http://%s:%d", HOST, PORT)
    uvicorn.run(
        "spam_server:app",
        host=HOST,
        port=PORT,
        log_level="info",
        reload=False,
    )