
/*
 * QuickAdd for SiYuan
 * Zero-build entry point: compose modules and manage the plugin lifecycle.
 */
const path = require("path");
const {createRequire} = require("module");
const workspaceDir = typeof window !== "undefined" && window.siyuan && window.siyuan.config && window.siyuan.config.system
    ? window.siyuan.config.system.workspaceDir
    : "";
const pluginRequire = workspaceDir
    ? createRequire(path.join(workspaceDir, "data", "plugins", "siyuan-quickadd", "index.js"))
    : require;
const siyuan = require("siyuan");
const {configureHost} = pluginRequire("./src/host");
configureHost(siyuan);
const {Plugin, Setting} = siyuan;
const DATA_FILE = "settings.json";

const {
    escapeHtml,
    toast,
    formatDate,
    sanitizeTitle,
    joinHPath,
} = pluginRequire("./src/utils");
const {
    configureVars,
    collectInputs,
    collectInputsFromAction,
    renderVars,
    renderGoLite,
    goLayoutToJs,
    stripIalIds,
} = pluginRequire("./src/vars");
const {
    configureContext,
    buildContext,
    resolveTargetDoc,
} = pluginRequire("./src/context");
const {
    configureActions,
    runActionInternal,
    runActionWithContext,
    executeMultiSelection,
    executeCapture,
    executeTemplate,
    rememberActionDocument,
    normalizeTags,
    prepareTemplateFolderChoice,
} = pluginRequire("./src/actions");
const {
    configureUI,
    QuickAddUI,
} = pluginRequire("./src/ui");
const {
    defaultSettings,
    normalizeSettings,
    normalizeAction,
} = pluginRequire("./src/settings");
const {
    createDoc,
    displayNotebookPath,
    resolveFolderChoicePath,
    listDocPathsUnder,
} = pluginRequire("./src/api");
const {
    normalizeHotkey,
    eventHotkey,
} = pluginRequire("./src/hotkeys");

let App = null;
const getApp = () => App;
configureVars({
    resolveStepAction: pluginRequire("./src/actions").resolveStepAction,
    getActions: () => (App && App.settings && App.settings.actions) || [],
});
configureContext({ui: QuickAddUI});
configureActions({getApp, ui: QuickAddUI});
configureUI({getApp});

const runActionById = pluginRequire("./src/actions").runActionById;
const typeBodyHtml = QuickAddUI.typeBodyHtml;

class QuickAddPlugin extends Plugin {
    constructor(options) {
        super(options);
        this.settings = defaultSettings();
        this._hotkeyHandler = null;
        this._commands = new Map();
    }

    async onload() {
        App = this;
        const saved = await this.loadData(DATA_FILE);
        this.settings = normalizeSettings(saved);
        if (!saved) {
            await this.saveData(DATA_FILE, this.settings);
        }
        this.setupTopBar();
        this.addCommand({
            langKey: "quickadd-open",
            langText: "打开 QuickAdd 面板",
            hotkey: "ctrl+alt+q",
            callback: () => QuickAddUI.openPanel(),
        });
        this.refreshCommands();
        this.refreshSlash();
        this.setupHotkeys();
        this.setupSetting();
        console.log("[quickadd] loaded", this.settings.actions.length, "actions");
    }

    onunload() {
        if (this._hotkeyHandler) {
            document.removeEventListener("keydown", this._hotkeyHandler, true);
            this._hotkeyHandler = null;
        }
        try {
            this.removeTopBar("quickadd");
        } catch (e) { /* ignore */ }
        try {
            this.setting?.close();
        } catch (e) { /* ignore */ }
        this.protyleSlash = [];
        App = null;
    }

    async saveSettings() {
        this.settings = normalizeSettings(this.settings);
        await this.saveData(DATA_FILE, this.settings);
        this.refreshSlash();
        this.refreshCommands();
    }

    markRecent(id) {
        this.settings.recent = this.settings.recent || {};
        this.settings.recent[id] = Date.now();
        const entries = Object.entries(this.settings.recent).sort((a, b) => b[1] - a[1]).slice(0, 30);
        this.settings.recent = Object.fromEntries(entries);
        void this.saveData(DATA_FILE, this.settings);
    }

    setupTopBar() {
        if (!this.settings.showTopBar) {
            return;
        }
        this.addTopBar({
            id: "quickadd",
            title: "QuickAdd",
            icon: `<svg viewBox="0 0 32 32" width="16" height="16"><path fill="currentColor" d="M18.9 2 5.4 19.1h7.2L11 30l13.6-17.6h-7.3L18.9 2z"/></svg>`,
            callback: () => QuickAddUI.openPanel(),
            contextMenu: (menu) => {
                menu.addItem({icon: "iconSettings", label: "动作管理", click: () => QuickAddUI.openManager()});
                menu.addItem({icon: "iconAdd", label: "新建动作", click: () => QuickAddUI.openEditor(null)});
            },
        });
    }

