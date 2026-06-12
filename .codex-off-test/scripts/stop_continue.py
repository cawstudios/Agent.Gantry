#!/usr/bin/env python3
from __future__ import annotations

import json

# PR readiness is enforced by validate_work.py and pr_ready.py. The stop hook
# stays non-disruptive so normal Codex turns are not blocked by artifact state.
print(json.dumps({"continue": True}))
