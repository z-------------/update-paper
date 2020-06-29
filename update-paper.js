#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const needle = require("needle");
const renameOptional = require("./lib/renameOptional");
const unlinkOptional = require("./lib/unlinkOptional");

const fsp = fs.promises;

/* set up yargs */

const argv = require("yargs")
    .version(false)

    .usage("Usage: $0 [options]")
    .describe("r", "Rename downloaded jar file, replacing any existing unless -k")
    .alias("r", "replace")
    .boolean("r")

    .describe("k", "Keep most recent existing jar file with `.old.' infix")
    .alias("k", "keep")
    .boolean("k")

    .describe("d", "Only list updates without downloading")
    .alias("d", "dry")
    .boolean("d")

    .describe("build", "Specify a build number to download")

    .describe("R", "Ignore state file")
    .boolean("R")

    .describe("v", "Enable verbose output")
    .alias("v", "verbose")
    .boolean("v")

    .argv;

/* consts */

const MSG_NO_NEW_VERSION = "No matching new version available.";

/* helper functions */

const rel = function(filename) {
    return path.join(process.cwd(), filename);
};

const print = function(msg) {
    return process.stdout.write(msg);
};

const pad = function(s, n, c) {
    s = s.toString();
    return repStr(c || "0", n - s.length) + s;
};

const repStr = function(c, n) {
    return Array(n + 1).join(c);
};

const progressBar = function(p, c1, c2, l) {
    l = l || 75;
    c1 = c1 || "#";
    c2 = c2 || "-";
    const lm = l - 2 - 5; // 2 for the [], 5 for _000%
    return `[${Array(Math.round(p * lm) + 1).join(c1)}${Array(Math.round((1 - p) * lm) + 1).join(c2)}] ${pad(Math.round(p * 100), 3, " ")}%`;
};

const semverGetMajor = function(v) {
    return v.split(".").slice(0, 2).join(".");
};

const semverSplit = function(v) {
    return v.split(".").map(Number);
};

const semverEQ = function(ver, n) {
    n = n || 3;
    if (!state.apiVersion) return true;
    const splitA = semverSplit(state.apiVersion);
    const splitB = semverSplit(ver);
    for (let i = 0; i < n; ++i) {
        if (splitA[i] !== splitB[i]) return false;
    }
    return true;
};

const buildNumberGT = function(buildNumber) {
    return !state.buildNumber || buildNumber > state.buildNumber;
};

const formatDate = date => {
    return {
        date: [pad(date.getFullYear(), 4), pad(date.getMonth() + 1, 2), pad(date.getDate(), 2)].join("-"),
        time: [pad(date.getHours(), 2), pad(date.getMinutes(), 2)].join(":")
    };
};

