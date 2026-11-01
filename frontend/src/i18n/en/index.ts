// The English messages — the source of every key (docs/i18n.md). One file per namespace.
import admin from "./admin.ts";
import chat from "./chat.ts";
import common from "./common.ts";
import composer from "./composer.ts";
import connections from "./connections.ts";
import downloads from "./downloads.ts";
import files from "./files.ts";
import mate from "./mate.ts";
import mateSettings from "./mateSettings.ts";
import nav from "./nav.ts";
import providers from "./providers.ts";
import settings from "./settings.ts";
import tasks from "./tasks.ts";
import turn from "./turn.ts";
import usage from "./usage.ts";

const en = { admin, chat, common, composer, connections, downloads, files, mate, mateSettings, nav, providers, settings, tasks, turn, usage };
export type Catalog = typeof en;
export default en;
