"""Reviewed recipes, not arbitrary executable downloads. No network work on listing.

Sources verified 2026-11-05. Package versions resolve only after Download is clicked.
"""

from __future__ import annotations

import base64
import os
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
    "atlassian-cloud": {
        "name": "Atlassian Cloud · Official",
        "publisher": "Atlassian",
        "official": True,
        "category": "work",
        "kind": "remote",
        "url": "https://mcp.atlassian.com/v2/mcp",
        "source": "https://github.com/atlassian/atlassian-mcp-server",
        "docs": "https://support.atlassian.com/atlassian-ai-gateway/docs/configure-authentication-via-api-token/",
        "method": "https://mcp.atlassian.com/v2/mcp",
        "summary": text(
            "Atlassian이 운영하는 Jira·Confluence 등 Cloud 연결이에요. 다운로드가 필요 없어요.",
            "Atlassian-hosted access to Jira, Confluence and other Cloud products. No download required.",
        ),
        "help": text(
            "조직 관리자가 MCP의 API 토큰 인증을 허용해야 해요. 개인 토큰은 이메일과 함께, 서비스 계정 키는 Bearer 방식으로 연결해요. 대화형 OAuth는 직접 설정의 인증 헤더로 대체되지 않아요.",
            "Your organization must enable API token authentication. Use email plus a personal API token, or a service-account Bearer key. Interactive OAuth is a different authentication flow.",
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
            field(
                "email",
                "계정 이메일 · 개인 토큰 사용 시",
                "Account email · personal token",
                "email",
            ),
            field(
                "token",
                "API 토큰 또는 서비스 계정 키",
                "API token or service account key",
                "password",
                required=True,
            ),
        ],
    },
    "github": {
        "name": "GitHub",
        "publisher": "GitHub",
        "official": True,
        "category": "development",
        "kind": "remote",
        "url": "https://api.githubcopilot.com/mcp/",
        "source": "https://github.com/github/github-mcp-server",
        "docs": "https://github.com/github/github-mcp-server#remote-github-mcp-server",
        "method": "https://api.githubcopilot.com/mcp/",
        "summary": text(
            "저장소·이슈·PR을 GitHub 공식 원격 MCP로 연결해요.",
            "Access repositories, issues and pull requests through GitHub's hosted MCP.",
        ),
        "help": text(
            "사용할 저장소와 기능에 필요한 권한의 개인 액세스 토큰을 입력하세요.",
            "Enter a personal access token with the permissions needed for your repositories and tools.",
        ),
        "fields": [
            field(
                "token",
                "GitHub 개인 액세스 토큰",
                "GitHub personal access token",
                "password",
                required=True,
            )
        ],
    },
    "context7": {
        "name": "Context7",
        "publisher": "Upstash",
        "official": True,
        "category": "development",
        "kind": "remote",
        "url": "https://mcp.context7.com/mcp",
        "source": "https://github.com/upstash/context7",
        "docs": "https://context7.com/docs/resources/all-clients",
        "method": "https://mcp.context7.com/mcp",
        "summary": text(
            "라이브러리·프레임워크의 최신 문서와 코드 예제를 찾아요.",
            "Find current library and framework documentation and code examples.",
        ),
        "help": text(
            "Context7 대시보드에서 발급한 API 키를 입력하세요.",
            "Enter an API key from your Context7 dashboard.",
        ),
        "fields": [
            field("token", "Context7 API 키", "Context7 API key", "password", required=True)
        ],
    },
    "playwright": {
        "name": "Playwright",
        "publisher": "Microsoft",
        "official": True,
        "category": "development",
        "kind": "npm",
        "package": "@playwright/mcp",
        "entry": "playwright-mcp",
        "source": "https://github.com/microsoft/playwright-mcp",
        "docs": "https://github.com/microsoft/playwright-mcp#readme",
        "method": "npm install @playwright/mcp",
        "summary": text(
            "브라우저 자동화·접근성 트리·화면 확인 도구예요.",
            "Browser automation, accessibility snapshots and page inspection.",
        ),
        "help": text(
            "브라우저 실행 시 해당 운영체제의 브라우저와 시스템 라이브러리도 필요해요. 도구 연결 테스트는 브라우저 다운로드나 웹사이트 조작을 실행하지 않아요.",
            "Running a browser also requires a compatible browser and OS libraries. Connection testing does not download a browser or operate websites.",
        ),
        "fields": [
            field(
                "headless",
                "화면 없는 브라우저 사용",
                "Use a headless browser",
                "boolean",
                default=True,
            )
        ],
    },
    "filesystem": {
        "name": "Filesystem",
        "publisher": "Model Context Protocol",
        "official": True,
        "category": "files",
        "kind": "npm",
        "package": "@modelcontextprotocol/server-filesystem",
        "entry": "mcp-server-filesystem",
        "source": "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
        "docs": "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem#readme",
        "method": "npm install @modelcontextprotocol/server-filesystem",
        "summary": text(
            "직접 허용한 폴더의 파일을 읽고 수정하는 도구예요.",
            "Read and edit files only inside the folders you explicitly allow.",
        ),
        "help": text(
            "허용할 폴더의 절대 경로를 한 줄에 하나씩 입력하세요. 서버 모드에서는 서버의 폴더를 지정해요.",
            "Enter one allowed absolute folder path per line. In Server mode these are folders on the server.",
        ),
        "fields": [
            field(
                "folders",
                "허용할 폴더 · 한 줄에 하나",
                "Allowed folders · one per line",
                "multiline",
                required=True,
            )
        ],
    },
    "memory": {
        "name": "Memory",
        "publisher": "Model Context Protocol",
        "official": True,
        "category": "files",
        "kind": "npm",
        "package": "@modelcontextprotocol/server-memory",
        "entry": "mcp-server-memory",
        "source": "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
        "docs": "https://github.com/modelcontextprotocol/servers/tree/main/src/memory#readme",
        "method": "npm install @modelcontextprotocol/server-memory",
        "summary": text(
            "개체·관계를 지식 그래프로 기록하고 다시 찾아요.",
            "Store and retrieve entities and relationships in a knowledge graph.",
        ),
        "help": text(
            "데이터는 MCP가 실행되는 기기 또는 서버의 앱 전용 폴더에 저장돼요.",
            "Data lives in the app-owned folder of the device or server running this MCP.",
        ),
        "fields": [],
    },
    "fetch": {
        "name": "Fetch",
        "publisher": "Model Context Protocol",
        "official": True,
        "category": "development",
        "kind": "python",
        "package": "mcp-server-fetch",
        "entry": "mcp-server-fetch",
        "source": "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
        "docs": "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch#readme",
        "method": "python -m pip install mcp-server-fetch",
        "summary": text(
            "웹페이지를 읽어서 텍스트·마크다운으로 가져와요.",
            "Retrieve web pages as text or Markdown.",
        ),
        "help": text(
            "앱의 다른 Python 패키지와 분리된 환경에 설치해요.",
            "Installed separately from the app's own Python dependencies.",
        ),
        "fields": [],
    },
    "time": {
        "name": "Time",
        "publisher": "Model Context Protocol",
        "official": True,
        "category": "development",
        "kind": "python",
        "package": "mcp-server-time",
        "entry": "mcp-server-time",
        "source": "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
        "docs": "https://github.com/modelcontextprotocol/servers/tree/main/src/time#readme",
        "method": "python -m pip install mcp-server-time",
        "summary": text(
            "현재 시각과 시간대 변환을 제공해요.", "Current time and timezone conversion."
        ),
        "help": text(
            "시스템 시간대를 사용하며 별도 API 키가 필요 없어요.",
            "Uses the runtime's timezone. No API key required.",
        ),
        "fields": [],
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
    if r["kind"] == "remote":
        spec["url"] = r["url"]
        auth = "Bearer " + v["token"]
        if rid == "atlassian-cloud" and v["auth"] == "basic":
            if not v["email"] or ":" in v["email"] or "@" not in v["email"]:
                raise ValueError("required_field:email")
            auth = "Basic " + base64.b64encode((v["email"] + ":" + v["token"]).encode()).decode()
        spec["headers"] = {"Authorization": auth}
    elif rid == "atlassian":
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
    elif rid == "filesystem":
        for raw in v["folders"].splitlines():
            if not raw.strip():
                continue
            p = Path(os.path.expanduser(raw.strip()))
            if not p.is_absolute() or not p.is_dir():
                raise ValueError("invalid_allowed_folder")
            spec["args"].append(str(p.resolve()))
        if not spec["args"]:
            raise ValueError("required_field:folders")
    elif rid == "memory":
        data_dir.mkdir(parents=True, exist_ok=True)
        spec["env"]["MEMORY_FILE_PATH"] = str(data_dir / "knowledge.jsonl")
    elif rid == "playwright" and v["headless"]:
        spec["args"] = ["--headless"]
    return spec
