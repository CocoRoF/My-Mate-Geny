"""Reviewed recipes, not arbitrary executable downloads. No network work on listing.

Sources verified 2026-11-05. Package versions resolve only after Download is clicked.
"""

from __future__ import annotations

import base64
from pathlib import Path


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
        "publisher": "Atlassian",
        "official": True,
        "category": "work",
        "kind": "remote",
        "url": "https://mcp.atlassian.com/v2/mcp",
        "source": "https://github.com/atlassian/atlassian-mcp-server",
        "docs": "https://support.atlassian.com/atlassian-ai-gateway/docs/configure-authentication-via-api-token/",
        "method": "https://mcp.atlassian.com/v2/mcp",
        "summary": text(
            "Atlassian 공식 서버로 Jira·Confluence Cloud를 연결해요. 글 작성·수정, 이슈 생성·변경까지 할 수 있고 다운로드는 필요 없어요.",
            "Connect Jira and Confluence Cloud through Atlassian's official server: read, publish and edit pages, create and change issues. No download.",
        ),
        "help": text(
            "계정 이메일과 API 토큰을 입력하세요. 조직 관리자가 API 토큰 인증을 막아 두었다면 연결되지 않아요. Server/Data Center는 직접 설정을 사용하세요.",
            "Enter your account email and API token. If your organization disabled API-token authentication, it won't connect. For Server/Data Center, use manual setup.",
        ),
        "fields": [
            field(
                "auth",
                "인증 방식",
                "Authentication",
                "select",
                default="basic",
                choices=[
                    choice("basic", "이메일 + 개인 API 토큰", "Email + personal API token"),
                    choice("bearer", "서비스 계정 API 키", "Service account API key"),
                ],
            ),
            field("email", "계정 이메일", "Account email", "email"),
            field(
                "token",
                "API 토큰 또는 서비스 계정 키",
                "API token or service account key",
                "password",
                required=True,
            ),
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
        "transport": "http",
        "command": "",
        "args": [],
        "env": {},
        "url": r["url"],
        "enabled": True,
    }
    auth = "Bearer " + v["token"]
    if v["auth"] == "basic":
        if not v["email"] or ":" in v["email"] or "@" not in v["email"]:
            raise ValueError("required_field:email")
        auth = "Basic " + base64.b64encode((v["email"] + ":" + v["token"]).encode()).decode()
    spec["headers"] = {"Authorization": auth}
    return spec
