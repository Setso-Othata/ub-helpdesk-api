"""
ingest.py — Load FAQ knowledge base into ChromaDB

Run this ONCE before starting the server:
    python ingest.py

This script:
1. Reads faq_knowledge_base.json
2. Converts each FAQ into a vector embedding using sentence-transformers
3. Stores the vectors + text in ChromaDB for fast similarity search
"""

import json
import os
import sys
from pathlib import Path
from dotenv import load_dotenv
import chromadb
from chromadb.utils import embedding_functions

load_dotenv()

# ── Config ────────────────────────────────────────────────
CHROMA_PERSIST_PATH = os.getenv("CHROMA_PERSIST_PATH", "./chroma_db")
EMBEDDING_MODEL     = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
FAQ_DATA_PATH       = Path(__file__).parent / "faq_knowledge_base.json"
COLLECTION_NAME     = "ub_faq"


def load_faqs(path: Path) -> list[dict]:
    """Load FAQ entries from JSON file."""
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def build_document(faq: dict) -> str:
    """
    Combine question + answer into a single document string for embedding.
    Prefixing with the question improves retrieval accuracy.
    """
    return f"Question: {faq['question']}\nAnswer: {faq['answer']}"


def ingest():
    print("=" * 60)
    print("  UB Help Desk — FAQ Ingestion")
    print("=" * 60)

    # Load FAQs
    print(f"\n[1/4] Loading FAQ data from: {FAQ_DATA_PATH}")
    faqs = load_faqs(FAQ_DATA_PATH)
    print(f"      Loaded {len(faqs)} FAQ entries")

    # Set up embedding function (runs locally, no API key needed)
    print(f"\n[2/4] Loading embedding model: {EMBEDDING_MODEL}")
    print("      (This may take a moment on first run — model downloads automatically)")
    ef = embedding_functions.SentenceTransformerEmbeddingFunction(
        model_name=EMBEDDING_MODEL
    )

    # Connect to ChromaDB
    print(f"\n[3/4] Connecting to ChromaDB at: {CHROMA_PERSIST_PATH}")
    client = chromadb.PersistentClient(path=CHROMA_PERSIST_PATH)

    # Delete existing collection if it exists (for re-ingestion)
    try:
        client.delete_collection(COLLECTION_NAME)
        print(f"      Deleted existing '{COLLECTION_NAME}' collection")
    except Exception:
        pass

    # Create fresh collection
    collection = client.create_collection(
        name=COLLECTION_NAME,
        embedding_function=ef,
        metadata={"hnsw:space": "cosine"}  # cosine similarity for semantic search
    )

    # Build documents, IDs, and metadata
    print(f"\n[4/4] Embedding and storing {len(faqs)} FAQ entries...")

    documents = []
    ids       = []
    metadatas = []

    for faq in faqs:
        doc = build_document(faq)
        documents.append(doc)
        ids.append(faq["id"])
        metadatas.append({
            "id":       faq["id"],
            "category": faq["category"],
            "audience": faq["audience"],
            "question": faq["question"],
            "answer":   faq["answer"],
        })

    # Add to ChromaDB in one batch
    collection.add(
        documents=documents,
        ids=ids,
        metadatas=metadatas,
    )

    print(f"      Successfully stored {len(documents)} entries")
    print(f"\n{'=' * 60}")
    print("  Ingestion complete!")
    print(f"  Vector store saved to: {CHROMA_PERSIST_PATH}")
    print(f"  Collection: '{COLLECTION_NAME}'")
    print("=" * 60)
    print("\nYou can now start the server with:  python server.py\n")


if __name__ == "__main__":
    ingest()
