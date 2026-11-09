
function normalizeHotkey(value) {
    const parts = String(value || "").toLowerCase().replace(/\s+/g, "").split("+").filter(Boolean);
    if (!parts.length) {
        return "";
    }
    const mods = new Set();
    let key = "";
    parts.forEach((part) => {
        if (["ctrl", "control", "ctl"].includes(part)) {
            mods.add("ctrl");
        } else if (["alt", "option", "opt"].includes(part)) {
            mods.add("alt");
        } else if (["shift"].includes(part)) {
            mods.add("shift");
        } else if (["meta", "cmd", "command", "win", "super"].includes(part)) {
            mods.add("meta");
        } else {
            key = part;
        }
    });
    const order = ["ctrl", "alt", "shift", "meta"];
    return order.filter((item) => mods.has(item)).concat(key ? [key] : []).join("+");
}

function eventHotkey(event) {
    const mods = [];
    if (event.ctrlKey) mods.push("ctrl");
    if (event.altKey) mods.push("alt");
    if (event.shiftKey) mods.push("shift");
    if (event.metaKey) mods.push("meta");
    let key = String(event.key || "").toLowerCase();
    if (key === " ") key = "space";
    return mods.concat(key ? [key] : []).join("+");
}


module.exports = {
    normalizeHotkey,
    eventHotkey,
};
