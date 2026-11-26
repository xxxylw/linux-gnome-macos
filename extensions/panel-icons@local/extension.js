const { Clutter, Gio, GLib, GObject, Meta, Shell, St } = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const WEATHER_URL = 'https://wttr.in/Shanghai?format=j1';
const REFRESH_SECONDS = 900;

function label(text, styleClass) {
    return new St.Label({ text, style_class: styleClass });
}

function weatherDescription(value) {
    const description = value.toLowerCase();
    if (description.includes('thunder'))
        return '雷雨';
    if (description.includes('snow') || description.includes('sleet'))
        return '雪';
    if (description.includes('drizzle'))
        return '毛毛雨';
    if (description.includes('rain'))
        return '降雨';
    if (description.includes('fog') || description.includes('mist'))
        return '雾';
    if (description.includes('cloud') || description.includes('overcast'))
        return '多云';
    if (description.includes('sunny') || description.includes('clear'))
        return '晴';
    return value;
}

class DesktopCards {
    constructor() {
        const extension = ExtensionUtils.getCurrentExtension();
        const row = new St.BoxLayout({ style_class: 'desktop-card-row' });
        const calendar = new St.BoxLayout({ vertical: true, reactive: true, track_hover: true, style_class: 'desktop-card desktop-calendar' });
        calendar.connect('button-press-event', () => {
            try {
                Gio.Subprocess.new(['/usr/bin/gnome-calendar'], Gio.SubprocessFlags.NONE);
            } catch (e) {
                Main.panel.statusArea.dateMenu.menu.toggle();
            }
            return Clutter.EVENT_STOP;
        });
        this._month = label('', 'desktop-month');
        calendar.add_child(this._month);
        this._calendarDays = new St.BoxLayout({ vertical: true, style_class: 'desktop-calendar-days' });
        calendar.add_child(this._calendarDays);

        const weather = new St.BoxLayout({ vertical: true, reactive: true, track_hover: true, style_class: 'desktop-card desktop-weather' });
        weather.connect('button-press-event', () => {
            this._weatherDetail.text = '正在刷新...';
            this._requestWeather();
            return Clutter.EVENT_STOP;
        });
        weather.add_child(label('上海', 'desktop-card-heading'));
        this._temperature = label('—°', 'desktop-temperature');
        weather.add_child(this._temperature);
        this._weatherDetail = label('正在读取天气', 'desktop-weather-detail');
        weather.add_child(this._weatherDetail);
        this._weatherRange = label('', 'desktop-weather-detail');
        weather.add_child(this._weatherRange);
        row.add_child(calendar);
        row.add_child(weather);

        const photo = new St.BoxLayout({ vertical: true, style_class: 'desktop-photo' });
        const background = extension.dir.get_child('golden-gate.jpg').get_uri();
        photo.set_style('background-image: url("' + background + '");');
        photo.add_child(new St.Widget({ y_expand: true }));
        const photoCaption = new St.BoxLayout({ vertical: true, style_class: 'desktop-photo-caption' });
        photoCaption.add_child(label('金门大桥', 'desktop-card-heading'));
        photoCaption.add_child(label('© Frank Schulenburg', 'desktop-photo-credit'));
        photo.add_child(photoCaption);

        this.actor = new St.BoxLayout({ vertical: true, style_class: 'desktop-cards' });
        this.actor.add_child(row);
        this.actor.add_child(photo);
        this._cachedW = 364;
        this._cachedH = 292;
        this._lastX = null;
        this._lastY = null;
        this._cardsVisible = true;
        this._calendar = calendar;
        this._weather = weather;
        this._weatherCancellation = new Gio.Cancellable();
        this._repositionIdleId = 0;
        this._visibilityIdleId = 0;
        this._bgAddedSignal = 0;
        this._focusedWin = null;
        this._focusedWinSignals = [];
        this._displaySignals = [];
        this._wmSignals = [];

        this._layoutSignal = Main.layoutManager.connect('monitors-changed', () => {
            this._reposition();
            this._scheduleReposition();
        });
        this._panelHeightSignal = Main.layoutManager.panelBox
            ? Main.layoutManager.panelBox.connect('notify::height', () => this._reposition())
            : 0;
        this._overviewShowSignal = Main.overview.connect('showing', () => this._updateVisibility());
        this._overviewHideSignal = Main.overview.connect('hidden', () => this._scheduleVisibilityUpdate());

        const onWindowEvent = () => this._scheduleVisibilityUpdate();
        for (const sig of ['restacked', 'grab-op-end', 'workareas-changed'])
            this._displaySignals.push(global.display.connect(sig, onWindowEvent));
        this._displaySignals.push(global.display.connect('notify::focus-window', () => {
            this._watchFocusedWindow();
            this._scheduleVisibilityUpdate();
        }));
        for (const sig of ['map', 'destroy', 'minimize', 'unminimize', 'size-changed', 'switch-workspace'])
            this._wmSignals.push(global.window_manager.connect(sig, onWindowEvent));

        this._watchFocusedWindow();
        this._setCalendar();
        this._requestWeather();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._setCalendar();
            if (GLib.get_monotonic_time() - this._lastWeatherRequest >= REFRESH_SECONDS * 1000000)
                this._requestWeather();
            return GLib.SOURCE_CONTINUE;
        });
    }

    attach() {
        const bgGroup = Main.layoutManager._backgroundGroup;
        bgGroup.add_child(this.actor);
        this._bgAddedSignal = bgGroup.connect('actor-added', (_group, actor) => {
            if (actor !== this.actor)
                this._scheduleReposition();
        });
        this._reposition();
        this._scheduleReposition();
    }

    _scheduleReposition() {
        if (this._repositionIdleId)
            return;
        this._repositionIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._repositionIdleId = 0;
            this._reposition();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleVisibilityUpdate() {
        if (this._visibilityIdleId)
            return;
        this._visibilityIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._visibilityIdleId = 0;
            this._updateVisibility();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearFocusedWindowWatch() {
        if (this._focusedWin) {
            for (const sig of this._focusedWinSignals) {
                try { this._focusedWin.disconnect(sig); } catch (_e) {}
            }
        }
        this._focusedWin = null;
        this._focusedWinSignals = [];
    }

    _watchFocusedWindow() {
        this._clearFocusedWindowWatch();
        const win = global.display.focus_window;
        if (!win)
            return;
        this._focusedWin = win;
        this._focusedWinSignals.push(
            win.connect('position-changed', () => this._scheduleVisibilityUpdate()),
            win.connect('size-changed', () => this._scheduleVisibilityUpdate()),
            win.connect('unmanaged', () => {
                this._clearFocusedWindowWatch();
                this._scheduleVisibilityUpdate();
            })
        );
    }

    _getCardBounds(monitor) {
        const panelHeight = Main.layoutManager.panelBox
            ? Math.round(Main.layoutManager.panelBox.height)
            : 27;
        let baseX = monitor.x;
        let baseY = monitor.y + Math.max(panelHeight, 27);
        try {
            const ws = global.workspace_manager.get_active_workspace();
            const wa = ws ? ws.get_work_area_for_monitor(Main.layoutManager.primaryIndex) : null;
            if (wa && wa.width > 0 && wa.height > 0) {
                baseX = wa.x;
                baseY = wa.y;
            }
        } catch (_e) {}
        return {
            x: baseX + 22,
            y: baseY + 18,
            w: this._cachedW,
            h: this._cachedH,
        };
    }

    _setCardsVisible(visible) {
        if (this._cardsVisible === visible)
            return;
        this._cardsVisible = visible;
        // Toggle opacity + reactivity instead of show()/hide() to avoid queueing
        // relayouts on MetaWindowGroup during window/overview animations.
        this.actor.opacity = visible ? 255 : 0;
        this._calendar.reactive = visible;
        this._weather.reactive = visible;
    }

    _reposition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) {
            this._setCardsVisible(false);
            return;
        }
        try {
            const [, , natW, natH] = this.actor.get_preferred_size();
            this._cachedW = Math.max(Math.round(natW || 0), 364);
            this._cachedH = Math.max(Math.round(natH || 0), 292);
        } catch (_e) {}
        const bounds = this._getCardBounds(monitor);
        if (this._lastX !== bounds.x || this._lastY !== bounds.y) {
            this._lastX = bounds.x;
            this._lastY = bounds.y;
            this.actor.set_position(bounds.x, bounds.y);
        }
        const parent = this.actor.get_parent();
        if (parent && parent.get_last_child() !== this.actor)
            parent.set_child_above_sibling(this.actor, null);
        this._updateVisibility();
    }

    _updateVisibility() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || Main.overview.visible) {
            this._setCardsVisible(false);
            return;
        }
        const bounds = this._getCardBounds(monitor);
        if (bounds.w + 44 > monitor.width || bounds.h + 64 > monitor.height) {
            this._setCardsVisible(false);
            return;
        }

        const pad = 12;
        const cx1 = bounds.x - pad;
        const cy1 = bounds.y - pad;
        const cx2 = bounds.x + bounds.w + pad;
        const cy2 = bounds.y + bounds.h + pad;

        let obscured = false;
        const workspace = global.workspace_manager.get_active_workspace();
        const windows = workspace ? workspace.list_windows() : [];
        for (const win of windows) {
            if (!win || win.minimized || !win.showing_on_its_workspace())
                continue;
            const type = win.window_type;
            if (type === Meta.WindowType.DESKTOP || type === Meta.WindowType.DOCK)
                continue;
            const rect = win.get_frame_rect();
            if (!rect || rect.width <= 0 || rect.height <= 0)
                continue;
            const overlaps = rect.x < cx2 && rect.x + rect.width > cx1 &&
                             rect.y < cy2 && rect.y + rect.height > cy1;
            if (overlaps) {
                obscured = true;
                break;
            }
        }

        this._setCardsVisible(!obscured);
    }

    _setCalendar() {
        const now = new Date();
        if (this._calendarDate === now.toDateString())
            return;
        this._calendarDate = now.toDateString();
        const year = now.getFullYear();
        const month = now.getMonth();
        this._month.text = `${month + 1} 月`;
        this._calendarDays.destroy_all_children();
        const firstDay = (new Date(year, month, 1).getDay() + 6) % 7;
        const lastDay = new Date(year, month + 1, 0).getDate();

        const week = new St.BoxLayout();
        for (const title of ['一', '二', '三', '四', '五', '六', '日'])
            week.add_child(label(title, 'desktop-day desktop-weekday'));
        this._calendarDays.add_child(week);
        for (let cell = 0; cell < 42; cell += 7) {
            const weekRow = new St.BoxLayout();
            for (let offset = 0; offset < 7; offset++) {
                const day = cell + offset - firstDay + 1;
                const title = day >= 1 && day <= lastDay ? String(day) : '';
                const style = day === now.getDate() ? 'desktop-day desktop-today' : 'desktop-day';
                weekRow.add_child(label(title, style));
            }
            this._calendarDays.add_child(weekRow);
        }
    }

    _requestWeather() {
        this._lastWeatherRequest = GLib.get_monotonic_time();
        const process = Gio.Subprocess.new(
            ['/usr/bin/curl', '-fsSL', '--max-time', '10', WEATHER_URL],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        process.communicate_utf8_async(null, this._weatherCancellation, (subprocess, result) => {
            if (this._weatherCancellation.is_cancelled())
                return;
            try {
                const [, output] = subprocess.communicate_utf8_finish(result);
                if (!subprocess.get_successful())
                    throw new Error('Weather request failed');
                const data = JSON.parse(output);
                const current = data.current_condition[0];
                const today = data.weather[0];
                this._temperature.text = `${current.temp_C}°`;
                this._weatherDetail.text = weatherDescription(current.weatherDesc[0].value);
                this._weatherRange.text = `↑ ${today.maxtempC}°  ↓ ${today.mintempC}°`;
            } catch (error) {
                this._weatherDetail.text = this._temperature.text === '—°' ? '天气暂不可用' : '天气更新失败';
            }
        });
    }

    destroy() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        if (this._repositionIdleId) {
            GLib.source_remove(this._repositionIdleId);
            this._repositionIdleId = 0;
        }
        if (this._visibilityIdleId) {
            GLib.source_remove(this._visibilityIdleId);
            this._visibilityIdleId = 0;
        }
        this._clearFocusedWindowWatch();
        for (const sig of this._displaySignals) {
            try { global.display.disconnect(sig); } catch (_e) {}
        }
        this._displaySignals = [];
        for (const sig of this._wmSignals) {
            try { global.window_manager.disconnect(sig); } catch (_e) {}
        }
        this._wmSignals = [];
        if (this._overviewShowSignal) {
            Main.overview.disconnect(this._overviewShowSignal);
            this._overviewShowSignal = 0;
        }
        if (this._overviewHidingSignal) {
            Main.overview.disconnect(this._overviewHidingSignal);
            this._overviewHidingSignal = 0;
        }
        if (this._overviewHideSignal) {
            Main.overview.disconnect(this._overviewHideSignal);
            this._overviewHideSignal = 0;
        }
        if (this._panelHeightSignal && Main.layoutManager.panelBox) {
            try { Main.layoutManager.panelBox.disconnect(this._panelHeightSignal); } catch (_e) {}
            this._panelHeightSignal = 0;
        }
        if (this._bgAddedSignal) {
            try { Main.layoutManager._backgroundGroup.disconnect(this._bgAddedSignal); } catch (_e) {}
            this._bgAddedSignal = 0;
        }
        if (this._layoutSignal) {
            Main.layoutManager.disconnect(this._layoutSignal);
            this._layoutSignal = 0;
        }
        this._weatherCancellation.cancel();
        this.actor.destroy();
    }
}

