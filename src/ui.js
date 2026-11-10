
const {hostRequire} = require("./host");
const siyuan = hostRequire();
const {Dialog} = siyuan;
const {
    clone,
    escapeHtml,
    escapeAttr,
    trimSlashes,
    joinHPath,
    toast,
} = require("./utils");
const {
    postOk,
    listNotebooks,
    listTemplateFiles,
    displayNotebookPath,
    resolveFolderChoicePath,
    listDocPathsUnder,
} = require("./api");
const {
    defaultActionCapture,
    defaultActionTemplate,
    defaultActionMulti,
    normalizeAction,
} = require("./settings");
const {
    resolveStepAction,
    runAction,
} = require("./actions");

let getApp = () => null;

function configureUI(options) {
    getApp = options && typeof options.getApp === "function" ? options.getApp : () => null;
}

const QuickAddUI = {};

QuickAddUI.icon = function(action) {
    const icon = String((action && action.icon) || "⚡").trim();
    if (/^icon[A-Z]/.test(icon)) {
        return `<svg class="qa-svg"><use xlink:href="#${escapeAttr(icon)}"></use></svg>`;
    }
    if (/^<svg/.test(icon)) {
        return icon;
    }
    return `<span class="qa-emoji">${escapeHtml(icon)}</span>`;
};

QuickAddUI.typeLabel = function(type) {
    return ({capture: "记录", template: "新建文档", macro: "宏", multi: "选择动作"})[type] || type;
};

/* ------------------------------------------------------------------ */
/* 选择动作：按动作分组稳定归类                                        */
/* 分组顺序沿用动作管理中的顺序；空分组名统一放在最后                   */
/* ------------------------------------------------------------------ */

QuickAddUI.groupActions = function(actions) {
    const groups = [];
    const byName = new Map();
    (actions || []).forEach((action) => {
        const name = String((action && action.group) || "").trim() || "未分组";
        let group = byName.get(name);
        if (!group) {
            group = {name, actions: []};
            byName.set(name, group);
            groups.push(group);
        }
        group.actions.push(action);
    });
    return groups.sort((a, b) => {
        if (a.name === "未分组") {
            return 1;
        }
        if (b.name === "未分组") {
            return -1;
        }
        return 0;
    });
};

QuickAddUI.dialogShell = function(title, bodyHtml, footHtml, options) {
    const opts = options || {};
    const foot = footHtml ? `<div class="b3-dialog__action qa-dialog-action">${footHtml}</div>` : "";
    return new Dialog({
        title: title,
        width: opts.width || "620px",
        height: opts.height || "",
        content: `<div class="b3-dialog__content qa-dialog">${bodyHtml}</div>${foot}`,
        destroyCallback: opts.destroyCallback,
        disableClose: opts.disableClose,
    });
};

QuickAddUI.askInputs = function(inputs, actionName) {
    return new Promise((resolve) => {
        let settled = false;
        const fields = inputs.map((item, index) => `<div class="qa-var-row">
    <label class="qa-var-label" for="qa-var-${index}">${escapeHtml(item.label)}</label>
    <input class="b3-text-field qa-var-input" id="qa-var-${index}" data-key="${escapeAttr(item.key)}"
        placeholder="输入${escapeAttr(item.label)}…" autocomplete="off" spellcheck="false">
</div>`).join("");
        const dialog = new Dialog({
            title: actionName ? actionName + " · 填写内容" : "填写内容",
            width: "460px",
            content: `<div class="b3-dialog__content qa-dialog qa-prompt">
  <div class="qa-hint">填完后直接按 Enter 执行，Esc 取消。</div>
  ${fields}
</div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--cancel">取消</button>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--text qa-submit">执行</button>
</div>`,
            destroyCallback: () => {
                if (!settled) {
                    settled = true;
                    resolve(null);
                }
            },
        });
        const submit = () => {
            if (settled) {
                return;
            }
            const result = {};
            dialog.element.querySelectorAll(".qa-var-input").forEach((input) => {
                result[input.getAttribute("data-key")] = input.value;
            });
            settled = true;
            resolve(result);
            dialog.destroy();
        };
        dialog.element.querySelector(".qa-submit").addEventListener("click", submit);
        dialog.element.querySelector(".b3-button--cancel").addEventListener("click", () => dialog.destroy());
        dialog.element.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229 && !event.shiftKey) {
                event.preventDefault();
                submit();
            }
        });
        let focusedOnce = false;
        const focusFirst = () => {
            if (settled || !dialog.element.isConnected) {
                return;
            }
            const first = dialog.element.querySelector(".qa-var-input");
            if (!first) {
                return;
            }
            first.focus({preventScroll: true});
            if (!focusedOnce) {
                first.select();
                focusedOnce = true;
            }
        };
        [0, 50, 150, 350, 700, 1200].forEach((delay) => setTimeout(focusFirst, delay));
    });
};

QuickAddUI.pickNotebook = function(notebooks) {
    return new Promise((resolve) => {
        let settled = false;
        const rows = notebooks.map((item) => `<div class="qa-pick-item" data-id="${escapeAttr(item.id)}">
    <svg class="qa-svg"><use xlink:href="#iconNotebook"></use></svg>
    <span class="qa-pick-item__name">${escapeHtml(item.name)}</span>
    <span class="qa-pick-item__meta">${escapeHtml(item.id)}</span>
</div>`).join("");
        const dialog = new Dialog({
            title: "选择笔记本",
            width: "520px",
            content: `<div class="b3-dialog__content qa-dialog"><div class="qa-pick-list">${rows}</div></div>`,
            destroyCallback: () => {
                if (!settled) {
                    settled = true;
                    resolve(null);
                }
            },
        });
        dialog.element.querySelectorAll(".qa-pick-item").forEach((row) => {
            row.addEventListener("click", () => {
                settled = true;
                resolve(row.getAttribute("data-id"));
                dialog.destroy();
            });
        });
    });
};

