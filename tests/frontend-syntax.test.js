import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

async function htmlFiles(root) {
  const entries=await readdir(root,{withFileTypes:true});
  const files=[];
  for(const entry of entries) {
    const full=path.join(root,entry.name);
    if(entry.isDirectory()) files.push(...await htmlFiles(full));
    else if(entry.isFile()&&entry.name.endsWith(".html")) files.push(full);
  }
  return files;
}

test("inline JavaScript in public HTML pages parses without syntax errors",async()=>{
  const files=["index.html",...await htmlFiles("public")];
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
