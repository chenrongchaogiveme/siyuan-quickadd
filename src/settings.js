
const {uid} = require("./utils");

function defaultActionCapture() {
    return {
        target: "current",
        notebook: "",
        path: "",
        docId: "",
        createIfMissing: true,
        position: "append",
        content: "- {{time}} {{input:内容}}",
    };
}

function defaultActionTemplate() {
    return {
        location: "notebook",
        notebook: "",
        folder: "/",
        chooseFolder: false,
        title: "{{date:YYYY-MM-DD}} {{input:标题}}",
        source: "inline",
        content: "",
        file: "",
        tags: "",
        onExists: "open",
        openAfter: true,
    };
}

/* ------------------------------------------------------------------ */
/* 选择动作：配置模型与兼容归一化                                      */
/* one  = 旧版行为，只选择一个动作                                    */
/* many = 勾选多个动作，按 children 的配置顺序执行                     */
/* ------------------------------------------------------------------ */

function defaultActionMulti() {
    return {
        children: [],
        mode: "one",
        stopOnError: true,
    };
}

function defaultSettings() {
    return {
        version: 1,
        showTopBar: true,
        showSlash: true,
        notifyOnRun: true,
        actions: [
            {
                id: "act-capture-demo",
                name: "快速记录",
                type: "capture",
                icon: "⚡",
                hotkey: "",
                enabled: true,
                capture: defaultActionCapture(),
            },
            {
                id: "act-template-demo",
                name: "新建笔记",
                type: "template",
                icon: "📝",
                hotkey: "",
                enabled: true,
                template: Object.assign(defaultActionTemplate(), {
                    content: "## {{input:标题}}\n\n> 创建于 {{datetime}}\n\n",
                }),
            },
        ],
        recent: {},
    };
}

function normalizeAction(raw) {
    const action = Object.assign({
        id: uid(),
        name: "未命名动作",
        type: "capture",
        icon: "⚡",
        hotkey: "",
        enabled: true,
    }, raw || {});
    if (!["capture", "template", "macro", "multi"].includes(action.type)) {
        action.type = "capture";
    }
    if (!action.id) {
        action.id = uid();
    }
    action.name = String(action.name || "未命名动作");
    action.enabled = action.enabled !== false;
    action.icon = String(action.icon || "⚡");
    action.hotkey = String(action.hotkey || "");
    action.group = String(action.group || "").trim();
    if (action.type === "capture") {
        action.capture = Object.assign(defaultActionCapture(), action.capture || {});
    } else if (action.type === "template") {
        action.template = Object.assign(defaultActionTemplate(), action.template || {});
        if (!["inline", "file"].includes(action.template.source)) {
            action.template.source = "inline";
        }
        delete action.template.docId;
    } else if (action.type === "macro") {
        action.macro = Object.assign({steps: []}, action.macro || {});
        if (!Array.isArray(action.macro.steps)) {
            action.macro.steps = [];
        }
    } else if (action.type === "multi") {
        action.multi = Object.assign(defaultActionMulti(), action.multi || {});
        if (!Array.isArray(action.multi.children)) {
            action.multi.children = [];
        }
        action.multi.children = Array.from(new Set(action.multi.children
            .map((id) => String(id || "").trim())
            .filter(Boolean)));
        if (!["one", "many"].includes(action.multi.mode)) {
            action.multi.mode = "one";
        }
        action.multi.stopOnError = action.multi.stopOnError !== false;
    }
    return action;
}

function normalizeSettings(raw) {
    const base = defaultSettings();
    const data = Object.assign({}, base, raw || {});
    if (!Array.isArray(data.actions)) {
        data.actions = base.actions;
    }
    data.actions = data.actions.map(normalizeAction);
    data.recent = data.recent && typeof data.recent === "object" ? data.recent : {};
    data.showTopBar = data.showTopBar !== false;
    data.showSlash = data.showSlash !== false;
    data.notifyOnRun = data.notifyOnRun !== false;
    return data;
}


module.exports = {
    defaultActionCapture,
    defaultActionTemplate,
    defaultActionMulti,
    defaultSettings,
    normalizeAction,
    normalizeSettings,
};
