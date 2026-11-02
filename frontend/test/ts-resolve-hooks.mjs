// Module resolve hook (see ts-resolve.mjs): "./x" / "../x" that isn't found as written → x.ts, x.tsx, x/index.ts.
const TRY = [".ts", ".tsx", "/index.ts"];

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (!relative || !["ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_DIR_IMPORT"].includes(err?.code)) throw err;
    for (const ext of TRY) {
      try {
        return await next(specifier + ext, context);
      } catch {
        /* the next one */
      }
    }
    throw err;
  }
}