QuickAddUI.pickFolder = async function(options) {
    const opts = options || {};
    const notebookId = String(opts.notebook || "");
    const basePath = joinHPath(opts.basePath || "/");
    const notebooks = await listNotebooks().catch(() => []);
    const notebook = notebooks.find((item) => item.id === notebookId);
    const notebookName = notebook ? notebook.name : "";
    let paths = await listDocPathsUnder(notebookId, basePath).catch(() => [basePath]);
    paths = [basePath].concat(paths.filter((item) => item && item !== basePath));
    return new Promise((resolve) => {
        let settled = false;
        let activeIndex = 0;
        let visibleOptions = [];
        let pathError = "";
        const dialog = new Dialog({
            title: opts.title || "选择保存路径",
            width: "720px",
            height: "560px",
            content: `<div class="b3-dialog__content qa-dialog qa-folder-picker">
  <div class="qa-folder-base">父路径：<code>${escapeHtml(displayNotebookPath(notebookName, basePath))}</code></div>
  <input class="b3-text-field fn__block qa-folder-input" placeholder="选择已有路径，或输入新的子路径…" autocomplete="off" spellcheck="false">
  <div class="qa-hint qa-folder-hint">输入已有名称会复用路径；输入新名称会创建新层级。↑↓ 选择，Enter 确认，Esc 取消。</div>
  <div class="qa-pick-list qa-folder-list"></div>
</div>`,
            destroyCallback: () => {
                if (!settled) {
                    settled = true;
                    resolve(null);
                }
            },
        });
        const input = dialog.element.querySelector(".qa-folder-input");
        const list = dialog.element.querySelector(".qa-folder-list");
        const choose = (path) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(path);
            dialog.destroy();
        };
        const buildOptions = () => {
            const raw = input.value.trim();
            const lowered = raw.toLocaleLowerCase();
            pathError = "";
            let customPath = "";
            if (raw) {
                try {
                    customPath = resolveFolderChoicePath(basePath, raw, notebookName);
                } catch (e) {
                    pathError = e.message || "路径无效";
                }
            }
            const existing = paths.filter((path) => {
                if (!lowered) {
                    return true;
                }
                const label = displayNotebookPath(notebookName, path).toLocaleLowerCase();
                return path.toLocaleLowerCase().includes(lowered) || label.includes(lowered);
            });
            const result = [];
            if (customPath && customPath !== basePath && !paths.includes(customPath)) {
                result.push({kind: "new", path: customPath});
            }
            existing.forEach((path) => result.push({kind: "existing", path: path}));
            return result;
        };
        const render = () => {
            visibleOptions = buildOptions();
            activeIndex = Math.max(0, Math.min(activeIndex, visibleOptions.length - 1));
            if (!visibleOptions.length) {
                list.innerHTML = `<div class="qa-empty">${escapeHtml(pathError || "没有匹配的路径")}</div>`;
                return;
            }
            list.innerHTML = visibleOptions.map((option, index) => {
                const isNew = option.kind === "new";
                const label = displayNotebookPath(notebookName, option.path);
                const meta = isNew ? "Enter 创建" : (option.path === basePath ? "当前父路径" : "已有路径");
                return `<div class="qa-pick-item qa-folder-item${index === activeIndex ? " qa-pick-item--active" : ""}${isNew ? " qa-folder-item--new" : ""}" data-index="${index}">
    <span class="qa-folder-item__mark">${isNew ? "＋" : "▸"}</span>
    <span class="qa-pick-item__name">${escapeHtml(isNew ? "新建：" + label : label)}</span>
    <span class="qa-pick-item__meta">${meta}</span>
</div>`;
            }).join("");
            list.querySelectorAll(".qa-folder-item").forEach((row) => {
                row.addEventListener("click", () => choose(visibleOptions[Number(row.getAttribute("data-index"))].path));
            });
            const active = list.querySelector(".qa-pick-item--active");
            if (active) {
                active.scrollIntoView({block: "nearest"});
            }
        };
        input.addEventListener("input", () => {
            activeIndex = 0;
            render();
        });
        input.addEventListener("keydown", (event) => {
            if (event.isComposing || event.keyCode === 229) {
                return;
            }
            if (event.key === "ArrowDown") {
                event.preventDefault();
                if (visibleOptions.length) {
                    activeIndex = (activeIndex + 1) % visibleOptions.length;
                    render();
                }
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                if (visibleOptions.length) {
                    activeIndex = (activeIndex - 1 + visibleOptions.length) % visibleOptions.length;
                    render();
                }
            } else if (event.key === "Enter") {
                event.preventDefault();
                const option = visibleOptions[activeIndex];
                if (option) {
                    choose(option.path);
                }
            }
        });
        render();
        setTimeout(() => input.focus(), 30);
    });
};

QuickAddUI.pickLocation = async function(options) {
    const opts = options || {};
    const notebooks = await listNotebooks().catch(() => []);
    if (!notebooks.length) {
        toast("没有可用的笔记本", "error");
        return null;
    }
    const preferredNotebook = String(opts.notebook || "");
    let notebookId = notebooks.some((item) => item.id === preferredNotebook)
        ? preferredNotebook
        : notebooks[0].id;
    let notebook = notebooks.find((item) => item.id === notebookId);
    let notebookName = notebook ? notebook.name : "";
    const defaultPath = joinHPath(opts.basePath || "/");
    let paths = await listDocPathsUnder(notebookId, "/").catch(() => ["/"]);
    let loadVersion = 0;
    const notebookOptions = notebooks.map((item) => `<option value="${escapeAttr(item.id)}"${item.id === notebookId ? " selected" : ""}>${escapeHtml(item.name)}</option>`).join("");
    return new Promise((resolve) => {
        let settled = false;
        let activeIndex = 0;
        let visibleOptions = [];
        let pathError = "";
        let loading = false;
        const dialog = new Dialog({
            title: opts.title || "选择保存位置",
            width: "760px",
            height: "600px",
            content: `<div class="b3-dialog__content qa-dialog qa-location-picker">
  <div class="qa-location-notebook-row">
    <span class="qa-location-label">笔记本</span>
    <select class="b3-select fn__flex-1 qa-location-notebook">${notebookOptions}</select>
  </div>
  <div class="qa-location-base">默认位置：<code class="qa-location-base-path"></code></div>
  <input class="b3-text-field fn__block qa-location-input" placeholder="选择已有路径，或输入新的路径…" autocomplete="off" spellcheck="false">
  <div class="qa-hint qa-location-hint">按笔记本搜索或新建路径；输入新路径会在保存到该路径时自动创建层级。↑↓ 选择，Enter 确认，Esc 取消。</div>
  <div class="qa-pick-list qa-location-list"></div>
</div>`,
            destroyCallback: () => {
                if (!settled) {
                    settled = true;
                    resolve(null);
                }
            },
        });
        const notebookSelect = dialog.element.querySelector(".qa-location-notebook");
        const basePathElement = dialog.element.querySelector(".qa-location-base-path");
        const input = dialog.element.querySelector(".qa-location-input");
        const list = dialog.element.querySelector(".qa-location-list");
        const allPaths = () => {
            return paths.includes(defaultPath) ? paths : [defaultPath].concat(paths);
        };
        const choose = (path) => {
            if (settled || loading) {
                return;
            }
            settled = true;
            resolve({notebook: notebookId, folder: joinHPath(path)});
            dialog.destroy();
        };
        const buildOptions = () => {
            const raw = input.value.trim();
            const lowered = raw.toLocaleLowerCase();
            pathError = "";
            let customPath = "";
            if (raw) {
                try {
                    customPath = resolveFolderChoicePath("/", raw, notebookName);
                } catch (e) {
                    pathError = e.message || "路径无效";
                }
            }
            const existing = allPaths().filter((path) => {
                if (!lowered) {
                    return true;
                }
                const label = displayNotebookPath(notebookName, path).toLocaleLowerCase();
                return path.toLocaleLowerCase().includes(lowered) || label.includes(lowered);
            });
            const result = [];
            if (customPath && !existing.includes(customPath)) {
                result.push({kind: "new", path: customPath});
            }
            existing.forEach((path) => result.push({kind: "existing", path: path}));
            return result;
        };
        const render = () => {
            basePathElement.textContent = displayNotebookPath(notebookName, defaultPath);
            visibleOptions = buildOptions();
            activeIndex = Math.max(0, Math.min(activeIndex, visibleOptions.length - 1));
            if (loading) {
                list.innerHTML = `<div class="qa-empty">正在读取路径…</div>`;
                return;
            }
            if (!visibleOptions.length) {
                list.innerHTML = `<div class="qa-empty">${escapeHtml(pathError || "没有匹配的路径")}</div>`;
                return;
            }
            list.innerHTML = visibleOptions.map((option, index) => {
                const isNew = option.kind === "new";
                const label = displayNotebookPath(notebookName, option.path);
                const meta = isNew
                    ? "Enter 创建"
                    : (option.path === defaultPath ? "默认位置" : "已有路径");
                return `<div class="qa-pick-item qa-folder-item qa-location-item${index === activeIndex ? " qa-pick-item--active" : ""}${isNew ? " qa-folder-item--new" : ""}" data-index="${index}">
    <span class="qa-folder-item__mark">${isNew ? "＋" : "▸"}</span>
    <span class="qa-pick-item__name">${escapeHtml(isNew ? "新建：" + label : label)}</span>
    <span class="qa-pick-item__meta">${meta}</span>
</div>`;
            }).join("");
            list.querySelectorAll(".qa-location-item").forEach((row) => {
                row.addEventListener("click", () => choose(visibleOptions[Number(row.getAttribute("data-index"))].path));
            });
            const active = list.querySelector(".qa-pick-item--active");
            if (active) {
                active.scrollIntoView({block: "nearest"});
            }
        };
        const refreshPaths = async () => {
            const version = ++loadVersion;
            loading = true;
            render();
            const nextPaths = await listDocPathsUnder(notebookId, "/").catch(() => ["/"]);
            if (settled || version !== loadVersion) {
                return;
            }
            paths = nextPaths;
            loading = false;
            activeIndex = 0;
            render();
            input.focus();
        };
        notebookSelect.addEventListener("change", () => {
            notebookId = notebookSelect.value;
            notebook = notebooks.find((item) => item.id === notebookId);
            notebookName = notebook ? notebook.name : "";
            input.value = "";
            void refreshPaths();
        });
        input.addEventListener("input", () => {
            activeIndex = 0;
            render();
        });
        input.addEventListener("keydown", (event) => {
            if (event.isComposing || event.keyCode === 229) {
                return;
            }
            if (event.key === "ArrowDown") {
                event.preventDefault();
                if (visibleOptions.length) {
                    activeIndex = (activeIndex + 1) % visibleOptions.length;
                    render();
                }
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                if (visibleOptions.length) {
                    activeIndex = (activeIndex - 1 + visibleOptions.length) % visibleOptions.length;
                    render();
                }
            } else if (event.key === "Enter") {
                event.preventDefault();
                if (loading) {
                    return;
                }
                const option = visibleOptions[activeIndex];
                if (option) {
                    choose(option.path);
                }
            }
        });
        render();
        setTimeout(() => input.focus(), 30);
    });
};

