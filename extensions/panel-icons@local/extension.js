const { Clutter, Gio, GLib, GObject, Shell, St } = imports.gi;
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
        this._reposition();
        this._layoutSignal = Main.layoutManager.connect('monitors-changed', () => this._reposition());
        this._setCalendar();
        this._requestWeather();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._setCalendar();
            if (GLib.get_monotonic_time() - this._lastWeatherRequest >= REFRESH_SECONDS * 1000000)
                this._requestWeather();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _reposition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor)
            this.actor.set_position(monitor.x + 22, monitor.y + 47);
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
        GLib.source_remove(this._timer);
        this._weatherCancellation.cancel();
        Main.layoutManager.disconnect(this._layoutSignal);
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
        this._dock = null;
        this._dash = null;
        this._savedClips = [];
        this._savedOffscreen = null;
        this._origSetClip = null;
        this._reparentedBox = false;
        this._stageSignal = 0;
        this._overviewShowSignal = 0;
        this._overviewHideSignal = 0;
        this._attachTimeoutId = 0;
        this._animTimeoutId = 0;
        this._hoverActive = false;
        this._pointerX = 0;
        this._scales = new Map();

        this._overviewShowSignal = Main.overview.connect('showing', () => this._resetImmediate());
        this._overviewHideSignal = Main.overview.connect('hidden', () => this._ensureAttached());

        this._ensureAttached();
        if (!this._dock) {
            let attempts = 0;
            this._attachTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                attempts++;
                this._ensureAttached();
                if (this._dock || attempts >= 20) {
                    this._attachTimeoutId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _findDock() {
        for (const child of Main.layoutManager.uiGroup.get_children()) {
            if (child.name === 'dashtodockContainer' && child.dash)
                return child;
        }
        return null;
    }

    _clearSlideClip() {
        if (this._dock && this._dock._box && this._dock._slider && this._dock._slider.slideX >= 0.99)
            this._dock._box.remove_clip();
    }

    _ensureAttached() {
        if (this._dock && this._dock.get_parent())
            return;
        const dock = this._findDock();
        if (!dock)
            return;

        this._dock = dock;
        this._dash = dock.dash;
        this._dock.add_style_class_name('macos-dock');

        this._savedOffscreen = this._dash.offscreen_redirect;
        this._dash.offscreen_redirect = Clutter.OffscreenRedirect.NONE;

        // St.ScrollView always clips its child viewport in C (st_scroll_view_paint),
        // cutting off icons that pop above the top glass border. Move _box directly
        // into _dashContainer while keeping _scrollView intact for clean teardown.
        if (this._dash._scrollView && this._dash._box && this._dash._dashContainer &&
            this._dash._box.get_parent() === this._dash._scrollView) {
            const idx = this._dash._dashContainer.get_children().indexOf(this._dash._scrollView);
            this._dash._scrollView.remove_actor(this._dash._box);
            this._dash._dashContainer.insert_child_at_index(this._dash._box, idx >= 0 ? idx : 0);
            this._dash._scrollView.hide();
            this._reparentedBox = true;
        }

        const actorsToUnclip = [
            this._dock,
            this._dock._slider,
            this._dock._box,
            this._dash,
            this._dash._dashContainer,
            this._dash._scrollView,
            this._dash._box,
        ];
        this._savedClips = [];
        for (const actor of actorsToUnclip) {
            if (actor) {
                this._savedClips.push([actor, actor.clip_to_allocation]);
                actor.clip_to_allocation = false;
            }
        }

        // DashSlideContainer.vfunc_allocate calls this._box.set_clip() AFTER allocate(),
        // which would re-clip icons popping above the top border on every relayout/tooltip.
        // Intercept set_clip on _box so it never clips while the dock is fully shown.
        if (this._dock._box && !this._origSetClip) {
            const box = this._dock._box;
            const slider = this._dock._slider;
            this._origSetClip = box.set_clip;
            box.set_clip = (...args) => {
                if (slider && slider.slideX >= 0.99) {
                    box.remove_clip();
                    return;
                }
                this._origSetClip.apply(box, args);
            };
            box.remove_clip();
        }

        if (this._dash._background)
            this._dash._background.set_pivot_point(0.5, 1.0);

        if (!this._stageSignal) {
            this._stageSignal = global.stage.connect('captured-event', (_stage, event) => {
                this._onStageEvent(event);
                return Clutter.EVENT_PROPAGATE;
            });
        }
    }

    _getAllDockChildren() {
        if (!this._dash || !this._dash._box)
            return [];
        const items = [];
        for (const child of this._dash._box.get_children()) {
            if (!child.visible)
                continue;
            const isIcon = !!(child.has_style_class_name && child.has_style_class_name('dash-item-container'));
            const isSep = !!(child.has_style_class_name && child.has_style_class_name('dash-separator'));
            if (isIcon || isSep)
                items.push({ actor: child, isIcon });
        }
        if (this._dash._showAppsIcon && this._dash._showAppsIcon.visible)
            items.push({ actor: this._dash._showAppsIcon, isIcon: true });
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

    _ensureHiResIcon(visual) {
        const stIcon = visual && visual.child;
        if (!stIcon || !(stIcon instanceof St.Icon))
            return;
        if (stIcon._macosHiResApplied)
            return;
        const baseSize = this._dash ? (this._dash.iconSize || 42) : 42;
        const hiResSize = Math.round(baseSize * DOCK_MAX_SCALE);
        visual.set_size(baseSize, baseSize);
        stIcon.set_icon_size(hiResSize);
        stIcon.set_size(baseSize, baseSize);
        stIcon._macosHiResApplied = true;
    }

    _onStageEvent(event) {
        if (!this._dock || !this._dash || Main.overview.visible) {
            if (this._hoverActive) {
                this._hoverActive = false;
                this._startAnim();
            }
            return;
        }
        const type = event.type();
        if (type === Clutter.EventType.LEAVE) {
            if (this._hoverActive) {
                this._hoverActive = false;
                this._startAnim();
            }
            return;
        }
        if (type !== Clutter.EventType.MOTION && type !== Clutter.EventType.ENTER)
            return;

        const [px, py] = event.get_coords();
        const bg = this._dash._background;
        if (!bg || !bg.visible)
            return;

        const [bx, by] = bg.get_transformed_position();
        const [bw, bh] = bg.get_transformed_size();
        if (bw <= 0 || bh <= 0)
            return;

        const topPad = this._hoverActive ? 34 : 6;
        const sidePad = this._hoverActive ? 20 : 6;
        const inZone = px >= bx - sidePad && px <= bx + bw + sidePad &&
                       py >= by - topPad && py <= by + bh + 10;

        if (inZone) {
            this._hoverActive = true;
            this._pointerX = px;
            this._startAnim();
        } else if (this._hoverActive) {
            this._hoverActive = false;
            this._startAnim();
        }
    }

    _startAnim() {
        if (this._animTimeoutId)
            return;
        this._clearSlideClip();
        this._animTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            return this._stepAnim();
        });
    }

    _stepAnim() {
        if (!this._dock || !this._dash) {
            this._animTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        }
        this._clearSlideClip();

        const entries = this._getAllDockChildren();
        if (entries.length === 0) {
            this._animTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        }

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
            if (this._hoverActive && entry.isIcon) {
                const dist = Math.abs(this._pointerX - restCenterX);
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
            const prev = this._scales.has(actor) ? this._scales.get(actor) : 1.0;
            let next = prev + (targets[i] - prev) * DOCK_LERP_ALPHA;
            if (Math.abs(next - targets[i]) < 0.004)
                next = targets[i];
            else
                stillMoving = true;

            this._scales.set(actor, next);
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
                this._ensureHiResIcon(visual);
                visual.set_pivot_point(0.5, 1.0);
                visual.scale_x = scale;
                visual.scale_y = scale;
                visual.translation_y = -(scale - 1.0) * DOCK_LIFT_PX;
            }
        }

        if (!stillMoving && !this._hoverActive) {
            this._animTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    }

    _resetImmediate() {
        this._hoverActive = false;
        if (this._animTimeoutId) {
            GLib.source_remove(this._animTimeoutId);
            this._animTimeoutId = 0;
        }
        for (const entry of this._getAllDockChildren()) {
            entry.actor.translation_x = 0;
            if (entry.isIcon) {
                const visual = this._getIconVisual(entry.actor);
                visual.scale_x = 1.0;
                visual.scale_y = 1.0;
                visual.translation_y = 0;
            }
        }
        this._scales.clear();
    }

    destroy() {
        if (this._attachTimeoutId) {
            GLib.source_remove(this._attachTimeoutId);
            this._attachTimeoutId = 0;
        }
        this._resetImmediate();
        if (this._origSetClip && this._dock && this._dock._box) {
            try { this._dock._box.set_clip = this._origSetClip; } catch (_e) {}
            this._origSetClip = null;
        }
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
        if (this._reparentedBox && this._dash && this._dash._box && this._dash._scrollView &&
            this._dash._box.get_parent() === this._dash._dashContainer) {
            try {
                this._dash._dashContainer.remove_child(this._dash._box);
                this._dash._scrollView.add_actor(this._dash._box);
                this._dash._scrollView.show();
            } catch (_e) {}
            this._reparentedBox = false;
        }
        if (this._dash && this._savedOffscreen !== null)
            this._dash.offscreen_redirect = this._savedOffscreen;
        for (const [actor, prevClip] of this._savedClips) {
            try { actor.clip_to_allocation = prevClip; } catch (_e) {}
        }
        this._savedClips = [];
        if (this._dock) {
            try { this._dock.remove_style_class_name('macos-dock'); } catch (_e) {}
        }
        this._dock = null;
        this._dash = null;
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
        Main.layoutManager._backgroundGroup.add_child(this._cards.actor);

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
