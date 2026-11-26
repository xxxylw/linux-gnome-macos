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
        this._weatherCancellation = new Gio.Cancellable();
        this._repositionIdleId = 0;
        this._visibilityIdleId = 0;
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
        for (const sig of ['restacked', 'grab-op-end'])
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
        Main.layoutManager._backgroundGroup.add_child(this.actor);
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
        const marginX = 22;
        const marginY = Math.max(panelHeight + 18, 47);
        const w = Math.max(Math.round(this.actor.width || 0), 364);
        const h = Math.max(Math.round(this.actor.height || 0), 292);
        return {
            x: monitor.x + marginX,
            y: monitor.y + marginY,
            w,
            h,
        };
    }

    _reposition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) {
            this.actor.hide();
            return;
        }
        const bounds = this._getCardBounds(monitor);
        this.actor.set_position(bounds.x, bounds.y);
        const parent = this.actor.get_parent();
        if (parent)
            parent.set_child_above_sibling(this.actor, null);
        this._updateVisibility();
    }

    _updateVisibility() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || Main.overview.visible) {
            this.actor.hide();
            return;
        }
        const bounds = this._getCardBounds(monitor);
        if (bounds.w + 44 > monitor.width || bounds.h + 64 > monitor.height) {
            this.actor.hide();
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

        if (obscured)
            this.actor.hide();
        else
            this.actor.show();
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
        if (this._overviewHideSignal) {
            Main.overview.disconnect(this._overviewHideSignal);
            this._overviewHideSignal = 0;
        }
        if (this._panelHeightSignal && Main.layoutManager.panelBox) {
            try { Main.layoutManager.panelBox.disconnect(this._panelHeightSignal); } catch (_e) {}
            this._panelHeightSignal = 0;
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
        this._syncTimeoutIds = [];
        this._animTimeoutId = 0;

        this._overviewShowSignal = Main.overview.connect('showing', () => this._resetImmediate());
        this._overviewHideSignal = Main.overview.connect('hidden', () => this._syncDocks());
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
        this._syncDocks();
        for (const delay of [250, 750]) {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._syncTimeoutIds = this._syncTimeoutIds.filter(t => t !== id);
                this._syncDocks();
                return GLib.SOURCE_REMOVE;
            });
            this._syncTimeoutIds.push(id);
        }
    }

    _findAllDocks() {
        const found = [];
        for (const child of Main.layoutManager.uiGroup.get_children()) {
            if (child && child.name === 'dashtodockContainer' && child.dash)
                found.push(child);
        }
        return found;
    }

    _clearSlideClip(state) {
        try {
            if (state.dock && state.dock._box && state.dock._slider && state.dock._slider.slideX >= 0.99)
                state.dock._box.remove_clip();
        } catch (_e) {}
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
        }
    }

    _attachDock(dock) {
        const dash = dock.dash;
        if (!dash)
            return;

        const state = {
            dock,
            dash,
            savedClips: [],
            savedOffscreen: null,
            origSetClip: null,
            origEnsureItemVisibility: null,
            reparentedBox: false,
            destroySignal: 0,
            hoverActive: false,
            pointerX: 0,
            scales: new Map(),
        };

        dock.add_style_class_name('macos-dock');
        state.savedOffscreen = dash.offscreen_redirect;
        dash.offscreen_redirect = Clutter.OffscreenRedirect.NONE;

        // St.ScrollView always clips its child viewport in C (st_scroll_view_paint),
        // cutting off icons that pop above the top glass border. Move _box directly
        // into _dashContainer while keeping _scrollView intact for clean teardown.
        if (dash._scrollView && dash._box && dash._dashContainer &&
            dash._box.get_parent() === dash._scrollView) {
            const idx = dash._dashContainer.get_children().indexOf(dash._scrollView);
            dash._scrollView.remove_actor(dash._box);
            dash._dashContainer.insert_child_at_index(dash._box, idx >= 0 ? idx : 0);
            dash._scrollView.hide();
            state.reparentedBox = true;
            if (typeof dash._ensureItemVisibility === 'function') {
                state.origEnsureItemVisibility = dash._ensureItemVisibility;
                dash._ensureItemVisibility = () => {};
            }
        }

        const actorsToUnclip = [
            dock,
            dock._slider,
            dock._box,
            dash,
            dash._dashContainer,
            dash._scrollView,
            dash._box,
        ];
        for (const actor of actorsToUnclip) {
            if (actor) {
                state.savedClips.push([actor, actor.clip_to_allocation]);
                actor.clip_to_allocation = false;
            }
        }

        // DashSlideContainer.vfunc_allocate calls this._box.set_clip() AFTER allocate(),
        // which would re-clip icons popping above the top border on every relayout/tooltip.
        // Intercept set_clip on _box so it never clips while the dock is fully shown.
        if (dock._box) {
            const box = dock._box;
            const slider = dock._slider;
            state.origSetClip = box.set_clip;
            box.set_clip = (...args) => {
                if (slider && slider.slideX >= 0.99) {
                    box.remove_clip();
                    return;
                }
                state.origSetClip.apply(box, args);
            };
            box.remove_clip();
        }

        if (dash._background)
            dash._background.set_pivot_point(0.5, 1.0);

        state.destroySignal = dock.connect('destroy', () => {
            this._detachDock(dock, true);
        });

        this._docks.set(dock, state);
    }

    _detachDock(dock, alreadyDisposed) {
        const state = this._docks.get(dock);
        if (!state)
            return;
        this._docks.delete(dock);

        if (!alreadyDisposed) {
            this._resetStateImmediate(state);
            if (state.destroySignal) {
                try { dock.disconnect(state.destroySignal); } catch (_e) {}
            }
            if (state.origSetClip && dock._box) {
                try { dock._box.set_clip = state.origSetClip; } catch (_e) {}
            }
            if (state.origEnsureItemVisibility && state.dash) {
                try { state.dash._ensureItemVisibility = state.origEnsureItemVisibility; } catch (_e) {}
            }
            if (state.reparentedBox && state.dash && state.dash._box && state.dash._scrollView) {
                try {
                    if (state.dash._box.get_parent() === state.dash._dashContainer) {
                        state.dash._dashContainer.remove_child(state.dash._box);
                        state.dash._scrollView.add_actor(state.dash._box);
                        state.dash._scrollView.show();
                    }
                } catch (_e) {}
            }
            if (state.dash && state.savedOffscreen !== null) {
                try { state.dash.offscreen_redirect = state.savedOffscreen; } catch (_e) {}
            }
            for (const [actor, prevClip] of state.savedClips) {
                try { actor.clip_to_allocation = prevClip; } catch (_e) {}
            }
            try { dock.remove_style_class_name('macos-dock'); } catch (_e) {}
        }
        state.scales.clear();
    }

    _getAllDockChildren(state) {
        const dash = state.dash;
        if (!dash || !dash._box)
            return [];
        const items = [];
        try {
            for (const child of dash._box.get_children()) {
                if (!child.visible)
                    continue;
                const isIcon = !!(child.has_style_class_name && child.has_style_class_name('dash-item-container'));
                const isSep = !!(child.has_style_class_name && child.has_style_class_name('dash-separator'));
                if (isIcon || isSep)
                    items.push({ actor: child, isIcon });
            }
            if (dash._showAppsIcon && dash._showAppsIcon.visible)
                items.push({ actor: dash._showAppsIcon, isIcon: true });
        } catch (_e) {
            return [];
        }
        return items;
    }

    _getIconVisual(item) {
        // Scale only the icon texture container so the running indicator dot stays fixed at the bottom
        const appBtn = item.child || item;
        if (appBtn && appBtn.icon && appBtn.icon._iconBin)
            return appBtn.icon._iconBin;
        if (item.icon && item.icon._iconBin)
            return item.icon._iconBin;
        return appBtn;
    }

    _ensureHiResIcon(dash, visual) {
        const stIcon = visual && visual.child;
        if (!stIcon || !(stIcon instanceof St.Icon))
            return;
        if (stIcon._macosHiResApplied)
            return;
        const baseSize = dash ? (dash.iconSize || 42) : 42;
        const hiResSize = Math.round(baseSize * DOCK_MAX_SCALE);
        visual.set_size(baseSize, baseSize);
        stIcon.set_icon_size(hiResSize);
        stIcon.set_size(baseSize, baseSize);
        stIcon._macosHiResApplied = true;
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
            let bg;
            try {
                if (!dock.get_parent()) {
                    this._detachDock(dock, true);
                    continue;
                }
                bg = state.dash._background;
                if (!bg || !bg.visible) {
                    if (state.hoverActive) {
                        state.hoverActive = false;
                        needAnim = true;
                    }
                    continue;
                }
                const [bx, by] = bg.get_transformed_position();
                const [bw, bh] = bg.get_transformed_size();
                if (bw <= 0 || bh <= 0)
                    continue;

                const topPad = state.hoverActive ? 34 : 6;
                const sidePad = state.hoverActive ? 20 : 6;
                const inZone = px >= bx - sidePad && px <= bx + bw + sidePad &&
                               py >= by - topPad && py <= by + bh + 10;

                if (inZone) {
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
        for (const state of this._docks.values())
            this._clearSlideClip(state);
        this._animTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            return this._stepAnim();
        });
    }

    _stepStateAnim(state) {
        this._clearSlideClip(state);

        const entries = this._getAllDockChildren(state);
        if (entries.length === 0)
            return false;

        const targets = [];
        const widths = [];
        for (const entry of entries) {
            const actor = entry.actor;
            const [ix] = actor.get_transformed_position();
            const iw = actor.width || 44;
            const curTx = actor.translation_x || 0;
            const restCenterX = ix - curTx + iw / 2;
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

            state.scales.set(actor, next);
            curScales.push(next);
            const extra = entries[i].isIcon ? widths[i] * (next - 1.0) * 0.45 : 0;
            extraWs.push(extra);
            totalExtraW += extra;
        }

        let runningOffset = -totalExtraW * 0.5;
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const actor = entry.actor;
            const scale = curScales[i];
            const extra = extraWs[i];
            const tx = runningOffset + extra * 0.5;
            runningOffset += extra;

            actor.translation_x = tx;
            if (entry.isIcon) {
                const visual = this._getIconVisual(actor);
                this._ensureHiResIcon(state.dash, visual);
                visual.set_pivot_point(0.5, 1.0);
                visual.scale_x = scale;
                visual.scale_y = scale;
                visual.translation_y = -(scale - 1.0) * DOCK_LIFT_PX;
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
        for (const entry of this._getAllDockChildren(state)) {
            try {
                entry.actor.translation_x = 0;
                if (entry.isIcon) {
                    const visual = this._getIconVisual(entry.actor);
                    visual.scale_x = 1.0;
                    visual.scale_y = 1.0;
                    visual.translation_y = 0;
                }
            } catch (_e) {}
        }
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
        for (const id of this._syncTimeoutIds) {
            try { GLib.source_remove(id); } catch (_e) {}
        }
        this._syncTimeoutIds = [];
        this._resetImmediate();
        if (this._stageSignal) {
            global.stage.disconnect(this._stageSignal);
            this._stageSignal = 0;
        }
        if (this._overviewShowSignal) {
            Main.overview.disconnect(this._overviewShowSignal);
            this._overviewShowSignal = 0;
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
    }

    disable() {
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
