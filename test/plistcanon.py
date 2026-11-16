"""Prints a plist as canonical JSON (sorted keys, data as hex, dates as ISO) for comparison.
A missing file prints {}, which is what a domain with every key deleted amounts to."""
import json
import plistlib
import sys
from datetime import datetime


def canon(v):
    if isinstance(v, dict):
        return {k: canon(v[k]) for k in sorted(v)}
    if isinstance(v, list):
        return [canon(x) for x in v]
    if isinstance(v, bytes):
        return {"data": v.hex()}
    if isinstance(v, datetime):
        return {"date": v.isoformat()}
    if isinstance(v, bool):
        return {"bool": v}
    if isinstance(v, float):
        return {"real": round(v, 6)}
    return v


try:
    with open(sys.argv[1], "rb") as f:
        print(json.dumps(canon(plistlib.load(f)), sort_keys=True))
except FileNotFoundError:
    print("{}")
