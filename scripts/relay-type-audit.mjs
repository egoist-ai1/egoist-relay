import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const args = process.argv.slice(2);
const projectArg = args.indexOf('--project');
const outputArg = args.indexOf('--output');
const baselineArg = args.indexOf('--baseline');
const project = path.resolve(projectArg >= 0 ? args[projectArg + 1] : 'tsconfig.test.json');
const output = outputArg >= 0 ? path.resolve(args[outputArg + 1]) : undefined;
const baseline = baselineArg >= 0 ? JSON.parse(fs.readFileSync(args[baselineArg + 1], 'utf8')) : undefined;
const projectRoot = path.dirname(project);
const config = ts.readConfigFile(project, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, projectRoot, { incremental: false, noEmit: true }, project);
const started = performance.now();
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)].map((diagnostic) => {
  const location = diagnostic.file && diagnostic.start !== undefined
    ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
  return {
    file: diagnostic.file ? path.relative(projectRoot, diagnostic.file.fileName).replaceAll('\\', '/') : undefined,
    line: location ? location.line + 1 : undefined,
    column: location ? location.character + 1 : undefined,
    code: diagnostic.code,
    category: ts.DiagnosticCategory[diagnostic.category],
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  };
});
const projectFiles = program.getSourceFiles().map((source) => path.relative(projectRoot, source.fileName).replaceAll('\\', '/'))
  .filter((file) => !file.startsWith('../') && !file.startsWith('node_modules/')).sort();
const testFiles = projectFiles.filter((file) => /\.test\.tsx?$/.test(file));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const result = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  nodeVersion: process.version,
  typescriptVersion: ts.version,
  config: path.relative(process.cwd(), project).replaceAll('\\', '/'),
  configSha256: hash(fs.readFileSync(project)),
  elapsedMs: Math.round(performance.now() - started),
  diagnosticCount: diagnostics.length,
  diagnostics,
  rootFileCount: parsed.fileNames.length,
  rootFiles: parsed.fileNames.map((file) => path.relative(projectRoot, file).replaceAll('\\', '/')).sort(),
  projectFileCount: projectFiles.length,
  projectFiles,
  projectFileListSha256: hash(JSON.stringify(projectFiles)),
  testFileCount: testFiles.length,
  testFiles,
  types: parsed.options.types,
  include: config.config.include,
  exclude: config.config.exclude,
  baselineComparison: baseline ? {
    removedProjectFiles: baseline.projectFiles.filter((file) => !projectFiles.includes(file)),
    removedTestFiles: baseline.testFiles.filter((file) => !testFiles.includes(file)),
    addedProjectFiles: projectFiles.filter((file) => !baseline.projectFiles.includes(file)),
  } : undefined,
};
if (output) fs.writeFileSync(output, `${JSON.stringify(result, undefined, 2)}\n`);
console.log(JSON.stringify({ diagnosticCount: diagnostics.length, testFileCount: testFiles.length,
  projectFileCount: projectFiles.length, elapsedMs: result.elapsedMs,
  baselineComparison: result.baselineComparison, output }, undefined, 2));
process.exitCode = diagnostics.length || result.baselineComparison?.removedProjectFiles.length ? 1 : 0;