
const {hostRequire} = require("./host");
const {showMessage} = hostRequire();

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

const clone = (obj) => JSON.parse(JSON.stringify(obj));
const pad = (num, size) => String(num).padStart(size || 2, "0");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function uid() {
    try {
        if (window.crypto && window.crypto.randomUUID) {
            return "a" + window.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
        }
    } catch (e) { /* ignore */ }
    return "a" + Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4);
}

function escapeHtml(value) {
    return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
    return escapeHtml(value).replace(/\n/g, "&#10;");
}

function trimSlashes(value) {
    return String(value || "").replace(/^\/+|\/+$/g, "");
}

function joinHPath(...parts) {
    return "/" + parts.map(trimSlashes).filter(Boolean).join("/");
}

function sanitizeTitle(title) {
    return String(title || "")
        .replace(/[\\/:*?"<>|]/g, (ch) => ({"/": "／", "\\": "＼", ":": "：", "*": "＊", "?": "？", "\"": "＂", "<": "＜", ">": "＞", "|": "｜"})[ch] || ch)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
}

function toast(message, type, timeout) {
    try {
        showMessage(String(message), timeout || 3000, type || "info");
    } catch (e) {
        console.log("[quickadd]", message);
    }
}

function today() {
    return new Date();
}

/* ------------------------------------------------------------------ */
/* 日期格式化                                                          */
/* ------------------------------------------------------------------ */

const WEEK_SHORT = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const WEEK_LONG = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

function formatDate(date, pattern) {
    const d = date instanceof Date ? date : new Date(date);
    const fmt = pattern == null || pattern === "" ? "YYYY-MM-DD" : String(pattern);
    return fmt.replace(/\[([^\]]*)\]|(YYYY|YY|MM|M|DD|D|HH|H|mm|m|ss|s|SSS|dddd|ddd)/g, (match, literal, token) => {
        if (literal != null) {
            return literal;
        }
        switch (token) {
            case "YYYY": return String(d.getFullYear());
            case "YY": return String(d.getFullYear()).slice(-2);
            case "MM": return pad(d.getMonth() + 1);
            case "M": return String(d.getMonth() + 1);
            case "DD": return pad(d.getDate());
            case "D": return String(d.getDate());
            case "HH": return pad(d.getHours());
            case "H": return String(d.getHours());
            case "mm": return pad(d.getMinutes());
            case "m": return String(d.getMinutes());
            case "ss": return pad(d.getSeconds());
            case "s": return String(d.getSeconds());
            case "SSS": return pad(d.getMilliseconds(), 3);
            case "dddd": return WEEK_LONG[d.getDay()];
            case "ddd": return WEEK_SHORT[d.getDay()];
            default: return match;
        }
    });
}


module.exports = {
    clone,
    pad,
    delay,
    uid,
    escapeHtml,
    escapeAttr,
    trimSlashes,
    joinHPath,
    sanitizeTitle,
    toast,
    today,
    WEEK_SHORT,
    WEEK_LONG,
    formatDate,
};
