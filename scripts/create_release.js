import { Octokit } from 'octokit';

const REPOSITORY_OWNER = 'Knorcedger';
const REPOSITORY_NAME = 'quickord-printer-server';

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

console.log('Creating release...');
const release = await octokit.request(
  `POST /repos/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/releases`,
  {
    owner: REPOSITORY_OWNER,
    repo: REPOSITORY_NAME,
    tag_name: `v${new Date().getFullYear()}.${new Date().getMonth() + 1}.${new Date().getDate()}`,
    target_commitish: 'main',
    draft: false,
    prerelease: false,
    generate_release_notes: true,
    headers: {
      'X-GitHub-Api-Version': '2022-11-28',
    },
  }
);

console.log('Uploading assets...');
await octokit.request(
  `POST /repos/${REPOSITORY_OWNER}/${REPOSITORY_NAME}/releases/${release.id}/assets{?name,label}`,
  {
    owner: REPOSITORY_OWNER,
    repo: REPOSITORY_NAME,
    release_id: release.id,
    data: './builds/quickord-printer-server.zip',
    headers: {
      'X-GitHub-Api-Version': '2022-11-28',
    },
  }
);

console.log('Release created successfully!');
