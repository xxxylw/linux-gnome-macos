#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_UUID="panel-icons@local"
EXT_DEST="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
BG_DIR="$HOME/.local/share/backgrounds"
BG_FILE="$BG_DIR/golden-gate-marshalls-beach.jpg"
BACKUP_DIR="$HOME/.local/share/linux-gnome-macos/backup"

APPLY_WALLPAPER=true
APPLY_TERMINAL=true
APPLY_THEME=true

for arg in "$@"; do
    case "$arg" in
        --no-wallpaper) APPLY_WALLPAPER=false ;;
        --no-terminal)  APPLY_TERMINAL=false ;;
        --no-theme)     APPLY_THEME=false ;;
        -h|--help)
            cat <<'EOF'
Usage: ./install.sh [OPTIONS]

Install the linux-gnome-macos desktop configuration (GNOME Shell 40-44).

Options:
  --no-wallpaper   Skip installing and applying the 4K Golden Gate wallpaper
  --no-terminal    Skip applying the macOS Pro GNOME Terminal profile
  --no-theme       Skip setting WhiteSur GTK / Icon / Shell theme keys
  -h, --help       Show this help message
EOF
            exit 0
            ;;
        *)
            echo "Unknown option: $arg" >&2
            exit 1
            ;;
    esac
done

echo "==> Backing up current GNOME settings to $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
dconf dump /org/gnome/shell/extensions/dash-to-dock/ > "$BACKUP_DIR/dash-to-dock.dconf" || true
dconf dump /org/gnome/desktop/interface/ > "$BACKUP_DIR/interface.dconf" || true
dconf dump /org/gnome/desktop/wm/preferences/ > "$BACKUP_DIR/wm-preferences.dconf" || true
dconf dump /org/gnome/desktop/background/ > "$BACKUP_DIR/background.dconf" || true
dconf dump /org/gnome/terminal/legacy/ > "$BACKUP_DIR/terminal.dconf" || true
gsettings get org.gnome.shell enabled-extensions > "$BACKUP_DIR/enabled-extensions.txt" 2>/dev/null || true

echo "==> Installing GNOME Shell extension ($EXT_UUID)"
mkdir -p "$EXT_DEST"
cp -f "$REPO_DIR/extensions/$EXT_UUID/metadata.json" \
      "$REPO_DIR/extensions/$EXT_UUID/extension.js" \
      "$REPO_DIR/extensions/$EXT_UUID/stylesheet.css" \
      "$REPO_DIR/extensions/$EXT_UUID/apple.svg" \
      "$REPO_DIR/extensions/$EXT_UUID/photo-credit.txt" \
      "$EXT_DEST/"

if $APPLY_WALLPAPER; then
    echo "==> Installing 4K wallpaper"
    mkdir -p "$BG_DIR"
    cp -f "$REPO_DIR/assets/wallpapers/golden-gate-marshalls-beach.jpg" "$BG_FILE"
    ln -sf "$BG_FILE" "$EXT_DEST/golden-gate.jpg"
    gsettings set org.gnome.desktop.background picture-uri "file://$BG_FILE"
    gsettings set org.gnome.desktop.background picture-uri-dark "file://$BG_FILE" 2>/dev/null || true
else
    ln -sf "$REPO_DIR/assets/wallpapers/golden-gate-marshalls-beach.jpg" "$EXT_DEST/golden-gate.jpg"
fi

echo "==> Applying macOS Dock geometry (42px icons, bottom floating, 65px total height)"
dconf load /org/gnome/shell/extensions/dash-to-dock/ < "$REPO_DIR/configs/dock.dconf"

echo "==> Setting macOS-style left traffic-light window buttons"
gsettings set org.gnome.desktop.wm.preferences button-layout 'close,minimize,maximize:'

if $APPLY_THEME; then
    if [[ -d "$HOME/.local/share/themes/WhiteSur-Light" || -d "/usr/share/themes/WhiteSur-Light" ]]; then
        echo "==> Applying WhiteSur-Light GTK & Shell theme"
        gsettings set org.gnome.desktop.interface gtk-theme 'WhiteSur-Light'
        dconf write /org/gnome/shell/extensions/user-theme/name "'WhiteSur-Light'"
    else
        echo "Note: WhiteSur-Light theme not found. Install https://github.com/vinceliuice/WhiteSur-gtk-theme for full styling."
    fi

    if [[ -d "$HOME/.local/share/icons/WhiteSur" || -d "/usr/share/icons/WhiteSur" ]]; then
        echo "==> Applying WhiteSur icon theme"
        gsettings set org.gnome.desktop.interface icon-theme 'WhiteSur'
    else
        echo "Note: WhiteSur icon theme not found. Install https://github.com/vinceliuice/WhiteSur-icon-theme for macOS icons."
    fi
fi

if $APPLY_TERMINAL; then
    echo "==> Applying macOS Pro GNOME Terminal profile & GTK 3 rounded window styling"
    dconf load /org/gnome/terminal/legacy/ < "$REPO_DIR/configs/terminal-macos-pro.dconf"
    mkdir -p "$HOME/.config/gtk-3.0"
    [[ -f "$HOME/.config/gtk-3.0/gtk.css" ]] && cp -f "$HOME/.config/gtk-3.0/gtk.css" "$BACKUP_DIR/gtk-3.0.css" || true
    cp -f "$REPO_DIR/configs/gtk3-terminal.css" "$HOME/.config/gtk-3.0/gtk.css"
fi

echo "==> Enabling GNOME Shell extensions"
if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions enable user-theme@gnome-shell-extensions.gcampax.github.com 2>/dev/null || true
    gnome-extensions enable "$EXT_UUID" 2>/dev/null || true
fi

cat <<'EOF'

Done! To activate the extension and stylesheet:
  - On X11: press Alt+F2, type "r", and press Enter (or run: killall -HUP gnome-shell)
  - On Wayland: log out and log back in.

To revert all changes later, run: ./restore.sh
EOF
