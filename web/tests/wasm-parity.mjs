import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import createModule from '../public/wasm/helix_engine.mjs';
const root=resolve(import.meta.dirname,'../..');
const module=await createModule({wasmBinary:readFileSync(resolve(root,'web/public/wasm/helix_engine.wasm'))});
function call(kind,source,data){let a=0,b=0,result=0;try{const allocate=text=>{const n=module.lengthBytesUTF8(text)+1,p=module._malloc(n);assert(p);module.stringToUTF8(text,p,n);return p};a=allocate(source);if(kind==='evaluate')b=allocate(data);result=kind==='evaluate'?module._helix_evaluate(a,b):module._helix_analyze(a);assert(result);return JSON.parse(module.UTF8ToString(result))}finally{if(result)module._helix_free_result(result);if(b)module._free(b);if(a)module._free(a)}}
const temporary=mkdtempSync(join(tmpdir(),'helix-parity-'));
try{
 const fixtures=[['high_glucose_alert','glucose'],['basic_rule','glucose'],['alert_rule','sepsis'],['temporal_rule','temporal'],['invalid_syntax_demo','glucose']];
 for(const [name,dataset] of fixtures){const sourceFile=resolve(root,`examples/${name}.helix`);const source=readFileSync(sourceFile,'utf8');const data=JSON.parse(readFileSync(resolve(root,`examples/data/${dataset}.json`),'utf8'));if(name==='basic_rule')data.Bindings['Labs.glucose']={table:'glucose_data',column:'value'};const json=JSON.stringify(data),dataFile=join(temporary,'dataset.json');writeFileSync(dataFile,json);
  for(const kind of ['analyze','evaluate']){const native=JSON.parse(execFileSync('python3',[resolve(root,'scripts/native_response.py'),resolve(root,'build/native/libhelix.so'),kind,sourceFile,...(kind==='evaluate'?[dataFile]:[])],{encoding:'utf8'}));const wasm=call(kind,source,json);assert.deepEqual(wasm,native,`${name}/${kind} differs`);if(name!=='invalid_syntax_demo')assert.equal(wasm.success,true,`${name}/${kind} failed`)}
  console.log(`Native/WASM parity: ${name}`);
 }
 for(let i=0;i<500;i++){assert(call('analyze','rule X: end rule').success);assert(!call('evaluate','rule X: source absent end rule','{}').success)}
 console.log('Five fixtures match native output; 1000 repeated WASM calls completed');
}finally{rmSync(temporary,{recursive:true,force:true})}