    refreshCommands() {
        const alive = new Set();
        this.settings.actions.forEach((action) => {
            alive.add(action.id);
            let command = this._commands.get(action.id);
            if (!command) {
                const id = action.id;
                command = {
                    langKey: "qa-" + id,
                    langText: "",
                    hotkey: "",
                    callback: () => runActionById(id),
                };
                this.addCommand(command);
                this._commands.set(action.id, command);
            }
            const id = action.id;
            command.langText = "执行：" + action.name;
            command.enabled = () => {
                const current = App && App.settings.actions.find((item) => item.id === id);
                return !!current && current.enabled !== false;
            };
        });
        this._commands.forEach((command, id) => {
            if (!alive.has(id)) {
                command.enabled = () => false;
            }
        });
    }

    refreshSlash() {
        if (!this.settings.showSlash) {
            this.protyleSlash = [];
            return;
        }
        const panelEntry = {
            id: "qa-open-panel",
            filter: ["qa", "quickadd", "快速添加", "面板"],
            html: `<div class="b3-list-item__first"><span class="qa-emoji">⚡</span><span class="b3-list-item__text">QuickAdd 面板</span><span class="b3-list-item__meta">QuickAdd</span></div>`,
            callback: () => {
                void QuickAddUI.openPanel();
            },
        };
        this.protyleSlash = [panelEntry].concat(this.settings.actions.filter((action) => action.enabled !== false).map((action) => ({
            id: "qa-" + action.id,
            filter: ["qa", "quickadd", action.name],
            html: `<div class="b3-list-item__first">${QuickAddUI.icon(action)}<span class="b3-list-item__text">${escapeHtml(action.name)}</span><span class="b3-list-item__meta">QuickAdd</span></div>`,
            callback: () => {
                void runActionById(action.id);
            },
        })));
    }

    setupHotkeys() {
        this._hotkeyHandler = (event) => {
            if (!(event.ctrlKey || event.altKey || event.metaKey)) {
                return;
            }
            const combo = eventHotkey(event);
            if (combo === "ctrl+alt+q") {
                event.preventDefault();
                event.stopPropagation();
                void QuickAddUI.openPanel();
                return;
            }
            const action = this.settings.actions.find((item) => item.enabled !== false && normalizeHotkey(item.hotkey) === combo);
            if (!action) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            void runActionById(action.id);
        };
        document.addEventListener("keydown", this._hotkeyHandler, true);
    }

    setupSetting() {
        this.setting = new Setting({
            confirmCallback: async () => {
                await this.saveSettings();
                this.syncTopBar();
            },
        });
        const makeSwitch = (key) => () => {
            const input = document.createElement("input");
            input.type = "checkbox";
            input.className = "b3-switch fn__flex-center";
            input.checked = this.settings[key] !== false;
            input.addEventListener("change", () => {
                this.settings[key] = input.checked;
            });
            return input;
        };
        this.setting.addItem({
            title: "显示顶栏按钮",
            description: "在顶栏显示 QuickAdd 闪电按钮",
            createActionElement: makeSwitch("showTopBar"),
            direction: "column",
        });
        this.setting.addItem({
            title: "显示斜杠菜单",
            description: "在编辑器输入 / 时列出所有动作",
            createActionElement: makeSwitch("showSlash"),
            direction: "column",
        });
        this.setting.addItem({
            title: "执行后提示",
            description: "动作执行完成后显示结果提示",
            createActionElement: makeSwitch("notifyOnRun"),
            direction: "column",
        });
        this.setting.addItem({
            title: "动作管理",
            description: "新增、编辑、排序、导入导出动作",
            createActionElement: () => {
                const button = document.createElement("button");
                button.className = "b3-button b3-button--outline";
                button.textContent = "打开动作管理";
                button.addEventListener("click", () => QuickAddUI.openManager());
                return button;
            },
            direction: "column",
        });
    }

    syncTopBar() {
        const exists = this.topBarIcons.some((item) => item.getAttribute("data-id") === "quickadd");
        if (this.settings.showTopBar && !exists) {
            this.setupTopBar();
        } else if (!this.settings.showTopBar && exists) {
            this.removeTopBar("quickadd");
        }
        this.refreshSlash();
    }
}

module.exports = QuickAddPlugin;
module.exports.__test = {
    buildContext,
    runActionInternal,
    typeBodyHtml,
    executeCapture,
    executeMultiSelection,
    executeTemplate,
    runActionWithContext,
    resolveTargetDoc,
    rememberActionDocument,
    createDoc,
    formatDate,
    renderVars,
    renderGoLite,
    goLayoutToJs,
    stripIalIds,
    collectInputs,
    collectInputsFromAction,
    normalizeSettings,
    normalizeAction,
    normalizeTags,
    normalizeHotkey,
    sanitizeTitle,
    joinHPath,
    displayNotebookPath,
    resolveFolderChoicePath,
    listDocPathsUnder,
    prepareTemplateFolderChoice,
    QuickAddUI,
    defaultSettings,
};
