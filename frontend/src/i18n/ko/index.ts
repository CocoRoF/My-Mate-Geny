// 한국어 messages: every en key (typed against en — a missing or extra key does not compile). Glossary: docs/i18n.md.
import type { Locale } from "..";
import admin from "./admin.ts";
import chat from "./chat.ts";
import cliTools from "./cliTools.ts";
import common from "./common.ts";
import composer from "./composer.ts";
import connections from "./connections.ts";
import downloads from "./downloads.ts";
import files from "./files.ts";
import mate from "./mate.ts";
import mateSettings from "./mateSettings.ts";
import nav from "./nav.ts";
import providers from "./providers.ts";
import session from "./session.ts";
import settings from "./settings.ts";
import tasks from "./tasks.ts";
import topbar from "./topbar.ts";
import turn from "./turn.ts";
import usage from "./usage.ts";
import workspace from "./workspace.ts";

const ko: Locale = { admin, chat, cliTools, common, composer, connections, downloads, files, mate, mateSettings, nav, providers, session, settings, tasks, topbar, turn, usage, workspace };
export default ko;
