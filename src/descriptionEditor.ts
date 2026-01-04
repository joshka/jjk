import * as vscode from "vscode";
import { createHash } from "crypto";
import path from "path";
import type { WorkspaceSourceControlManager } from "./repository";
import { isDescendant } from "./utils";

/**
 * Multiline change description editor for `jj describe`.
 *
 * Overview:
 * - Provide a normal VS Code text editor for editing change descriptions (multi-line), instead of
 *   `window.showInputBox` (single-line).
 * - Store the backing file under `context.globalStorageUri` so it doesn't touch the repo working
 *   copy or show up as an untracked file.
 * - Open -> edit -> manual save -> apply via `jj describe -m`.
 * - Match `jj describe` UX by including `JJ:` footer lines and stripping them before applying.
 *
 * This file is not in the repository working copy, so it won't show up as an untracked file and
 * it works even for repositories opened read-only.
 */

// --- Backing file layout ------------------------------------------------------
//
// We store editor buffers as:
//   <globalStorageUri>/description-editor/<repoKey>/<encodedRev>.jjdescription
//
// `repoKey` is a stable hash of the repository root path so we can map saves back to the right
// repo without leaking paths into filenames.

const DESCRIPTION_EDITOR_DIRNAME = "description-editor";
const DESCRIPTION_FILE_EXTENSION = ".jjdescription";

/**
 * `jj describe` populates the editor with informational lines prefixed with `JJ:` and strips them
 * before writing the final message. We mimic that UX and perform the same stripping on save.
 */
const JJ_COMMENT_PREFIX = "JJ:";

/**
 * Maps an on-disk "repo folder" to a repository root without exposing the full path in filenames.
 * Collisions are extremely unlikely, even with the truncated digest.
 *
 * This is used in both directions:
 * - when opening: repository root -> repoKey -> file path
 * - when saving: file path -> repoKey -> repository root
 */
function computeRepoKey(repositoryRoot: string): string {
  return createHash("sha256")
    .update(repositoryRoot)
    .digest("hex")
    .slice(0, 16);
}

function encodeRevForFilename(rev: string): string {
  return encodeURIComponent(rev);
}

function decodeRevFromFilename(rev: string): string {
  return decodeURIComponent(rev);
}

/**
 * Determines whether `uri` is one of our description editor backing files, and if so extracts the
 * repo key and revision from its path.
 *
 * Expected layout:
 *   <globalStorageUri>/description-editor/<repoKey>/<encodedRev>.jjdescription
 *
 * This intentionally ignores anything that doesn't match the shape exactly, since the save hook
 * runs for every saved document in the workspace.
 */
function isDescriptionEditorUri(
  baseDir: vscode.Uri,
  uri: vscode.Uri,
): { repoKey: string; rev: string } | undefined {
  if (uri.scheme !== "file") {
    return undefined;
  }

  // Only treat files under our global storage base directory as editor backing files.
  if (!isDescendant(baseDir.fsPath, uri.fsPath)) {
    return undefined;
  }

  if (path.extname(uri.fsPath) !== DESCRIPTION_FILE_EXTENSION) {
    return undefined;
  }

  // We expect exactly `<repoKey>/<encodedRev>.jjdescription`. Anything else is ignored.
  const relativePath = path.relative(baseDir.fsPath, uri.fsPath);
  const parts = relativePath.split(path.sep).filter(Boolean);
  if (parts.length !== 2) {
    return undefined;
  }

  const [repoKey, filename] = parts;
  const encodedRev = path.basename(filename, DESCRIPTION_FILE_EXTENSION);

  return { repoKey, rev: decodeRevFromFilename(encodedRev) };
}

/**
 * Initializes the backing file content for a new editor session, but avoids overwriting an
 * existing unsaved editor buffer if the user already has it open.
 *
 * This prevents surprising "content jumps" if the user triggers `jj.describe` multiple times or
 * has multiple windows open against the same global storage.
 */
async function writeFileIfNotDirty(uri: vscode.Uri, content: string) {
  const alreadyOpen = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.toString() === uri.toString(),
  );
  if (alreadyOpen?.isDirty) {
    return;
  }
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
}

/**
 * Matches the initial contents `jj describe` writes when it opens an editor:
 * - the current description
 * - followed by `JJ:` informational footer lines
 *
 * We do this so users can learn one mental model: "this looks like jj's editor".
 */
function formatJjDescriptionEditorText({
  description,
  changeId,
}: {
  description: string;
  changeId: string;
}): string {
  return [
    description,
    "",
    `${JJ_COMMENT_PREFIX} Change ID: ${changeId}`,
    `${JJ_COMMENT_PREFIX}`,
    `${JJ_COMMENT_PREFIX} Lines starting with "${JJ_COMMENT_PREFIX}" (like this one) will be removed.`,
    "",
  ].join("\n");
}

