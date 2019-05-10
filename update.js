const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;
const { detailedDiff } = require('deep-object-diff');
const { spawnSync } = require('child_process');

let previousData;
let current;
let changes;

scrapeResearch('Pact Merging Speed I');

fs.access('.updating', async err => {
   if (err) {
       fs.writeFileSync('.updating');
       try {
           try {
               let json = fs.readFileSync('output/research.json');
               previousData = JSON.parse(json);
           } catch (e) {
               previousData = [];
           }
           changes = '';
           let trees = await scrapeResearchTrees();
           if (changes) {
               fs.writeFileSync('output/research.json', JSON.stringify(trees, null, 2));
               process.chdir('output');
               spawnSync('git', ['add', '.']);
               spawnSync('git', ['commit', '-m', new Date().toISOString() + "\n" + changes]);
               spawnSync('git', ['push']);
               process.chdir('..');
           }
       } catch (e) {
            console.error(e);
       }
       fs.unlinkSync('.updating');
   }
});

function url(page) {
    return `https://lordsmobile.fandom.com/api.php?action=parse&page=${page}&format=json`
}

function sleep(time = 30) {
    return new Promise(resolve => setTimeout(resolve, time));
}

function getTableType(table) {
    let cols = {};
    let header = [...table.querySelectorAll('tr:first-child th')];
    cols.level = header.findIndex(td => td.textContent.match(/Level/) != null);
    if (cols.level === -1) {
        return null;
    }
    cols.might = header.findIndex(td => td.textContent.match(/Might/) != null);
    if (cols.might !== -1) {
        cols.resources = header.findIndex(td => td.textContent.match(/Resources/) != null);
        cols.requires = header.findIndex(td => td.textContent.match(/Requires|Requirements|Required/) != null);
        cols.time = header.findIndex(td => td.textContent.match(/(Orig\. )?Time/) != null);
        if (cols.requires === -1) {
            console.warn(`[${current}] missing "requires" in "requirements" table.`);
            return null;
        }
        if (cols.time === -1) {
            console.warn(`[${current}] missing "time" in "requirements" table.`);
            return null;
        }

        // Clau `value`
        for (let h in header) {
            if (!Object.keys(cols).find(c => cols[c] === +h)) {
                if (cols.value) {
                    console.warn(`[${current}] Setting value again: ${header[cols.value].textContent} -> ${header[h].textContent}.`)
                }
                cols.value = +h;
            }
        }

        // Esborram claus no trobades
        Object.keys(cols).map(c => cols[c] === -1 && delete cols[c]);

        return {
            id: cols.resources === undefined ? 'requirements' : 'both',
            cols
        };
    } else {
        delete cols.might;
        cols.food = header.findIndex(td => td.textContent.match(/Food/) != null);
        cols.stone = header.findIndex(td => td.textContent.match(/Stone/) != null);
        cols.timber = header.findIndex(td => td.textContent.match(/Timber|Wood/) != null);
        cols.ore = header.findIndex(td => td.textContent.match(/Ore/) != null);
        cols.gold = header.findIndex(td => td.textContent.match(/Gold/) != null);
        if (cols.food === -1 || cols.stone === -1 || cols.timber === -1 || cols.ore === -1 || cols.gold === -1) {
            return null;
        }
        cols.anima = header.findIndex(td => td.textContent.match(/Anima/) != null);
        cols.tomes = header.findIndex(td => td.textContent.match(/Archaic Tome/) != null);

        // Esborram claus no trobades
        Object.keys(cols).map(c => cols[c] === -1 && delete cols[c]);

        return {
            id: 'resources',
            cols
        };
    }
}

