"""
rag.py — Core RAG pipeline

Handles:
- Connecting to ChromaDB
- Retrieving the most relevant FAQ chunks for a query
- Sending context + query to Claude for answer generation
"""

import os
import anthropic
import chromadb
from chromadb.utils import embedding_functions
from dotenv import load_dotenv

load_dotenv()

# ── Config ────────────────────────────────────────────────
CHROMA_PERSIST_PATH = os.getenv("CHROMA_PERSIST_PATH", "./chroma_db")
EMBEDDING_MODEL     = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
CLAUDE_MODEL        = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-20250514")
TOP_K               = int(os.getenv("TOP_K_RESULTS", "3"))
COLLECTION_NAME     = "ub_faq"

# ── Lazy-loaded singletons ────────────────────────────────
_chroma_client     = None
_collection        = None
_embedding_fn      = None
_anthropic_client  = None


def get_embedding_fn():
    global _embedding_fn
    if _embedding_fn is None:
        _embedding_fn = embedding_functions.SentenceTransformerEmbeddingFunction(
            model_name=EMBEDDING_MODEL
        )
    return _embedding_fn


def get_collection():
    global _chroma_client, _collection
    if _collection is None:
        _chroma_client = chromadb.PersistentClient(path=CHROMA_PERSIST_PATH)
        _collection = _chroma_client.get_collection(
            name=COLLECTION_NAME,
            embedding_function=get_embedding_fn()
        )
    return _collection


def get_anthropic():
    global _anthropic_client
    if _anthropic_client is None:
        _anthropic_client = anthropic.Anthropic(
            api_key=os.getenv("ANTHROPIC_API_KEY")
        )
    return _anthropic_client


# ── Retrieval ─────────────────────────────────────────────

def retrieve(query: str, audience: str = None, top_k: int = TOP_K) -> list[dict]:
    """
    Find the top_k most semantically similar FAQ entries to the query.

    Args:
        query:    The user's question
        audience: 'student' or 'admin' — filters results to the right role
        top_k:    Number of results to return

    Returns:
        List of matching FAQ metadata dicts with a 'score' field added
    """
    collection = get_collection()

    # Build optional where filter for audience
    where = {"audience": audience} if audience in ("student", "admin") else None

    results = collection.query(
        query_texts=[query],
        n_results=top_k,
        where=where,
        include=["metadatas", "distances"]
    )

    hits = []
    metadatas = results["metadatas"][0]
    distances = results["distances"][0]

    for meta, dist in zip(metadatas, distances):
        # Convert cosine distance to similarity score (0–1, higher = better)
        score = round(1 - dist, 4)
        hits.append({**meta, "score": score})

    return hits


# ── Generation ────────────────────────────────────────────

SYSTEM_PROMPT = """You are a helpful assistant for the University of Botswana Student Affairs Help Desk.
Your job is to answer student and staff questions clearly and accurately using only the FAQ information provided.

Guidelines:
- Answer in plain, professional English
- Be concise but complete — typically 2 to 4 sentences
- If the retrieved FAQs don't fully answer the question, say so and direct the user to contact Registry Services at registry@ub.bw or call +267 355 0000
- Never invent information that is not in the provided FAQs
- Do not mention that you are using FAQs or a knowledge base — just answer naturally
- If the question is completely unrelated to university help desk topics, politely say you can only help with academic requests"""


def generate_answer(query: str, retrieved_faqs: list[dict]) -> str:
    """
    Send the retrieved FAQ context + user query to Claude and return the answer.

    Args:
        query:          The user's original question
        retrieved_faqs: List of retrieved FAQ dicts from retrieve()

    Returns:
        Claude's generated answer string
    """
    if not retrieved_faqs:
        return (
            "I'm sorry, I couldn't find relevant information for your question. "
            "Please contact Registry Services directly at registry@ub.bw "
            "or call +267 355 0000 during office hours (Mon–Fri, 08:00–16:30)."
        )

    # Build context block from retrieved FAQs
    context_parts = []
    for i, faq in enumerate(retrieved_faqs, 1):
        context_parts.append(
            f"[FAQ {i}]\n"
            f"Category: {faq['category']}\n"
            f"Q: {faq['question']}\n"
            f"A: {faq['answer']}"
        )
    context = "\n\n".join(context_parts)

    user_message = (
        f"Using the FAQ information below, please answer the following question.\n\n"
        f"--- RETRIEVED FAQ CONTEXT ---\n{context}\n"
        f"--- END OF CONTEXT ---\n\n"
        f"Student's question: {query}"
    )

    client = get_anthropic()
    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=512,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_message}]
    )

    return response.content[0].text.strip()


# ── Main pipeline ─────────────────────────────────────────

def rag_query(query: str, audience: str = "student") -> dict:
    """
    Full RAG pipeline: retrieve relevant FAQs then generate an answer.

    Returns a dict with:
        answer:   Claude's generated answer
        sources:  List of retrieved FAQ entries that informed the answer
        query:    The original query (echoed back)
    """
    retrieved = retrieve(query, audience=audience)
    answer    = generate_answer(query, retrieved)

    # Return sources with non-sensitive fields only
    sources = [
        {
            "id":       r["id"],
            "category": r["category"],
            "question": r["question"],
            "score":    r["score"]
        }
        for r in retrieved
    ]

    return {
        "answer":  answer,
        "sources": sources,
        "query":   query
    }
