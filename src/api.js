
const {hostRequire} = require("./host");
const {fetchSyncPost} = hostRequire();
const {delay, trimSlashes, joinHPath, formatDate} = require("./utils");

async function post(path, payload) {
    return fetchSyncPost(path, payload || {});
}

async function postOk(path, payload) {
    const response = await post(path, payload);
    if (!response || response.code !== 0) {
        throw new Error((response && response.msg) || ("请求失败：" + path));
    }
    return response.data;
}

const documentCapabilitiesCache = new Map();

async function getDocumentCapabilities(notebook) {
    if (documentCapabilitiesCache.has(notebook)) {
        return documentCapabilitiesCache.get(notebook);
    }
    const data = await postOk("/api/notebook/getNotebookConf", {notebook: notebook});
    const capabilities = (data && data.documentCapabilities) || null;
    if (capabilities && capabilities.structuredPaths && capabilities.indexState === "ready") {
        documentCapabilitiesCache.set(notebook, capabilities);
    }
    return capabilities;
}

async function listNotebooks() {
    const data = await postOk("/api/notebook/lsNotebooks", {});
    const notebooks = (data && data.notebooks) || [];
    return notebooks.filter((item) => !item.closed);
}

async function listTemplateFiles() {
    const out = [];
    const walk = async (dir, prefix) => {
        let items = [];
        try {
            items = await postOk("/api/file/readDir", {path: dir});
        } catch (e) {
            return;
        }
        for (const item of items || []) {
            if (item.isDir) {
                await walk(dir + "/" + item.name, prefix + item.name + "/");
            } else if (/\.md$/i.test(item.name)) {
                out.push(prefix + item.name);
            }
        }
    };
    await walk("/data/templates", "");
    return out.sort((a, b) => a.localeCompare(b, "zh"));
}

function displayNotebookPath(notebookName, hpath) {
    const notebook = trimSlashes(notebookName);
    const path = trimSlashes(hpath);
    if (!notebook) {
        return hpath === "/" ? "/" : "/" + path;
    }
    return path ? notebook + "/" + path : notebook;
}

