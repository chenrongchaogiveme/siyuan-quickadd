const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");

const apiCalls = [];
const originalLoad = Module._load;
Module._load = function loadWithSiYuanMock(request, parent, isMain) {
    if (request === "siyuan") {
        return {
            Plugin: class {},
            Dialog: class {},
            Menu: class {},
            showMessage() {},
            fetchSyncPost(path, payload) {
                apiCalls.push({path, payload});
                return Promise.resolve({code: 0, data: {}});
            },
            openTab() {},
            getActiveEditor() {
                return null;
            },
            insertContent() {},
            Setting: class {},
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const QuickAddPlugin = require("../index.js");
Module._load = originalLoad;

const {
    collectInputsFromAction,
    executeCapture,
    executeMultiSelection,
    rememberActionDocument,
    prepareTemplateFolderChoice,
    resolveTemplateLocation,
    resolveTargetDoc,
    runActionWithContext,
    typeBodyHtml,
    normalizeAction,
    QuickAddUI,
} = QuickAddPlugin.__test;

function captureAction(id, label) {
    return {
        id,
        name: id,
        type: "capture",
        enabled: true,
        capture: {content: `{{input:${label}}}`},
    };
}

function templateAction(id, titleLabel, folderLabel) {
    return {
        id,
        name: id,
        type: "template",
        enabled: true,
        template: {
            title: `{{input:${titleLabel}}}`,
            folder: `/${folderLabel ? `{{input:${folderLabel}}}` : ""}`,
            source: "inline",
            content: "",
        },
    };
}

test("macro input collection resolves referenced actions", () => {
    const template = templateAction("template", "Title", "Path");
    const capture = captureAction("capture", "Content");
    const macro = {
        id: "macro",
        name: "macro",
        type: "macro",
        enabled: true,
        macro: {steps: [{actionId: template.id}, {actionId: capture.id}]},
    };

    const inputs = collectInputsFromAction(macro, [], [], [template, capture, macro]);
    assert.deepEqual(inputs.map((item) => item.key), ["Title", "Path", "Content"]);
});

test("macro input collection deduplicates values and stops reference cycles", () => {
    const template = templateAction("template", "Title");
    const capture = captureAction("capture", "Title");
    const macroA = {
        id: "macro-a",
        name: "A",
        type: "macro",
        enabled: true,
        macro: {steps: [{actionId: "macro-b"}, {actionId: template.id}]},
    };
    const macroB = {
        id: "macro-b",
        name: "B",
        type: "macro",
        enabled: true,
        macro: {steps: [{actionId: "macro-a"}, {actionId: capture.id}]},
    };

    const inputs = collectInputsFromAction(macroA, [], [], [template, capture, macroA, macroB]);
    assert.deepEqual(inputs.map((item) => item.key), ["Title"]);
});

test("capture resolves the document created by an earlier macro step", async () => {
    const target = await resolveTargetDoc({target: "macro-created"}, {
        lastCreatedId: "new-doc-id",
        lastCreatedTitle: "新文档",
        lastCreatedPath: "/收集箱/新文档",
        lastCreatedNotebook: "notebook-id",
    });

    assert.deepEqual(target, {
        id: "new-doc-id",
        title: "新文档",
        path: "/收集箱/新文档",
        notebook: "notebook-id",
    });
});

test("capture editor exposes the macro-created document target", () => {
    const html = typeBodyHtml({
        type: "capture",
        capture: {
            target: "macro-created",
            notebook: "",
            path: "",
            docId: "",
            position: "append",
            content: "- {{time}} {{input:内容}}",
        },
    }, [], []);

    assert.match(html, /value="macro-created" selected/);
});

test("template editor only exposes inline Markdown and template files", () => {
    const html = typeBodyHtml({
        type: "template",
        template: {
            title: "标题",
            folder: "/",
            source: "inline",
            content: "",
            file: "",
        },
    }, [], []);

    assert.match(html, /内联 Markdown/);
    assert.match(html, /模板文件（data\/templates）/);
    assert.doesNotMatch(html, /以某篇文档为模板/);
    assert.doesNotMatch(html, /value="doc"/);
    assert.doesNotMatch(html, /qa-pick-doc/);
});

test("template editor exposes runtime location with default notebook and path", () => {
    const html = typeBodyHtml({
        type: "template",
        template: {
            location: "runtime",
            notebook: "",
            folder: "/阅读",
            title: "标题",
            source: "inline",
            content: "",
            file: "",
        },
    }, [], []);

    assert.match(html, /value="runtime" selected/);
    assert.match(html, /每次执行时选择位置（可跨笔记本）/);
    assert.match(html, /data-field="template.notebook"/);
    assert.match(html, /data-field="template.folder"/);
    assert.doesNotMatch(html, /data-field="template.chooseFolder"/);
});

test("runtime template stores the location chosen at execution time", async () => {
    const originalPickLocation = QuickAddUI.pickLocation;
    QuickAddUI.pickLocation = async (options) => {
        assert.equal(options.notebook, "current-notebook");
        assert.equal(options.basePath, "/默认位置");
        return {notebook: "other-notebook", folder: "/阅读"};
    };
    try {
        const ctx = {notebookId: "current-notebook", vars: {}};
        const ready = await prepareTemplateFolderChoice({
            id: "runtime-template",
            name: "运行时模板",
            type: "template",
            template: {
                location: "runtime",
                notebook: "",
                folder: "/默认位置",
            },
        }, ctx);

        assert.equal(ready, true);
        assert.deepEqual(ctx.templateFolderChoices["runtime-template"], {
            notebook: "other-notebook",
            folder: "/阅读",
        });
    } finally {
        QuickAddUI.pickLocation = originalPickLocation;
    }
});

test("runtime template cancellation stops the action", async () => {
    const originalPickLocation = QuickAddUI.pickLocation;
    QuickAddUI.pickLocation = async () => null;
    try {
        await assert.rejects(
            runActionWithContext({
                id: "runtime-cancel",
                name: "取消位置",
                type: "template",
                enabled: true,
                template: {
                    location: "runtime",
                    notebook: "",
                    folder: "/",
                },
            }, {notebookId: "current-notebook", vars: {}}),
            (error) => error && error.cancelled === true,
        );
    } finally {
        QuickAddUI.pickLocation = originalPickLocation;
    }
});

test("runtime template resolves the selected notebook and folder", async () => {
    const target = await resolveTemplateLocation(
        {location: "runtime"},
        {templateFolderChoices: {runtime: {notebook: "reading", folder: "/书摘"}}},
        {id: "runtime"},
    );

    assert.deepEqual(target, {
        notebook: "reading",
        folder: "/书摘",
        label: "运行时选择",
    });
});

test("fixed notebook templates defer folder inputs to the shared input step", async () => {
    const originalAskInputs = QuickAddUI.askInputs;
    QuickAddUI.askInputs = async () => {
        throw new Error("不应提前询问父路径");
    };
    try {
        const ctx = {notebookId: "current-notebook", vars: {}};
        const ready = await prepareTemplateFolderChoice({
            id: "fixed-template",
            name: "固定位置",
            type: "template",
            template: {
                location: "notebook",
                notebook: "",
                folder: "/{{input:路径}}",
                chooseFolder: false,
            },
        }, ctx);

        assert.equal(ready, true);
        assert.deepEqual(ctx.vars, {});
    } finally {
        QuickAddUI.askInputs = originalAskInputs;
    }
});

test("multi actions are presented as action selectors", () => {
    assert.equal(QuickAddUI.typeLabel("multi"), "选择动作");
});

test("legacy multi actions default to one mode and stop on error", () => {
    const action = normalizeAction({
        name: "旧选择动作",
        type: "multi",
        multi: {children: ["a", "a", "", "b"]},
    });

    assert.equal(action.multi.mode, "one");
    assert.equal(action.multi.stopOnError, true);
    assert.deepEqual(action.multi.children, ["a", "b"]);
    assert.equal(action.group, "");
});

test("multi action editor exposes mode, error policy, and grouped children", () => {
    const html = typeBodyHtml({
        type: "multi",
        multi: {
            children: ["read"],
            mode: "many",
            stopOnError: false,
        },
    }, [], []);

    assert.match(html, /value="many" selected/);
    assert.match(html, /多选执行会按下方/);
    assert.match(html, /data-field="multi.stopOnError"/);
    assert.doesNotMatch(html, /data-field="multi.stopOnError"[^>]* checked/);
});

test("action groups preserve first-seen order and put ungrouped actions last", () => {
    const groups = QuickAddUI.groupActions([
        {id: "1", name: "写作", group: "阅读"},
        {id: "2", name: "摘录", group: ""},
        {id: "3", name: "论文", group: "阅读"},
        {id: "4", name: "临时", group: "收集"},
    ]);

    assert.deepEqual(groups.map((group) => group.name), ["阅读", "收集", "未分组"]);
    assert.deepEqual(groups[0].actions.map((action) => action.id), ["1", "3"]);
});

test("multi execution shares one context and keeps configured order", async () => {
    apiCalls.length = 0;
    const actions = [
        {
            id: "first",
            name: "第一条",
            type: "capture",
            enabled: true,
            capture: {target: "macro-created", position: "append", content: "A"},
        },
        {
            id: "second",
            name: "第二条",
            type: "capture",
            enabled: true,
            capture: {target: "macro-created", position: "append", content: "B"},
        },
    ];
    const outcome = await executeMultiSelection(actions, {
        lastCreatedId: "shared-doc",
        lastCreatedTitle: "共享文档",
        lastCreatedPath: "/共享文档",
        lastCreatedNotebook: "notebook",
        vars: {},
    }, {stopOnError: true});

    assert.deepEqual(outcome.results.map((item) => item.action.id), ["first", "second"]);
    assert.deepEqual(apiCalls.map((call) => call.payload.data), ["A", "B"]);
    assert.equal(apiCalls[0].payload.parentID, "shared-doc");
    assert.equal(apiCalls[1].payload.parentID, "shared-doc");
});

test("multi execution stops at the first error when configured", async () => {
    const actions = [
        {id: "broken-a", name: "失败 A", type: "macro", enabled: true, macro: {steps: []}},
        {id: "broken-b", name: "失败 B", type: "macro", enabled: true, macro: {steps: []}},
    ];

    await assert.rejects(
        executeMultiSelection(actions, {}, {stopOnError: true}),
        (error) => error.actionName === "失败 A" && error.completedCount === 0,
    );
});

test("multi execution continues and collects errors when configured", async () => {
    const actions = [
        {id: "broken-a", name: "失败 A", type: "macro", enabled: true, macro: {steps: []}},
        {id: "broken-b", name: "失败 B", type: "macro", enabled: true, macro: {steps: []}},
    ];

    const outcome = await executeMultiSelection(actions, {}, {stopOnError: false});

    assert.equal(outcome.results.length, 0);
    assert.deepEqual(outcome.errors.map((item) => item.action.name), ["失败 A", "失败 B"]);
});

test("legacy document-template actions migrate to inline Markdown", () => {
    const action = normalizeAction({
        name: "旧模板",
        type: "template",
        template: {
            source: "doc",
            docId: "legacy-doc-id",
            content: "旧模板内容",
        },
    });

    assert.equal(action.template.source, "inline");
    assert.equal(action.template.content, "旧模板内容");
    assert.equal(Object.prototype.hasOwnProperty.call(action.template, "docId"), false);
});

test("opening a document updates the current macro context", () => {
    const ctx = {
        docId: "old-doc",
        docTitle: "旧文档",
        title: "旧文档",
        docPath: "/旧文档",
        notebookId: "old-notebook",
        firstCreatedId: "",
    };

    rememberActionDocument(ctx, {
        id: "new-doc",
        title: "新文档",
        path: "/收集箱/新文档",
        notebook: "new-notebook",
    }, true);

    assert.equal(ctx.lastCreatedId, "new-doc");
    assert.equal(ctx.docId, "new-doc");
    assert.equal(ctx.docTitle, "新文档");
    assert.equal(ctx.docPath, "/收集箱/新文档");
    assert.equal(ctx.notebookId, "new-notebook");
});

test("capture appends to the document created by the macro", async () => {
    apiCalls.length = 0;
    const ctx = {
        docId: "old-doc",
        lastCreatedId: "new-doc",
        lastCreatedTitle: "新文档",
        lastCreatedPath: "/收集箱/新文档",
        lastCreatedNotebook: "notebook-id",
        vars: {},
        now: new Date("2026-11-09T04:30:00+08:00"),
    };

    const result = await executeCapture({
        capture: {
            target: "macro-created",
            position: "append",
            content: "宏内记录",
        },
    }, ctx);

    assert.equal(result.docId, "new-doc");
    assert.deepEqual(apiCalls[0], {
        path: "/api/block/appendBlock",
        payload: {
            dataType: "markdown",
            data: "宏内记录",
            parentID: "new-doc",
        },
    });
});
