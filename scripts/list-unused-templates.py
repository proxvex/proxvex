#!/usr/bin/env python3
"""List JSON templates not referenced by any JSON template/enum reference.

Scans json/**/templates/*.json and looks for references via keys:
- template
- templateFile
- enumValuesTemplate

Outputs full paths of unused templates.
"""
from __future__ import annotations

import glob
import json
import os
from typing import Any

ROOT = "/Users/volkmar/proxvex"


def walk(obj: Any, refs: set[str]) -> None:
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key in ("template", "templateFile", "enumValuesTemplate") and isinstance(value, str):
                refs.add(value)
            walk(value, refs)
    elif isinstance(obj, list):
        for value in obj:
            walk(value, refs)


def main() -> None:
    template_files = set(glob.glob(f"{ROOT}/json/**/templates/*.json", recursive=True))
    refs: set[str] = set()

    for path in glob.glob(f"{ROOT}/json/**/*.json", recursive=True):
        try:
            with open(path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except Exception:
            continue
        walk(data, refs)

    ref_names = {os.path.basename(ref) for ref in refs}
    unused = sorted(path for path in template_files if os.path.basename(path) not in ref_names)

    print(f"TEMPLATES_TOTAL {len(template_files)}")
    print(f"TEMPLATES_UNUSED {len(unused)}")
    for path in unused:
        print(path)


if __name__ == "__main__":
    main()
