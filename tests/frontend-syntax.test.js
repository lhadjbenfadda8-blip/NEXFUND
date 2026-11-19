import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

async function sourceFiles(root, extension) {
  const entries=await readdir(root,{withFileTypes:true});
  const files=[];
  for(const entry of entries) {
    const full=path.join(root,entry.name);
    if(entry.isDirectory()) files.push(...await htmlFiles(full));
    else if(entry.isFile()&&entry.name.endsWith(extension)) files.push(full);
  }
  return files;
}

test("frontend inline and external JavaScript parses without syntax errors",async()=>{
  const files=["index.html",...await sourceFiles("public",".html"),...await sourceFiles("public",".js")];
  let checked=0;
  for(const file of files) {
    const html=await readFile(file,"utf8");
    const blocks=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    for(const block of blocks) {
      const source=block[1].trim();
      if(!source) continue;
      assert.doesNotThrow(()=>new vm.Script(source,{filename:file}),file);
      checked++;
    }
  }
  assert.ok(checked>0,"Expected to check at least one inline script.");
});
