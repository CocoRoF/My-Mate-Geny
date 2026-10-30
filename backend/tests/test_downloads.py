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
