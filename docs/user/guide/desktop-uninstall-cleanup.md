# Uninstall DSH Desktop

English | [中文](desktop-uninstall-cleanup.zh.md)

Use this guide to uninstall Yundashi Agent Desktop on macOS or Windows. Local data cleanup is optional.

## 1. Uninstall the app

Finish any commands using Desktop's bundled CLI. If you installed the `dsh` command through Desktop, first select **Manage dsh Command… → Remove** in the application menu. This removes Desktop's command registration without uninstalling independent CLI programs.

Quit Yundashi Agent, then uninstall it using your platform's procedure:

- **macOS:** Delete the app from Applications in Finder.
- **Windows:** Uninstall it through Settings → Apps → Installed apps on Windows 11, or Control Panel → Programs → Programs and Features.

## 2. Clean up local data

This step is optional. If you want to clean up local data, select the script for your platform below, then paste and run it in Terminal on macOS or PowerShell on Windows.

The `@deepseek-ai/dsh-desktop` and `@deepseek-aidsh-desktop-updater` directory names come from the app's package identity, not its displayed name. Electron derives the user-data directory from the package name, and the updater cache name is that package name with path separators removed plus `-updater`. They remain correct even though the app is displayed as Yundashi Agent; deleting a directory named after the displayed name would not remove the real data.

The scripts permanently delete the current user's default Harness home and the Desktop data paths listed below, including sessions, credentials, settings, plugins, caches, and shared CLI state. If you configured `DSH_HOME`, inspect that directory separately before deleting it; the scripts still delete the default `~/.dsh`. Isolated development and test data directories are outside this cleanup scope.

On Windows, the uninstaller normally removes the two application-data directories listed in the script but retains the Harness home. The script also handles those directories if uninstallation left files behind or retained app data.

::: code-group

```sh [macOS]
sh -c '
rm -rf -- \
  "$HOME/.dsh" \
  "$HOME/Library/Application Support/@deepseek-ai/dsh-desktop" \
  "$HOME/Library/Logs/云大师 Agent" \
  "$HOME/Library/Preferences/com.yundashi.agent.plist" \
  "$HOME/Library/Preferences/ByHost"/com.yundashi.agent.ShipIt.*.plist \
  "$HOME/Library/Caches/com.yundashi.agent" \
  "$HOME/Library/Caches/com.yundashi.agent.ShipIt" \
  "$HOME/Library/HTTPStorages/com.yundashi.agent" \
  "$HOME/Library/Caches/@deepseek-aidsh-desktop-updater" \
  "$(getconf DARWIN_USER_CACHE_DIR)/com.yundashi.agent" \
  "$(getconf DARWIN_USER_CACHE_DIR)/com.yundashi.agent.helper"
'
```

```powershell [Windows]
$ErrorActionPreference = 'Stop'
@(
    (Join-Path $env:USERPROFILE '.dsh'),
    (Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop'),
    (Join-Path $env:LOCALAPPDATA '@deepseek-aidsh-desktop-updater')
) | ForEach-Object {
    if (Test-Path -LiteralPath $_) {
        Remove-Item -LiteralPath $_ -Recurse -Force
    }
}
```

:::

## 3. Verify cleanup

If you ran a cleanup script, confirm before reinstalling that the paths listed in it no longer exist. If the script reports an error, resolve it, rerun the script, and check all listed paths again. The Windows script stops at the first error, so later paths may remain.
