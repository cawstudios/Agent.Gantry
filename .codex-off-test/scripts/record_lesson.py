#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SEVERITIES = {"low", "medium", "high"}
REQUIRED_FIELDS = {"topic", "lesson", "source", "addedAt", "appliesTo", "severity"}


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
    parser = argparse.ArgumentParser(description="Append an architecture lesson to .codex/lessons.jsonl.")
    parser.add_argument("--topic", required=True, help="Short topic, such as permission safety.")
    parser.add_argument("--lesson", required=True, help="Lesson text to record.")
    parser.add_argument("--source", required=True, help="Source file, review, issue, or command that produced the lesson.")
    parser.add_argument("--added-at", default=None, help="ISO-8601 UTC timestamp. Defaults to now.")
    parser.add_argument("--applies-to", action="append", default=[], help="Path glob or keyword. Repeat for multiple values.")
    parser.add_argument("--severity", required=True, choices=sorted(SEVERITIES))
    parser.add_argument("--lessons", type=Path, default=None, help="Override lessons JSONL path.")
    return parser.parse_args()


def validate_lesson(value: Any, line_label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{line_label}: lesson record must be a JSON object")

    missing = sorted(REQUIRED_FIELDS - set(value))
    if missing:
        raise ValueError(f"{line_label}: missing required fields: {', '.join(missing)}")

    for key in ("topic", "lesson", "source", "addedAt", "severity"):
        if not isinstance(value.get(key), str) or not value[key].strip():
            raise ValueError(f"{line_label}: {key} must be a non-empty string")

    if value["severity"] not in SEVERITIES:
        raise ValueError(f"{line_label}: severity must be one of: {', '.join(sorted(SEVERITIES))}")

    applies_to = value.get("appliesTo")
    if (
        not isinstance(applies_to, list)
        or not applies_to
        or any(not isinstance(item, str) or not item.strip() for item in applies_to)
    ):
        raise ValueError(f"{line_label}: appliesTo must be a non-empty list of strings")

    return value


def load_lessons(path: Path) -> list[dict[str, Any]]:
    lessons: list[dict[str, Any]] = []
    if not path.exists():
        return lessons

    for index, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"line {index}: invalid JSON: {exc.msg}") from exc
        lessons.append(validate_lesson(payload, f"line {index}"))
    return lessons


def main() -> int:
    args = parse_args()
    path = (args.lessons or default_lessons_path()).resolve()
    record = {
        "topic": args.topic.strip(),
        "lesson": args.lesson.strip(),
        "source": args.source.strip(),
        "addedAt": (
            args.added_at
            or datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        ).strip(),
        "appliesTo": [item.strip() for item in args.applies_to if item.strip()],
        "severity": args.severity.strip(),
    }

    try:
        validate_lesson(record, "new lesson")
        existing = load_lessons(path)
        lesson_text = record["lesson"].strip()
        if any(item["lesson"].strip() == lesson_text for item in existing):
            raise ValueError("duplicate lesson text; existing lessons already contain this exact lesson")
    except ValueError as exc:
        print(f"record_lesson.py: {exc}", file=sys.stderr)
        return 2

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, separators=(",", ":")) + "\n")
    print(f"Recorded lesson in {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