const QUICK_APPS = [
    { key: 'terminal', ids: ['org.gnome.Terminal.desktop'], fallbackIcon: 'utilities-terminal', label: '终端' },
    { key: 'chrome', ids: ['google-chrome.desktop', 'com.google.Chrome.desktop'], fallbackIcon: 'google-chrome', label: 'Chrome' },
    { key: 'files', ids: ['org.gnome.Nautilus.desktop'], fallbackIcon: 'system-file-manager', label: '文件' },
];

const SPINNER_RE = /[\u2800-\u28ff]/;

const QuickAppButton = GObject.registerClass(
class QuickAppButton extends PanelMenu.Button {
    _init(spec) {
        super._init(0.0, spec.label, false);
        this._spec = spec;
        this._menuTitleSignals = [];
        this._watchSignals = [];
        this._appSignal = 0;
        this._watchedApp = null;
        this.add_style_class_name('panel-quick-app');

        const box = new St.BoxLayout({ style_class: 'panel-quick-app-box' });
        const app = this._resolveApp();
        const icon = app
            ? app.create_icon_texture(16)
            : new St.Icon({ icon_name: spec.fallbackIcon, icon_size: 16 });
        icon.y_align = Clutter.ActorAlign.CENTER;
        box.add_child(icon);

        this._statusLabel = new St.Label({
            text: '',
            style_class: 'panel-quick-status',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._statusLabel.hide();
        box.add_child(this._statusLabel);
        this.add_child(box);

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (!isOpen)
                this._clearMenuTitleSignals();
        });

        this._appStateSignal = Shell.AppSystem.get_default().connect('app-state-changed', () => {
            this._syncWindowWatches();
        });
        this._syncWindowWatches();
    }

    _resolveApp() {
        const appSys = Shell.AppSystem.get_default();
        for (const id of this._spec.ids) {
            const app = appSys.lookup_app(id);
            if (app)
                return app;
        }
        return null;
    }

    _clearWatchSignals() {
        for (const [win, sig] of this._watchSignals) {
            try { win.disconnect(sig); } catch (_e) {}
        }
        this._watchSignals = [];
        if (this._watchedApp && this._appSignal) {
            try { this._watchedApp.disconnect(this._appSignal); } catch (_e) {}
        }
        this._watchedApp = null;
        this._appSignal = 0;
    }

    _updateStatusBadge() {
        const app = this._resolveApp();
        const wins = app ? app.get_windows() : [];
        let spinner = '';
        for (const win of wins) {
            const title = win.get_title() || '';
            const m = title.match(SPINNER_RE);
            if (m) {
                spinner = m[0];
                break;
            }
        }
        if (spinner) {
            this._statusLabel.text = spinner;
            this._statusLabel.show();
        } else {
            this._statusLabel.text = '';
            this._statusLabel.hide();
        }
    }

    _syncWindowWatches() {
        this._clearWatchSignals();
        const app = this._resolveApp();
        if (app) {
            this._watchedApp = app;
            this._appSignal = app.connect('windows-changed', () => this._syncWindowWatches());
            for (const win of app.get_windows()) {
                const sig = win.connect('notify::title', () => this._updateStatusBadge());
                this._watchSignals.push([win, sig]);
            }
        }
        this._updateStatusBadge();
    }

    _clearMenuTitleSignals() {
        for (const [win, sig] of this._menuTitleSignals) {
            try { win.disconnect(sig); } catch (_e) {}
        }
        this._menuTitleSignals = [];
    }

    _formatWindowLabel(win, focused) {
        let title = win.get_title() || this._spec.label;
        if (title.length > 48)
            title = title.slice(0, 47) + '…';
        const prefix = win === focused ? '● ' : '   ';
        return prefix + title;
    }

    _rebuildMenu(app, wins) {
        this._clearMenuTitleSignals();
        this.menu.removeAll();
        const focused = global.display.focus_window;
        if (wins.length > 0) {
            for (const win of wins) {
                const item = new PopupMenu.PopupMenuItem(this._formatWindowLabel(win, focused));
                item.connect('activate', () => Main.activateWindow(win));
                const sig = win.connect('notify::title', () => {
                    item.label.text = this._formatWindowLabel(win, global.display.focus_window);
                });
                this._menuTitleSignals.push([win, sig]);
                this.menu.addMenuItem(item);
            }
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }
        const newItem = new PopupMenu.PopupMenuItem(`新建${this._spec.label}窗口`);
        newItem.connect('activate', () => {
            if (app) {
                if (wins.length > 0 && app.can_open_new_window())
                    app.open_new_window(-1);
                else
                    app.activate();
            }
        });
        this.menu.addMenuItem(newItem);
    }

    vfunc_event(event) {
        if (event.type() === Clutter.EventType.BUTTON_PRESS) {
            const btn = event.get_button();
            const app = this._resolveApp();
            const wins = app ? app.get_windows() : [];
            if (btn === 1 && wins.length <= 1) {
                this.menu.close();
                if (app) {
                    if (wins.length === 1)
                        Main.activateWindow(wins[0]);
                    else
                        app.activate();
                }
                return Clutter.EVENT_STOP;
            }
            this._rebuildMenu(app, wins);
        }
        return super.vfunc_event(event);
    }

    destroy() {
        this._clearMenuTitleSignals();
        this._clearWatchSignals();
        if (this._appStateSignal) {
            try { Shell.AppSystem.get_default().disconnect(this._appStateSignal); } catch (_e) {}
            this._appStateSignal = 0;
        }
        super.destroy();
    }
});

