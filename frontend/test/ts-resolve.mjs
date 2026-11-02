// node --test loads the app's TypeScript as is (type stripping); the app imports its own modules without
// extensions (Vite resolves them). This lets a test import such a module (e.g. src/stores/chatStore.ts):
//   node --import ./test/ts-resolve.mjs --test test/…
import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);
