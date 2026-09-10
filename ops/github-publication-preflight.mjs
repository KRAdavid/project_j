import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGitHubTargetPreflight } from './github-target-preflight.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const requiredFiles = [
  '.gitattributes',
  '.github/workflows/quality-gates.yml',
  '.github/workflows/production-cutover-gate.yml',
  'README.md',
  'package.json',
  'pnpm-lock.yaml',
  'beta-app/server.mjs',
  'data/material-master.json',
  'data/postgres-schema.sql',
  'ops/github-target.json',
];
const strongSecretPatterns = [
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

const git = (args) => {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
};

const candidateFiles = () => [...new Set([
  ...git(['ls-files']).split(/\r?\n/),
  ...git(['ls-files', '--others', '--exclude-standard']).split(/\r?\n/),
].filter(Boolean))].sort();

const gitLines = (args) => git(args).split(/\r?\n/).filter(Boolean);

const scanForStrongSecrets = async (files) => {
  const findings = [];
  for (const file of files) {
    if (file.endsWith('.env.staging.example') || file.endsWith('compose.staging.yml')) continue;
    let contents;
    try { contents = await readFile(resolve(root, file), 'utf8'); } catch { continue; }
    contents.split(/\r?\n/).forEach((line, index) => {
      if (strongSecretPatterns.some((pattern) => pattern.test(line))) findings.push({ file, line: index + 1, type: 'STRONG_SECRET_PATTERN' });
    });
  }
  return findings;
};

export const buildGitHubPublicationPreflight = async ({ target = {}, localBranch = git(['branch', '--show-current']), files = candidateFiles(), stagedFiles = gitLines(['diff', '--cached', '--name-only']), unstagedFiles = gitLines(['diff', '--name-only']), untrackedFiles = gitLines(['ls-files', '--others', '--exclude-standard']) } = {}) => {
  const origin = git(['remote', 'get-url', 'origin']);
  const targetPreflight = buildGitHubTargetPreflight({ repository: target.repository, remote: origin, baseBranch: target.baseBranch });
  const missingFiles = requiredFiles.filter((file) => !files.includes(file));
  const secretFindings = await scanForStrongSecrets(files);
  const branchMismatch = Boolean(localBranch && target.baseBranch && localBranch !== target.baseBranch);
  const blockers = [
    ...(targetPreflight.status === 'TARGET_MATCH' ? [] : ['GITHUB_TARGET_NOT_MATCHED']),
    ...(missingFiles.length ? ['REQUIRED_PUBLICATION_FILE_MISSING'] : []),
    ...(secretFindings.length ? ['SECRET_PATTERN_FOUND'] : []),
    ...(branchMismatch ? ['LOCAL_BRANCH_DIFFERS_FROM_TARGET_BASE'] : []),
    ...((unstagedFiles.length || untrackedFiles.length) ? ['WORKTREE_NOT_STAGED_FOR_EXPLICIT_COMMIT'] : []),
  ];
  return {
    schemaVersion: 'GITHUB-PUBLICATION-PREFLIGHT-0.1',
    status: blockers.length ? 'BLOCKED' : 'READY_FOR_EXPLICIT_PUSH',
    target: targetPreflight,
    localBranch: localBranch || null,
    requiredFiles,
    candidateFileCount: files.length,
    stagedFileCount: stagedFiles.length,
    unstagedFileCount: unstagedFiles.length,
    untrackedFileCount: untrackedFiles.length,
    missingFiles,
    secretFindings,
    blockers,
    warnings: ['커밋·푸시·PR·배포는 이 사전점검에서 실행하지 않는다.', '외부 저장소 변경은 H-01 또는 지정 릴리스 담당자의 명시적 승인이 필요하다.'],
    externalWritesPerformed: false,
  };
};

if (process.argv[1] && basename(process.argv[1]) === 'github-publication-preflight.mjs') {
  let target = {};
  try { target = JSON.parse(await readFile(resolve(root, 'ops', 'github-target.json'), 'utf8')); } catch {}
  console.log(JSON.stringify({ ...(await buildGitHubPublicationPreflight({ target })), checkedAt: new Date().toISOString() }));
}