const DOCK_MAX_SCALE = 1.45;
const DOCK_SPREAD_RADIUS = 76;
const DOCK_LERP_ALPHA = 0.30;
const DOCK_LIFT_PX = 1;

class DockMagnifier {
    constructor() {
        this._docks = new Map();
        this._stageSignal = 0;
        this._overviewShowSignal = 0;
        this._overviewHideSignal = 0;
        this._monitorsSignal = 0;
        this._uiGroupAddedSignal = 0;
        this._attachTimeoutId = 0;
        this._syncIdleId = 0;
        this._animTimeoutId = 0;

        this._overviewShowSignal = Main.overview.connect('showing', () => this._resetImmediate());
        this._overviewHidingSignal = Main.overview.connect('hiding', () => this._resetImmediate());
        this._overviewHideSignal = Main.overview.connect('hidden', () => this._scheduleSync());
        this._monitorsSignal = Main.layoutManager.connect('monitors-changed', () => {
            this._resetImmediate();
            this._scheduleSync();
        });
        this._uiGroupAddedSignal = Main.layoutManager.uiGroup.connect('actor-added', (_group, actor) => {
            if (actor && actor.name === 'dashtodockContainer')
                this._scheduleSync();
        });

        this._syncDocks();
        if (this._docks.size === 0) {
            let attempts = 0;
            this._attachTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                attempts++;
                this._syncDocks();
                if (this._docks.size > 0 || attempts >= 20) {
                    this._attachTimeoutId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _scheduleSync() {
        if (this._syncIdleId)
            return;
        this._syncIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._syncIdleId = 0;
            this._syncDocks();
            return GLib.SOURCE_REMOVE;
        });
    }

    _findAllDocks() {
        const found = [];
        for (const child of Main.layoutManager.uiGroup.get_children()) {
            if (child && child.name === 'dashtodockContainer' && child.dash)
                found.push(child);
        }
        return found;
    }

    _syncDocks() {
        const liveDocks = new Set(this._findAllDocks());
        for (const dock of Array.from(this._docks.keys())) {
            let alive = liveDocks.has(dock);
            if (alive) {
                try {
                    alive = !!dock.get_parent();
                } catch (_e) {
                    alive = false;
                }
            }
            if (!alive)
                this._detachDock(dock, true);
        }
        for (const dock of liveDocks) {
            if (!this._docks.has(dock))
                this._attachDock(dock);
        }
        if (this._docks.size > 0 && !this._stageSignal) {
            this._stageSignal = global.stage.connect('captured-event', (_stage, event) => {
                this._onStageEvent(event);
                return Clutter.EVENT_PROPAGATE;
            });
        } else if (this._docks.size === 0 && this._stageSignal) {
            global.stage.disconnect(this._stageSignal);
            this._stageSignal = 0;
        }
    }

    _attachDock(dock) {
        const dash = dock.dash;
        if (!dash)
            return;

        // Keep Ubuntu Dock's actor hierarchy intact (never reparent _box out of _scrollView)
        // and render magnified icons in a non-reactive overlay directly above the dock.
        const overlay = new Clutter.Actor({
            name: 'macosDockMagnifierOverlay',
            reactive: false,
            visible: false,
        });
        Main.layoutManager.uiGroup.add_child(overlay);
        try {
            Main.layoutManager.uiGroup.set_child_above_sibling(overlay, dock);
        } catch (_e) {}

        dock.add_style_class_name('macos-dock');

        const state = {
            dock,
            dash,
            overlay,
            destroySignal: 0,
            unmapSignal: 0,
            hoverActive: false,
            pointerX: 0,
            scales: new Map(),
            mirrors: new Map(),
            hiddenVisuals: new Set(),
        };

        state.destroySignal = dock.connect('destroy', () => {
            this._detachDock(dock, true);
            this._scheduleSync();
        });
        state.unmapSignal = dock.connect('notify::mapped', () => {
            try {
                if (!dock.mapped)
                    this._resetStateImmediate(state);
            } catch (_e) {}
        });

        this._docks.set(dock, state);
    }

    _clearOverlay(state) {
        for (const visual of state.hiddenVisuals) {
            try { visual.opacity = 255; } catch (_e) {}
        }
        state.hiddenVisuals.clear();
        for (const mirror of state.mirrors.values()) {
            try { mirror.destroy(); } catch (_e) {}
        }
        state.mirrors.clear();
        if (state.overlay) {
            try { state.overlay.hide(); } catch (_e) {}
        }
    }

    _detachDock(dock, alreadyDisposed) {
        const state = this._docks.get(dock);
        if (!state)
            return;
        this._docks.delete(dock);

        this._clearOverlay(state);
        state.scales.clear();
        if (state.overlay) {
            try { state.overlay.destroy(); } catch (_e) {}
            state.overlay = null;
        }
        if (!alreadyDisposed) {
            if (state.destroySignal) {
                try { dock.disconnect(state.destroySignal); } catch (_e) {}
            }
            if (state.unmapSignal) {
                try { dock.disconnect(state.unmapSignal); } catch (_e) {}
            }
            try { dock.remove_style_class_name('macos-dock'); } catch (_e) {}
        }
        if (this._docks.size === 0 && this._stageSignal) {
            global.stage.disconnect(this._stageSignal);
            this._stageSignal = 0;
        }
    }

    _getAllDockChildren(state) {
        const dash = state.dash;
        if (!dash || !dash._box)
            return [];
        const items = [];
        try {
            for (const child of dash._box.get_children()) {
                if (!child.visible || !child.mapped)
                    continue;
                const isIcon = !!(child.has_style_class_name && child.has_style_class_name('dash-item-container'));
                const isSep = !!(child.has_style_class_name && child.has_style_class_name('dash-separator'));
                if (isIcon || isSep)
                    items.push({ actor: child, isIcon });
            }
            if (dash._showAppsIcon && dash._showAppsIcon.visible && dash._showAppsIcon.mapped)
                items.push({ actor: dash._showAppsIcon, isIcon: true, isShowApps: true });
        } catch (_e) {
            return [];
        }
        return items;
    }

    _getIconVisual(item) {
        const appBtn = item.child || item;
        if (appBtn && appBtn.icon && appBtn.icon._iconBin)
            return appBtn.icon._iconBin;
        if (item.icon && item.icon._iconBin)
            return item.icon._iconBin;
        return null;
    }

    _getOrCreateMirror(state, visual, isShowApps) {
        const stIcon = visual && visual.child;
        if (!stIcon || !(stIcon instanceof St.Icon))
            return null;

        const baseSize = state.dash ? (state.dash.iconSize || 42) : 42;
        const hiResSize = Math.round(baseSize * DOCK_MAX_SCALE);
        let mirror = state.mirrors.get(visual);
        if (mirror) {
            const iconActor = isShowApps ? mirror.child : mirror;
            if (iconActor instanceof St.Icon) {
                if (stIcon.gicon && iconActor.gicon !== stIcon.gicon)
                    iconActor.gicon = stIcon.gicon;
                else if (!stIcon.gicon && stIcon.icon_name && iconActor.icon_name !== stIcon.icon_name)
                    iconActor.icon_name = stIcon.icon_name;
            }
            return mirror;
        }

        const props = {
            reactive: false,
            icon_size: hiResSize,
            width: baseSize,
            height: baseSize,
        };
        if (stIcon.style_class)
            props.style_class = stIcon.style_class;
        if (stIcon.gicon)
            props.gicon = stIcon.gicon;
        else if (stIcon.icon_name)
            props.icon_name = stIcon.icon_name;
        else
            return null;

        const iconActor = new St.Icon(props);
        if (isShowApps) {
            // Preserve WhiteSur's `.show-apps .show-apps-icon` CSS selector (view-app-grid.svg)
            if (!iconActor.has_style_class_name('show-apps-icon'))
                iconActor.add_style_class_name('show-apps-icon');
            mirror = new St.Bin({
                style_class: 'show-apps',
                reactive: false,
                width: baseSize,
                height: baseSize,
                child: iconActor,
            });
        } else {
            mirror = iconActor;
        }

        mirror.set_pivot_point(0.5, 1.0);
        state.overlay.add_child(mirror);
        state.mirrors.set(visual, mirror);
        return mirror;
    }

    _pointerInDockMonitor(dock, px, py) {
        const monIdx = typeof dock.monitorIndex === 'number' ? dock.monitorIndex : -1;
        if (monIdx >= 0 && monIdx < Main.layoutManager.monitors.length) {
            const m = Main.layoutManager.monitors[monIdx];
            return px >= m.x && px < m.x + m.width && py >= m.y && py < m.y + m.height;
        }
        return true;
    }

    _isPointerInDockZone(state, px, py) {
        const dock = state.dock;
        const bg = state.dash._background;
        const slider = dock._slider;
        if (Main.overview.visible || !dock.mapped || !bg || !bg.visible || (slider && slider.slideX < 0.99))
            return false;
        if (!this._pointerInDockMonitor(dock, px, py))
            return false;
        const [bx, by] = bg.get_transformed_position();
        const [bw, bh] = bg.get_transformed_size();
        if (bw <= 0 || bh <= 0)
            return false;
        const topPad = state.hoverActive ? 34 : 6;
        const sidePad = state.hoverActive ? 20 : 6;
        return px >= bx - sidePad && px <= bx + bw + sidePad &&
               py >= by - topPad && py <= by + bh + 10;
    }

    _onStageEvent(event) {
        if (this._docks.size === 0 || Main.overview.visible) {
            let needAnim = false;
            for (const state of this._docks.values()) {
                if (state.hoverActive) {
                    state.hoverActive = false;
                    needAnim = true;
                }
            }
            if (needAnim)
                this._startAnim();
            return;
        }
        const type = event.type();
        if (type === Clutter.EventType.LEAVE) {
            let needAnim = false;
            for (const state of this._docks.values()) {
                if (state.hoverActive) {
                    state.hoverActive = false;
                    needAnim = true;
                }
            }
            if (needAnim)
                this._startAnim();
            return;
        }
        if (type !== Clutter.EventType.MOTION && type !== Clutter.EventType.ENTER)
            return;

        const [px, py] = event.get_coords();
        let needAnim = false;

        for (const [dock, state] of Array.from(this._docks.entries())) {
            try {
                if (!dock.get_parent()) {
                    this._detachDock(dock, true);
                    continue;
                }
                if (this._isPointerInDockZone(state, px, py)) {
                    state.hoverActive = true;
                    state.pointerX = px;
                    needAnim = true;
                } else if (state.hoverActive) {
                    state.hoverActive = false;
                    needAnim = true;
                }
            } catch (_e) {
                this._detachDock(dock, true);
            }
        }

        if (needAnim)
            this._startAnim();
    }

    _startAnim() {
        if (this._animTimeoutId)
            return;
        this._animTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            return this._stepAnim();
        });
    }

    _stepStateAnim(state) {
        // On X11, global.stage stops receiving MOTION events once the pointer moves onto
        // an application window; poll global.get_pointer() while active so icons always shrink back.
        if (state.hoverActive) {
            const [px, py] = global.get_pointer();
            if (this._isPointerInDockZone(state, px, py))
                state.pointerX = px;
            else
                state.hoverActive = false;
        }

        const entries = this._getAllDockChildren(state);
        if (entries.length === 0) {
            this._clearOverlay(state);
            return false;
        }

        const targets = [];
        const widths = [];
        for (const entry of entries) {
            const actor = entry.actor;
            const [ix] = actor.get_transformed_position();
            const iw = actor.width || 44;
            const restCenterX = ix + iw / 2;
            widths.push(iw);

            let target = 1.0;
            if (state.hoverActive && entry.isIcon) {
                const dist = Math.abs(state.pointerX - restCenterX);
                if (dist < DOCK_SPREAD_RADIUS) {
                    const norm = dist / DOCK_SPREAD_RADIUS;
                    const cosine = (Math.cos(norm * Math.PI) + 1) * 0.5;
                    const focused = cosine * cosine;
                    target = 1.0 + (DOCK_MAX_SCALE - 1.0) * focused;
                }
            }
            targets.push(target);
        }

        let stillMoving = false;
        let anyMagnified = false;
        const curScales = [];
        let totalExtraW = 0;
        const extraWs = [];

        for (let i = 0; i < entries.length; i++) {
            const actor = entries[i].actor;
            const prev = state.scales.has(actor) ? state.scales.get(actor) : 1.0;
            let next = prev + (targets[i] - prev) * DOCK_LERP_ALPHA;
            if (Math.abs(next - targets[i]) < 0.004)
                next = targets[i];
            else
                stillMoving = true;

            if (next > 1.001)
                anyMagnified = true;

            state.scales.set(actor, next);
            curScales.push(next);
            const extra = entries[i].isIcon ? widths[i] * (next - 1.0) * 0.45 : 0;
            extraWs.push(extra);
            totalExtraW += extra;
        }

        if (!state.hoverActive && !stillMoving && !anyMagnified) {
            this._clearOverlay(state);
            state.scales.clear();
            return false;
        }

        try {
            Main.layoutManager.uiGroup.set_child_above_sibling(state.overlay, state.dock);
        } catch (_e) {}
        state.overlay.show();

        const activeVisuals = new Set();
        let runningOffset = -totalExtraW * 0.5;
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const scale = curScales[i];
            const extra = extraWs[i];
            const tx = runningOffset + extra * 0.5;
            runningOffset += extra;

            if (!entry.isIcon)
                continue;

            const visual = this._getIconVisual(entry.actor);
            if (!visual)
                continue;

            const mirror = this._getOrCreateMirror(state, visual, entry.isShowApps);
            if (!mirror)
                continue;

            activeVisuals.add(visual);
            if (!state.hiddenVisuals.has(visual)) {
                visual.opacity = 0;
                state.hiddenVisuals.add(visual);
            }

            const [vx, vy] = visual.get_transformed_position();
            const [vw, vh] = visual.get_transformed_size();
            if (vw > 0 && vh > 0) {
                mirror.set_size(vw, vh);
                if (mirror instanceof St.Bin && mirror.child)
                    mirror.child.set_size(vw, vh);
            }
            mirror.set_position(Math.round(vx + tx), Math.round(vy));
            mirror.set_pivot_point(0.5, 1.0);
            mirror.scale_x = scale;
            mirror.scale_y = scale;
            mirror.translation_y = -(scale - 1.0) * DOCK_LIFT_PX;
            mirror.show();
        }

        // Restore/remove any visuals that disappeared from the dock mid-hover
        for (const visual of Array.from(state.hiddenVisuals)) {
            if (!activeVisuals.has(visual)) {
                try { visual.opacity = 255; } catch (_e) {}
                state.hiddenVisuals.delete(visual);
                const mirror = state.mirrors.get(visual);
                if (mirror) {
                    try { mirror.destroy(); } catch (_e) {}
                    state.mirrors.delete(visual);
                }
            }
        }

        return stillMoving || state.hoverActive;
    }

    _stepAnim() {
        if (this._docks.size === 0) {
            this._animTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        }

        let anyActive = false;
        for (const [dock, state] of Array.from(this._docks.entries())) {
            try {
                if (!dock.get_parent()) {
                    this._detachDock(dock, true);
                    continue;
                }
                if (this._stepStateAnim(state))
                    anyActive = true;
            } catch (_e) {
                this._detachDock(dock, true);
            }
        }

        if (!anyActive) {
            this._animTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    }

    _resetStateImmediate(state) {
        state.hoverActive = false;
        this._clearOverlay(state);
        state.scales.clear();
    }

    _resetImmediate() {
        if (this._animTimeoutId) {
            GLib.source_remove(this._animTimeoutId);
            this._animTimeoutId = 0;
        }
        for (const state of this._docks.values())
            this._resetStateImmediate(state);
    }

    destroy() {
        if (this._attachTimeoutId) {
            GLib.source_remove(this._attachTimeoutId);
            this._attachTimeoutId = 0;
        }
        if (this._syncIdleId) {
            GLib.source_remove(this._syncIdleId);
            this._syncIdleId = 0;
        }
        this._resetImmediate();
        if (this._stageSignal) {
            global.stage.disconnect(this._stageSignal);
            this._stageSignal = 0;
        }
        if (this._overviewShowSignal) {
            Main.overview.disconnect(this._overviewShowSignal);
            this._overviewShowSignal = 0;
        }
        if (this._overviewHidingSignal) {
            Main.overview.disconnect(this._overviewHidingSignal);
            this._overviewHidingSignal = 0;
        }
        if (this._overviewHideSignal) {
            Main.overview.disconnect(this._overviewHideSignal);
            this._overviewHideSignal = 0;
        }
        if (this._monitorsSignal) {
            Main.layoutManager.disconnect(this._monitorsSignal);
            this._monitorsSignal = 0;
        }
        if (this._uiGroupAddedSignal) {
            Main.layoutManager.uiGroup.disconnect(this._uiGroupAddedSignal);
            this._uiGroupAddedSignal = 0;
        }
        for (const dock of Array.from(this._docks.keys()))
            this._detachDock(dock, false);
        this._docks.clear();
    }
}
class DockWorkareaGuard {
    constructor() {
        this._pendingIdleIds = [];
        this._lastClampTime = new WeakMap();
        this._grabEndSignal = global.display.connect('grab-op-end', (_display, arg1, arg2) => {
            const win = arg1 instanceof Meta.Window ? arg1 : (arg2 instanceof Meta.Window ? arg2 : null);
            if (win)
                this._scheduleClamp(win, true);
        });
        this._monitorsSignal = Main.layoutManager.connect('monitors-changed', () => {
            this._scheduleClampAll();
        });
    }

