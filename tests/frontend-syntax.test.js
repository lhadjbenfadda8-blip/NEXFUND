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
    if(entry.isDirectory()) files.push(...await sourceFiles(full,extension));
    else if(entry.isFile()&&entry.name.endsWith(extension)) files.push(full);
  }
  return files;
}

test("inline and external frontend JavaScript parses without syntax errors",async()=>{
  const htmlFiles=["index.html",...await sourceFiles("public",".html")];
  const jsFiles=await sourceFiles("public",".js");
  let checked=0;
  for(const file of htmlFiles) {
    const html=await readFile(file,"utf8");
    const blocks=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    for(const block of blocks) {
      const source=block[1].trim();
      if(!source) continue;
      try { new vm.Script(source,{filename:file}); } catch (error) { assert.fail(file+": "+error.stack); }
      checked++;
    }
  }
  for(const file of jsFiles) {
    const source=await readFile(file,"utf8");
    try { new vm.Script(source,{filename:file}); } catch (error) { assert.fail(file+": "+error.stack); }
    checked++;
  }
  assert.ok(checked>0,"Expected to check frontend scripts.");
});
