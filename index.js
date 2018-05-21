import assert from 'assert';
import path from 'path';
import WebhooksApi from '@octokit/webhooks';
import createLogger from 'silk-log';
import express from 'express';
import github from 'octonode';
import {promisify} from 'es6-promisify';
import createBuildKiteClient from 'buildnode';
import AnsiToHtml from 'ansi-to-html';

const log = createLogger('index');

const STATUS_CONTEXT = 'ci-gate';
const CI_LABEL = 'CI';

const envconst = {
  /*
    The buildkite token requires the following scopes:
      * read_builds
      * write_builds
      * read_build_logs
      * read_organizations
      * read_pipelines
   */
  BUILDKITE_TOKEN: null,

  /*
     The buildkite organization slug name to use
   */
  BUILDKITE_ORG_SLUG: null,

  /*
     List of buildkite pipelines that may have their logs exposed to the public
   */
  BUILDKITE_PIPELINE_PUBLIC_LOG_WHITELIST: '', // comma separated, no spaces

  /*
     Github OAuth token with access to relative github projects.
     TODO: document required scopes
   */
  GITHUB_TOKEN: null,

  /*
     Default http port (used for local dev only normally)
   */
  PORT: 5000,

  /*
     Public URL to this server
   */
  PUBLIC_URL_ROOT: 'http://localhost:5000',
  GITHUB_WEBHOOK_SECRET: null,

  /*
     List of users without write access to the repo that should also be
     automatically granted CI access
   */
  CI_USER_WHITELIST: '', // comma separated, no spaces
};

for (const v in envconst) {
  envconst[v] = process.env[v] || envconst[v];
  if (envconst[v] === null) {
    throw new Error(`${v} environment variable not defined`);
  }
}

const githubClient = github.client(envconst.GITHUB_TOKEN);
const buildkiteClient = createBuildKiteClient({
  accessToken: envconst.BUILDKITE_TOKEN
});
buildkiteClient.getOrganizationAsync = promisify(buildkiteClient.getOrganization);
let buildkiteOrg;


async function triggerBuildkitePullRequestCI(
  repoName, branch, prNumber, headSha
) {
  const pipelineName = path.basename(repoName);

  const pipeline = await buildkiteOrg.getPipelineAsync(pipelineName);
  pipeline.createBuildAsync = promisify(pipeline.createBuild);

  const newBuild = await pipeline.createBuildAsync({
    branch: `pull/${prNumber}/head`,
    commit: headSha,
    message: `Pull Request #${prNumber}`,
  });

  log.info('createBuild result:', newBuild);
}

/*
async function prSetLabel(repoName, prNumber, labelName) {
  const issue = githubClient.issue(repoName, prNumber);
  await issue.addLabelsAsync([labelName]);
}
*/

async function prHasLabel(repoName, prNumber, labelName) {
  const issue = githubClient.issue(repoName, prNumber);
  const [labels] = await issue.labelsAsync();
  const labelNames = labels.map((label) => label.name);
  return labelNames.includes(labelName);
}

async function userInCiWhitelist(repoName, user) {
  const repo = githubClient.repo(repoName);
  if (await repo.collaboratorsAsync(user)) {
    return true;
  }
  return envconst.CI_USER_WHITELIST.split(',').includes(user);
}

