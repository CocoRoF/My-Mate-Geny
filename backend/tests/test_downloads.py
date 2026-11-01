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


def test_asset_classification_new_names():
    """Since 0.3 the artifacts are named my-mate-geny-…; both names classify the same."""
    c = DownloadService.classify
    assert c("my-mate-geny-0.3.12-windows-x64-setup.exe")["kind"] == "installer"
    assert c("my-mate-geny-0.3.12-macos-arm64.dmg")["arch"] == "arm64"
    assert c("my-mate-geny-0.3.12-macos-x64.dmg")["label"] == "macOS · Intel"
    assert c("my-mate-geny-0.3.12-linux-x86_64.AppImage")["platform"] == "linux"
    assert c("my-mate-geny-0.3.12-linux-amd64.deb")["kind"] == "deb"
    assert c("my-mate-geny-0.3.12-android.apk")["platform"] == "android"
    assert c("my-mate-geny-0.3.12-windows-x64-setup.exe.blockmap") is None
    for old, new in [("hr-harnessor-0.2.9-android.apk", "my-mate-geny-0.3.10-android.apk"),
                     ("hr-harnessor-0.2.9-linux-amd64.deb", "my-mate-geny-0.3.10-linux-amd64.deb")]:
        assert c(old) == c(new)


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
    assert out["product"] == "My Mate Geny"


def test_latest_mid_rename_swap(monkeypatch):
    """The first my-mate-geny build lands in apps-latest next to the old
    hr-harnessor files: one per platform, the newest, whatever its name."""
    from app.config import settings
    monkeypatch.setattr(settings, "github_token", "t")
    monkeypatch.setattr(settings, "apps_repo", "o/r")

    def asset(i, name, at):
        return {"id": i, "name": name, "size": 10, "updated_at": at, "state": "uploaded"}

    rel = {
        "tag_name": "apps-latest",
        "body": '<!-- hrh-meta {"version": "0.3.40"} -->',
        "assets": [
            asset(1, "hr-harnessor-0.2.39-android.apk", "2026-10-30T10:00:00Z"),
            asset(2, "my-mate-geny-0.3.40-android.apk", "2026-10-31T10:00:00Z"),
            asset(3, "hr-harnessor-0.2.39-windows-x64-setup.exe", "2026-10-30T10:00:00Z"),
        ],
    }
    svc = DownloadService()
    monkeypatch.setattr(svc, "_get", lambda url: rel)
    out = svc.latest()
    by_platform = {a["platform"]: a["name"] for a in out["assets"]}
    assert by_platform == {"android": "my-mate-geny-0.3.40-android.apk",
                           "windows": "hr-harnessor-0.2.39-windows-x64-setup.exe"}


def test_update_feed_files_by_name(monkeypatch, tmp_path):
    """The desktop updater's feed: latest*.yml and the installers they name, by exact name, newest upload wins;
    nothing else (no path tricks, no other release files)."""
    from app.config import settings
    monkeypatch.setattr(settings, "github_token", "t")
    monkeypatch.setattr(settings, "apps_repo", "o/r")

    def asset(i, name, at):
        return {"id": i, "name": name, "size": 3, "updated_at": at, "state": "uploaded"}

    rel = {"tag_name": "apps-latest", "body": "", "assets": [
        asset(1, "latest.yml", "2026-10-30T10:00:00Z"),
        asset(2, "latest.yml", "2026-10-31T10:00:00Z"),
        asset(3, "my-mate-geny-0.4.12-windows-x64-setup.exe", "2026-10-31T10:00:00Z"),
        asset(4, "latest-linux.yml", "2026-10-31T10:00:00Z"),
        asset(5, "notes.txt", "2026-10-31T10:00:00Z"),
    ]}
    svc = DownloadService()
    monkeypatch.setattr(svc, "_get", lambda url: rel)
    got = []
    monkeypatch.setattr(svc, "_cached", lambda a: (got.append(a["id"]) or tmp_path / a["name"], a["name"]))
    assert svc.update_path("latest.yml")[1] == "latest.yml" and got[-1] == 2
    assert svc.update_path("my-mate-geny-0.4.12-windows-x64-setup.exe")[1].endswith(".exe") and got[-1] == 3
    assert svc.update_path("latest-linux.yml") and got[-1] == 4
    import pytest
    for bad in ("notes.txt", "../latest.yml", "latest-mac.yml", "x/../../etc/passwd", ""):
        with pytest.raises(KeyError):
            svc.update_path(bad)
