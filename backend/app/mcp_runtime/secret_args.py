"""Legacy configurations may embed credentials in argv. Keep them write-only too."""

import re
from urllib.parse import parse_qsl, urlsplit

KEY = re.compile(r"token|password|secret|api[-_]?key|authorization", re.I)
TOKEN = re.compile(
    r"(?:ATATT[A-Za-z0-9_-]{15,}|gh[pousr]_[A-Za-z0-9_]{15,}|github_pat_[A-Za-z0-9_]{15,}|sk-[A-Za-z0-9_-]{15,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"
)


def secret_indexes(args):
    result = set()
    for i, arg in enumerate(args):
        if TOKEN.search(arg) or ("=" in arg and KEY.search(arg.split("=", 1)[0])):
            result.add(i)
        if i and KEY.search(args[i - 1]) and args[i - 1].startswith("-") and "=" not in args[i - 1]:
            result.add(i)
        if "://" in arg:
            try:
                u = urlsplit(arg)
                if u.password or any(KEY.search(k) for k, _ in parse_qsl(u.query)):
                    result.add(i)
            except ValueError:
                pass
    return result


def values(args):
    for i in secret_indexes(args):
        value = args[i]
        yield value
        if "=" in value:
            yield value.split("=", 1)[1]
