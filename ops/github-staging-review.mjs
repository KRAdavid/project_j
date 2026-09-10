import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

const gitStatus = () => {
  try { return execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
};

export const parseGitStatus = (output = '') => {
  const entries = [];
  const tokens = String(output).split('\0').filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const status = token.slice(0, 2);
    const path = token.slice(3);
    if (!path) continue;
    const isRename = status.includes('R') || status.includes('C');
    entries.push({ status, path, renameSource: isRename ? tokens[index + 1] || null : null });
    if (isRename) index += 1;
  }
  return entries;
};

const categoryFor = (path) => {
  if (path.startsWith('.github/')) return 'github-governance';
  if (path.startsWith('beta-app/')) return 'product-app';
  if (path.startsWith('simulator/')) return 'simulation';
  if (path.startsWith('data/')) return 'domain-data';
  if (path.startsWith('ops/')) return 'operations';
  if (path.endsWith('.md')) return 'documentation';
  if (path.endsWith('.png')) return 'visual-assets';
  return 'root-config';
};

export const buildStagingReview = ({ entries = parseGitStatus(gitStatus()), generatedAt = new Date().toISOString() } = {}) => {
  const normalized = entries.map((entry) => ({ ...entry, category: categoryFor(entry.path), staged: entry.status[0] !== ' ' && entry.status !== '??', unstaged: entry.status !== '??' && entry.status[1] !== ' ', untracked: entry.status === '??' }));
  const groups = [...new Set(normalized.map((entry) => entry.category))].sort().map((category) => ({ category, files: normalized.filter((entry) => entry.category === category).map(({ path, status, staged, unstaged, untracked, renameSource }) => ({ path, status, staged, unstaged, untracked, ...(renameSource ? { renameSource } : {}) })) }));
  const uncommitted = normalized.filter((entry) => entry.unstaged || entry.untracked);
  return {
    schemaVersion: 'GITHUB-STAGING-REVIEW-0.1',
    generatedAt,
    status: uncommitted.length ? 'REVIEW_REQUIRED' : 'READY_FOR_HUMAN_COMMIT',
    totalFiles: normalized.length,
    stagedFiles: normalized.filter((entry) => entry.staged).length,
    unstagedFiles: normalized.filter((entry) => entry.unstaged).length,
    untrackedFiles: normalized.filter((entry) => entry.untracked).length,
    groups,
    guardrail: '이 검토는 파일을 스테이징·커밋·푸시하지 않으며, 초기 커밋 범위의 인간 확인을 요구한다.',
  };
};

export const writeStagingReview = async ({ jsonPath = resolve(root, 'ops', 'latest-github-staging-review.json'), markdownPath = resolve(root, 'ops', 'latest-github-staging-review.md'), generatedAt = new Date().toISOString() } = {}) => {
  const review = buildStagingReview({ generatedAt });
  await writeFile(jsonPath, `${JSON.stringify(review, null, 2)}\n`, 'utf8');
  const lines = [
    `# GitHub 초기 커밋 스테이징 검토 · ${review.generatedAt}`,
    '',
    `- 상태: **${review.status}**`,
    `- 전체 파일: ${review.totalFiles}개 · staged ${review.stagedFiles}개 · unstaged ${review.unstagedFiles}개 · untracked ${review.untrackedFiles}개`,
    '',
    ...review.groups.flatMap((group) => [`## ${group.category}`, '', ...group.files.map((file) => `- \`${file.status}\` ${file.path}${file.renameSource ? ` ← ${file.renameSource}` : ''}`), '']),
    review.guardrail,
  ];
  await writeFile(markdownPath, `${lines.join('\n')}\n`, 'utf8');
  return review;
};

if (process.argv[1] && basename(process.argv[1]) === 'github-staging-review.mjs') {
  console.log(JSON.stringify(await writeStagingReview()));
}