QuickAddUI.pickDoc = function(options) {
    const opts = options || {};
    return new Promise((resolve) => {
        let settled = false;
        const dialog = new Dialog({
            title: opts.title || "选择文档",
            width: "640px",
            height: "560px",
            content: `<div class="b3-dialog__content qa-dialog">
  <input class="b3-text-field fn__block qa-doc-search" placeholder="输入标题关键字搜索文档…">
  <div class="qa-pick-list qa-doc-list"><div class="qa-empty">输入关键字开始搜索</div></div>
</div>`,
            destroyCallback: () => {
                if (!settled) {
                    settled = true;
                    resolve(null);
                }
            },
        });
        const input = dialog.element.querySelector(".qa-doc-search");
        const list = dialog.element.querySelector(".qa-doc-list");
        let timer = null;
        const search = async () => {
            const keyword = input.value.trim();
            if (!keyword) {
                list.innerHTML = `<div class="qa-empty">输入关键字开始搜索</div>`;
                return;
            }
            list.innerHTML = `<div class="qa-empty">搜索中…</div>`;
            try {
                let stmt = `select id, content, hpath, box from blocks where type = 'd' and content like '%${keyword.replace(/'/g, "''")}%'`;
                if (opts.notebook) {
                    stmt += ` and box = '${String(opts.notebook).replace(/'/g, "''")}'`;
                }
                stmt += " order by updated desc limit 30";
                const rows = await postOk("/api/query/sql", {stmt: stmt});
                if (!Array.isArray(rows) || !rows.length) {
                    list.innerHTML = `<div class="qa-empty">没有找到匹配的文档</div>`;
                    return;
                }
                list.innerHTML = rows.map((row) => `<div class="qa-pick-item" data-id="${escapeAttr(row.id)}" data-hpath="${escapeAttr(row.hpath || "")}" data-box="${escapeAttr(row.box || "")}">
    <svg class="qa-svg"><use xlink:href="#iconFile"></use></svg>
    <span class="qa-pick-item__name">${escapeHtml(row.content || row.id)}</span>
    <span class="qa-pick-item__meta">${escapeHtml(row.hpath || "")}</span>
</div>`).join("");
                list.querySelectorAll(".qa-pick-item").forEach((row) => {
                    row.addEventListener("click", () => {
                        settled = true;
                        resolve({
                            id: row.getAttribute("data-id"),
                            hpath: row.getAttribute("data-hpath") || "",
                            content: row.querySelector(".qa-pick-item__name").textContent,
                            notebook: row.getAttribute("data-box") || "",
                        });
                        dialog.destroy();
                    });
                });
            } catch (e) {
                list.innerHTML = `<div class="qa-empty">搜索失败：${escapeHtml(e.message)}</div>`;
            }
        };
        input.addEventListener("input", () => {
            clearTimeout(timer);
            timer = setTimeout(search, 260);
        });
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
                clearTimeout(timer);
                search();
            }
        });
        setTimeout(() => input.focus(), 30);
    });
};

