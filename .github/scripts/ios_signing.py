#!/usr/bin/env python3
"""The iOS app target signed by hand with the team's App Store profile (.github/workflows/apps.yml "ios").

    ios_signing.py <project.pbxproj> <team id> <profile uuid>

Only the app target's two configurations: given on xcodebuild's command line instead, the settings would reach the
Swift packages too, and those take no provisioning profile. The project in the repository keeps automatic signing (a
developer's own Xcode, a fork's simulator build).
"""
import re
import sys

path, team, uuid = sys.argv[1:4]
if not re.fullmatch(r"[A-Z0-9]{10}", team) or not re.fullmatch(r"[0-9a-fA-F-]{36}", uuid):
    raise SystemExit("ios_signing.py: not a team id / profile uuid")
text = open(path, encoding="utf-8").read()
signing = (f"CODE_SIGN_STYLE = Manual;\n\t\t\t\tDEVELOPMENT_TEAM = {team};\n\t\t\t\t"
           f'"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "Apple Distribution";\n\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = "{uuid}";')
text, n = re.subn(r"CODE_SIGN_STYLE = Automatic;", lambda _m: signing, text)
if n != 2:
    raise SystemExit(f"ios_signing.py: expected the app target's two configurations, found {n}")
open(path, "w", encoding="utf-8").write(text)
print("the app target: manual signing, Apple Distribution, the App Store profile")
