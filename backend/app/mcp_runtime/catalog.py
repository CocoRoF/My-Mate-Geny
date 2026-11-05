"""Reviewed recipes, not arbitrary executable downloads. No network work on listing.

Sources verified 2026-11-05. Package versions resolve only after Download is clicked.
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlsplit


def text(ko, en):
    return {"ko": ko, "en": en}


def field(key, ko, en, kind="text", *, required=False, default="", choices=None):
    return {
        "key": key,
        "label": text(ko, en),
        "kind": kind,
        "required": required,
        "default": default,
        "choices": choices or [],
    }


def choice(value, ko, en):
    return {"value": value, "label": text(ko, en)}


RECIPES = {
    "atlassian": {
        "name": "Atlassian · Jira / Confluence",
        "publisher": "sooperset",
        "official": False,
        "category": "work",
        "kind": "python",
        "package": "mcp-atlassian",
        "entry": "mcp-atlassian",
        "source": "https://github.com/sooperset/mcp-atlassian",
        "docs": "https://github.com/sooperset/mcp-atlassian/blob/main/docs/installation.mdx",
        "method": "python -m pip install mcp-atlassian",
        "summary": text(
            "Jira·Confluence Cloud와 Server/Data Center를 연결해요. Docker 없이 앱 전용 환경에 설치해요.",
            "Connect Jira and Confluence Cloud or Server/Data Center in an app-owned environment, without Docker.",
        ),
        "help": text(
            "Cloud는 사이트 주소·계정 이메일·API 토큰, Server/Data Center는 주소·개인 액세스 토큰이 필요해요. 필요한 서비스만 선택하세요.",
            "Cloud needs a site URL, account email and API token; Server/Data Center needs its URL and a personal access token. Choose the services you use.",
        ),
        "fields": [
            field(
                "service",
                "연결할 서비스",
                "Services",
                "select",
                default="jira",
                choices=[
                    choice("jira", "Jira", "Jira"),
                    choice("confluence", "Confluence", "Confluence"),
                    choice("both", "둘 다", "Both"),
                ],
            ),
            field(
                "deployment",
                "Atlassian 종류",
                "Atlassian deployment",
                "select",
                default="cloud",
                choices=[
                    choice("cloud", "Cloud", "Cloud"),
                    choice("server", "Server / Data Center", "Server / Data Center"),
                ],
            ),
            field("jira_url", "Jira 사이트 주소", "Jira site URL", "url"),
            field("jira_email", "Jira 계정 이메일 · Cloud", "Jira email · Cloud", "email"),
            field(
                "jira_token",
                "Jira API 토큰 또는 개인 토큰",
                "Jira API token or personal token",
                "password",
            ),
            field(
                "confluence_url",
                "Confluence 사이트 주소 · /wiki 포함",
                "Confluence site URL · include /wiki",
                "url",
            ),
            field(
                "confluence_email",
                "Confluence 계정 이메일 · Cloud",
                "Confluence email · Cloud",
                "email",
            ),
            field(
                "confluence_token",
                "Confluence API 토큰 또는 개인 토큰",
                "Confluence API token or personal token",
                "password",
            ),
            field("read_only", "읽기 전용으로 연결", "Connect read-only", "boolean", default=True),
        ],
    },
}


def recipe(rid):
    if rid not in RECIPES:
        raise KeyError("mcp_recipe_not_found")
    return {"id": rid, "verified_at": "2026-11-05", **RECIPES[rid]}


def definition(rid, values, *, name="", data_dir: Path):
    r = recipe(rid)
    if not isinstance(values, dict) or set(values) - {f["key"] for f in r["fields"]}:
        raise ValueError("invalid_catalog_fields")
    v = {f["key"]: values.get(f["key"], f["default"]) for f in r["fields"]}
    for f in r["fields"]:
        x = v[f["key"]]
        if f["kind"] == "boolean":
            if not isinstance(x, bool):
                raise ValueError("invalid_field:" + f["key"])
        elif not isinstance(x, str) or len(x) > 16000 or "\0" in x:
            raise ValueError("invalid_field:" + f["key"])
        elif f["choices"] and x not in {c["value"] for c in f["choices"]}:
            raise ValueError("invalid_field:" + f["key"])
        if f["required"] and not x:
            raise ValueError("required_field:" + f["key"])
    spec = {
        "name": name.strip() or r["name"],
        "catalog_id": rid,
        "transport": "http" if r["kind"] == "remote" else "stdio",
        "command": "geny-managed" if r["kind"] != "remote" else "",
        "args": [],
        "env": {},
        "headers": {},
        "enabled": True,
    }
    for service in ("jira", "confluence"):
        if v["service"] not in (service, "both"):
            continue
        prefix = service.upper()
        url, token = v[service + "_url"].strip(), v[service + "_token"]
        if urlsplit(url).scheme not in ("https", "http") or not urlsplit(url).hostname:
            raise ValueError("required_field:" + service + "_url")
        if not token:
            raise ValueError("required_field:" + service + "_token")
        spec["env"][prefix + "_URL"] = url
        if v["deployment"] == "cloud":
            if not v[service + "_email"]:
                raise ValueError("required_field:" + service + "_email")
            spec["env"].update(
                {prefix + "_USERNAME": v[service + "_email"], prefix + "_API_TOKEN": token}
            )
        else:
            spec["env"][prefix + "_PERSONAL_TOKEN"] = token
    spec["env"]["READ_ONLY_MODE"] = str(v["read_only"]).lower()
    return spec
