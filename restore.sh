#!/usr/bin/env bash
set -euo pipefail

EXT_UUID="panel-icons@local"
EXT_DEST="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
BACKUP_DIR="$HOME/.local/share/linux-gnome-macos/backup"

echo "==> Disabling and removing $EXT_UUID"
if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions disable "$EXT_UUID" 2>/dev/null || true
fi
rm -rf "$EXT_DEST"

if [[ -d "$BACKUP_DIR" ]]; then
    echo "==> Restoring GNOME settings from $BACKUP_DIR"
    [[ -s "$BACKUP_DIR/dash-to-dock.dconf" ]] && dconf load /org/gnome/shell/extensions/dash-to-dock/ < "$BACKUP_DIR/dash-to-dock.dconf" || dconf reset -f /org/gnome/shell/extensions/dash-to-dock/
    [[ -s "$BACKUP_DIR/interface.dconf" ]] && dconf load /org/gnome/desktop/interface/ < "$BACKUP_DIR/interface.dconf" || true
    [[ -s "$BACKUP_DIR/wm-preferences.dconf" ]] && dconf load /org/gnome/desktop/wm/preferences/ < "$BACKUP_DIR/wm-preferences.dconf" || true
    [[ -s "$BACKUP_DIR/background.dconf" ]] && dconf load /org/gnome/desktop/background/ < "$BACKUP_DIR/background.dconf" || true
    [[ -s "$BACKUP_DIR/terminal.dconf" ]] && dconf load /org/gnome/terminal/legacy/ < "$BACKUP_DIR/terminal.dconf" || true
else
    echo "==> No backup found; resetting modified keys to GNOME defaults"
    dconf reset -f /org/gnome/shell/extensions/dash-to-dock/
    dconf reset /org/gnome/desktop/wm/preferences/button-layout
    dconf reset /org/gnome/desktop/interface/gtk-theme
    dconf reset /org/gnome/desktop/interface/icon-theme
    dconf reset /org/gnome/desktop/background/picture-uri
    dconf reset /org/gnome/desktop/background/picture-uri-dark
    dconf reset /org/gnome/shell/extensions/user-theme/name
fi

echo "Restore complete. Reload GNOME Shell (Alt+F2 -> r on X11, or log out/in on Wayland)."