QuickAddUI.openPanel = function(options) {
    return new Promise((resolve) => {
        const opts = options || {};
        const multiple = opts.multiple === true;
        const source = opts.actions || (getApp() && getApp().settings.actions) || [];
        const actions = source.filter((item) => item.enabled !== false);
        const recent = (getApp() && getApp().settings.recent) || {};
        const ordered = actions.slice().sort((a, b) => {
            if (opts.preserveOrder) {
                return 0;
            }
            const ra = recent[a.id] || 0;
            const rb = recent[b.id] || 0;
            return rb - ra;
        });
        const selectedIds = new Set((opts.initialSelectedIds || []).filter((id) => actions.some((action) => action.id === id)));
        let activeIndex = 0;
        let filtered = ordered;
        let settled = false;
        let dialog = null;

        const finish = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(value);
            if (dialog) {
                dialog.destroy();
            }
        };

        dialog = new Dialog({
            title: opts.title || "QuickAdd",
            width: "560px",
            height: "520px",
            content: `<div class="b3-dialog__content qa-panel">
  <div class="qa-search">
    <svg class="qa-svg"><use xlink:href="#iconSearch"></use></svg>
    <input class="b3-text-field qa-search-input" placeholder="${multiple ? "搜索动作，勾选后可批量执行…" : "搜索动作，回车执行…"}" autocomplete="off">
  </div>
  <div class="qa-list" role="${multiple ? "group" : "listbox"}"></div>
  <div class="qa-panel-foot">
    <span class="qa-kbd-hint">${multiple
        ? `<kbd>↑</kbd><kbd>↓</kbd> 移动 · <kbd>Space</kbd> 勾选 · <kbd>Enter</kbd> 执行 · <kbd>Esc</kbd> 关闭`
        : `<kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>Enter</kbd> 执行 · <kbd>Esc</kbd> 关闭`}</span>
    <span class="fn__flex-1"></span>
    ${multiple
        ? `<button class="b3-button b3-button--cancel qa-picker-cancel">取消</button>
    <span class="fn__space"></span>
    <button class="b3-button b3-button--text qa-picker-confirm" disabled>执行 0 个</button>`
        : (opts.manage === false ? "" : `<button class="b3-button b3-button--text qa-manage">管理动作</button>`)}
  </div>
</div>`,
            destroyCallback: () => {
                if (!settled) {
                    settled = true;
                    resolve(multiple ? [] : null);
                }
            },
        });
        const listElement = dialog.element.querySelector(".qa-list");
        const input = dialog.element.querySelector(".qa-search-input");
        const confirmButton = dialog.element.querySelector(".qa-picker-confirm");

        const actionRowHtml = (action, index) => {
            const hotkey = action.hotkey ? `<span class="qa-item__hotkey">${escapeHtml(action.hotkey)}</span>` : "";
            const group = action.group ? `<span class="qa-item__group">${escapeHtml(action.group)}</span>` : "";
            const checked = selectedIds.has(action.id);
            return `<div class="qa-item${index === activeIndex ? " qa-item--active" : ""}${checked ? " qa-item--selected" : ""}" data-index="${index}" role="option" aria-selected="${checked}">
    ${multiple ? `<input class="qa-picker-check" type="checkbox" tabindex="-1"${checked ? " checked" : ""}>` : ""}
    <span class="qa-item__icon">${QuickAddUI.icon(action)}</span>
    <span class="qa-item__name">${escapeHtml(action.name)}</span>
    ${group}
    <span class="qa-item__type">${QuickAddUI.typeLabel(action.type)}</span>
    ${hotkey}
</div>`;
        };

        const updateSelectionUi = () => {
            if (!confirmButton) {
                return;
            }
            const count = selectedIds.size;
            confirmButton.textContent = "执行 " + count + " 个";
            confirmButton.disabled = count === 0;
        };

        const render = () => {
            if (!filtered.length) {
                listElement.innerHTML = `<div class="qa-empty">${actions.length ? "没有匹配的动作" : "还没有动作，点击「管理动作」创建"}</div>`;
                updateSelectionUi();
                return;
            }
            const indexById = new Map(filtered.map((action, index) => [action.id, index]));
            if (multiple) {
                listElement.innerHTML = QuickAddUI.groupActions(filtered).map((group) => `<section class="qa-action-group">
  <div class="qa-action-group__title">
    <span>${escapeHtml(group.name)}</span>
    <span class="qa-action-group__count">${group.actions.length}</span>
  </div>
  <div class="qa-action-group__body">${group.actions.map((action) => actionRowHtml(action, indexById.get(action.id))).join("")}</div>
</section>`).join("");
            } else {
                listElement.innerHTML = filtered.map((action, index) => actionRowHtml(action, index)).join("");
            }
            listElement.querySelectorAll(".qa-item").forEach((item) => {
                item.addEventListener("mouseenter", () => {
                    activeIndex = Number(item.getAttribute("data-index"));
                    listElement.querySelectorAll(".qa-item").forEach((row) => row.classList.remove("qa-item--active"));
                    item.classList.add("qa-item--active");
                });
                item.addEventListener("click", (event) => {
                    const index = Number(item.getAttribute("data-index"));
                    const action = filtered[index];
                    if (!action) {
                        return;
                    }
                    activeIndex = index;
                    if (multiple) {
                        event.preventDefault();
                        if (selectedIds.has(action.id)) {
                            selectedIds.delete(action.id);
                        } else {
                            selectedIds.add(action.id);
                        }
                        render();
                        return;
                    }
                    run(index);
                });
            });
            updateSelectionUi();
        };

        const run = (index) => {
            const action = filtered[index];
            if (!action) {
                return;
            }
            finish(action);
            if (opts.onPick) {
                opts.onPick(action);
            } else {
                runAction(action);
            }
        };

        const confirmSelection = () => {
            if (!multiple) {
                run(activeIndex);
                return;
            }
            const selected = ordered.filter((action) => selectedIds.has(action.id));
            if (selected.length) {
                finish(selected);
            }
        };

        const update = () => {
            const keyword = input.value.trim().toLowerCase();
            filtered = ordered.filter((action) => {
                if (!keyword) {
                    return true;
                }
                return (action.name + " " + (action.group || "") + " " + QuickAddUI.typeLabel(action.type)).toLowerCase().includes(keyword);
            });
            activeIndex = 0;
            render();
        };

        input.addEventListener("input", update);
        dialog.element.addEventListener("keydown", (event) => {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                if (filtered.length) {
                    activeIndex = Math.min(filtered.length - 1, activeIndex + 1);
                    render();
                    listElement.querySelector(".qa-item--active")?.scrollIntoView({block: "nearest"});
                }
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                if (filtered.length) {
                    activeIndex = Math.max(0, activeIndex - 1);
                    render();
                    listElement.querySelector(".qa-item--active")?.scrollIntoView({block: "nearest"});
                }
            } else if (event.key === " " && multiple) {
                event.preventDefault();
                const action = filtered[activeIndex];
                if (action) {
                    if (selectedIds.has(action.id)) {
                        selectedIds.delete(action.id);
                    } else {
                        selectedIds.add(action.id);
                    }
                    render();
                }
            } else if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                confirmSelection();
            }
        });
        const manage = dialog.element.querySelector(".qa-manage");
        if (manage) {
            manage.addEventListener("click", () => {
                finish(null);
                QuickAddUI.openManager();
            });
        }
        dialog.element.querySelector(".qa-picker-cancel")?.addEventListener("click", () => finish([]));
        confirmButton?.addEventListener("click", confirmSelection);
        render();
        setTimeout(() => input.focus(), 30);
    });
};
QuickAddUI.confirm = function(title, message, okText) {
    return new Promise((resolve) => {
        let settled = false;
        const dialog = new Dialog({
            title: title || "确认",
            width: "420px",
            content: `<div class="b3-dialog__content qa-dialog"><div class="qa-confirm-text">${escapeHtml(message)}</div></div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--cancel">取消</button>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--text qa-ok">${escapeHtml(okText || "确定")}</button>
</div>`,
            destroyCallback: () => {
                if (!settled) {
                    settled = true;
                    resolve(false);
                }
            },
        });
        dialog.element.querySelector(".qa-ok").addEventListener("click", () => {
            settled = true;
            resolve(true);
            dialog.destroy();
        });
        dialog.element.querySelector(".b3-button--cancel").addEventListener("click", () => dialog.destroy());
    });
};

