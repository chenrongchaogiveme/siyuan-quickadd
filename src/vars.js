
const {formatDate} = require("./utils");

let resolveStepAction = () => null;
let getActions = () => [];

function configureVars(options) {
    const config = options || {};
    resolveStepAction = typeof config.resolveStepAction === "function" ? config.resolveStepAction : () => null;
    getActions = typeof config.getActions === "function" ? config.getActions : () => [];
}

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)(?:\s*:\s*([^{}]*?))?\s*\}\}/g;
const INPUT_NAMES = ["input", "value", "prompt", "ask"];

function collectInputs(template, out) {
    const list = out || [];
    if (!template) {
        return list;
    }
    String(template).replace(VAR_RE, (match, rawName, arg) => {
        const name = rawName.toLowerCase();
        if (INPUT_NAMES.includes(name)) {
            const label = String(arg || "").trim() || "内容";
            if (!list.some((item) => item.key === label)) {
                list.push({key: label, label: label});
            }
        }
        return match;
    });
    return list;
}

function collectInputsFromAction(action, list, stack, actions) {
    const out = list || [];
    const chain = stack || [];
    if (!action || (action.id && chain.includes(action.id))) {
        return out;
    }
    const nextChain = action.id ? chain.concat(action.id) : chain;
    if (action.type === "capture") {
        collectInputs(action.capture && action.capture.content, out);
    } else if (action.type === "template") {
        const tpl = action.template || {};
        collectInputs(tpl.title, out);
        collectInputs(tpl.folder, out);
        if ((tpl.source || "inline") === "inline") {
            collectInputs(tpl.content, out);
        }
    } else if (action.type === "macro") {
        ((action.macro && action.macro.steps) || []).forEach((step) => {
            const child = resolveStepAction(step, actions);
            if (child && child.enabled !== false && child.type !== "multi") {
                collectInputsFromAction(child, out, nextChain, actions);
            }
        });
    }
    return out;
}

function renderVars(template, ctx) {
    if (!template) {
        return "";
    }
    return String(template).replace(VAR_RE, (match, rawName, arg) => {
        const name = rawName.toLowerCase();
        const now = ctx.now || new Date();
        switch (name) {
            case "date":
                return formatDate(now, arg || "YYYY-MM-DD");
            case "time":
                return formatDate(now, arg || "HH:mm");
            case "datetime":
                return formatDate(now, arg || "YYYY-MM-DD HH:mm");
            case "timestamp":
                return String(now.getTime());
            case "title":
            case "doc_title":
                return ctx.title || "";
            case "docid":
            case "doc_id":
                return ctx.docId || "";
            case "docpath":
            case "doc_path":
                return ctx.docPath || "";
            case "notebook":
            case "notebook_id":
                return ctx.notebookName || ctx.notebookId || "";
            case "clipboard":
                return ctx.clipboard || "";
            case "selection":
            case "selected":
                return ctx.selection || "";
            case "random": {
                const len = Math.max(1, Math.min(64, parseInt(arg, 10) || 6));
                let text = "";
                const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
                for (let i = 0; i < len; i++) {
                    text += chars.charAt(Math.floor(Math.random() * chars.length));
                }
                return text;
            }
            case "cursor":
                return "";
            default:
                break;
        }
        if (INPUT_NAMES.includes(name)) {
            const label = String(arg || "").trim() || "内容";
            const value = ctx.vars && Object.prototype.hasOwnProperty.call(ctx.vars, label) ? ctx.vars[label] : "";
            return value == null ? "" : String(value);
        }
        return match;
    });
}

/* ------------------------------------------------------------------ */
/* 思源模板语法兼容（.action / {{.title}} / {{now | date}}）              */
/* ------------------------------------------------------------------ */

function goLayoutToJs(layout) {
    return String(layout || "2006-01-02")
        .replace(/2006/g, "YYYY")
        .replace(/01/g, "MM")
        .replace(/02/g, "DD")
        .replace(/15/g, "HH")
        .replace(/04/g, "mm")
        .replace(/05/g, "ss")
        .replace(/1/g, "M")
        .replace(/2/g, "D")
        .replace(/3/g, "H")
        .replace(/4/g, "m")
        .replace(/5/g, "s");
}

function renderGoLite(text, ctx) {
    if (!text) {
        return "";
    }
    const now = (ctx && ctx.now) || new Date();
    let out = String(text);
    out = out.replace(/\{\{\s*\.?now\s*\|\s*date\s*"([^"]*)"\s*\}\}/g, (match, layout) => formatDate(now, goLayoutToJs(layout)));
    out = out.replace(/\{\{\s*\.title\s*\}\}/g, (ctx && ctx.title) || "");
    out = out.replace(/\{\{\s*\.id\s*\}\}/g, (ctx && ctx.docId) || "");
    out = out.replace(/\{\{\s*\.created\s*\}\}/g, formatDate(now, "YYYY-MM-DD HH:mm"));
    out = out.replace(/\{\{\s*\.updated\s*\}\}/g, formatDate(now, "YYYY-MM-DD HH:mm"));
    return out;
}

function stripIalIds(text) {
    return String(text || "").replace(/^\{:\s*id="[^"]*"\}\s*$/gm, "");
}


module.exports = {
    configureVars,
    VAR_RE,
    INPUT_NAMES,
    collectInputs,
    collectInputsFromAction,
    renderVars,
    goLayoutToJs,
    renderGoLite,
    stripIalIds,
};
