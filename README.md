# UB Help Desk — RAG FAQ Setup Guide

This guide walks you through setting up the AI-powered FAQ search
for the University of Botswana Student Help Desk.

---

## What You Need

- Python 3.10 or higher  (https://www.python.org/downloads/)
- An Anthropic API key   (https://console.anthropic.com)
- The UB Help Desk HTML files (already in this folder)

---

## Project Structure

Everything lives in one folder:

```
ub-helpdesk/
  ├── index.html                  ← Login page (start here)
  ├── student-dashboard.html
  ├── student-faq.html            ← RAG search is on this page
  ├── admin-faq.html              ← RAG search is on this page
  ├── ... (other HTML pages)
  ├── style.css
  ├── shared.js
  │
  ├── server.py                   ← FastAPI server (run this)
  ├── rag.py                      ← RAG pipeline (retrieve + generate)
  ├── ingest.py                   ← One-time setup script
  ├── faq_knowledge_base.json     ← All FAQ content
  ├── requirements.txt            ← Python dependencies
  ├── .env.example                ← Copy this to .env
  └── chroma_db/                  ← Created automatically by ingest.py
```

---

## Step-by-Step Setup

### Step 1 — Install Python dependencies

Open a terminal in the `ub-helpdesk/` folder and run:

```bash
pip install -r requirements.txt
```

This installs:
- **fastapi + uvicorn** — the web server
- **chromadb** — vector database (runs locally, no external service)
- **sentence-transformers** — free local embedding model (~90MB download on first run)
- **anthropic** — Claude API client
- **python-dotenv** — reads your .env file

---

### Step 2 — Set up your API key

Copy the example environment file:

```bash
cp .env.example .env
```

Open `.env` in a text editor and replace the placeholder with your real key:

```
ANTHROPIC_API_KEY=sk-ant-api03-...your-key-here...
```

Get your API key at: https://console.anthropic.com

---

### Step 3 — Ingest the FAQ knowledge base (run once)

This converts all FAQ entries into vector embeddings and stores them locally:

```bash
python ingest.py
```

You will see:

```
[1/4] Loading FAQ data...       Loaded 21 FAQ entries
[2/4] Loading embedding model: all-MiniLM-L6-v2
[3/4] Connecting to ChromaDB at: ./chroma_db
[4/4] Embedding and storing 21 FAQ entries...
      Successfully stored 21 entries
Ingestion complete!
```

A chroma_db/ folder will be created — this is your local vector database.

Re-run python ingest.py any time you update faq_knowledge_base.json.

---

### Step 4 — Start the server

```bash
python server.py
```

You should see:

```
============================================================
  UB Help Desk RAG Server
  Running at: http://0.0.0.0:8000
  API docs:   http://localhost:8000/docs
============================================================
```

Keep this terminal open while using the app.

---

### Step 5 — Open the frontend

Open student-faq.html or admin-faq.html directly in your browser.

The "Ask a Question" box at the top of each FAQ page will now be live.
Type any question in plain language and get an AI-powered answer.

The static accordion FAQs below the search box remain as a fallback.

---

## How RAG Works

```
Student types: "can I drop a course after week 3?"
        |
Embedding model converts query to a vector
        |
ChromaDB finds the 3 most similar FAQ entries
        |
Those 3 FAQs + original question sent to Claude
        |
Claude writes a natural, helpful answer
        |
Answer + source chips appear in the browser
```

---

## Testing the API

Visit http://localhost:8000/docs for the interactive Swagger UI.

Or test with curl:

```bash
curl -X POST http://localhost:8000/api/faq/search \
  -H "Content-Type: application/json" \
  -d '{"query": "Can I drop a course after week 3?", "audience": "student"}'
```

Expected response:

```json
{
  "answer": "Yes, you can drop a course after Week 2, but dropping after Week 4 results in a W grade on your transcript...",
  "sources": [
    {"id": "s002", "category": "Course Registration", "question": "Can I drop a course...", "score": 0.92}
  ],
  "query": "Can I drop a course after week 3?"
}
```

---

## Adding More FAQs

Open faq_knowledge_base.json and add entries following this structure:

```json
{
  "id": "s015",
  "category": "Your Category",
  "audience": "student",
  "question": "Your question here?",
  "answer": "Your full answer here."
}
```

Set audience to "student" or "admin" to control which role sees results.
Then re-run: python ingest.py

You can also add excerpts from the student handbook or policy documents
by breaking them into question/answer chunks in the same JSON file.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "Could not connect to RAG server" | Make sure python server.py is running |
| "Vector store not initialised" | Run python ingest.py first |
| Invalid API key error | Check your .env file has the correct key |
| Port 8000 already in use | Change PORT=8001 in .env and update RAG_API in the HTML files |
| Slow first response | Normal — embedding model loads into memory on first use |
| CORS error in browser | Open the HTML file from the same machine the server is running on |

---

## Cost Estimate

| Component | Cost |
|---|---|
| ChromaDB (runs locally) | Free |
| Sentence-transformers embedding model | Free |
| Claude API per search query | ~$0.003 with claude-sonnet-4 |

For a low-traffic university help desk, monthly API costs will be minimal.

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | /api/health | Health check |
| POST | /api/faq/search | RAG search — main endpoint |
| GET | /api/faq/list | List all FAQs (optional ?audience=student) |