function setByPath(target, path, value) {
    const parts = path.split(".");
    let cursor = target;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!cursor[parts[i]] || typeof cursor[parts[i]] !== "object") {
            cursor[parts[i]] = {};
        }
        cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = value;
}

function getByPath(target, path) {
    return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), target);
}

function selectHtml(field, current, options, extra) {
    const items = options.map((item) => `<option value="${escapeAttr(item.value)}"${String(item.value) === String(current || "") ? " selected" : ""}>${escapeHtml(item.label)}</option>`).join("");
    return `<select class="b3-select fn__block" data-field="${escapeAttr(field)}" ${extra || ""}>${items}</select>`;
}

function inputHtml(field, current, placeholder, type) {
    return `<input class="b3-text-field fn__block" type="${type || "text"}" data-field="${escapeAttr(field)}" value="${escapeAttr(current || "")}" placeholder="${escapeAttr(placeholder || "")}">`;
}

function textareaHtml(field, current, placeholder, rows) {
    return `<textarea class="b3-text-field fn__block qa-code" rows="${rows || 6}" data-field="${escapeAttr(field)}" placeholder="${escapeAttr(placeholder || "")}">${escapeHtml(current || "")}</textarea>`;
}

function checkboxHtml(field, current, label) {
    return `<label class="qa-check"><input type="checkbox" data-field="${escapeAttr(field)}" data-bool="1"${current ? " checked" : ""}><span>${escapeHtml(label)}</span></label>`;
}

QuickAddUI.field = function(label, inner, hint) {
    return `<div class="qa-field">
  <div class="qa-field__label">${escapeHtml(label)}</div>
  ${inner}
  ${hint ? `<div class="qa-field__hint">${hint}</div>` : ""}
</div>`;
};

QuickAddUI.notebookOptions = function(notebooks, current) {
    return [{value: "", label: "（使用当前文档所在笔记本）"}].concat(notebooks.map((item) => ({value: item.id, label: item.name})))
        .map((item) => `<option value="${escapeAttr(item.value)}"${String(item.value) === String(current || "") ? " selected" : ""}>${escapeHtml(item.label)}</option>`).join("");
};

