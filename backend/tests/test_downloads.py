from app.services.downloads import DownloadService


def test_asset_classification():
    c = DownloadService.classify
    assert c("hr-harnessor-0.2.7-windows-x64-setup.exe")["platform"] == "windows"
    assert c("hr-harnessor-0.2.7-macos-arm64.dmg")["arch"] == "arm64"
    assert c("hr-harnessor-0.2.7-macos-x64.dmg")["arch"] == "x64"
    assert c("hr-harnessor-0.2.7-linux-x86_64.AppImage")["kind"] == "appimage"
    assert c("hr-harnessor-0.2.7-linux-amd64.deb")["kind"] == "deb"
    assert c("hr-harnessor-0.2.7-android.apk")["platform"] == "android"
    assert c("latest.yml") is None and c("hr-harnessor-0.2.7-windows-x64-setup.exe.blockmap") is None


def test_not_configured_without_token(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "github_token", "")
    assert DownloadService().latest() == {"available": False, "reason": "not_configured"}


def test_latest_offers_one_build_per_platform_mid_swap(monkeypatch):
    """apps-latest is updated in place; while old and new files coexist the
    page must offer only the newest of each (and skip half-uploaded ones)."""
    from app.config import settings
    monkeypatch.setattr(settings, "github_token", "t")
    monkeypatch.setattr(settings, "apps_repo", "o/r")

    def asset(i, name, at, state="uploaded"):
        return {"id": i, "name": name, "size": 10, "updated_at": at, "state": state}

    rel = {
        "tag_name": "apps-latest",
        "body": '<!-- hrh-meta {"version": "0.2.5", "commit": "abc"} -->\nBuilt from abc',
        "assets": [
            asset(1, "hr-harnessor-0.2.4-android.apk", "2026-10-30T10:00:00Z"),
            asset(2, "hr-harnessor-0.2.5-android.apk", "2026-10-31T10:00:00Z"),
            asset(3, "hr-harnessor-0.2.5-linux-amd64.deb", "2026-10-31T10:00:00Z", state="starter"),
            asset(4, "hr-harnessor-0.2.4-linux-amd64.deb", "2026-10-30T10:00:00Z"),
            asset(5, "latest-linux.yml", "2026-10-31T10:00:00Z"),
        ],
    }
    svc = DownloadService()
    monkeypatch.setattr(svc, "_get", lambda url: rel)
    out = svc.latest()
    assert out["version"] == "0.2.5" and out["commit"] == "abc"
    assert sorted(a["id"] for a in out["assets"]) == [2, 4]
    assert out["notes"] == "Built from abc"