    _scheduleClamp(win, force) {
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._pendingIdleIds = this._pendingIdleIds.filter(t => t !== id);
            this._clampWindow(win, force);
            return GLib.SOURCE_REMOVE;
        });
        this._pendingIdleIds.push(id);
    }

    _scheduleClampAll() {
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._pendingIdleIds = this._pendingIdleIds.filter(t => t !== id);
            const workspace = global.workspace_manager.get_active_workspace();
            const windows = workspace ? workspace.list_windows() : [];
            for (const win of windows)
                this._clampWindow(win, false);
            return GLib.SOURCE_REMOVE;
        });
        this._pendingIdleIds.push(id);
    }

    _getMonitorMaxBottom(monitor, workArea) {
        const workBottom = workArea.y + workArea.height;
        const bottomReserved = (monitor.y + monitor.height) - workBottom;
        if (bottomReserved > 0)
            return workBottom;

        // Fallback if a fixed bottom dock is visible on this monitor before struts settle
        for (const child of Main.layoutManager.uiGroup.get_children()) {
            if (!child || child.name !== 'dashtodockContainer' || !child.visible || !child.dash)
                continue;
            const bg = child.dash._background;
            if (!bg || !bg.visible)
                continue;
            try {
                const [bx, by] = bg.get_transformed_position();
                const [bw, bh] = bg.get_transformed_size();
                if (bw <= 0 || bh <= 0)
                    continue;
                const cx = bx + bw * 0.5;
                const cy = by + bh * 0.5;
                if (cx >= monitor.x && cx < monitor.x + monitor.width &&
                    cy >= monitor.y && cy < monitor.y + monitor.height &&
                    by > monitor.y + monitor.height * 0.5) {
                    return Math.floor(by) - 4;
                }
            } catch (_e) {}
        }
        return null;
    }

    _clampWindow(win, force) {
        if (!win)
            return;
        try {
            if (win.minimized || win.is_fullscreen() || win.is_override_redirect())
                return;
            if (win.window_type !== Meta.WindowType.NORMAL)
                return;
            if (win.get_maximized() === Meta.MaximizeFlags.BOTH)
                return;

            const now = GLib.get_monotonic_time();
            const prev = this._lastClampTime.get(win) || 0;
            if (!force && now - prev < 350000)
                return;

            const monIdx = win.get_monitor();
            if (monIdx < 0 || monIdx >= Main.layoutManager.monitors.length)
                return;
            const monitor = Main.layoutManager.monitors[monIdx];
            const workspace = win.get_workspace() || global.workspace_manager.get_active_workspace();
            if (!workspace)
                return;
            const workArea = workspace.get_work_area_for_monitor(monIdx);
            if (!workArea || workArea.height <= 0)
                return;

            const maxBottom = this._getMonitorMaxBottom(monitor, workArea);
            if (maxBottom === null)
                return;

            const rect = win.get_frame_rect();
            if (!rect || rect.width <= 0 || rect.height <= 0)
                return;

            if (rect.y + rect.height <= maxBottom)
                return;

            this._lastClampTime.set(win, now);
            const allowedHeight = Math.max(120, maxBottom - workArea.y);
            if (rect.height > allowedHeight) {
                win.move_resize_frame(true, rect.x, workArea.y, rect.width, allowedHeight);
            } else {
                const newY = Math.max(workArea.y, maxBottom - rect.height);
                win.move_frame(true, rect.x, newY);
            }
        } catch (_e) {}
    }

    destroy() {
        for (const id of this._pendingIdleIds) {
            try { GLib.source_remove(id); } catch (_e) {}
        }
        this._pendingIdleIds = [];
        if (this._grabEndSignal) {
            global.display.disconnect(this._grabEndSignal);
            this._grabEndSignal = 0;
        }
        if (this._monitorsSignal) {
            Main.layoutManager.disconnect(this._monitorsSignal);
            this._monitorsSignal = 0;
        }
    }
}