function parseRequirementsTable(table, cols) {
    let levels = [];
    let rows = [...table.querySelectorAll('tr:not(:first-child)')];
    rows.forEach(r => {
        let cells = [...r.querySelectorAll('td')].map(td => td.textContent);
        let values = {};
        values.level = +cells[cols.level].trim();
        if (cols.value)
            values.value = cells[cols.value].trim().replace(/,/g, '');
        values.might = +cells[cols.might].trim().replace(/,/g, '');
        values.requires = [];
        let re = /\W*([^:]+):.*?(\d+)/gm;
        let matches;
        while ((matches = re.exec(cells[cols.requires]))) {
            values.requires.push({
                r: matches[1],
                l: +matches[2]
            });
        }
        values.time = cells[cols.time].trim();
        values.seconds = parseTime(values.time);
        // NaN -> null
        Object.keys(values).map(k => {
            if (Number.isNaN(values[k])) {
                values[k] = null;
            }
        });
        levels.push(values);
    });

    return levels;
}

function parseBothTables(table, cols) {
    let requirements = [];
    let resources = [];
    let rows = [...table.querySelectorAll('tr:not(:first-child)')];
    rows.forEach(r => {
        let cells = [...r.querySelectorAll('td')].map(td => td.textContent);
        let thisLevelRequirements = {};
        let thisLevelResources = {};
        thisLevelRequirements.level = +cells[cols.level].trim();
        thisLevelResources.level = +cells[cols.level].trim();
        if (cols.value)
            thisLevelRequirements.value = cells[cols.value].trim().replace(/,/g, '');
        thisLevelRequirements.might = +cells[cols.might].trim().replace(/,/g, '');
        thisLevelRequirements.requires = [];
        let regExpRequires = /^([^:]+):.*?(\d+)$/gm;
        let matches;
        while ((matches = regExpRequires.exec(cells[cols.requires]))) {
            thisLevelRequirements.requires.push({
                r: matches[1],
                l: +matches[2]
            });
        }
        thisLevelRequirements.time = cells[cols.time].trim();
        thisLevelRequirements.seconds = parseTime(thisLevelRequirements.time);
        let regExpResources = /^\s*^(\w+)[: ]+([\d,]+)\s*$/gm;
        while ((matches = regExpResources.exec(cells[cols.resources]))) {
            let type;
            switch (matches[1]) {
                case 'F':
                    type = 'food';
                    break;
                case 'S':
                    type = 'stone';
                    break;
                case 'T':
                case 'W':
                    type = 'timber';
                    break;
                case 'O':
                    type = 'ore';
                    break;
                case 'G':
                    type = 'gold';
                    break;
                default:
                    console.warn(`[${current}] unknown resource type "${matches[1]}".`)
            }
            let value = +matches[2].replace(/[,\.]/g, '');
            thisLevelResources[type] = value;
        }
        // NaN -> null
        Object.keys(thisLevelRequirements).map(k => {
            if (Number.isNaN(thisLevelRequirements[k])) {
                thisLevelRequirements[k] = null;
            }
        });
        Object.keys(thisLevelResources).map(k => {
            if (Number.isNaN(thisLevelResources[k])) {
                thisLevelResources[k] = null;
            }
        });
        requirements.push(thisLevelRequirements);
        resources.push(thisLevelResources);
    });

    return {
        requirements,
        resources
    };
}

function parseResourcesTable(table, cols) {
    let levels = [];
    let rows = [...table.querySelectorAll('tr:not(:first-child)')];
    rows.forEach(r => {
        let cells = [...r.querySelectorAll('td')].map(td => td.textContent);
        let values = {};
        Object.keys(cols).map(c => {
            values[c] = +cells[cols[c]].trim().replace(/[,\.]/g, '');
        });
        levels.push(values);// NaN -> null
        Object.keys(values).map(k => {
            if (Number.isNaN(values[k])) {
                values[k] = null;
            }
        });
    });

    return levels;
}

function mergeTables(requirements, resources) {
    let levels = [];
    for (let i = 0; i < requirements.length; i++) {
        let req = requirements[i];
        let res = resources[i];
        if (req.level === res.level) {
            delete res.level;
            req.resources = res;
            levels.push(req);
        } else {
            console.warn(`[${current}] row ${i} level differ between tables.`);
        }
    }
    return levels;
}

