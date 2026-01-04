# Multi-line Descriptions

The `jj.describe` command ("Jujutsu: Update change description") opens the
change description in an editor so you can view and edit multi-line text.

## Why This Exists

VS Code input boxes are single-line, which makes it awkward to write
commit-style descriptions with paragraphs, lists, and blank lines.

Editing in a normal text editor provides:

- Multi-line editing with your usual keybindings.
- Syntax highlighting via the `jj-commit` language mode.
- A clear "save to apply" workflow.

## How To Use It

1. Run "Jujutsu: Update change description" (command id: `jj.describe`).
2. Edit the description in the opened editor.
3. Save the file to apply the update to the change.

Notes:

- The update is applied on manual save (e.g. `Cmd+S` / `Ctrl+S`).
- If the change is immutable, you will be prompted to confirm before applying.

## Saving And Closing

- Save applies the description change immediately.
- Close the editor tab to dismiss it.
- Closing a dirty editor will prompt to save; choosing "Save" will apply
  the description, and choosing "Don't Save" will discard your edits.

## How It Works

- The command opens a `.jjdescription` file in the extension's global
  storage directory, not in your repository.
- A per-repository directory is used (keyed by a stable hash of the
  repository root path).
- The revision id is encoded into the filename to keep paths safe.
- The editor content includes the same `JJ:` footer lines as native `jj describe`.
- When you save, the extension strips `JJ:` lines and runs
  `jj describe -m <message> <rev>` for the associated repository and revision.
