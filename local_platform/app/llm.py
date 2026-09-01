"""Project AI: canvas JSON + source messages, then LLM (OpenAI / Anthropic / Ollama)."""
from __future__ import annotations

import json
import os
from typing import Iterator

import httpx

OPENAI_KEY = os.getenv("OPENAI_API_KEY", "").strip()
ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.2")


def build_prompt(canvas: dict, sources: list[dict], question: str) -> tuple[str, str]:
    system = (
        "You are an assistant for a small internal team using a WhatsApp strategy canvas. "
        "You only use the strategy board JSON and the source WhatsApp messages provided. "
        "Nodes, edges, and frames describe how the team grouped and connected evidence. "
        "Do not invent files or chats that are not in the context. "
        "Be concrete and practical."
    )
    user = (
        f"Strategy board JSON:\n{json.dumps(canvas, ensure_ascii=False)[:12000]}\n\n"
        f"Source WhatsApp items currently on the board:\n{json.dumps(sources, ensure_ascii=False)[:12000]}\n\n"
        f"Team question: {question}"
    )
    return system, user


def local_fallback(canvas: dict, sources: list[dict], question: str) -> str:
    if not sources and not canvas.get("nodes"):
        return (
            "This project canvas is empty. Drag chats, links, docs, or reels from the library "
            "onto the board, then ask again.\n\n"
            "To enable a full LLM, set OPENAI_API_KEY, ANTHROPIC_API_KEY, or run Ollama locally."
        )
    lines = [
        "No cloud LLM key is configured, so here is a local reading of the board.",
        f"Nodes: {len(canvas.get('nodes') or [])}. Connections: {len(canvas.get('edges') or [])}. Frames: {len(canvas.get('frames') or [])}.",
        f"Question: {question}",
        "",
        "Items on the board:",
    ]
    for item in sources[:12]:
        snippet = (item.get("raw_text") or "")[:220]
        lines.append(f"- [{item.get('type')}] {item.get('sender')} - {snippet}")
    lines.append("")
    lines.append("Set OPENAI_API_KEY or ANTHROPIC_API_KEY, or start Ollama, for drafted replies and strategy synthesis.")
    return "\n".join(lines)


def complete(system: str, user: str, canvas: dict, sources: list[dict], question: str) -> str:
    if OPENAI_KEY:
        try:
            return _openai(system, user)
        except Exception as exc:
            return f"OpenAI error: {exc}\n\n" + local_fallback(canvas, sources, question)
    if ANTHROPIC_KEY:
        try:
            return _anthropic(system, user)
        except Exception as exc:
            return f"Anthropic error: {exc}\n\n" + local_fallback(canvas, sources, question)
    try:
        return _ollama(system, user)
    except Exception:
        return local_fallback(canvas, sources, question)


def _openai(system: str, user: str) -> str:
    with httpx.Client(timeout=90) as client:
        res = client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENAI_KEY}"},
            json={
                "model": os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "temperature": 0.3,
            },
        )
        res.raise_for_status()
        return res.json()["choices"][0]["message"]["content"]


def _anthropic(system: str, user: str) -> str:
    with httpx.Client(timeout=90) as client:
        res = client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": os.getenv("ANTHROPIC_MODEL", "claude-3-5-haiku-latest"),
                "max_tokens": 1200,
                "system": system,
                "messages": [{"role": "user", "content": user}],
            },
        )
        res.raise_for_status()
        parts = res.json().get("content") or []
        return "".join(part.get("text", "") for part in parts if part.get("type") == "text")


def _ollama(system: str, user: str) -> str:
    with httpx.Client(timeout=8) as client:
        res = client.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": OLLAMA_MODEL,
                "stream": False,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            },
        )
        res.raise_for_status()
        return res.json().get("message", {}).get("content") or ""
