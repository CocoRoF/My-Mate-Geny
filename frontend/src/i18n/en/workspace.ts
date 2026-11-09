// Workspaces: picking a folder / repository, the file tree, local-folder links and uploads.
export default {
  workspace: "Workspace",
  localThisServer: "Local — this server",
  gitRepos: "Git repositories",
  // the folder tree
  editPath: "Edit path",
  pathPlaceholder: "/absolute/path",
  selected: "selected",
  useThis: "use this",
  use: "use",
  filter: "filter",
  noSubfolders: "No subfolders.",
  noSubfoldersMatch: "No subfolders match.",
  // a new folder (the tree's first row)
  newFolder: "New folder",
  newFolderName: "Folder name",
  newFolderIn: "In {path} — Enter to create, Esc to cancel",
  create: "Create",
  nameEmpty: "Give the folder a name.",
  nameDots: "“.” and “..” can't be folder names.",
  nameSlash: "A folder name can't contain / or \\ (one folder at a time).",
  nameLong: "That name is too long.",
  nameTaken: "“{name}” already exists here.",
  // repositories
  searchRepos: "Search repositories…",
  loadingRepos: "Loading repositories…",
  private: "private",
  cloning: "cloning",
  noRepos: "No repositories.",
  noReposMatch: "No repositories match.",
  // adding a folder to a session
  addFolderTitle: "Add a folder",
  addFolderHint: "The agent can read and edit this folder too, alongside the workspace. Browsing <b>{host}</b>.",
  navigateHint: "Navigate to a folder and click “use this”.",
  alreadyAdded: "Already added",
  addFolder: "Add folder",
  selectFolder: "Select",
  selectFolderTitle: "Add it to the selection — connect several folders (on several servers) together",
  // a folder from this computer (lib/localFolder.ts, localFolderStore, folderUploads)
  appCouldNotRead: "the app could not read this folder",
  couldNotRead: "could not read {file}",
  copied: {
    one: "Copied {count} file to {path}",
    other: "Copied {count} files to {path}",
  },
  uploadFailed: "upload failed ({status})",
};
