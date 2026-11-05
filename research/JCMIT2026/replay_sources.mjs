import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';

const home = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(home, process.argv[3] || '.');
await fs.mkdir(out, {recursive:true});
const freeze = JSON.parse(await fs.readFile(path.join(home, 'freeze.json'), 'utf8'));
const stage = process.argv[2];
if (!['B','R'].includes(stage)) throw Error('Use B or R');
const repo = stage === 'R' ? freeze.source_root : freeze.control_root;
const corpusBytes = await fs.readFile(freeze.corpus_path);
const hash = value => createHash('sha256').update(value).digest('hex');
const hashJson = value => hash(JSON.stringify(value));
if (hash(corpusBytes) !== freeze.corpus_sha256) throw Error('Corpus pin failed');
const corpus = JSON.parse(corpusBytes);
if (corpus.rows.length !== 3710 || new Set(corpus.rows.map(x=>x.licenseNo)).size !== 3710) throw Error('Corpus scope failed');
const requireRepo = createRequire(pathToFileURL(path.join(repo, 'package.json')));
const {build} = requireRepo('esbuild');
const result = await build({absWorkingDir:repo,stdin:{contents:'export {sourcePassages} from "./server/ai.ts";',resolveDir:repo,sourcefile:'offline-source-entry.ts',loader:'ts'},outfile:path.join(out,`source-reader-${stage}.cjs`),write:false,bundle:true,platform:'node',format:'cjs',packages:'external',treeShaking:true,metafile:true,logLevel:'silent'});
const bundle = result.outputFiles[0];
await fs.writeFile(bundle.path, bundle.contents, {flag:'wx'});
const codePins = {};
for (const name of Object.keys(result.metafile.inputs)) {
  if (name === 'offline-source-entry.ts' || name === '<stdin>') continue;
  codePins[name] = hash(await fs.readFile(path.resolve(repo,name)));
}
let networkAttempts = 0;
const moduleRecord = {exports:{}};
const context = vm.createContext({module:moduleRecord,exports:moduleRecord.exports,require:name=>{
  if (!['node:crypto','zod'].includes(name)) throw Error('Unexpected offline dependency: '+name);
  return requireRepo(name);
},process:{env:Object.freeze({})},fetch:()=>{networkAttempts++;throw Error('Network forbidden during replay');},structuredClone,Buffer,URL,URLSearchParams,TextEncoder,TextDecoder,AbortController,AbortSignal,setTimeout,clearTimeout});
new vm.Script(bundle.text,{filename:bundle.path}).runInContext(context,{timeout:30000});
const rows = [], evidenceKinds = {}, citationMultiplicity = {}, violations = [];
let passages = 0, citations = 0;
for (const source of corpus.rows) {
  const inputHash = hashJson(source.chunks);
  try {
    const fields = moduleRecord.exports.sourcePassages(structuredClone(source.chunks));
    const chunks = new Map(source.chunks.map(c=>[c.id,c.text]));
    for (const field of fields) {
      const support = field.citations || [{chunkId:field.chunkId,quote:field.quote}];
      const kind = field.evidenceKind || 'ordinary';
      evidenceKinds[kind] = (evidenceKinds[kind] || 0) + 1;
      citationMultiplicity[support.length] = (citationMultiplicity[support.length] || 0) + 1;
      for (const citation of support) {
        const original = chunks.get(citation.chunkId);
        if (typeof original !== 'string' || typeof citation.quote !== 'string' || !citation.quote.trim() || !original.includes(citation.quote)) {
          violations.push({licenseNo:source.licenseNo,chunkId:citation.chunkId,quote:citation.quote});
        }
        citations++;
      }
      passages++;
    }
    rows.push({licenseNo:source.licenseNo,status:'readable',inputSha256:inputHash,fieldsSha256:hashJson(fields),orderedQuotesSha256:hashJson(fields.map(x=>x.quote)),concatenatedQuotesSha256:hash(fields.map(x=>x.quote).join('')),fieldCount:fields.length,fields:fields.map(x=>({section:x.sourceSection || null,quoteSha256:hash(x.quote),citationsSha256:hashJson(x.citations || [{chunkId:x.chunkId,quote:x.quote}]),originalFieldId:x.originalFieldId || null,evidenceKind:x.evidenceKind || 'ordinary'}))});
  } catch (error) {
    if (error.code !== 'source_requires_review') throw error;
    rows.push({licenseNo:source.licenseNo,status:'held',inputSha256:inputHash,error:error.code});
  }
  if (hashJson(source.chunks) !== inputHash) throw Error('Input mutated');
}
for (const [name,pin] of Object.entries(codePins)) if (hash(await fs.readFile(path.resolve(repo,name))) !== pin) throw Error('Code changed: '+name);
if (networkAttempts || hash(await fs.readFile(freeze.corpus_path)) !== freeze.corpus_sha256) throw Error('Offline/pin invariant failed');
const summary = {stage,at_utc:new Date().toISOString(),commit:stage==='R'?freeze.release_commit:freeze.control_commit,node:process.version,corpusSha256:freeze.corpus_sha256,total:rows.length,readable:rows.filter(x=>x.status==='readable').length,held:rows.filter(x=>x.status==='held').length,passages,citations,evidenceKinds,citationMultiplicity,literalViolations:violations.length,networkAttempts,providerCalls:0,cloudWrites:0,codePins,bundleSha256:hash(bundle.contents)};
await fs.writeFile(path.join(out,`source-replay-${stage}.json`),JSON.stringify({...summary,violations,rows},null,2)+'\n',{flag:'wx'});
await fs.writeFile(path.join(out,`source-summary-${stage}.json`),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(summary));
if (violations.length) process.exitCode = 1;
if (stage === 'R') {
  const before = JSON.parse(await fs.readFile(path.join(out,'source-replay-B.json'),'utf8'));
  const b = new Map(before.rows.map(x=>[x.licenseNo,x]));
  const regressions = rows.filter(x=>b.get(x.licenseNo).status==='readable'&&x.status!=='readable').map(x=>x.licenseNo);
  const recovered = rows.filter(x=>b.get(x.licenseNo).status==='held'&&x.status==='readable').map(x=>x.licenseNo);
  const changed = rows.filter(x=>b.get(x.licenseNo).status==='readable'&&x.status==='readable'&&b.get(x.licenseNo).fieldsSha256!==x.fieldsSha256).map(x=>({licenseNo:x.licenseNo,quoteArrayExactlyEqual:b.get(x.licenseNo).orderedQuotesSha256===x.orderedQuotesSha256,concatenatedQuotesExactlyEqual:b.get(x.licenseNo).concatenatedQuotesSha256===x.concatenatedQuotesSha256,before:b.get(x.licenseNo).fields,after:x.fields}));
  const paired = {at_utc:new Date().toISOString(),controlCommit:freeze.control_commit,releaseCommit:freeze.release_commit,corpusSha256:freeze.corpus_sha256,total:3710,beforeReadable:before.readable,afterReadable:summary.readable,recovered,regressions,changedOldReadable:changed,unchangedOldReadable:before.readable-regressions.length-changed.length,allChangedConcatenatedQuotesExactlyPreserved:changed.every(x=>x.concatenatedQuotesExactlyEqual),literalViolations:summary.literalViolations};
  await fs.writeFile(path.join(out,'source-paired-comparison.json'),JSON.stringify(paired,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({...paired,changedOldReadable:changed.map(x=>({licenseNo:x.licenseNo,quoteArrayExactlyEqual:x.quoteArrayExactlyEqual,concatenatedQuotesExactlyEqual:x.concatenatedQuotesExactlyEqual}))}));
  if (regressions.length || !paired.allChangedConcatenatedQuotesExactlyPreserved) process.exitCode = 1;
}