function pipelineInPublicLogWhitelist(pipeline) {
  const wl = envconst.BUILDKITE_PIPELINE_PUBLIC_LOG_WHITELIST;
  return wl.split(',').includes(pipeline);
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

function isBuildkitePublicLogUrl(url) {
  if (typeof(url) !== 'string') {
    return false;
  }

  const orgUrlPrefix = `https://buildkite.com/${envconst.BUILDKITE_ORG_SLUG}/`;
  if (!url.startsWith(orgUrlPrefix)) {
    return false;
  }

  const buildInfo = url.slice(orgUrlPrefix.length);
  const reMatch = buildInfo.match(/^([a-z-]+)\/builds\/([1-9[0-9]+)$/);
  if (!reMatch) {
    return false;
  }
  assert(reMatch.index === 0);
  assert(reMatch.length === 3);

  const pipeline = reMatch[1];
  const buildNumber = Number(reMatch[2]);
  return {pipeline, buildNumber};
}


async function onGithubStatusUpdate(payload) {
  log.info('onGithubStatusUpdate', payload);

  // Rewrite buildkite URLs to make the buildkite logs read-accessible to everybody
  // (temporary hack until buildkite supports public logs)
  const {
    context,
    description,
    name,
    sha,
    state,
    target_url,
  } = payload;

  if (isBuildkitePublicLogUrl(target_url)) {
    const new_target_url = envconst.PUBLIC_URL_ROOT + '/buildkite_public_log?' + target_url;
    log.info('updating to', new_target_url);
    const repo = githubClient.repo(name);
    await repo.statusAsync(sha, {
      state,
      context: 'PUBLIC LOG: ' + context,
      description,
      target_url: new_target_url,
    });
  } else {
    log.info(`Ignoring non-buildkite URL: ${target_url}`);
  }
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
  case 'opened':
  case 'reopened':
  case 'synchronize':
  {
    await prRemoveLabel(repoName, prNumber, CI_LABEL);
    const user = payload.sender.login;

    if (userInCiWhitelist(repoName, user)) {
      await triggerBuildkitePullRequestCI(repoName, branch, prNumber, headSha);
    } else {
      await repo.statusAsync(headSha, {
        'state': 'pending',
        'context': STATUS_CONTEXT,
        'description': `A project member must add the '${CI_LABEL}' label for tests to start`,
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
          'description': 'Pull Request accepted for test',
        });
        await prRemoveLabel(repoName, prNumber, CI_LABEL);
        await triggerBuildkitePullRequestCI(repoName, branch, prNumber, headSha);
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

function buildKiteStateStyle(state) {
  switch (state) {
  case 'running':
    return 'color:orange;';
  case 'failed':
    return 'color:red;';
  case 'passed':
    return 'color:green;';
  default:
    return 'color:black;';
  }
}

async function onBuildKitePublicLogRequest(req, res) {
  res.set('Content-Type', 'text/html');
  const queryIndex = req.originalUrl.indexOf('?');
  const url = (queryIndex >= 0) ? req.originalUrl.slice(queryIndex + 1) : '';
  const buildInfo = isBuildkitePublicLogUrl(url);
  if (!buildInfo) {
    log.warn(`Invalid public log url:`, url);
    res.status(400).send('');
    return;
  }
  if (!pipelineInPublicLogWhitelist(buildInfo.pipeline)) {
    log.warn(`Pipeline is not in whitelist:`, buildInfo.pipeline);
    res.status(400).send('');
    return;
  }

  const pipeline = await buildkiteOrg.getPipelineAsync(buildInfo.pipeline);
  pipeline.listBuildsAsync = promisify(pipeline.listBuilds);

  const builds = await pipeline.listBuildsAsync();
  const build = builds.find(
    (build) => build.number === buildInfo.buildNumber
  );
  if (!build) {
    log.warn(`Build ${buildInfo.buildNumber} not found`);
    res.status(400).send('');
    return;
  }

  // Filter out job names without the text '[public]' in their description
  const jobs = build.jobs.filter((job) => job.name.includes('[public]'));

  let header = `
    <h2>${build.message}</h2>
    <b>State:</b>
      <span style="${buildKiteStateStyle(build.state)}">
        ${build.state}
      </span>
      <br/>
  `;
  let body = '';

  if (jobs.length > 0) {
    const brief = jobs.length === 1;

    if (!brief) {
      header += `
        <b>Steps:</b>
        <ol>
      `;
      body += '</ol>';
    }
    const htmlConverter = new AnsiToHtml();
    for (let job of jobs) {
      const jobName = job.name.replace(/\[public\]/gi, '').trim();
      const jobNameUri = encodeURI(jobName);
      job.getLogAsync = promisify(job.getLog);
      const jobLog = await job.getLogAsync();

      if (!brief) {
        header += `
          <li>
            <a href="#${jobNameUri}">${jobName}</a>
            <span style="${buildKiteStateStyle(build.state)}">
              ${job.data.state}
            </span>
          </li>
        `;
        body += `
          <hr><h3><a name="${jobNameUri}">${jobName}</a></h3>
          <b>State:</b>
              <span style="${buildKiteStateStyle(build.state)}">
                ${job.data.state}
              </span>
            <br/>
        `;
      }
      body += `
        <b>Command:</b> <code>${job.command}</code></br>
        <pre>${htmlConverter.toHtml(jobLog.content)}</pre>
      `;
    }
  }

  log.info('Emitting log for', url);
  res.send(header + body);
}

async function main() {
  try {
    buildkiteOrg = await buildkiteClient.getOrganizationAsync(envconst.BUILDKITE_ORG_SLUG);
    buildkiteOrg.getPipelineAsync = promisify(buildkiteOrg.getPipeline);

    const webhooks = new WebhooksApi({
      secret: envconst.GITHUB_WEBHOOK_SECRET,
      path: '/github',
    });
    webhooks.on('*', onGithub);

    const app = express();
    app.use(webhooks.middleware);
    app.use(express.static(path.join(__dirname, 'public_html')));
    app.get('/buildkite_public_log', onBuildKitePublicLogRequest);

    app.listen(envconst.PORT, () => log.info(`Listening on ${envconst.PORT}`));
  } catch (err) {
    log.error(err);
    process.exit(1);
  }
}

main();
