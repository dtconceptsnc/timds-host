#!/usr/bin/env node
// Embed the toolkit's hosted design-system skill template so the Worker can
// serve it through the designer MCP get_skill tool. Reads the installed
// @dtconcepts/timds package by default; pass a toolkit checkout to try an
// unreleased template. No credentials or network.
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const toolkit=path.resolve(process.argv[2]||path.join(root,'node_modules/@dtconcepts/timds'));
const pkg=JSON.parse(await readFile(path.join(toolkit,'package.json'),'utf8'));
if(pkg.name!=='@dtconcepts/timds')throw new Error(`Not the toolkit package: ${toolkit}`);
const template=await readFile(path.join(toolkit,'skills/timds-hosted-design-system/SKILL.md'),'utf8');
const source=process.argv[2]?`a ${pkg.version} checkout (unreleased; regenerate from the released package)`:`@dtconcepts/timds ${pkg.version}`;
await writeFile(path.join(root,'src/mcp/hosted-skill-data.mjs'),`// Generated from ${source} by scripts/generate-hosted-skill.mjs. Do not edit.\nexport const hostedSkillToolkit=${JSON.stringify(pkg.version)};\nexport const hostedSkillTemplate=${JSON.stringify(template)};\n`);
console.log(`src/mcp/hosted-skill-data.mjs written from ${source}`);
