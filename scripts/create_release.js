import { Octokit } from '@octokit/rest';
import fs from 'fs';

const REPOSITORY_OWNER = 'Knorcedger';
const REPOSITORY_NAME = 'quickord-printer-server';
const TAG = process.env.TAG;

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

console.log('Reading zip file "quickord-cashier-server.zip"...');
const codeData = fs.readFileSync('builds/quickord-cashier-server.zip');

console.log('Reading zip file "requirements.zip"...');
const requirementData = fs.readFileSync('builds/requirements.zip');

const now = new Date();
let version = `v${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}-${now.getTime().toString().slice(-5)}`;

try {
  const versionFile = await fs.promises.readFile('version', 'utf-8');

  if (versionFile.trim()) {
    version = versionFile.trim();
  }
} catch (error) {
  console.error('Error reading version file:', error);
}

console.log('Creating release...');
const release = await octokit.rest.repos.createRelease({
  owner: REPOSITORY_OWNER,
  repo: REPOSITORY_NAME,
  tag_name: version,
  target_commitish: 'main',
  draft: false,
  prerelease: false,
  generate_release_notes: true,
  headers: {
    'X-GitHub-Api-Version': '2022-11-28',
  },
});

const releaseId = release?.data?.id;

if (!releaseId) {
  console.error('No release id found!');
  process.exit(1);
}

console.log('Uploading "quickord-cashier-server" asset...');
await octokit.rest.repos.uploadReleaseAsset({
  owner: REPOSITORY_OWNER,
  repo: REPOSITORY_NAME,
  release_id: releaseId,
  data: codeData,
  name: 'quickord-cashier-server.zip',
  headers: {
    'X-GitHub-Api-Version': '2022-11-28',
  },
});

console.log('Uploading "requirements" asset...');
await octokit.rest.repos.uploadReleaseAsset({
  owner: REPOSITORY_OWNER,
  repo: REPOSITORY_NAME,
  release_id: releaseId,
  data: requirementData,
  name: 'requirements.zip',
  headers: {
    'X-GitHub-Api-Version': '2022-11-28',
  },
});