function parseTime(timeString) {
    let matches = timeString.match(/(?:(\d+)d )?(\d+):(\d+):(\d+)/);
    if (matches) {
        let time = 0;
        if (matches[1]) {
            time += matches[1] * 86400; // days
        }
        time += matches[2] * 3600; // hours
        time += matches[3] * 60; // minutes
        time += +matches[4]; // seconds
        return time;
    } else {
        return 0;
    }
}

async function scrapeResearchTrees() {
    let trees = [];

    let research = await fetch(url('Category:Research'));
    let json = await research.json();
    let links = json.parse.links.map(e => e['*']);
    for (let l of links) {
        try {
            trees.push(await scrapeTree(l));
        } catch (e) {
            console.error(`Error when scraping tree ${l}:`);
            console.error(e);
        }
        await sleep();
    }

    return trees;
}

async function scrapeTree(link) {

    let researches = [];

    let page = await fetch(url(link));
    let json = await page.json();
    let title = json.parse.title;
    let text = json.parse.text['*'];
    const { document } = new JSDOM(text).window;
    let links = [...document.querySelectorAll('.article-table a[href^="/wiki/"][title]')].map(a => a.getAttribute('title'));
    for (let l of links) {
        try {
            let research = await scrapeResearch(l);
            researches.push(research);
            (() => {
                let pTree = previousData.find(tree => tree.title === link);
                if (pTree) {
                    let pResearch = pTree.researches.find(r => r.title === l); //TODO this will fail when redirecting :/
                    if (pResearch) {
                        let diff = detailedDiff(pResearch, research);
                        if (Object.keys(diff.added).length > 0 || Object.keys(diff.deleted).length > 0 || Object.keys(diff.updated).length > 0) {
                            changes += `Research ${l} in tree ${link}:\n` + JSON.stringify(diff, null, 2) + '\n';
                        }
                    } else {
                        changes += `New research ${l} in tree ${link}:\n` + JSON.stringify(detailedDiff({}, research).added, null, 2) + '\n';
                    }
                } else {
                    changes += `New research ${l} in new tree ${link}:\n` + JSON.stringify(detailedDiff({}, research).added, null, 2) + '\n';
                }
            })();
        } catch (e) {
            console.error(`Error when scraping research ${l}:`);
            console.error(e);
        }
        await sleep();
    }

    return {
        title,
        researches
    };
}

async function scrapeResearch(link) {
    current = link;
    let page = await fetch(url(link));
    let json = await page.json();
    let title = json.parse.title;
    let text = json.parse.text['*'];
    const { document } = new JSDOM(text).window;
    let redirect = text.match(/^<ol><li>REDIRECT <a.+title="([^"]+)">.+<\/a>\n<\/li><\/ol>\n\n/);
    if (redirect) {
        console.info(`Redirecting ${link} -> ${redirect[1]}.`)
        return scrapeResearch(redirect[1]);
    } else {
        let tables = [...document.querySelectorAll('.article-table')];
        let requirements, resources;
        for (let table of tables) {
            let tableType = getTableType(table);
            if (tableType) {
                switch (tableType.id) {
                    case 'requirements':
                        requirements = parseRequirementsTable(table, tableType.cols);
                        break;
                    case 'resources':
                        resources = parseResourcesTable(table, tableType.cols);
                        break;
                    case 'both':
                        let both = parseBothTables(table, tableType.cols);
                        requirements = both.requirements;
                        resources = both.resources;
                        break;
                }
            }
        }
        if (!requirements) {
            console.warn(`[${current}] Missing table requirements.`)
        }
        if (!resources) {
            console.warn(`[${current}] Missing table resources.`)
        }
        return {
            title,
            requirements: mergeTables(requirements, resources)
        };
    }
}