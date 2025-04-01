import { createHash as i } from "crypto";
import e from "nconf";
import t from "node:fs";
import { tmpdir as r } from "node:os";
import { sep as a } from "node:path";
import { pipeline as o } from "node:stream/promises";
import n from "yauzl-promise";
import s from "../modules/logger.js";

e.argv().env().file("./config.json");

let f = "";

async function c() {
    try {
        s.info("Downloading latest code");
        let i = await fetch(e.get("CODE_UPDATE_URL"));
        let c = Buffer.from(await (await i.blob()).arrayBuffer());

        s.info("Creating temp dir");
        f = await t.promises.mkdtemp(`${r()}${a}quickord-cashier-server-update`);
        let l = `${f}${a}quickord-cashier-server.zip`;

        s.info("Writing zip file");
        await t.promises.writeFile(l, c);

        s.info("Extracting zip file");
        let d = `${f}${a}code`;
        await t.promises.mkdir(d);

        let m = await n.open(l);
        try {
            for await (let i of m) {
                if (i.filename.endsWith("\\") || i.filename.endsWith("/")) {
                    await t.promises.mkdir(`${d}${a}${i.filename}`);
                } else {
                    let e = await i.openReadStream();
                    let r = t.createWriteStream(`${d}${a}${i.filename}`);
                    await o(e, r);
                }
            }
        } finally {
            await m.close();
        }
        return true;
    } catch (i) {
        s.error(i);
    }
    return false;
}

async function l() {
    if ("" !== f) {
        s.info("Deleting temp dir");
        await t.promises.rm(f, { recursive: true });
    }
}

async function d(i, e = [], r) {
    for (let o of await t.promises.readdir(i)) {
        let n = `${i}${a}${o}`;
        if ((await t.promises.lstat(n)).isDirectory()) {
            await d(n, e, r);
        } else {
            if (e.includes(o.split(a).pop() || "")) continue;
            await r?.(n);
        }
    }
}

async function m(e) {
    try {
        let r = await t.promises.readFile(e);
        return i("md5").update(r).digest("hex");
    } catch (i) {
        s.error("Error reading file", i);
        return "";
    }
}

async function p() {
    let i, e;
    let r = "init.bat";
    let o = `${f}${a}code${a}init.bat`;
    
    try {
        i = await t.promises.readFile(r, "utf-8");
        e = await t.promises.readFile(o, "utf-8");
    } catch (i) {
        s.error("Error reading init.bat", i);
        return;
    }
    
    if (i.replace(/(cd).*/g, "") !== e.replace(/(cd).*/g, "")) {
        s.info("Updating init.bat");
        try {
            await t.promises.writeFile(r, e.replace(/(cd).*/g, i.match(/(cd).*/g)?.[0] || ""));
        } catch (i) {
            s.error("Error updating init.bat", i);
        }
    }
}

export async function main() {
    await s.init("autoupdate");
    try {
        if (await c()) {
            let i = "";
            try {
                i = await t.promises.readFile("version", "utf-8");
            } catch (i) {
                s.warn("cannot find current version file", i);
            }
            
            let e = "";
            try {
                e = await t.promises.readFile(`${f}${a}code${a}version`, "utf-8");
            } catch (i) {
                s.warn("cannot find new version file", i);
            }
            
            s.info("Current version:", i, " | New version:", e);
            if (i === e && "" !== e) {
                s.info("Already up to date");
                return;
            }
            
            s.info("Updating code to version", e);
           /* await d(`${f}${a}code`, ["init.bat"], async i => {
                let e = i.replace(`${f}${a}code${a}`, "");
                let r = await m(e);
                let o = await m(i);
                if (r !== o) {
                    s.info("    Updating file", e);
                    await t.promises.copyFile(i, e);
                }
            });*/
            await p();
        } else {
            s.error("Failed to download latest code");
        }
    } finally {
        await l();
    }
}

main();