class PanelIcons {
    enable() {
        const { activities, appMenu } = Main.panel.statusArea;
        this._activities = activities;
        this._activitiesLabel = activities._label;
        this._appMenu = appMenu;
        this._appMenuWasVisible = appMenu.container.visible;
        this._appLabel = appMenu._label;
        this._appLabelWasVisible = this._appLabel.visible;
        const iconFile = ExtensionUtils.getCurrentExtension().dir.get_child('apple.svg');
        this._icon = new St.Icon({
            gicon: new Gio.FileIcon({ file: iconFile }),
            icon_size: 17,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._activities.set_accessible_name(this._activitiesLabel.text);
        this._activitiesLabel.hide();
        this._activities.insert_child_at_index(this._icon, 0);
        this._appLabel.hide();
        appMenu.container.hide();

        this._quickButtons = [];
        const actIndex = Main.panel._leftBox.get_children().indexOf(activities.container);
        let insertPos = actIndex >= 0 ? actIndex + 1 : 1;
        for (const spec of QUICK_APPS) {
            const btn = new QuickAppButton(spec);
            Main.panel.addToStatusArea(`panel-quick-${spec.key}`, btn, insertPos++, 'left');
            this._quickButtons.push(btn);
        }

        this._cards = new DesktopCards();
        this._cards.attach();

        this._dockMagnifier = new DockMagnifier();
        this._dockWorkareaGuard = new DockWorkareaGuard();
    }

    disable() {
        if (this._dockWorkareaGuard)
            this._dockWorkareaGuard.destroy();
        if (this._dockMagnifier)
            this._dockMagnifier.destroy();
        if (this._cards)
            this._cards.destroy();
        if (this._quickButtons) {
            for (const btn of this._quickButtons)
                btn.destroy();
        }
        if (this._icon)
            this._icon.destroy();
        if (this._activitiesLabel)
            this._activitiesLabel.show();
        if (this._appLabel)
            this._appLabel.visible = this._appLabelWasVisible;
        if (this._appMenu)
            this._appMenu.container.visible = this._appMenuWasVisible;
        this._dockWorkareaGuard = null;
        this._dockMagnifier = null;
        this._cards = null;
        this._quickButtons = null;
        this._icon = null;
        this._appMenu = null;
    }
}

function init() {
    return new PanelIcons();
}
