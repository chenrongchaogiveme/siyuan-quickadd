
const {hostRequire} = require("./host");
const {getActiveEditor, insertContent} = hostRequire();
const {joinHPath} = require("./utils");
const {renderVars} = require("./vars");
const {
    postOk,
    listNotebooks,
    getIDsByHPath,
    createDoc,
    createDailyNote,
} = require("./api");

let ui = null;

function configureContext(options) {
    ui = options && options.ui ? options.ui : null;
}

function activeEditor() {
    try {
        return getActiveEditor(true) || getActiveEditor(false) || null;
    } catch (e) {
        return null;
    }
}

function getSelectionBlockId() {
    try {
        const selection = window.getSelection();
        if (!selection || !selection.rangeCount) {
            return null;
        }
        let node = selection.anchorNode;
        if (!node) {
            return null;
        }
        const element = node.nodeType === 1 ? node : node.parentElement;
        const block = element && element.closest ? element.closest("[data-node-id]") : null;
        return block ? block.getAttribute("data-node-id") : null;
    } catch (e) {
        return null;
    }
}

async function readClipboard() {
    try {
        if (navigator.clipboard && navigator.clipboard.readText) {
            return await navigator.clipboard.readText();
        }
    } catch (e) { /* ignore */ }
    try {
        if (window.JSAndroid && window.JSAndroid.readClipboard) {
            return window.JSAndroid.readClipboard();
        }
    } catch (e) { /* ignore */ }
    return "";
}

async function buildContext(action) {
    const editor = activeEditor();
    const protyle = editor && editor.protyle ? editor.protyle : editor;
    let docId = "";
    let docTitle = "";
    let notebookId = "";
    let docPath = "";
    if (protyle) {
        docId = (protyle.block && protyle.block.rootID) || "";
        notebookId = protyle.notebookId || "";
        try {
            docTitle = (protyle.title && protyle.title.editElement && protyle.title.editElement.textContent || "").trim();
        } catch (e) { /* ignore */ }
        if (!docTitle && protyle.background && protyle.background.ial) {
            docTitle = protyle.background.ial.title || "";
        }
    }
    if (docId) {
        try {
            const info = await postOk("/api/block/getBlockInfo", {id: docId});
            if (info) {
                docTitle = info.rootTitle || docTitle;
                notebookId = info.box || notebookId;
            }
            try {
                docPath = await postOk("/api/filetree/getHPathByID", {id: docId});
            } catch (e) { /* ignore */ }
        } catch (e) { /* ignore */ }
    }
    let notebookName = "";
    if (notebookId) {
        try {
            const notebooks = await listNotebooks();
            const found = notebooks.find((item) => item.id === notebookId);
            notebookName = found ? found.name : "";
        } catch (e) { /* ignore */ }
    }
    const selection = (() => {
        try {
            return String(window.getSelection() || "");
        } catch (e) {
            return "";
        }
    })();
    return {
        action: action,
        now: new Date(),
        protyle: protyle,
        docId: docId,
        docTitle: docTitle,
        title: docTitle,
        docPath: docPath,
        notebookId: notebookId,
        notebookName: notebookName,
        selection: selection,
        clipboard: await readClipboard(),
        vars: {},
        firstCreatedId: "",
        lastCreatedId: "",
        lastCreatedTitle: "",
        lastCreatedPath: "",
        lastCreatedNotebook: "",
        stepResults: [],
    };
}

/* ------------------------------------------------------------------ */
/* 目标文档解析                                                        */
/* ------------------------------------------------------------------ */

async function pickNotebookId(ctx) {
    if (ctx && ctx.notebookId) {
        return ctx.notebookId;
    }
    const notebooks = await listNotebooks();
    if (!notebooks.length) {
        throw new Error("没有可用的笔记本");
    }
    if (notebooks.length === 1) {
        return notebooks[0].id;
    }
    return await ui.pickNotebook(notebooks);
}

async function resolveTargetDoc(capture, ctx) {
    const target = capture.target || "current";
    if (target === "macro-created") {
        if (!ctx.lastCreatedId) {
            throw new Error("宏中还没有新建或打开文档");
        }
        return {
            id: ctx.lastCreatedId,
            title: ctx.lastCreatedTitle,
            notebook: ctx.lastCreatedNotebook,
            path: ctx.lastCreatedPath,
        };
    }
    if (target === "current" || target === "cursor") {
        if (!ctx.docId) {
            throw new Error("请先打开一篇文档");
        }
        return {id: ctx.docId, title: ctx.docTitle, notebook: ctx.notebookId};
    }
    if (target === "daily") {
        const notebook = capture.notebook || await pickNotebookId(ctx);
        const id = await createDailyNote(notebook);
        if (!id) {
            throw new Error("创建日记失败");
        }
        return {id: id, title: "日记", notebook: notebook, isDaily: true};
    }
    if (target === "docId") {
        const id = String(capture.docId || "").trim();
        if (!id) {
            throw new Error("未填写目标文档 ID");
        }
        return {id: id, title: "", notebook: ""};
    }
    if (target === "path") {
        const notebook = capture.notebook || ctx.notebookId;
        if (!notebook) {
            throw new Error("请为「指定路径」选择笔记本");
        }
        const hpath = joinHPath(renderVars(capture.path, ctx));
        if (hpath === "/") {
            throw new Error("未填写目标文档路径");
        }
        let ids = await getIDsByHPath(notebook, hpath);
        if (!ids.length && capture.createIfMissing !== false) {
            const created = await createDoc(notebook, hpath, "");
            ids = [created];
        }
        if (!ids.length) {
            throw new Error("找不到文档：" + hpath);
        }
        return {id: ids[0], title: hpath.split("/").filter(Boolean).pop() || "", notebook: notebook, created: ids.length && !ids[0] ? false : undefined};
    }
    throw new Error("未知的目标类型：" + target);
}

async function insertMarkdown(target, position, markdown, ctx) {
    const data = String(markdown == null ? "" : markdown);
    if (!data.trim()) {
        throw new Error("内容为空");
    }
    if (position === "cursor") {
        const result = insertContent({data: data, dataType: "markdown", editor: ctx.protyle});
        if (result && result.status && result.status !== "inserted") {
            throw new Error("无法在光标处插入：" + result.status);
        }
        return target && target.id;
    }
    if (position === "after-block" || position === "child-block") {
        const blockId = getSelectionBlockId();
        if (!blockId) {
            throw new Error("请将光标放在要插入的块中");
        }
        if (position === "after-block") {
            await postOk("/api/block/insertBlock", {dataType: "markdown", data: data, previousID: blockId});
        } else {
            await postOk("/api/block/appendBlock", {dataType: "markdown", data: data, parentID: blockId});
        }
        return target && target.id;
    }
    if (!target || !target.id) {
        throw new Error("未找到目标文档");
    }
    if (position === "prepend") {
        await postOk("/api/block/prependBlock", {dataType: "markdown", data: data, parentID: target.id});
    } else {
        await postOk("/api/block/appendBlock", {dataType: "markdown", data: data, parentID: target.id});
    }
    return target.id;
}
/* ------------------------------------------------------------------ */

module.exports = {
    configureContext,
    activeEditor,
    getSelectionBlockId,
    readClipboard,
    buildContext,
    pickNotebookId,
    resolveTargetDoc,
    insertMarkdown,
};