QuickAddUI.typeBodyHtml = function(draft, notebooks, templateFiles) {
    const action = draft;
    if (action.type === "capture") {
        const cap = action.capture;
        const targetOptions = [
            {value: "current", label: "当前文档"},
            {value: "macro-created", label: "宏中新建/打开的文档"},
            {value: "cursor", label: "光标处"},
            {value: "path", label: "指定路径的文档"},
            {value: "daily", label: "今天的日记"},
            {value: "docId", label: "指定文档 ID"},
        ];
        const positionOptions = [
            {value: "append", label: "追加到文档末尾"},
            {value: "prepend", label: "插入到文档开头"},
            {value: "after-block", label: "当前块之后"},
            {value: "child-block", label: "作为当前块的子块"},
        ];
        let extra = "";
        if (cap.target === "path" || cap.target === "daily") {
            extra += QuickAddUI.field("笔记本", `<select class="b3-select fn__block" data-field="capture.notebook">${QuickAddUI.notebookOptions(notebooks, cap.notebook)}</select>`, "为空时使用当前文档所在笔记本");
        }
        if (cap.target === "path") {
            extra += QuickAddUI.field("文档路径", inputHtml("capture.path", cap.path, "如 /收集箱/灵感"), "文档的完整 hpath；支持 <code>{{date}}</code> 等变量，不存在时自动创建");
        }
        if (cap.target === "docId") {
            extra += QuickAddUI.field("文档 ID", inputHtml("capture.docId", cap.docId, "目标文档的块 ID"), "");
        }
        return QuickAddUI.field("目标", selectHtml("capture.target", cap.target, targetOptions))
            + extra
            + QuickAddUI.field("插入位置", selectHtml("capture.position", cap.position, positionOptions), "目标为「光标处」时忽略此项")
            + QuickAddUI.field("记录内容", textareaHtml("capture.content", cap.content, "- {{time}} {{input:内容}}", 7), "支持 Markdown 与变量，详见底部变量说明")
            + checkboxHtml("capture.openAfter", cap.openAfter, "记录后打开目标文档");
    }
    if (action.type === "template") {
        const tpl = action.template || defaultActionTemplate();
        const source = tpl.source === "file" ? "file" : "inline";
        const sourceOptions = [
            {value: "inline", label: "内联 Markdown"},
            {value: "file", label: "模板文件（data/templates）"},
        ];
        const existsOptions = [
            {value: "open", label: "打开已有文档"},
            {value: "duplicate", label: "仍然新建"},
        ];
        const locationOptions = [
            {value: "notebook", label: "指定笔记本 + 父路径（绝对）"},
            {value: "current-folder", label: "当前文档所在目录（同级）"},
            {value: "current-doc", label: "作为当前文档的子文档"},
            {value: "current-notebook", label: "当前笔记本根目录"},
            {value: "runtime", label: "每次执行时选择位置（可跨笔记本）"},
        ];
        const location = tpl.location || "notebook";
        const locationHint = {
            notebook: "父路径只在你选择的笔记本内生效；不存在时会自动创建父文档。",
            "current-folder": "新文档和当前文档同级，笔记本自动跟随当前文档。",
            "current-doc": "新文档成为当前文档的子文档，笔记本自动跟随当前文档。",
            "current-notebook": "新文档放在当前笔记本的根目录。",
            runtime: "执行时先选择笔记本，再选择或输入保存路径；下方是选择器的默认值，不会限制切换。",
        }[location] || "";
        let locHtml = QuickAddUI.field("位置", selectHtml("template.location", location, locationOptions), escapeHtml(locationHint));
        if (location === "notebook" || location === "runtime") {
            const notebookHint = location === "runtime"
                ? "选择器的默认笔记本；为空时使用当前文档所在笔记本"
                : "为空时使用当前文档所在笔记本";
            const folderHint = location === "runtime"
                ? "选择器的默认保存位置；执行时可以选择其他路径，支持 <code>{{date}}</code> 等变量"
                : "点击「选择」浏览该笔记本里的文档；也可直接输入，支持 <code>{{date}}</code> 等变量";
            locHtml += QuickAddUI.field(location === "runtime" ? "默认笔记本" : "笔记本", `<select class="b3-select fn__block" data-field="template.notebook">${QuickAddUI.notebookOptions(notebooks, tpl.notebook)}</select>`, notebookHint);
            locHtml += QuickAddUI.field(location === "runtime" ? "默认父路径" : "父路径", `<div class="fn__flex"><input class="b3-text-field fn__flex-1" data-field="template.folder" value="${escapeAttr(tpl.folder || "")}" placeholder="如 /技能学习/编程"><span class="fn__space"></span><button class="b3-button b3-button--outline qa-pick-folder">选择</button></div>`, folderHint);
        }
        if (location === "notebook") {
            locHtml += checkboxHtml("template.chooseFolder", tpl.chooseFolder === true, "执行时先选择子路径（列出父路径下的现有层级，也可输入新路径），再填写标题等变量");
        }
        let sourceHtml = "";
        if (source === "file") {
            const files = (templateFiles || []).slice();
            const current = tpl.file || "";
            if (current && !files.includes(current)) {
                files.unshift(current);
            }
            const optionHtml = [{value: "", label: "（选择模板文件）"}].concat(files.map((file) => ({value: file, label: file})))
                .map((item) => `<option value="${escapeAttr(item.value)}"${String(item.value) === String(current) ? " selected" : ""}>${escapeHtml(item.label)}</option>`).join("");
            sourceHtml = QuickAddUI.field("模板文件", `<div class="fn__flex"><select class="b3-select fn__flex-1" data-field="template.file">${optionHtml}</select><span class="fn__space"></span><button class="b3-button b3-button--outline qa-refresh-templates">刷新</button><span class="fn__space"></span><button class="b3-button b3-button--outline qa-open-templates">打开目录</button></div>`, "来自 <code>data/templates</code>，支持思源模板语法（<code>.action{…}</code>、<code>{{.title}}</code>、<code>{{now | date &quot;2006-01-02&quot;}}</code>）");
        } else {
            sourceHtml = QuickAddUI.field("模板内容", textareaHtml("template.content", tpl.content, "输入 Markdown 模板内容（可留空）", 8), "支持 Markdown；变量可按需添加、编辑或删除");
        }
        return locHtml
            + QuickAddUI.field("标题", inputHtml("template.title", tpl.title, "{{date:YYYY-MM-DD}} {{input:标题}}"), "支持变量；同名文档按下方规则处理")
            + QuickAddUI.field("内容来源", selectHtml("template.source", source, sourceOptions))
            + sourceHtml
            + QuickAddUI.field("标签", inputHtml("template.tags", tpl.tags, "如 读书, 待整理"), "多个标签用逗号分隔")
            + QuickAddUI.field("同名文档", selectHtml("template.onExists", tpl.onExists || "open", existsOptions))
            + checkboxHtml("template.openAfter", tpl.openAfter !== false, "创建后打开新文档");
    }
    if (action.type === "macro") {
        const steps = (action.macro && action.macro.steps) || [];
        const rows = steps.map((step, index) => {
            const child = resolveStepAction(step);
            if (!child) {
                return "";
            }
            return `<div class="qa-step" data-step-index="${index}">
    <span class="qa-step__index">${index + 1}</span>
    <span class="qa-step__icon">${QuickAddUI.icon(child)}</span>
    <span class="qa-step__name">${escapeHtml(child.name)}</span>
    <span class="qa-step__type">${QuickAddUI.typeLabel(child.type)}</span>
    <span class="fn__flex-1"></span>
    <button class="b3-button b3-button--text qa-step-up" title="上移">↑</button>
    <button class="b3-button b3-button--text qa-step-down" title="下移">↓</button>
    <button class="b3-button b3-button--text qa-step-del" title="移除">✕</button>
</div>`;
        }).join("");
        const candidates = ((getApp() && getApp().settings && getApp().settings.actions) || [])
            .filter((item) => item.id !== action.id && item.type !== "multi");
        const addOptions = candidates.map((item) => `<option value="${escapeAttr(item.id)}">${escapeHtml(item.name)}（${QuickAddUI.typeLabel(item.type)}）</option>`).join("");
        return `<div class="qa-field">
  <div class="qa-field__label">执行步骤</div>
  <div class="qa-steps">${rows || `<div class="qa-empty">还没有步骤</div>`}</div>
  <div class="fn__flex qa-step-add">
    <select class="b3-select fn__flex-1 qa-step-select"><option value="">选择要添加的动作…</option>${addOptions}</select>
    <span class="fn__space"></span>
    <button class="b3-button b3-button--outline qa-step-add-btn">添加步骤</button>
  </div>
  <div class="qa-field__hint">宏会按顺序执行这些动作，变量只需填写一次。</div>
</div>`;
    }
    if (action.type === "multi") {
        const multi = Object.assign(defaultActionMulti(), action.multi || {});
        const children = multi.children || [];
        const candidates = ((getApp() && getApp().settings && getApp().settings.actions) || [])
            .filter((item) => item.id !== action.id && item.type !== "multi");
        const childRow = (item) => `<label class="qa-check qa-check--row">
  <input type="checkbox" data-child-id="${escapeAttr(item.id)}"${children.includes(item.id) ? " checked" : ""}>
  <span class="qa-step__icon">${QuickAddUI.icon(item)}</span>
  <span>${escapeHtml(item.name)}</span>
  <span class="qa-item__type">${QuickAddUI.typeLabel(item.type)}</span>
</label>`;
        const groupRows = QuickAddUI.groupActions(candidates).map((group) => `<div class="qa-child-group">
  <div class="qa-action-group__title">
    <span>${escapeHtml(group.name)}</span>
    <span class="qa-action-group__count">${group.actions.length}</span>
  </div>
  <div class="qa-child-group__body">${group.actions.map(childRow).join("")}</div>
</div>`).join("");
        return `<div class="qa-field">
  <div class="qa-field__label">入口模式</div>
  ${selectHtml("multi.mode", multi.mode || "one", [
      {value: "one", label: "单选入口：只执行一个动作"},
      {value: "many", label: "多选执行：可勾选多个动作"},
  ])}
  <div class="qa-field__hint">多选执行会按下方“包含的动作”配置顺序串行运行，并共享同一份上下文与变量。</div>
</div>
<div class="qa-field">
  <div class="qa-field__label">包含的动作</div>
  <div class="qa-children">${groupRows || `<div class="qa-empty">还没有其他动作</div>`}</div>
  ${multi.mode === "many"
      ? checkboxHtml("multi.stopOnError", multi.stopOnError !== false, "某个动作失败后停止后续动作")
      : `<div class="qa-field__hint">运行时只能选择一个动作；若只需固定顺序，请使用“宏”。</div>`}
  <div class="qa-field__hint">多选至少需要勾选一个动作；取消弹窗不会执行任何内容。</div>
</div>`;
    }
    return "";
};