function resolveFolderChoicePath(basePath, input, notebookName) {
    const base = joinHPath(basePath || "/");
    let text = String(input || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const notebook = trimSlashes(notebookName);
    if (notebook) {
        if (text === notebook) {
            text = "";
        } else if (text.startsWith(notebook + "/")) {
            text = text.slice(notebook.length + 1);
        }
    }
    const baseRel = trimSlashes(base);
    if (baseRel && (text === baseRel || text.startsWith(baseRel + "/"))) {
        return "/" + text;
    }
    const parts = text.split("/").filter(Boolean);
    if (parts.some((part) => part === "." || part === "..")) {
        throw new Error("路径不能包含 . 或 ..");
    }
    return joinHPath(base, parts.join("/"));
}

async function listDocPathsUnder(notebook, folder) {
    const base = joinHPath(folder || "/");
    if (!notebook) {
        return [base];
    }
    const box = String(notebook).replace(/'/g, "''");
    const pathSql = base.replace(/'/g, "''");
    const likeSql = pathSql.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    const where = base === "/" ? "" : ` and (hpath = '${pathSql}' or hpath like '${likeSql}/%' escape '\\')`;
    const rows = await postOk("/api/query/sql", {
        stmt: `select hpath from blocks where type = 'd' and box = '${box}'${where} order by hpath asc`,
    });
    const paths = new Set([base]);
    (rows || []).forEach((row) => {
        const hpath = row && row.hpath ? String(row.hpath) : "";
        if (hpath && (base === "/" || hpath === base || hpath.startsWith(base + "/"))) {
            paths.add(hpath);
        }
    });
    const rest = Array.from(paths).filter((item) => item !== base)
        .sort((a, b) => a.localeCompare(b, "zh", {numeric: true, sensitivity: "base"}));
    return [base].concat(rest);
}

async function getIDsByHPath(notebook, hpath) {
    const data = await postOk("/api/filetree/getIDsByHPath", {notebook: notebook, path: hpath});
    return Array.isArray(data) ? data : [];
}

function isDocumentMetadataPending(error) {
    return /document metadata is not ready|indexing/i.test(String((error && error.message) || error || ""));
}

async function findDocIds(notebook, hpath) {
    try {
        return await getIDsByHPath(notebook, hpath);
    } catch (e) {
        return [];
    }
}

async function waitForDocPath(notebook, hpath, timeout) {
    const deadline = Date.now() + (timeout || 1800);
    do {
        const ids = await findDocIds(notebook, hpath);
        if (ids.length) {
            return ids[0];
        }
        if (Date.now() >= deadline) {
            break;
        }
        await delay(60);
    } while (true);
    return "";
}

function newNodeId() {
    const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
    let suffix = "";
    try {
        const bytes = new Uint8Array(7);
        window.crypto.getRandomValues(bytes);
        suffix = Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
    } catch (e) {
        for (let index = 0; index < 7; index++) {
            suffix += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
        }
    }
    return formatDate(new Date(), "YYYYMMDDHHmmss") + "-" + suffix;
}

async function createDocStructured(notebook, hpath, markdown) {
    const parts = trimSlashes(hpath).split("/").filter(Boolean);
    if (!parts.length) {
        throw new Error("文档路径为空");
    }
    const resolution = await postOk("/api/filetree/resolveDocPath", {
        notebook: notebook,
        start: {kind: "root"},
        segments: parts,
    });
    if (resolution && resolution.status === "resolved" && resolution.resolved && resolution.resolved.id) {
        return resolution.resolved.id;
    }
    if (!resolution || !["missing", "resolved"].includes(resolution.status)) {
        throw new Error("无法唯一解析文档路径：" + hpath);
    }

    let parentId = resolution.resolved && resolution.resolved.id ? resolution.resolved.id : null;
    let startIndex = Number(resolution.nextIndex);
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= parts.length) {
        startIndex = resolution.resolved && Array.isArray(resolution.resolved.segments)
            ? resolution.resolved.segments.length
            : 0;
    }
    let createdId = "";
    for (let index = startIndex; index < parts.length; index++) {
        const id = newNodeId();
        const data = await postOk("/api/filetree/createDocByParent", {
            notebook: notebook,
            parentID: parentId,
            id: id,
            title: {format: "plain", text: parts[index]},
            markdown: index === parts.length - 1 ? (markdown == null ? "" : String(markdown)) : "",
        });
        createdId = data && data.id ? data.id : id;
        parentId = createdId;
    }
    if (!createdId) {
        throw new Error("创建文档失败：" + hpath);
    }
    return createdId;
}

async function createDocRaw(notebook, hpath, markdown) {
    const capabilities = await getDocumentCapabilities(notebook);
    if (capabilities && capabilities.structuredPaths) {
        if (capabilities.indexState !== "ready") {
            throw new Error("document metadata is not ready: 笔记本索引尚未就绪");
        }
        if (Array.isArray(capabilities.titleFormats) && !capabilities.titleFormats.includes("plain")) {
            throw new Error("当前笔记本不支持纯文本文档标题");
        }
        return await createDocStructured(notebook, hpath, markdown);
    }
    return await postOk("/api/filetree/createDocWithMd", {
        notebook: notebook,
        path: hpath,
        markdown: markdown == null ? "" : String(markdown),
    });
}

async function createDocStep(notebook, hpath, markdown) {
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            return await createDocRaw(notebook, hpath, markdown);
        } catch (e) {
            lastError = e;
            const ids = await findDocIds(notebook, hpath);
            if (ids.length) {
                return ids[0];
            }
            if (!isDocumentMetadataPending(e) || attempt === 4) {
                throw e;
            }
            await delay(100 * (attempt + 1));
        }
    }
    throw lastError || new Error("创建文档失败");
}

async function ensureParentDocs(notebook, hpath) {
    const parts = trimSlashes(hpath).split("/").filter(Boolean);
    if (parts.length <= 1) {
        return;
    }
    for (let index = 1; index < parts.length; index++) {
        const parentPath = joinHPath.apply(null, parts.slice(0, index));
        if (await waitForDocPath(notebook, parentPath, 350)) {
            continue;
        }
        await createDocStep(notebook, parentPath, "");
        await waitForDocPath(notebook, parentPath, 1800);
    }
}

async function createDoc(notebook, hpath, markdown) {
    try {
        return await createDocRaw(notebook, hpath, markdown);
    } catch (e) {
        if (!isDocumentMetadataPending(e)) {
            throw e;
        }
        const existing = await findDocIds(notebook, hpath);
        if (existing.length) {
            return existing[0];
        }
        await ensureParentDocs(notebook, hpath);
        return await createDocStep(notebook, hpath, markdown);
    }
}

async function createDailyNote(notebook) {
    const appId = (window.siyuan && window.siyuan.ws && window.siyuan.ws.app && window.siyuan.ws.app.appId) || "";
    const data = await postOk("/api/filetree/createDailyNote", {notebook: notebook, app: appId});
    return data && data.id;
}

async function renderKernelTemplate(absPath, id, content) {
    const payload = {path: absPath, id: id};
    if (typeof content === "string") {
        payload.content = content;
        payload.preview = true;
    }
    const data = await postOk("/api/template/render", payload);
    return (data && data.content) || "";
}

module.exports = {
    post,
    postOk,
    getDocumentCapabilities,
    listNotebooks,
    listTemplateFiles,
    displayNotebookPath,
    resolveFolderChoicePath,
    listDocPathsUnder,
    getIDsByHPath,
    isDocumentMetadataPending,
    findDocIds,
    waitForDocPath,
    newNodeId,
    createDocStructured,
    createDocRaw,
    createDocStep,
    ensureParentDocs,
    createDoc,
    createDailyNote,
    renderKernelTemplate,
};
