
const {hostRequire} = require("./host");
const {openTab} = hostRequire();
const {
    trimSlashes,
    joinHPath,
    sanitizeTitle,
    toast,
} = require("./utils");
const {
    defaultActionCapture,
    defaultActionTemplate,
    normalizeAction,
} = require("./settings");
const {
    collectInputs,
    collectInputsFromAction,
    renderVars,
    renderGoLite,
    stripIalIds,
} = require("./vars");
const {
    postOk,
    getIDsByHPath,
    createDoc,
    renderKernelTemplate,
} = require("./api");
const {
    buildContext,
    pickNotebookId,
    resolveTargetDoc,
    insertMarkdown,
} = require("./context");

let getApp = () => null;
let ui = null;

function configureActions(options) {
    const config = options || {};
    getApp = typeof config.getApp === "function" ? config.getApp : () => null;
    ui = config.ui || ui;
}

function normalizeTags(input) {
    const text = String(input || "").trim();
    if (!text) {
        return "";
    }
    if (/#/.test(text)) {
        return text;
    }
    return text.split(/[,，\s]+/).filter(Boolean).map((tag) => "#" + tag.replace(/^#+|#+$/g, "") + "#").join(" ");
}

function openDocument(id, ctx) {
    try {
        openTab({app: getApp() && getApp().app ? getApp().app : window.siyuan.ws.app, doc: {id: id, action: ["cb-get-all"]}});
    } catch (e) {
        console.error("[quickadd] openTab failed", e);
    }
    void ctx;
}

function rememberActionDocument(ctx, target, reveal) {
    if (!ctx || !target || !target.id) {
        return;
    }
    ctx.firstCreatedId = ctx.firstCreatedId || target.id;
    ctx.lastCreatedId = target.id;
    ctx.lastCreatedTitle = target.title || "";
    ctx.lastCreatedPath = target.path || "";
    ctx.lastCreatedNotebook = target.notebook || "";
    if (reveal) {
        ctx.docId = target.id;
        ctx.docTitle = target.title || "";
        ctx.title = ctx.docTitle;
        ctx.docPath = target.path || ctx.docPath || "";
        ctx.notebookId = target.notebook || ctx.notebookId;
    }
}

async function executeCapture(action, ctx) {
    const capture = action.capture || defaultActionCapture();
    let markdown = renderVars(capture.content, ctx);
    if (capture.target === "cursor") {
        const docId = await insertMarkdown(null, "cursor", markdown, ctx);
        return {docId: docId, message: "已插入到光标处"};
    }
    const target = await resolveTargetDoc(capture, ctx);
    let position = capture.position || "append";
    if (["after-block", "child-block"].includes(position)
        && (target.id !== ctx.docId || capture.target === "macro-created")) {
        position = "append";
    }
    await insertMarkdown(target, position, markdown, ctx);
    if (capture.openAfter) {
        openDocument(target.id, ctx);
    }
    return {docId: target.id, message: "已记录到「" + (target.title || target.id) + "」"};
}

async function readWorkspaceFile(relPath) {
    const clean = "/" + trimSlashes(relPath);
    const token = (window.siyuan && window.siyuan.config && window.siyuan.config.api && window.siyuan.config.api.token) || "";
    const response = await fetch("/api/file/getFile", {
        method: "POST",
        headers: {"Content-Type": "application/json", "Authorization": "Token " + token},
        body: JSON.stringify({path: clean}),
    });
    if (!response.ok) {
        throw new Error("读取模板文件失败：" + response.status);
    }
    return await response.text();
}

function parentFolderOf(hpath) {
    const value = String(hpath || "");
    const index = value.lastIndexOf("/");
    if (index <= 0) {
        return "/";
    }
    return value.slice(0, index);
}

async function prepareTemplateFolderChoice(action, ctx) {
    const tpl = action.template || defaultActionTemplate();
    if ((tpl.location || "notebook") !== "notebook" || !tpl.chooseFolder) {
        return true;
    }
    const folderInputs = collectInputs(tpl.folder, []);
    if (folderInputs.length) {
        const folderVars = await ui.askInputs(folderInputs, action.name);
        if (folderVars === null) {
            return false;
        }
        ctx.vars = Object.assign({}, ctx.vars || {}, folderVars);
    }
    const notebook = tpl.notebook || await pickNotebookId(ctx);
    const basePath = tpl.folder ? renderVars(tpl.folder, ctx) : "/";
    const picked = await ui.pickFolder({
        notebook: notebook,
        basePath: basePath,
        title: "选择保存路径",
    });
    if (picked == null) {
        return false;
    }
    ctx.templateFolderChoices = ctx.templateFolderChoices || {};
    ctx.templateFolderChoices[action.id] = {notebook: notebook, folder: picked};
    return true;
}

async function resolveTemplateLocation(tpl, ctx, action) {
    const location = tpl.location || "notebook";
    if (location === "current-folder") {
        if (!ctx.docId) {
            throw new Error("请先打开一篇文档，或改用「指定笔记本 + 父路径」");
        }
        return {notebook: ctx.notebookId, folder: ctx.docPath ? parentFolderOf(ctx.docPath) : "/", label: "当前文档所在目录"};
    }
    if (location === "current-doc") {
        if (!ctx.docId) {
            throw new Error("请先打开一篇文档，或改用「指定笔记本 + 父路径」");
        }
        return {notebook: ctx.notebookId, folder: ctx.docPath || "/", label: "当前文档下"};
    }
    if (location === "current-notebook") {
        if (!ctx.notebookId) {
            throw new Error("请先打开一篇文档，或改用「指定笔记本 + 父路径」");
        }
        return {notebook: ctx.notebookId, folder: "/", label: "当前笔记本根目录"};
    }
    const pickedChoice = action && ctx.templateFolderChoices && ctx.templateFolderChoices[action.id];
    if (pickedChoice) {
        return {notebook: pickedChoice.notebook, folder: pickedChoice.folder, label: "运行时选择"};
    }
    const notebook = tpl.notebook || await pickNotebookId(ctx);
    const folder = tpl.folder ? renderVars(tpl.folder, ctx) : "/";
    if (tpl.chooseFolder) {
        const picked = await ui.pickFolder({
            notebook: notebook,
            basePath: folder,
            title: "选择保存路径",
        });
        if (picked == null) {
            const error = new Error("已取消选择路径");
            error.cancelled = true;
            throw error;
        }
        return {notebook: notebook, folder: picked, label: "运行时选择"};
    }
    return {notebook: notebook, folder: folder, label: "指定路径"};
}

async function executeTemplate(action, ctx) {
    const tpl = action.template || defaultActionTemplate();
    const target = await resolveTemplateLocation(tpl, ctx, action);
    const notebook = target.notebook;
    if (!notebook) {
        throw new Error("未选择笔记本");
    }
    const folder = target.folder || "/";
    const title = sanitizeTitle(renderVars(tpl.title || "{{datetime}}", ctx));
    if (!title) {
        throw new Error("标题为空");
    }
    const hpath = joinHPath(folder, title);
    const existing = await getIDsByHPath(notebook, hpath);
    if (existing.length && tpl.onExists !== "duplicate") {
        rememberActionDocument(ctx, {
            id: existing[0],
            title: title,
            path: hpath,
            notebook: notebook,
        }, tpl.openAfter !== false);
        openDocument(existing[0], ctx);
        return {docId: existing[0], message: "文档已存在，已打开"};
    }
    const childCtx = Object.assign({}, ctx, {title: title, notebookId: notebook});
    const source = tpl.source === "file" ? "file" : "inline";
    let createdId = "";
    if (source === "file") {
        const file = String(tpl.file || "").trim();
        if (!file) {
            throw new Error("未填写模板文件");
        }
        const created = await createDoc(notebook, hpath, "");
        createdId = created;
        const dataDir = window.siyuan.config.system.dataDir;
        const absPath = dataDir.replace(/[\\/]+$/, "") + "/templates/" + trimSlashes(file);
        let raw = "";
        try {
            raw = await readWorkspaceFile("/data/templates/" + trimSlashes(file));
        } catch (e) {
            raw = "";
        }
        const prepared = raw ? renderGoLite(renderVars(raw, childCtx), childCtx) : "";
        let content = "";
        let isDom = true;
        try {
            try {
                content = await renderKernelTemplate(absPath, createdId, prepared || undefined);
            } catch (e) {
                if (!prepared) {
                    throw e;
                }
                content = stripIalIds(prepared);
                isDom = false;
            }
            await postOk("/api/block/appendBlock", {dataType: isDom ? "dom" : "markdown", data: content, parentID: createdId});
        } catch (e) {
            try {
                await postOk("/api/filetree/removeDocByID", {id: createdId});
            } catch (ignore) { /* ignore */ }
            throw e;
        }
    } else {
        let markdown = tpl.content || "";
        markdown = renderGoLite(renderVars(markdown, childCtx), childCtx);
        createdId = await createDoc(notebook, hpath, markdown);
    }
    const tags = normalizeTags(renderVars(tpl.tags || "", childCtx));
    if (tags && createdId) {
        try {
            await postOk("/api/attr/setBlockAttrs", {id: createdId, attrs: {tags: tags}});
        } catch (e) { /* ignore */ }
    }
    rememberActionDocument(ctx, {
        id: createdId,
        title: title,
        path: hpath,
        notebook: notebook,
    }, tpl.openAfter !== false);
    if (tpl.openAfter !== false) {
        openDocument(createdId, ctx);
    }
    return {docId: createdId, message: "已新建「" + title + "」"};
}

function cancelledActionError() {
    const error = new Error("已取消");
    error.cancelled = true;
    return error;
}

async function prepareActionInputs(action, ctx) {
    const vars = Object.assign({}, ctx.vars || {});
    const inputs = collectInputsFromAction(action)
        .filter((item) => !Object.prototype.hasOwnProperty.call(vars, item.key));
    if (!inputs.length) {
        ctx.vars = vars;
        return true;
    }
    const result = await ui.askInputs(inputs, action.name);
    if (result === null) {
        return false;
    }
    ctx.vars = Object.assign({}, vars, result);
    return true;
}

/* ------------------------------------------------------------------ */
/* 选择动作：统一单项执行入口                                          */
/* 宏和“多选执行”都复用这里，确保同一个上下文可以连续传递             */
/* ------------------------------------------------------------------ */

async function runActionWithContext(action, ctx, stack) {
    if (!action || action.enabled === false) {
        return null;
    }
    if (action.type === "multi") {
        throw new Error("选择动作不能再嵌套选择动作");
    }
    if (action.type === "template") {
        const ready = await prepareTemplateFolderChoice(action, ctx);
        if (!ready) {
            throw cancelledActionError();
        }
    }
    if (action.type !== "macro") {
        const inputsReady = await prepareActionInputs(action, ctx);
        if (!inputsReady) {
            throw cancelledActionError();
        }
    }
    return runActionInternal(action, ctx, stack || []);
}

/* ------------------------------------------------------------------ */
/* 选择动作：批量执行链                                                */
/* 按 children 配置顺序串行执行；stopOnError=false 时收集失败继续跑    */
/* ------------------------------------------------------------------ */

async function executeMultiSelection(actions, ctx, options) {
    const opts = options || {};
    const stopOnError = opts.stopOnError !== false;
    const queue = (actions || []).filter((action) => action && action.enabled !== false);
    if (!queue.length) {
        throw new Error("请至少选择一个动作");
    }

    const results = [];
    const errors = [];
    for (let index = 0; index < queue.length; index++) {
        const action = queue[index];
        try {
            const result = await runActionWithContext(action, ctx, []);
            results.push({action, result, index});
        } catch (rawError) {
            if (rawError && rawError.cancelled) {
                throw rawError;
            }
            const error = rawError instanceof Error ? rawError : new Error(String(rawError));
            error.actionName = action.name;
            error.completedCount = results.length;
            errors.push({action, error, index});
            if (stopOnError) {
                throw error;
            }
        }
    }
    return {
        results,
        errors,
        lastResult: results.length ? results[results.length - 1].result : null,
    };
}

async function executeMacro(action, ctx, stack) {
    const chain = stack || [];
    if (chain.includes(action.id)) {
        throw new Error("宏出现循环调用：" + action.name);
    }
    const nextChain = chain.concat(action.id);
    const steps = (action.macro && action.macro.steps) || [];
    if (!steps.length) {
        throw new Error("宏没有步骤");
    }
    let last = null;
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const child = resolveStepAction(step);
        if (!child || child.enabled === false) {
            continue;
        }
        if (child.type === "multi") {
            continue;
        }
        last = await runActionWithContext(child, ctx, nextChain);
    }
    return last || {message: "宏已执行"};
}

function resolveStepAction(step, actions) {
    if (!step) {
        return null;
    }
    if (step.action && typeof step.action === "object") {
        return normalizeAction(step.action);
    }
    const id = step.actionId;
    const source = Array.isArray(actions) ? actions : ((getApp() && getApp().settings && getApp().settings.actions) || []);
    return source.find((item) => item.id === id) || null;
}

async function runActionInternal(action, ctx, stack) {
    if (!action) {
        return null;
    }
    if (action.type === "capture") {
        return executeCapture(action, ctx);
    }
    if (action.type === "template") {
        return executeTemplate(action, ctx);
    }

    if (action.type === "macro") {
        return executeMacro(action, ctx, stack);
    }
    if (action.type === "multi") {
        throw new Error("选择动作不能在宏或多选执行中嵌套");
    }
    return null;
}

async function runAction(action) {
    if (!action) {
        return;
    }
    if (action.type === "multi") {
        const multi = action.multi || {};
        const children = (multi.children || [])
            .map((id) => getApp().settings.actions.find((item) => item.id === id))
            .filter((item) => item && item.enabled !== false && item.type !== "multi");
        if (!children.length) {
            toast("这个选择动作还没有可执行的子动作", "error");
            return;
        }
        try {
            const ctx = await buildContext(action);
            const multiple = multi.mode === "many";
            const picked = await ui.openPanel({
                title: action.name,
                actions: children,
                manage: false,
                preserveOrder: true,
                multiple: multiple,
            });
            const selected = multiple ? picked : (picked ? [picked] : []);
            if (!selected || !selected.length) {
                return;
            }
            const outcome = await executeMultiSelection(selected, ctx, {
                stopOnError: multi.stopOnError !== false,
            });
            getApp().markRecent(action.id);
            if (multiple && outcome.errors.length) {
                toast("已执行 " + outcome.results.length + " 个动作，" + outcome.errors.length + " 个失败", "error", 6000);
            } else if (getApp().settings.notifyOnRun !== false) {
                if (multiple) {
                    toast("已执行 " + outcome.results.length + " 个动作");
                } else if (outcome.lastResult && outcome.lastResult.message) {
                    toast(outcome.lastResult.message);
                }
            }
        } catch (e) {
            if (e && e.cancelled) {
                return;
            }
            console.error("[quickadd] multi action failed", e);
            const prefix = e && e.actionName ? "「" + e.actionName + "」执行失败：" : "";
            toast(prefix + ((e && e.message) || String(e)), "error", 6000);
        }
        return;
    }
    try {
        const ctx = await buildContext(action);
        const result = await runActionWithContext(action, ctx, []);
        getApp().markRecent(action.id);
        if (getApp().settings.notifyOnRun !== false && result && result.message) {
            toast(result.message);
        }
    } catch (e) {
        if (e && e.cancelled) {
            return;
        }
        console.error("[quickadd] run failed", e);
        toast((e && e.message) || String(e), "error", 6000);
    }
}

function runActionById(id) {
    const action = getApp() && getApp().settings.actions.find((item) => item.id === id);
    if (!action) {
        toast("动作不存在或已删除", "error");
        return;
    }
    return runAction(action);
}

/* ------------------------------------------------------------------ */

module.exports = {
    configureActions,
    normalizeTags,
    openDocument,
    rememberActionDocument,
    executeCapture,
    readWorkspaceFile,
    parentFolderOf,
    prepareTemplateFolderChoice,
    resolveTemplateLocation,
    executeTemplate,
    cancelledActionError,
    prepareActionInputs,
    runActionWithContext,
    executeMultiSelection,
    executeMacro,
    resolveStepAction,
    runActionInternal,
    runAction,
    runActionById,
};
