import path from 'path';
import WebhooksApi from '@octokit/webhooks';
import createLogger from 'silk-log';
import express from 'express';
import github from 'octonode';
import fetch from 'node-fetch';

const log = createLogger('index');

const STATUS_CONTEXT = 'ci-gate';
const CI_LABEL = 'CI';

const envconst = {
  BUILDKITE_TOKEN: null,
  BUILDKITE_ORG_SLUG: null,
  GITHUB_TOKEN: null,
  PORT: 5000,
  GITHUB_WEBHOOK_SECRET: null,
  CI_USER_WHITELIST: 'mvines', // comma separated, no spaces
};

for (const v in envconst) {
  envconst[v] = process.env[v] || envconst[v];
  if (!envconst[v]) {
    throw new Error(`${v} environment variable not defined`);
  }
}

const githubClient = github.client(envconst.GITHUB_TOKEN);

async function triggerBuildkiteCI(repoName, branch, prNumber, headSha) {
  const url = `https://api.buildkite.com/v2/organizations/` +
      `${envconst.BUILDKITE_ORG_SLUG}/pipelines/` +
      `${path.basename(repoName)}/builds`;

  log.info('fetch', url);
  const response = await fetch(
    url,
    {
      method: 'POST',
      body: JSON.stringify({
        branch,
        commit: headSha,
        message: `Pull Request #${prNumber}`,
      }),
      headers: {
        'Authorization': `Bearer ${envconst.BUILDKITE_TOKEN}`,
      },
    }
  );
  log.info('fetch response:', response.status, response.statusText);
}

async function prSetLabel(repoName, prNumber, labelName) {
  const issue = githubClient.issue(repoName, prNumber);
  await issue.addLabelsAsync([labelName]);
}

async function prHasLabel(repoName, prNumber, labelName) {
  const issue = githubClient.issue(repoName, prNumber);
  const [labels] = await issue.labelsAsync();
  const labelNames = labels.map((label) => label.name);
  return labelNames.includes(labelName);
}

async function prRemoveLabel(repoName, prNumber, labelName) {
  log.info(`Removing label ${labelName} from ${repoName}#${prNumber}`);
  const issue = githubClient.issue(repoName, prNumber);
  try {
    await issue.removeLabelAsync(labelName);
  } catch (err) {
    if (err.message !== 'Label does not exist') {
      throw err;
    }
  }
}

async function onGithubStatusUpdate(payload) {
  log.info('onGithubStatusUpdate', payload);
  await Promise.resolve(); // pacify eslint
}

async function onGithubPullRequest(payload) {
  const prNumber = payload.number;
  const repoName = payload.repository.full_name;
  const {pull_request} = payload;
  const headSha = pull_request.head.sha;
  const merged = pull_request.merged;
  const branch = pull_request.base.ref;
  const repo = githubClient.repo(repoName);

  log.info(payload.action, headSha, prNumber, repoName);
  switch (payload.action) {
  case 'open':
  case 'reopened':
  case 'synchronize':
  {
    await prRemoveLabel(repoName, prNumber, CI_LABEL);
    const user = payload.sender.login;

    if (envconst.CI_USER_WHITELIST.split(',').includes(user)) {
      await prSetLabel(repoName, prNumber, CI_LABEL);
    } else {
      await repo.statusAsync(headSha, {
        'state': 'failure',
        'context': STATUS_CONTEXT,
        'description': 'CI label required',
      });
    }
    break;
  }
  case 'labeled':
    if (!merged) {
      if (prHasLabel(repoName, prNumber, CI_LABEL)) {
        await repo.statusAsync(headSha, {
          'state': 'success',
          'context': STATUS_CONTEXT,
          'description': 'PR accepted for CI',
        });
        await prRemoveLabel(repoName, prNumber, CI_LABEL);
        await triggerBuildkiteCI(repoName, branch, prNumber, headSha);
      }
    }
    break;
  default:
    log.info('Ignored pull request action:', payload.action);
  }
}

async function onGithubPush(payload) {
  log.info(payload);
  await Promise.resolve(); // pacify eslint
}

async function onGithubPing(payload) {
  log.info('Github ping:', payload.zen);
  await Promise.resolve(); // pacify eslint
}

async function onGithub({id, name, payload}) {
  try {
    log.debug('Github webhook:', name, id);
    log.verbose(payload);
    const hooks = {
      'ping': onGithubPing,
      'pull_request': onGithubPullRequest,
      'push': onGithubPush,
      'status': onGithubStatusUpdate,
    };
    if (hooks[name]) {
      await hooks[name](payload);
    } else {
      log.warn('Unhandled Github webhook:', name);
    }
  } catch (err) {
    log.error(err);
  }
}


function main() {
  try {
    const webhooks = new WebhooksApi({
      secret: envconst.GITHUB_WEBHOOK_SECRET,
      path: '/github',
    });
    webhooks.on('*', onGithub);

    const app = express();
    app.use(webhooks.middleware);
    app.use(express.static(path.join(__dirname, 'public_html')));
    app.listen(envconst.PORT, () => log.info(`Listening on ${envconst.PORT}`));
  } catch (err) {
    log.error(err);
    process.exit(1);
  }
}

main();
