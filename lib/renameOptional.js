const fs = require("fs");
const fsp = fs.promises;

/**
 * Try to rename a file, silently failing if the file doesn't exist.
 * @param {fs.PathLike} oldPath
 * @param {fs.PathLike} newPath
 */
module.exports = async function renameOptional(oldPath, newPath) {
    try {
        await fsp.rename(oldPath, newPath);
    } catch (e) {
        if (e.code === "ENOENT") return;
        else throw e;
    }
};