/**
 * Removes all `JJ:` comment lines before applying the description to `jj`.
 *
 * We deliberately trim only the end, so user-leading whitespace/blank lines are preserved.
 */
function stripJjCommentLines(text: string): string {
  const lines = text.split(/\r?\n/);
  const nonCommentLines = lines.filter(
    (line) => !line.startsWith(JJ_COMMENT_PREFIX),
  );
  // Mirror `jj describe` behavior: keep the body as-is, but avoid forcing an extra trailing
  // newline into the commit description.
  return nonCommentLines.join("\n").trimEnd();
}

/**
 * Wires up the description editor behavior for the extension.
 *
 * Responsibilities:
 * - Registers a save hook that applies changes for `.jjdescription` backing files.
 * - Provides `openDescriptionEditor(...)` to open/seed the editor for a given repo + rev.
 *
 * Invariants:
 * - Only manual saves apply changes (autosave should not trigger jj commands).
 * - `JJ:` footer lines are ignored when applying.
 */
export function registerDescriptionEditor({
  context,
  workspaceSCM,
}: {
  context: vscode.ExtensionContext;
  workspaceSCM: WorkspaceSourceControlManager;
}) {
  // Base directory for all description editor backing files.
  //
  // This lives in global storage (outside any repository) so it does not:
  // - appear in source control views
  // - affect repo status / snapshotting behavior
  // - depend on a writeable repository directory
  const baseDir = vscode.Uri.joinPath(
    context.globalStorageUri,
    DESCRIPTION_EDITOR_DIRNAME,
  );

  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((e) => {
      // Apply flow (high level):
      // - Recognize saves of our backing file.
      // - Map backing file -> repo + rev.
      // - Translate buffer -> message (strip `JJ:` footer).
      // - Run `jj describe` (with immutable prompting handled in `describeRetryImmutable`).

      // Only apply on explicit user intent to avoid repeated `jj describe` calls from autosave.
      if (e.reason !== vscode.TextDocumentSaveReason.Manual) {
        return;
      }

      // Only intercept saves for our `.jjdescription` backing files.
      const parsed = isDescriptionEditorUri(baseDir, e.document.uri);
      if (!parsed) {
        return;
      }

      const { repoKey, rev } = parsed;
      // Map the repoKey back to a repository root, then apply the description update there.
      const repoSCM = workspaceSCM.repoSCMs.find(
        (repo) => computeRepoKey(repo.repositoryRoot) === repoKey,
      );
      if (!repoSCM) {
        void vscode.window.showErrorMessage(
          `Failed to update description: repository not found for ${rev}`,
        );
        return;
      }

      // Strip `JJ:` lines (and only those lines) so users can keep the footer intact.
      const message = stripJjCommentLines(e.document.getText());
      void repoSCM.repository
        .describeRetryImmutable(rev, message)
        .then(() => {
          vscode.window.setStatusBarMessage(
            `Updated description for ${rev}`,
            3000,
          );
        })
        .catch((error: unknown) => {
          void vscode.window.showErrorMessage(
            `Failed to update description${error instanceof Error ? `: ${error.message}` : ""}`,
          );
        });
    }),
  );

  return {
    // Called by `jj.describe` to start an edit session for the selected change.
    async openDescriptionEditor({
      repositoryRoot,
      rev,
      initialDescription,
      changeId,
    }: {
      repositoryRoot: string;
      rev: string;
      initialDescription: string;
      changeId: string;
    }) {
      const repoKey = computeRepoKey(repositoryRoot);

      // Ensure the per-repo directory exists so our backing file has a stable location.
      const repoDir = vscode.Uri.joinPath(baseDir, repoKey);
      await vscode.workspace.fs.createDirectory(repoDir);

      // The filename includes the encoded rev so multiple changes can be edited independently.
      const uri = vscode.Uri.joinPath(
        repoDir,
        `${encodeRevForFilename(rev)}${DESCRIPTION_FILE_EXTENSION}`,
      );

      // Seed the file with the current description + `JJ:` footer, but don't overwrite a dirty
      // buffer if the user already has the editor open.
      await writeFileIfNotDirty(
        uri,
        formatJjDescriptionEditorText({
          description: initialDescription,
          changeId,
        }),
      );

      // Open the file in an editor and switch it to the commit-message language mode for better UX.
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.languages.setTextDocumentLanguage(document, "jj-commit");
      await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
      });

      vscode.window.setStatusBarMessage(
        "Edit description and press Save to apply",
        5000,
      );
    },
  };
}