QuickAddUI.openEditor = async function(action, options) {
    const opts = options || {};
    const notebooks = await listNotebooks().catch(() => []);
    let templateFiles = await listTemplateFiles().catch(() => []);
    const isNew = !action;
    let draft = normalizeAction(clone(action || {name: "新动作", type: "capture", capture: defaultActionCapture()}));
    let dialog = null;

    const renderBody = () => {
        const body = dialog.element.querySelector(".qa-editor-body");
        body.innerHTML = QuickAddUI.typeBodyHtml(draft, notebooks, templateFiles);
        const rerenderOn = (selector) => {
            const element = body.querySelector(selector);
            if (element) {
                element.addEventListener("change", () => {
                    collectForm();
                    renderBody();
                });
            }
        };
        rerenderOn('[data-field="capture.target"]');
        rerenderOn('[data-field="template.source"]');
        rerenderOn('[data-field="template.location"]');
        rerenderOn('[data-field="multi.mode"]');
        const pickFolder = body.querySelector(".qa-pick-folder");
        if (pickFolder) {
            pickFolder.addEventListener("click", async () => {
                collectForm();
                const doc = await QuickAddUI.pickDoc({title: "选择父文档", notebook: draft.template.notebook});
                if (doc) {
                    draft.template.folder = doc.hpath || "/";
                    if (draft.template.location === "runtime" && doc.notebook) {
                        draft.template.notebook = doc.notebook;
                    }
                    renderBody();
                }
            });
        }
        const refreshTemplates = body.querySelector(".qa-refresh-templates");
        if (refreshTemplates) {
            refreshTemplates.addEventListener("click", async () => {
                collectForm();
                templateFiles = await listTemplateFiles().catch(() => []);
                renderBody();
            });
        }
        const openTemplates = body.querySelector(".qa-open-templates");
        if (openTemplates) {
            openTemplates.addEventListener("click", () => {
                const file = draft.template.file ? "/data/templates/" + trimSlashes(draft.template.file) : "/data/templates";
                if (siyuan.openPath) {
                    siyuan.openPath(file);
                } else {
                    toast("请在文件管理器打开：" + file);
                }
            });
        }
        const addBtn = body.querySelector(".qa-step-add-btn");
        if (addBtn) {
            addBtn.addEventListener("click", () => {
                collectForm();
                const select = body.querySelector(".qa-step-select");
                if (!select || !select.value) {
                    return;
                }
                draft.macro = draft.macro || {steps: []};
                draft.macro.steps.push({actionId: select.value});
                renderBody();
            });
        }
        body.querySelectorAll(".qa-step-up").forEach((btn) => btn.addEventListener("click", () => {
            collectForm();
            const index = Number(btn.closest(".qa-step").getAttribute("data-step-index"));
            if (index > 0) {
                const steps = draft.macro.steps;
                [steps[index - 1], steps[index]] = [steps[index], steps[index - 1]];
                renderBody();
            }
        }));
        body.querySelectorAll(".qa-step-down").forEach((btn) => btn.addEventListener("click", () => {
            collectForm();
            const index = Number(btn.closest(".qa-step").getAttribute("data-step-index"));
            const steps = draft.macro.steps;
            if (index < steps.length - 1) {
                [steps[index + 1], steps[index]] = [steps[index], steps[index + 1]];
                renderBody();
            }
        }));
        body.querySelectorAll(".qa-step-del").forEach((btn) => btn.addEventListener("click", () => {
            collectForm();
            const index = Number(btn.closest(".qa-step").getAttribute("data-step-index"));
            draft.macro.steps.splice(index, 1);
            renderBody();
        }));
    };

    const collectForm = () => {
        dialog.element.querySelectorAll("[data-field]").forEach((element) => {
            const field = element.getAttribute("data-field");
            let value = element.type === "checkbox" ? element.checked : element.value;
            if (element.hasAttribute("data-bool")) {
                value = element.checked;
            }
            setByPath(draft, field, value);
        });
        const typeSelect = dialog.element.querySelector('[data-field="type"]');
        if (typeSelect) {
            draft.type = typeSelect.value;
        }
        if (draft.type === "multi") {
            const childBoxes = dialog.element.querySelectorAll("[data-child-id]");
            draft.multi = draft.multi || defaultActionMulti();
            draft.multi.children = Array.from(childBoxes)
                .filter((box) => box.checked)
                .map((box) => box.getAttribute("data-child-id"));
        }
    };

    dialog = QuickAddUI.dialogShell(opts.title || (isNew ? "新建动作" : "编辑动作"), `<div class="qa-editor">
  <div class="qa-editor-head">
    <input class="b3-text-field qa-icon-input" data-field="icon" value="${escapeAttr(draft.icon)}" title="图标（emoji 或 iconXxx）">
    <input class="b3-text-field fn__flex-1 qa-name-input" data-field="name" value="${escapeAttr(draft.name)}" placeholder="动作名称">
    <select class="b3-select qa-type-select">${["capture", "template", "macro", "multi"].map((type) => `<option value="${type}"${draft.type === type ? " selected" : ""}>${QuickAddUI.typeLabel(type)}</option>`).join("")}</select>
  </div>
  <div class="qa-field qa-field--inline">
    <div class="qa-field__label">快捷键</div>
    <input class="b3-text-field fn__flex-1" data-field="hotkey" value="${escapeAttr(draft.hotkey)}" placeholder="如 Ctrl+Alt+1（留空表示不绑定）">
  </div>
  <div class="qa-field qa-field--inline">
    <div class="qa-field__label">分组</div>
    <input class="b3-text-field fn__flex-1" data-field="group" value="${escapeAttr(draft.group || "")}" placeholder="可选，用于面板中归类">
  </div>
  <div class="qa-editor-body"></div>
  <details class="qa-help">
    <summary>可用变量</summary>
    <div class="qa-help__body">
      <code>{{date}}</code> <code>{{date:YYYY年MM月DD日}}</code> <code>{{time}}</code> <code>{{datetime}}</code><br>
      <code>{{input:提示语}}</code>（执行时弹窗填写，同一提示语只填一次）<br>
      <code>{{title}}</code> <code>{{docPath}}</code> <code>{{notebook}}</code> <code>{{clipboard}}</code> <code>{{selection}}</code> <code>{{random:6}}</code><br>
      也兼容 QuickAdd 写法：<code>{{VALUE}}</code> <code>{{VALUE:提示语}}</code> <code>{{DATE}}</code> <code>{{TIME}}</code> <code>{{CLIPBOARD}}</code> <code>{{TITLE}}</code>
    </div>
  </details>
</div>`, `<button class="b3-button b3-button--cancel">取消</button>
${isNew ? "" : `<div class="fn__space"></div><button class="b3-button b3-button--warning qa-delete">删除</button>`}
<div class="fn__space"></div>
<button class="b3-button b3-button--text qa-save">保存</button>`, {width: "680px", height: opts.height || "76vh"});

    renderBody();
    dialog.element.querySelector(".qa-type-select").addEventListener("change", (event) => {
        collectForm();
        draft.type = event.target.value;
        if (draft.type === "template" && !draft.template) {
            draft.template = defaultActionTemplate();
        }
        if (draft.type === "capture" && !draft.capture) {
            draft.capture = defaultActionCapture();
        }
        if (draft.type === "macro" && !draft.macro) {
            draft.macro = {steps: []};
        }
        if (draft.type === "multi" && !draft.multi) {
            draft.multi = defaultActionMulti();
        }
        renderBody();
    });
    dialog.element.querySelector(".qa-save").addEventListener("click", async () => {
        collectForm();
        draft.name = String(draft.name || "").trim();
        if (!draft.name) {
            toast("请填写动作名称", "error");
            return;
        }
        draft = normalizeAction(draft);
        if (isNew) {
            getApp().settings.actions.push(draft);
        } else {
            const index = getApp().settings.actions.findIndex((item) => item.id === draft.id);
            if (index >= 0) {
                getApp().settings.actions[index] = draft;
            } else {
                getApp().settings.actions.push(draft);
            }
        }
        await getApp().saveSettings();
        dialog.destroy();
        toast("已保存");
        if (opts.onSaved) {
            opts.onSaved();
        }
    });
    const deleteButton = dialog.element.querySelector(".qa-delete");
    if (deleteButton) {
        deleteButton.addEventListener("click", async () => {
            const ok = await QuickAddUI.confirm("删除动作", "确定删除「" + draft.name + "」？此操作不可撤销。", "删除");
            if (!ok) {
                return;
            }
            getApp().settings.actions = getApp().settings.actions.filter((item) => item.id !== draft.id);
            await getApp().saveSettings();
            dialog.destroy();
            toast("已删除");
            if (opts.onSaved) {
                opts.onSaved();
            }
        });
    }
    dialog.element.querySelector(".b3-button--cancel").addEventListener("click", () => dialog.destroy());
    setTimeout(() => dialog.element.querySelector(".qa-name-input")?.focus(), 30);
};
QuickAddUI.openManager = function() {
    let dialog = null;
    const render = () => {
        const actions = getApp().settings.actions;
        const rows = actions.map((action, index) => `<div class="qa-manager-row" data-id="${escapeAttr(action.id)}">
  <input class="b3-switch qa-switch" type="checkbox"${action.enabled !== false ? " checked" : ""} title="启用/停用">
  <span class="qa-item__icon">${QuickAddUI.icon(action)}</span>
  <span class="qa-manager-name">${escapeHtml(action.name)}</span>
  <span class="qa-item__type">${QuickAddUI.typeLabel(action.type)}</span>
  ${action.hotkey ? `<span class="qa-item__hotkey">${escapeHtml(action.hotkey)}</span>` : ""}
  <span class="fn__flex-1"></span>
  <button class="b3-button b3-button--text qa-up" title="上移"${index === 0 ? " disabled" : ""}>↑</button>
  <button class="b3-button b3-button--text qa-down" title="下移"${index === actions.length - 1 ? " disabled" : ""}>↓</button>
  <button class="b3-button b3-button--text qa-edit">编辑</button>
  <button class="b3-button b3-button--text qa-remove">删除</button>
</div>`).join("");
        dialog.element.querySelector(".qa-manager-list").innerHTML = rows || `<div class="qa-empty">还没有动作</div>`;
        dialog.element.querySelector(".qa-manager-count").textContent = "共 " + actions.length + " 个动作";
        dialog.element.querySelectorAll(".qa-manager-row").forEach((row) => {
            const id = row.getAttribute("data-id");
            const action = getApp().settings.actions.find((item) => item.id === id);
            row.querySelector(".qa-switch").addEventListener("change", async (event) => {
                action.enabled = event.target.checked;
                await getApp().saveSettings();
            });
            row.querySelector(".qa-edit").addEventListener("click", () => QuickAddUI.openEditor(action, {onSaved: render}));
            row.querySelector(".qa-remove").addEventListener("click", async () => {
                const ok = await QuickAddUI.confirm("删除动作", "确定删除「" + action.name + "」？", "删除");
                if (ok) {
                    getApp().settings.actions = getApp().settings.actions.filter((item) => item.id !== id);
                    await getApp().saveSettings();
                    render();
                }
            });
            row.querySelector(".qa-up").addEventListener("click", async () => {
                const index = getApp().settings.actions.findIndex((item) => item.id === id);
                if (index > 0) {
                    const list = getApp().settings.actions;
                    [list[index - 1], list[index]] = [list[index], list[index - 1]];
                    await getApp().saveSettings();
                    render();
                }
            });
            row.querySelector(".qa-down").addEventListener("click", async () => {
                const index = getApp().settings.actions.findIndex((item) => item.id === id);
                const list = getApp().settings.actions;
                if (index >= 0 && index < list.length - 1) {
                    [list[index + 1], list[index]] = [list[index], list[index + 1]];
                    await getApp().saveSettings();
                    render();
                }
            });
        });
    };
    dialog = QuickAddUI.dialogShell("动作管理", `<div class="qa-manager">
  <div class="qa-manager-head">
    <span class="qa-manager-count"></span>
    <span class="fn__flex-1"></span>
    <button class="b3-button b3-button--outline qa-new">新建动作</button>
  </div>
  <div class="qa-manager-list"></div>
</div>`, `<button class="b3-button b3-button--cancel">关闭</button>
<div class="fn__space"></div>
<button class="b3-button b3-button--outline qa-import">导入</button>
<div class="fn__space"></div>
<button class="b3-button b3-button--outline qa-export">导出</button>
<div class="fn__space"></div>
<button class="b3-button b3-button--text qa-run">打开面板</button>`, {width: "720px", height: "70vh"});
    render();
    dialog.element.querySelector(".qa-new").addEventListener("click", () => QuickAddUI.openEditor(null, {onSaved: render}));
    dialog.element.querySelector(".qa-run").addEventListener("click", () => {
        dialog.destroy();
        QuickAddUI.openPanel();
    });
    dialog.element.querySelector(".b3-button--cancel").addEventListener("click", () => dialog.destroy());
    dialog.element.querySelector(".qa-export").addEventListener("click", () => {
        QuickAddUI.openTextDialog("导出动作 (JSON)", JSON.stringify(getApp().settings.actions, null, 2), "复制下面的 JSON 保存即可。", null);
    });
    dialog.element.querySelector(".qa-import").addEventListener("click", () => {
        QuickAddUI.openTextDialog("导入动作 (JSON)", "", "粘贴之前导出的 JSON 数组，导入后会追加到现有动作。", async (text) => {
            const parsed = JSON.parse(text);
            if (!Array.isArray(parsed)) {
                throw new Error("需要 JSON 数组");
            }
            parsed.forEach((item) => getApp().settings.actions.push(normalizeAction(item)));
            await getApp().saveSettings();
            render();
            toast("已导入 " + parsed.length + " 个动作");
        });
    });
};

