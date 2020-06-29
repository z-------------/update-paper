const fs = require("fs");
const fsp = fs.promises;

/**
 * Try to unlink a file, silently failing if the file doesn't exist.
 * @param {string | Buffer | URL} path
 */
module.exports = async function unlinkOptional(path) {
    try {
        await fsp.unlink(path);
    } catch (e) {
        if (e.code === "ENOENT") return;
        else throw e;
    }
};
