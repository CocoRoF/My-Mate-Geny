export default {
  issueDockerDaemon:
    "Docker is installed but its engine is unavailable. Check Docker and its permissions on the runtime machine, or use a catalog option without Docker.",
  registrationDone: "MCP registered. Enable it in a session panel to use it.",
  requiredCatalogField: "Enter {field}.",
  setupChanged:
    "The configuration changed in another window. Reload and test again.",
  downloadBusy: "Another download is in progress. Try again when it finishes.",

  managedPackage: "App-managed MCP package",
  manageTab: "Manage MCPs",
  catalogTab: "Catalog",
  directTab: "Manual setup",
  directHint:
    "Configure an executable or server URL directly. Saving a connected configuration first tests initialization and tool discovery.",
  catalogHint:
    "Review the publisher and installation method, then install only the MCPs you need. Browsing does not download or connect anything.",
  searchCatalog: "Search MCP names and capabilities",
  catalogLoading: "Loading catalog…",
  noCatalogMatches: "No matching MCPs.",
  official: "First-party / project maintained",
  community: "Community maintained",
  downloaded: "Downloaded",
  noDownload: "Hosted service · no download required.",
  installOnDevice: "Installed in this computer’s app-owned folder.",
  installOnServer: "Installed in the connected server’s app-owned folder.",
  downloadMethod: "Installation method",
  startSetup: "Start setup",
  replaceExisting:
    "Reconfigure the existing entry while preserving its identity and session selections.",
  newRegistration: "Only a successfully tested configuration is registered.",
  prepareConnection: "Prepare connection",
  download: "Download",
  configureTest: "Configure and test",
  registerSuccess: "Register MCP",
  remotePreparation:
    "Configure credentials and test the hosted connection from this runtime. No download is needed.",
  isolatedInstallHint:
    "Downloads the publisher’s package and dependencies into an app-owned environment. Node.js/npm is prepared if needed. Existing system installations and accounts are preserved.",
  publisherDocs: "Publisher installation guide",
  sourceCode: "Source code",
  downloading: "Downloading package and dependencies…",
  downloadLog: "Download log",
  cancelDownload: "Cancel download",
  previousStep: "Back",
  testConnection: "Test connection",
  testing: "Checking connection and tools…",
  testPassed: "Connection test passed",
  testFailed: "Connection test failed.",
  testExpired: "The connection test expired. Please test again.",
  testScope:
    "Tests server initialization and tool discovery only. Does not edit files, create issues or execute tools.",
  registrationHint:
    "After registration, check the connection in Manage MCPs. Each session must enable it in its panel before use.",
  registerMcp: "Register MCP",
  repairWithCatalog: "Repair using catalog setup",
  technicalDetails: "Technical details",
  secretArgHint:
    "Arguments containing credentials appear as null. A null keeps the saved value at that position.",
  issueDocker:
    "Docker is not installed in this MCP runtime. Choose a catalog installation or hosted connection that does not need Docker, or install Docker on the machine running MCP.",
  issueExecutable:
    "Executable not found in this runtime. Check its installation and path. Server mode uses files on the server.",
  issuePermission: "The runtime cannot access or execute the configured file.",
  issueFolder:
    "The working folder does not exist in this runtime. Correct it or leave it empty to use the default.",
  issueFolderPermission: "The runtime cannot access the working folder.",
  issueDockerEnv:
    "A Docker environment argument is invalid. Use the catalog’s named credential fields instead of placing a bare token in arguments.",
  issueAuth:
    "Authentication was rejected. Check the account, token, permissions and your organization’s MCP policy.",
  issueTimeout:
    "Connection timed out. Check the address, network and server status.",
  issueConnection:
    "MCP initialization failed or the process exited. Check the required configuration and logs.",
  issuePackage:
    "The app-managed MCP package is missing or unavailable. Download it again from the catalog.",

  loadingTools: "Loading tools…",
  moreTools: "Load more tools",

  diagnostics: "Also save server diagnostics",
  diagnosticsHint:
    "Save the server’s diagnostic output too. Environment and authentication header values are redacted; other text printed by the MCP may be included.",
  cancelled: "Cancelled",
  logs: "Runtime logs",

  title: "MCP",
  llmTitle: "Language model providers",
  llmIntro:
    "Set up Claude Code and Codex installations, sign-ins, accounts and usage limits.",
  mediaTitle: "Image and voice providers",
  mediaIntro:
    "Connect services for image/video generation, speech recognition (STT) and speech (TTS).",
  intro:
    "Register MCP connections, then enable the tools you need in each session panel.",
  localRuntime: "MCP runs on this computer",
  serverRuntime: "MCP runs on the connected server",
  scopeHint:
    "Commands, file paths and environment variables belong to this execution environment. Enable each MCP in a session to use it.",
  add: "Add MCP",
  import: "Import settings JSON",
  refresh: "Refresh",
  empty: "No MCP connections yet",
  emptyHint:
    "Add a command or MCP server address, or paste an mcpServers JSON configuration.",
  catalogCount: "{count} registered MCPs",
  toolsCount: "{count} tools",
  toggleConnection: "Toggle {name} connection",
  connected: "Connected",
  connecting: "Connecting",
  disconnected: "Disconnected",
  disabled: "Connection off",
  failed: "Connection error",
  edit: "Edit settings",
  delete: "Delete",
  deleteHint: "Deleting this MCP prevents further calls from all sessions.",
  reconnect: "Reconnect",
  name: "Display name",
  transport: "Connection type",
  stdio: "Command (stdio)",
  http: "Server address (Streamable HTTP)",
  sse: "Server address (legacy SSE)",
  command: "Executable",
  arguments: "Arguments · one per line or a JSON array",
  cwd: "Working folder · leave blank for default",
  url: "MCP server address",
  environment: "Environment variables · API keys, etc.",
  headers: "Authentication headers",
  secretHint:
    "Values are encrypted and never shown again. Leave a saved value blank to keep it; remove its row to delete it.",
  keyName: "Variable or header name",
  keyValue: "Value",
  keepSecret: "Keep saved value",
  enterValue: "Enter value",
  removeRow: "Remove this row",
  addRow: "Add row",
  hideValues: "Hide entered values",
  showValues: "Show entered values",
  advanced: "Advanced settings",
  timeout: "Call timeout (seconds)",
  connectAfterSave: "Connect after saving",
  saveConnect: "Save and connect",
  saving: "Saving and connecting…",
  invalidForm:
    "Check the argument format and duplicate environment variable or header names.",
  importHint:
    "Paste JSON containing mcpServers. Imports start disconnected. Existing entries with the same name are kept.",
  invalidJson: "Check the JSON syntax.",
  jsonConfig: "MCP settings JSON",
  sessionHint:
    "Enabled MCPs are available from the next turn. Disabling immediately blocks further calls, including a running connection.",
  useInSession: "Use {name} in this session",
  manage: "Open MCP settings",
  mediaManage: "Open image and voice provider settings",
  mediaMoved:
    "Manage service connections and API keys in Settings → Image and voice providers.",
  google: "Google Gemini",
  googleHint:
    "Connect speech recognition, speech generation and image models with a Gemini API key.",
  googleTtsHint: "Read replies using Gemini speech models.",
  googleSttHint: "Transcribe recorded speech with Gemini.",
  images: "Images",
  modelCatalog: "Voice and image models available to this key",
  selfHosted: "Self-hosted voice services",
  systemTitle: "MCP runtime and call history",
  systemHint:
    "Inspect current runtime counters and saved call history. Basic call records exclude environment values, authentication keys, tool arguments and response bodies.",
  calls: "Calls",
  errors: "Errors",
  lastLatency: "Last duration",
  noLogs: "No MCP events yet.",
  moreLogs: "Load earlier events",
  allMcp: "All MCPs",
  allLevels: "All statuses",
  levelInfo: "Info",
  levelWarning: "Warning",
  levelError: "Error",
  session: "Session",
};
