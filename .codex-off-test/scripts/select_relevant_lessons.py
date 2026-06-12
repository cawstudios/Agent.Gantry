#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fnmatch
import json
import re
import subprocess
from pathlib import Path
from typing import Any


def repo_root() -> Path:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
        )
        return Path(out.stdout.strip())
    except subprocess.CalledProcessError:
        return Path(__file__).resolve().parents[2]


def default_lessons_path() -> Path:
    return repo_root() / ".codex" / "lessons.jsonl"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Select relevant architecture lessons for a task.")
    parser.add_argument("--prompt", default="", help="Task prompt or summary.")
    parser.add_argument("--changed-file", action="append", default=[], help="Changed file path. Repeat as needed.")
    parser.add_argument("--limit", type=int, default=10, help="Maximum lessons to print.")
    parser.add_argument("--json", action="store_true", help="Print JSON instead of text.")
    parser.add_argument("--lessons", type=Path, default=None, help="Override lessons JSONL path.")
    return parser.parse_args()


def load_lessons(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []

    lessons: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            lessons.append(json.loads(line))
    return lessons


def words(value: str) -> list[str]:
    return [word for word in re.split(r"[^a-z0-9]+", value.lower()) if word]


def applies_to_matches(pattern: str, prompt: str, changed_files: list[str]) -> bool:
    candidate = pattern.lower().strip()
    if not candidate:
        return False

    prompt_lower = prompt.lower()
    changed_lower = [path.lower() for path in changed_files]
    has_glob = any(char in candidate for char in "*?[]")
    if has_glob:
        return any(fnmatch.fnmatch(path, candidate) for path in changed_lower)

    return candidate in prompt_lower or any(candidate in path for path in changed_lower)


def score_lesson(lesson: dict[str, Any], prompt: str, changed_files: list[str]) -> tuple[int, list[str]]:
    haystack = " ".join([prompt, *changed_files]).lower()
    score = 0
    reasons: list[str] = []

    topic = str(lesson.get("topic", "")).lower().strip()
    if topic and topic in haystack:
        score += 4
        reasons.append("topic phrase")
    else:
        matched_words = [word for word in words(topic) if len(word) > 2 and word in haystack]
        if matched_words:
            score += len(matched_words)
            reasons.append("topic terms")

    for pattern in lesson.get("appliesTo", []):
        if applies_to_matches(str(pattern), prompt, changed_files):
            score += 5
            reasons.append(f"appliesTo:{pattern}")

    return score, reasons


def main() -> int:
    args = parse_args()
    path = (args.lessons or default_lessons_path()).resolve()
    lessons = load_lessons(path)
    ranked = []
    for lesson in lessons:
        score, reasons = score_lesson(lesson, args.prompt, args.changed_file)
        if score > 0:
            ranked.append({"score": score, "reasons": reasons, **lesson})

    ranked.sort(key=lambda item: (-int(item["score"]), str(item.get("severity", "")), str(item.get("topic", ""))))
    selected = ranked[: max(args.limit, 0)]

    if args.json:
        print(json.dumps(selected, indent=2))
        return 0

    if not selected:
        print("No relevant lessons found.")
        return 0

    print("Relevant lessons:")
    for item in selected:
        print(f"- [{item.get('severity')}] {item.get('topic')}: {item.get('lesson')}")
        print(f"  source: {item.get('source')} (score {item.get('score')})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
