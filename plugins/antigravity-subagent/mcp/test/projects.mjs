import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agy-projects-test-'));
const outfile = path.join(tempDir, 'projects.mjs');

try {
  await build({ entryPoints: [path.resolve('src/projects.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile, logLevel: 'silent' });
  const {
    canonicalProjectPath,
    discoverAgyProjects,
    folderUriToPath,
    projectContainsPath,
    resolveAgyProject,
  } = await import(pathToFileURL(outfile).href);

  assert.equal(canonicalProjectPath('D:\\Source\\App\\', 'win32'), 'd:\\source\\app');
  assert.equal(canonicalProjectPath('d:/source/app', 'win32'), 'd:\\source\\app');
  assert.equal(folderUriToPath('file:///d%3A/projects/app', 'win32'), 'd:\\projects\\app');
  assert.equal(projectContainsPath('D:\\Source\\App', 'd:\\source\\app\\src\\Api', 'win32'), true);
  assert.equal(projectContainsPath('D:\\Source\\App', 'D:\\Source\\Other', 'win32'), false);

  const projects = [
    { id: 'a', name: 'Project A', roots: ['D:\\path1', 'D:\\path2', 'D:\\path3'], sourceFile: 'a.json' },
    { id: 'b', name: 'Project B', roots: ['D:\\path2', 'D:\\path4'], sourceFile: 'b.json' },
  ];
  const ambiguous = resolveAgyProject('D:\\path2', projects, undefined, 'win32');
  assert.equal(ambiguous.kind, 'ambiguous');
  assert.deepEqual(ambiguous.candidates.map((entry) => entry.id), ['a', 'b']);

  const nested = resolveAgyProject('D:\\Source\\App\\src', [
    { id: 'wide', name: 'Wide', roots: ['D:\\Source'], sourceFile: 'wide.json' },
    { id: 'specific', name: 'Specific', roots: ['D:\\Source\\App'], sourceFile: 'specific.json' },
  ], undefined, 'win32');
  assert.equal(nested.kind, 'auto');
  assert.equal(nested.project.id, 'specific');

  const explicit = resolveAgyProject('D:\\path2', projects, 'b', 'win32');
  assert.equal(explicit.kind, 'explicit');
  assert.equal(explicit.project.id, 'b');
  assert.equal(resolveAgyProject('D:\\missing', projects, 'b', 'win32').kind, 'error');
  assert.equal(resolveAgyProject('D:\\new', projects, undefined, 'win32').kind, 'create');

  const registryDir = path.join(tempDir, 'registry');
  const rootA = path.join(tempDir, 'root-a');
  const rootB = path.join(tempDir, 'root-b');
  await mkdir(registryDir, { recursive: true });
  await mkdir(rootA, { recursive: true });
  await mkdir(rootB, { recursive: true });
  await writeFile(path.join(registryDir, 'project-a.json'), JSON.stringify({
    id: 'project-a',
    name: 'Project A',
    projectResources: { resources: [
      { gitFolder: { folderUri: pathToFileURL(rootA).href } },
      { localFolder: { folderUri: pathToFileURL(rootB).href } },
    ] },
  }), 'utf8');
  await writeFile(path.join(registryDir, 'broken.json'), '{ nope', 'utf8');

  const registry = await discoverAgyProjects({ AGY_PROJECTS_DIR: registryDir }, tempDir);
  assert.equal(registry.directory, registryDir);
  assert.equal(registry.projects.length, 1);
  assert.equal(registry.projects[0].id, 'project-a');
  assert.deepEqual(new Set(registry.projects[0].roots), new Set([rootA, rootB]));
  assert.equal(registry.warnings.some((entry) => entry.includes('broken.json')), true);

  console.error('AGY project resolver test passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
