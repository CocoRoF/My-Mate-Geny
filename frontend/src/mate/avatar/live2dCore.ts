/**
 * Moved to `src/mate/live2dCore.ts` (shared with the settings UI); kept so older imports keep working.
 * (markLive2DCoreInstalled is exported from there only: the settings panel calls whichever module has it.)
 */
export {
  setLive2DCoreUrl,
  getLive2DCoreUrl,
  loadCubismCore,
  useLive2DCoreInstalls,
  live2dCoreInstalls,
  openLive2DSettings,
  LIVE2D_CORE_INSTALLED_EVENT,
} from "../live2dCore";
