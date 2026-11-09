let siyuan = null;

function configureHost(host) {
    siyuan = host;
}

function hostRequire() {
    if (!siyuan) {
        throw new Error("QuickAdd host API is not configured");
    }
    return siyuan;
}

module.exports = {
    configureHost,
    hostRequire,
};
