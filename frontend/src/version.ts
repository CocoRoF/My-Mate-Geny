/** the release line (backend/app/__init__.py, the package.json files: backend/tests/test_version.py keeps them equal) */
export const LINE_VERSION = "1.1.0";
/** this build's version: <line>.<n> as the apps workflow numbered its commit (vite.config.ts), else the line's */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" && __APP_VERSION__ ? __APP_VERSION__ : LINE_VERSION;
/** the web console build (vite.config.ts): its git commit and when it was built */
export const BUILD_COMMIT: string = typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : "";
export const BUILD_TIME: string = typeof __BUILD_TIME__ === "string" ? __BUILD_TIME__ : "";
