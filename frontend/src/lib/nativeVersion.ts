/**
 * The app's own version (window.hrhNative.version), for what compares it with the newest build (Settings → Updates,
 * the update banner, the Download page). The Android bridge learns it from App.getInfo, which can answer after the
 * first render (native.ts): it says so with NATIVE_VERSION_EVENT and this re-reads it. "" while unknown (the bridge's
 * placeholder 0.0.0 is not a version to compare — it made every build look newer).
 */
import { useEffect, useState } from "react";

export const NATIVE_VERSION_EVENT = "hrh:native-version";

export const knownVersion = (v: string | undefined | null): string => (v && v !== "0.0.0" ? v : "");

export function useNativeVersion(): string {
  const [v, setV] = useState(() => knownVersion(window.hrhNative?.version));
  useEffect(() => {
    const read = () => setV(knownVersion(window.hrhNative?.version));
    read();
    window.addEventListener(NATIVE_VERSION_EVENT, read);
    return () => window.removeEventListener(NATIVE_VERSION_EVENT, read);
  }, []);
  return v;
}