QuickAddUI.openTextDialog = function(title, value, hint, onSubmit) {
    let dialog = null;
    dialog = QuickAddUI.dialogShell(title, `<div class="qa-dialog">
  <div class="qa-hint">${escapeHtml(hint || "")}</div>
  <textarea class="b3-text-field fn__block qa-code qa-json" rows="16" spellcheck="false">${escapeHtml(value || "")}</textarea>
</div>`, onSubmit ? `<button class="b3-button b3-button--cancel">取消</button><div class="fn__space"></div><button class="b3-button b3-button--text qa-ok">导入</button>` : `<button class="b3-button b3-button--cancel">关闭</button>`, {width: "660px", height: "70vh"});
    dialog.element.querySelector(".b3-button--cancel").addEventListener("click", () => dialog.destroy());
    const ok = dialog.element.querySelector(".qa-ok");
    if (ok) {
        ok.addEventListener("click", async () => {
            try {
                await onSubmit(dialog.element.querySelector(".qa-json").value);
                dialog.destroy();
            } catch (e) {
                toast(e.message || String(e), "error", 6000);
            }
        });
    }
    const area = dialog.element.querySelector(".qa-json");
    if (area) {
        setTimeout(() => {
            area.focus();
            area.select();
        }, 30);
    }
};

module.exports = {
    configureUI,
    QuickAddUI,
};
