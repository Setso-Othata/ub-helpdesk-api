"""
server.py — FastAPI REST API for the UB Help Desk RAG system

Endpoints:
    POST /api/faq/search   — Main RAG query endpoint
    GET  /api/faq/list     — Return all FAQs (for static fallback)
    GET  /api/health       — Health check

Run with:
    python server.py
Or directly with uvicorn:
    uvicorn server:app --host 0.0.0.0 --port 8000 --reload
"""

import json
import os
from pathlib import Path

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from rag import rag_query

load_dotenv()

# ── App setup ─────────────────────────────────────────────
app = FastAPI(
    title="UB Help Desk RAG API",
    description="Retrieval-Augmented Generation API for the University of Botswana Student Help Desk FAQ system",
    version="1.0.0"
)

# Allow requests from your HTML files (opened locally or hosted)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],      # In production, replace with your actual domain
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

FAQ_DATA_PATH = Path(__file__).parent / "faq_knowledge_base.json"


# ── Request / Response models ─────────────────────────────

class SearchRequest(BaseModel):
    query:    str  = Field(..., min_length=3, max_length=500, description="The user's question")
    audience: str  = Field("student", description="'student' or 'admin'")

    class Config:
        json_schema_extra = {
            "example": {
                "query":    "Can I drop a course after week 2?",
                "audience": "student"
            }
        }


class SourceItem(BaseModel):
    id:       str
    category: str
    question: str
    score:    float


class SearchResponse(BaseModel):
    answer:  str
    sources: list[SourceItem]
    query:   str


# ── Endpoints ─────────────────────────────────────────────

@app.get("/api/health")
def health_check():
    """Simple health check — confirms the server is running."""
    return {"status": "ok", "service": "UB Help Desk RAG API"}


@app.post("/api/faq/search", response_model=SearchResponse)
def search_faq(request: SearchRequest):
    """
    Main RAG endpoint.

    1. Embeds the query using sentence-transformers
    2. Retrieves the top matching FAQs from ChromaDB
    3. Sends the context + query to Claude
    4. Returns Claude's answer + source FAQs
    """
    if request.audience not in ("student", "admin"):
        raise HTTPException(
            status_code=400,
            detail="audience must be 'student' or 'admin'"
        )

    try:
        result = rag_query(
            query=request.query.strip(),
            audience=request.audience
        )
        return result

    except FileNotFoundError:
        raise HTTPException(
            status_code=503,
            detail=(
                "Vector store not initialised. "
                "Please run: python ingest.py — then restart the server."
            )
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/faq/list")
def list_faqs(audience: str = None):
    """
    Return all FAQs from the knowledge base.
    Optionally filter by audience: ?audience=student or ?audience=admin
    Used by the frontend as a static fallback if the RAG search fails.
    """
    try:
        with open(FAQ_DATA_PATH, "r", encoding="utf-8") as f:
            faqs = json.load(f)

        if audience in ("student", "admin"):
            faqs = [faq for faq in faqs if faq["audience"] == audience]

        return {"faqs": faqs, "count": len(faqs)}

    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="FAQ data file not found")


# ── Entry point ───────────────────────────────────────────

if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))

    print(f"\n{'=' * 60}")
    print("  UB Help Desk RAG Server")
    print(f"  Running at: http://{host}:{port}")
    print(f"  API docs:   http://localhost:{port}/docs")
    print(f"{'=' * 60}\n")

    uvicorn.run("server:app", host=host, port=port, reload=True)