const formatBuildInfo = function(build) {
    const commits = build.changeSet.items;
    const dateFormatted = formatDate(new Date(build.timestamp));
    let lines = [];
    for (let i = 0; i < commits.length; ++i) {
        let commentLines = commits[i].comment.split("\n").filter(commentLine => commentLine.trim().length);
        if (!argv.v) {
            commentLines.length = Math.min(commentLines.length, 1);
        } else if (i === 0) {
            commentLines[0] += " - " + dateFormatted.date + " " + dateFormatted.time;
        }
        for (let j = 1; j < commentLines.length; ++j) {
            commentLines[j] = repStr(" ", 15) + commentLines[j];
        }
        lines.push(`${i === 0 ? `#${pad(build.number, 3)} ` : ""}[${commits[i].commitId.substring(0, 7)}] ${commentLines.join("\n")}\n`);
    }
    for (let i = 1; i < lines.length; ++i) {
        lines[i] = repStr(" ", 5) + lines[i];
    }
    if (!lines.length) return "";
    return lines.join("\n");
};

const underline = function(text) {
    return text + "\n" + repStr("=", text.length);
};

const logVerbose = function() {
    if (argv.v) return console.log(...arguments);
};

const die = function(message, code = 1) {
  console.error(message);
  process.exit(code);
};

/* globals */

let isDownloadInProgress = false;
let filename, filenameTemp, buildNumber;
let readStream;

/* get state */

let state = {
    apiVersion: null,
    buildNumber: null
};

if (!argv.R) {
    try {
        const vHistFileContents = fs.readFileSync(rel("version_history.json"), "utf-8");
        const versionInfo = JSON.parse(vHistFileContents).currentVersion;
        
        const patApiVersion = /(?<=MC: )\d+\.\d+(\.\d+)?/;
        const patBuildNumber = /(?<=git-Paper-)\d+/;

        const matchApiVersion = versionInfo.match(patApiVersion);
        const matchBuildNumber = versionInfo.match(patBuildNumber);

        if (matchApiVersion) state.apiVersion = matchApiVersion[0];
        if (matchBuildNumber) state.buildNumber = Number(matchBuildNumber[0]);
    } catch (e) {
        console.log("Couldn't read version history file.");
    }
}

/* hey ho */

(async () => {
    let json;

    const downloadsResponse = await needle("get", "https://papermc.io/js/downloads.js");
    let openCount = 0, closeCount = 0;
    let startIndex = -1, endIndex = -1;
    const body = downloadsResponse.body.toString();
    const chars = body.split("");
    for (let i = 0; i < chars.length; ++i) {
        const char = chars[i];
        if (char === "{") {
            ++openCount;
            if (startIndex === -1) startIndex = i;
        }
        else if (char === "}") ++closeCount;
        if (openCount > 1 && openCount == closeCount) {
            endIndex = i + 1;
            const sub = body.substring(startIndex, endIndex)
                .replace(/\/\/.*/g, "")
                .replace(/,\s*(?=})/g, "");
            json = JSON.parse(sub);
            break;
        }
    }

    // find matching version
    let matchingVersion;
    for (let key in json) {
        const apiVersion = json[key].api_version;
        if (json[key].api_endpoint === "paper" && semverEQ(apiVersion, 2)) {
            matchingVersion = apiVersion;
            break;
        }
    }

    if (!matchingVersion) return console.log(MSG_NO_NEW_VERSION);

    let major = semverGetMajor(matchingVersion);
    // get build numbers for matching version
    const buildsResponse = await needle("get", `https://papermc.io/ci/job/Paper-${major}/api/json?tree=builds[number,timestamp,changeSet[items[comment,commitId,msg]]]`, { json: true });
    let newerBuilds = buildsResponse.body.builds
        .filter(build => buildNumberGT(build.number))
        .filter(build => {
            for (let commit of build.changeSet.items) {
                if (commit.comment.indexOf("[CI-SKIP]") !== -1) return false;
            }
            return true;
        });

    if (!newerBuilds.length) return console.log(MSG_NO_NEW_VERSION);

    print(`\n${repStr(" ", 5)}Paper ${matchingVersion}\n\n`);
    for (let build of newerBuilds) {
        const formatted = formatBuildInfo(build);
        if (formatted.trim().length) print(formatted + "\n");
    }

    if (!argv.d) {
        buildNumber = argv.build || newerBuilds[0].number;
        const url = `https://papermc.io/api/v1/paper/${matchingVersion}/${buildNumber}/download`;
        filename = `paper-${buildNumber}.jar`;
        filenameTemp = filename + ".temp";

        // start downloading jar
        print(`Downloading ${matchingVersion} #${pad(buildNumber, 3)}...\n`);
        try {
            const headResponse = await needle("head", url);
            const contentLength = Number(headResponse.headers["content-length"]);
            let writeStream = fs.createWriteStream(rel(filenameTemp));
            log(`Writing to ${filenameTemp}...`);
            readStream = needle.get(url);
            readStream.pipe(writeStream);
            readStream.on("data", () => {
                isDownloadInProgress = true;
                process.stdout.write("\r" + progressBar(writeStream.bytesWritten / contentLength, null, null, process.stdout.columns));
            });
            readStream.on("end", async () => {
                if (!isDownloadInProgress) return;

                isDownloadInProgress = false;
                print("\nDownload complete.\n");
                
                if (argv.k) { // keep any old paper-xxx.jar with same build number
                    try {
                        await fsp.rename(rel(filename), rel(`paper-${buildNumber}.old.jar`));
                        logVerbose(`Renamed old numbered jar to paper-${buildNumber}.old.jar.`);
                    } catch (err) {
                        if (err.code === "ENOENT") logVerbose("No old numbered jar to rename. Continuing.");
                        else return console.error(`Couldn't rename ${filename}.`, err);
                    }
                }
                // rename to paper-xxx.jar, removing .temp suffix
                fs.rename(rel(filenameTemp), rel(filename), err => {
                    if (err) {
                        return console.error(`Couldn't rename ${filenameTemp}.`, err);
                    } else {
                        logVerbose(`Renamed ${filenameTemp} to ${filename}.`);
                    }
                });
                if (argv.r) { // rename to paper.jar
                    // move any existing paper.jar to paper.temp.jar
                    try {
                        await renameOptional(rel("paper.jar"), rel("paper.temp.jar"));
                        logVerbose("Renamed old jar (if it exists) to paper.temp.jar.");
                    } catch (err) {
                        return console.error("Couldn't rename paper.jar.", err);
                    }

                    try {
                        await fsp.rename(rel(filename), rel("paper.jar"));
                        logVerbose("Renamed new jar.");
                    } catch (err) {
                        return console.error(`Couldn't rename ${filename}.`);
                    }

                    if (argv.k) { // keep any old paper.jar (now renamed paper.temp.jar)
                        try {
                            await renameOptional(rel("paper.temp.jar"), rel("paper.old.jar"));
                            logVerbose("Renamed temp jar (if it exists) to paper.old.jar.");
                        } catch (err) {
                            return console.error("Couldn't rename paper.temp.jar.", err);
                        }
                    } else { // delete any old paper.jar (now renamed paper.temp.jar)
                        try {
                            await unlinkOptional(rel("paper.temp.jar"));
                            logVerbose("Deleted temp jar (if it exists).");
                        } catch (err) {
                            return console.error("Couldn't delete paper.temp.jar.", err);
                        }
                    }
                }
            });
        } catch (e) {
            console.error(`Error downloading from ${url}.`);
        }
    }
})();

process.on("SIGINT", async () => {
    if (isDownloadInProgress) {
        isDownloadInProgress = false;
        readStream.destroy();
        logVerbose("Destroyed stream.");
        logVerbose("Deleting partially downloaded file...");
        try {
            await fsp.unlink(filenameTemp);
            logVerbose(`Deleted ${filenameTemp}.`);
        } catch (e) {
            console.error(`Failed to delete ${filenameTemp}.`)
        }
        process.exit();
    }
});
