import assert from 'assert';
import path from 'path';
import WebhooksApi from '@octokit/webhooks';
import createLogger from 'silk-log';
import express from 'express';
import github from 'octonode';
import {promisify} from 'es6-promisify';
import createBuildKiteClient from 'buildnode';
import moment from 'moment';

const log = createLogger('index');

const STATUS_CONTEXT = 'ci-gate';
const CI_LABEL = 'CI';
const NOCI_LABEL = 'noCI';
const AUTOMERGE_LABEL = 'automerge';

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
     Exposes all logs of whitelisted pipelines if set to true
   */
  BUILDKITE_EXPOSE_ALL_JOB_LOGS: false,

  /*
     Github OAuth token with access to the relevant github projects with the
     required scopes:
     * repo:status
     * repo_deployment
     * public_repo
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

  /*
     Secret string added in the Github webhook configuration
   */
  GITHUB_WEBHOOK_SECRET: null,

  /*
     List of users without write access to the repo that should also be
     automatically granted CI access
   */
  CI_USER_WHITELIST: '', // comma separated, no spaces

  /*
     List of github repos (full_name format; e.g. `org/repo`) that use
     public Buildkite pipelines
  */
  PUBLIC_PIPELINE_REPOS: '', // comma separated, no spaces
};

for (const v in envconst) {
  envconst[v] = process.env[v] || envconst[v];
  if (envconst[v] === null) {
    throw new Error(`${v} environment variable not defined`);
  }
}

const PUBLIC_PIPELINE_REPOS = new Set(envconst.PUBLIC_PIPELINE_REPOS.split(','));
const githubClient = github.client(envconst.GITHUB_TOKEN);
const buildkiteClient = createBuildKiteClient({
  accessToken: envconst.BUILDKITE_TOKEN
});
buildkiteClient.getOrganizationAsync = promisify(buildkiteClient.getOrganization);
let buildkiteOrg;


async function triggerPullRequestCI(repoName, prNumber, commit) {
  const repo = githubClient.repo(repoName);
  const branch = `pull/${prNumber}/head`;

  if (await prHasLabel(repoName, prNumber, NOCI_LABEL)) {
    await repo.statusAsync(commit, {
      'state': 'failure',
      'context': STATUS_CONTEXT,
      'description': `Remove ${NOCI_LABEL} label to continue`,
    });
    return;
  }

  const message = `Pull Request #${prNumber} - ${commit.substring(0, 8)}`;

  log.info(`Triggering pull request: ${repoName}:${branch} at ${commit}`);

  const pr = repo.pr(prNumber);
  const prFiles = await pr.filesAsync();
  const prFilenames = prFiles[0].map(f => f.filename);
  const affected_files = prFilenames.join(':');
  log.info(`files affected by this PR: ${affected_files}`);

  const pipelineName = path.basename(repoName).replace(/\./g, '-');

  const pipeline = await buildkiteOrg.getPipelineAsync(pipelineName);

  let description = `${pipelineName} CI pipeline not present`;
  if (pipeline) {
    pipeline.createBuildAsync = promisify(pipeline.createBuild);

    const newBuild = await pipeline.createBuildAsync({
      branch,
      commit,
      message,
      meta_data: {
        affected_files,
      },
    });
    description = 'Pull Request accepted for CI';
    log.info('createBuild result:', newBuild);
  }

  await repo.statusAsync(
    commit,
    {
      state: 'success',
      context: STATUS_CONTEXT,
      description,
    }
  );

  await prRemoveLabel(repoName, prNumber, CI_LABEL);
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
  const labelNames = labels.map((label) => label.name.toLowerCase());
  return labelNames.includes(labelName.toLowerCase());
}

async function userInCiWhitelist(repoName, user) {
  const repo = githubClient.repo(repoName);
  try {
    if (await repo.collaboratorsAsync(user)) {
      return true;
    }
  } catch (err) {
    log.warn(`Error: userInCiWhitelist(${user}):`, err.message);
  }
  return envconst.CI_USER_WHITELIST.split(',').includes(user);
}

async function handleCommitsPushedToPullRequest(repoName, prNumber) {
  const repo = githubClient.repo(repoName);
  const issue = repo.issue(prNumber);

  if (!await prHasLabel(repoName, prNumber, AUTOMERGE_LABEL)) {
    log.debug(`handleCommitsPushedToPullRequest: ${AUTOMERGE_LABEL} label is not set`);
    return;
  }

  if (await prRemoveLabel(repoName, prNumber, AUTOMERGE_LABEL)) {
    const body = ':scream: New commits were pushed while the automerge label was present.';
    log.info(body);
    await issue.createCommentAsync({body});
  }
}

async function autoMergePullRequest(repoName, prNumber) {
  const repo = githubClient.repo(repoName);
  const pr = repo.pr(prNumber);
  const issue = repo.issue(prNumber);
  const info = await pr.infoAsync();
  assert(typeof info === 'object');
  const {state, mergeable, head} = info[0];

  if (state !== 'open') {
    return;
  }

  if (!await prHasLabel(repoName, prNumber, AUTOMERGE_LABEL)) {
    log.debug(`autoMergePullRequest: ${AUTOMERGE_LABEL} label is not set`);
    return;
  }

  if (mergeable === null) {
    // https://developer.github.com/v3/pulls/#response-1
    log.debug(`mergeable state is not yet known.`);
    return;
  }

  if (mergeable === false) {
    if (await prRemoveLabel(repoName, prNumber, AUTOMERGE_LABEL)) {
      const body = ':broken_heart: Unable to automerge due to merge conflict';
      log.info(body);
      await issue.createCommentAsync({body});
    }
    return;
  }

  // Check the CI status of the head SHA
  log.debug(`fetching CI status for head SHA ${head.sha}`);
  const status = (await repo.combinedStatusAsync(head.sha))[0];
  log.info(`CI status: ${status.state} with ${status.statuses.length} statuses`);
  log.debug('All statuses:', status.statuses);

  switch (status.state) {
  case 'success':
  {
    if (status.statuses.length < 2) {
      log.warn(`Refusing to automerge with no evidence of success`);
    } else {
      log.info(`CI status is success, trying to merge...`);
      const mergeResult = await pr.mergeAsync({
        sha: head.sha,
        commit_message: 'automerge',
        merge_method: 'rebase',
      });
      log.info(`successfully merged`, mergeResult);
    }
    break;
  }

  case 'failure':
  {
    if (await prRemoveLabel(repoName, prNumber, AUTOMERGE_LABEL)) {
      const body = ':broken_heart: Unable to automerge due to CI failure';
      log.info(body);
      await issue.createCommentAsync({body});
    }
    break;
  }

  default:
    break;
  }
}

async function autoMergePullRequests(repoName) {
  log.info(`autoMergePullRequests for ${repoName}...`);

  const openPrs = await new Promise((resolve, reject) => {
    const repo = githubClient.repo(repoName);
    repo.prs((err, pulls) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(
        pulls.filter((pull) => {
          return pull.state === 'open';
        })
      );
    });
  });

  for (let openPr of openPrs) {
    log.info(`Processing #${openPr.number} ${openPr.title}`);
    await autoMergePullRequest(repoName, openPr.number);
  }
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
    log.warn(
      `Error removing label ${labelName} from ${repoName}#${prNumber}`,
      err.message
    );
    return false;
  }
  return true;
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
  const reMatch = buildInfo.match(/^([a-z-]+)\/builds\/([1-9[0-9]+|latest\/[a-z]+)$/);
  if (!reMatch) {
    return false;
  }
  assert(reMatch.index === 0);
  assert(reMatch.length === 3);

  const pipeline = reMatch[1];
  const buildNumber = reMatch[2].startsWith('latest/') ? reMatch[2].substr(7) : Number(reMatch[2]);
  return {pipeline, buildNumber};
}

function isBuildkitePublicArtifactUrl(url) {
  if (typeof(url) !== 'string') {
    return false;
  }

  const orgUrlPrefix = `https://api.buildkite.com/v2/organizations/${envconst.BUILDKITE_ORG_SLUG}/pipelines/`;
  if (!url.startsWith(orgUrlPrefix)) {
    return false;
  }

  const buildInfo = url.slice(orgUrlPrefix.length);
  const reMatch = buildInfo.match(
    /^([a-z-]+)\/builds\/([1-9[0-9]+)\/jobs\/([-a-z0-9]+)\/artifacts\/([-a-z0-9]+)\/download$/
  );
  if (!reMatch) {
    return false;
  }
  assert(reMatch.index === 0);
  assert(reMatch.length === 5);

  const pipeline = reMatch[1];
  const buildNumber = Number(reMatch[2]);
  const jobId = reMatch[3];
  const artifactId = reMatch[4];
  return {pipeline, buildNumber, jobId, artifactId};
}

let autoMergePullRequestsBusy = false;
let autoMergePullRequestsPending = false;
async function onGithubStatusUpdate(payload) {
  log.info('onGithubStatusUpdate', payload);

  // Rewrite buildkite URLs to make the buildkite logs read-accessible to everybody
  // (temporary hack until buildkite supports public logs)
  const {
    context,
    description,
    name,
    repository,
    sha,
    state,
    target_url,
  } = payload;

  if (!PUBLIC_PIPELINE_REPOS.has(repository.full_name) && isBuildkitePublicLogUrl(target_url)) {
    // Overwrite the buildkite status url with the public log equivalent
    const new_target_url = envconst.PUBLIC_URL_ROOT + '/buildkite_public_log?' + target_url;
    log.info('updating to', new_target_url);
    const repo = githubClient.repo(name);
    await repo.statusAsync(sha, {
      state,
      context,
      description,
      target_url: new_target_url,
    });
  } else {
    log.info(`Ignoring non-buildkite URL: ${target_url}`);
  }

  autoMergePullRequestsPending = true;
  if (autoMergePullRequestsBusy) {
    log.info('autoMergePullRequests busy');
    return;
  }
  autoMergePullRequestsBusy = true;
  while (autoMergePullRequestsPending) {
    autoMergePullRequestsPending = false;
    try {
      // Check if any PRs in this repo should be merged, as unfortunately the status
      // API provides no link from commit status to the corresponding pull request
      await autoMergePullRequests(name);
    } catch (err) {
      log.error('autoMergePullRequests failed with:', err);
    }
  }
  autoMergePullRequestsBusy = false;
}

async function onGithubPullRequestReview(payload) {
  const {action, review, pull_request} = payload;
  const prNumber = pull_request.number;
  const repoName = pull_request.head.repo.full_name;

  log.info(`onGithubPullRequestReview ${action} on ${repoName}#{prNumber}`, review);
  await autoMergePullRequest(repoName, prNumber);
}


async function onGithubPullRequest(payload) {
  const prNumber = payload.number;
  const repoName = payload.repository.full_name;
  const user = payload.sender.login;
  const {pull_request} = payload;
  const headSha = pull_request.head.sha;
  const merged = pull_request.merged;
  const repo = githubClient.repo(repoName);

  log.info(payload.action, headSha, prNumber, repoName);
  switch (payload.action) {
  case 'synchronize':
    handleCommitsPushedToPullRequest(repoName, prNumber);
    //fall through
  case 'opened':
  case 'reopened':
  {
    await prRemoveLabel(repoName, prNumber, CI_LABEL);

    if (await userInCiWhitelist(repoName, user)) {
      await triggerPullRequestCI(repoName, prNumber, headSha);
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
      if (await prHasLabel(repoName, prNumber, CI_LABEL)) {
        await triggerPullRequestCI(repoName, prNumber, headSha);
      }
      await autoMergePullRequest(repoName, prNumber);
    }
    break;
  default:
    log.info('Ignored pull request action:', payload.action);
  }
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
      'status': onGithubStatusUpdate,
      'pull_request_review': onGithubPullRequestReview,
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

function buildkiteActiveState(state) {
  switch (state) {
  case 'canceling':
  case 'canceled':
  case 'failed':
  case 'passed':
  case 'timed_out':
  case 'waiting_failed':
    return false;
  default:
    return true;
  }
}

function buildkiteStateStyle(state) {
  const colorByState = {
    accepted: 'gray',
    assigned: 'gray',
    blocked: 'gray',
    canceling: 'red',
    canceled: 'red',
    failed: 'red',
    passed: 'green',
    running: 'orange',
    scheduled: 'gray',
    timed_out: 'red',
    waiting: 'gray',
    waiting_failed: 'red',
  };
  assert(
    typeof colorByState[state] === 'string',
    `Missing state in colorByState: ${state}`
  );
  return `font-weight: bold; color: ${colorByState[state]};`;
}

function buildkiteHumanTimeInfo(buildData) {
  assert(typeof buildData.state === 'string');

  let description = '';
  switch (buildData.state) {
  case 'scheduled':
  case 'waiting':
  case 'assigned':
  case 'accepted':
  {
    assert(typeof buildData.scheduled_at === 'string');
    const scheduledTime = moment.utc(buildData.scheduled_at);
    scheduledTime.local();
    description = 'waiting since ' + scheduledTime.format('HH:mm:ss on dddd');
    break;
  }
  case 'blocked':
  {
    description = 'blocked';
    break;
  }
  case 'timed_out':
  {
    description = 'timed out';
    break;
  }
  case 'waiting_failed':
  case 'canceling':
  case 'canceled':
  {
    description = 'aborted';
    break;
  }
  case 'running':
  {
    assert(typeof buildData.scheduled_at === 'string');
    assert(typeof buildData.started_at === 'string');
    const startedTime = moment.utc(buildData.started_at);
    startedTime.local();
    description = 'running since ' + startedTime.format('HH:mm:ss on dddd');
    break;
  }
  case 'failed':
  case 'passed':
  {
    assert(typeof buildData.scheduled_at === 'string');
    assert(typeof buildData.started_at === 'string');
    assert(typeof buildData.finished_at === 'string');
    const scheduledTime = moment.utc(buildData.scheduled_at);
    const startedTime = moment.utc(buildData.started_at);
    const finishedTime = moment.utc(buildData.finished_at);

    scheduledTime.local();
    startedTime.local();
    finishedTime.local();
    const runDuration = moment.duration(finishedTime.diff(startedTime));
    const waitDuration = moment.duration(startedTime.diff(scheduledTime));

    description = 'ran for ' + runDuration.humanize();
    if (waitDuration.minutes() > 0) {
      description += ', queued for ' + waitDuration.humanize();
    }
    break;
  }
  default:
    throw new Error(`Unknown state: ${buildData.state}`);
  }
  return description;
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

  // TODO: Add pagination support for older builds
  const builds = await pipeline.listBuildsAsync();
  const build = builds.find(
    (build) => {
      if (typeof buildInfo.buildNumber === 'string') {
        return build.branch === buildInfo.buildNumber;
      } else {
        return build.number === buildInfo.buildNumber;
      }
    }
  );

  if (!build) {
    let msg = `Build ${buildInfo.buildNumber} not found, try <a href="${url}">here</a> instead.`;

    // TODO: Add pagination support for older builds
    msg += '<p>TODO: Add pagination support for older builds';
    log.warn(msg);
    res.status(400).send(msg);
    return;
  }

  const {provider} = build.data.pipeline;
  let branchHtml = build.branch;
  if (provider.id === 'github') {
    const {repository} = provider.settings;

    const prMatch = build.branch.match(/^pull\/([1-9[0-9]+)\/head$/);
    if (prMatch) {
      const prNumber = prMatch[1];
      branchHtml = `
        <a
          href="https://github.com/${repository}/pull/${prNumber}"
        >#${prNumber}</a>
      `;
    } else {
      branchHtml = `
        <a
          href="https://github.com/${repository}/tree/${build.branch}"
        >${branchHtml}</a>
      `;
    }
  }

  const jobs = build.jobs.filter((job) => job.name);

  let spinnerHtml = '';
  if (buildkiteActiveState(build.state)) {
    spinnerHtml = `<img style='vertical-align:middle;' src='spinner.gif'>`;
  }

  let header = `
    <html>
    <head>
      <title>${build.message}</title>
      <link rel="stylesheet" type="text/css" href="/terminal.css" />
    </head>
    <body>
    <h2>${spinnerHtml} ${build.message}</h2>
    <b>State:</b>
      <span style="${buildkiteStateStyle(build.state)}">
        ${build.state}
      </span>
      - <i>${buildkiteHumanTimeInfo(build.data)}</i>
      <br/>
    <b>Branch:</b> ${branchHtml}</br>
    <b>Buildkite Log:</b> <a href="${build.data.web_url}"/>link</a></br>
  `;
  let body = '';
  const footer = '</body></html>';

  if (jobs.length > 0) {
    const brief = jobs.length === 1;

    if (!brief) {
      header += `
        <b>Steps:</b>
        <ol>
      `;
      body += '</ol>';
    }
    let jobSpinnerRendered = false;
    for (let job of jobs) {
      const jobName = job.name.replace(/\[public\]/gi, '').trim();
      const jobNameUri = encodeURI(jobName);
      job.getLogHtmlAsync = promisify(job.getLogHtml);
      const jobHumanTime = buildkiteHumanTimeInfo(job.data);

      let jobLog = '<br><i>Build log not available</i><br>';
      let artifacts;
      if (envconst.BUILDKITE_EXPOSE_ALL_JOB_LOGS || job.name.includes('[public]')) {
        const html = await job.getLogHtmlAsync();
        if (html) {
          jobLog = `<div class="term-container">${html}</div>`;
        }

        job.listArtifactsAsync = promisify(job.listArtifacts);
        const jobArtifacts = await job.listArtifactsAsync();

        if (jobArtifacts.length > 0) {
          artifacts = jobArtifacts.map(a => {
            const url = envconst.PUBLIC_URL_ROOT + '/buildkite_public_artifact?' +
              `https://api.buildkite.com/v2/organizations/${envconst.BUILDKITE_ORG_SLUG}/pipelines/${buildInfo.pipeline}/builds/${build.number}/jobs/${a.jobId}/artifacts/${a.id}/download`;
            return `<li><a href="${url}" target="_blank">${a.path}</a> (${a.size} bytes)</li>`;
          }).join('');
          artifacts = `<ul>${artifacts}</ul>`;
        }
      }

      if (!jobSpinnerRendered && buildkiteActiveState(job.data.state)) {
        jobSpinnerRendered = true;
        jobLog += `
          <img style='vertical-align:middle;' src='spinner.gif'>
          <div style='color:orange; vertical-align:middle; display:inline;'>
            <i>Job active, refresh page manually for updates...</i>
          </div>
        `;
      }

      if (!brief) {
        header += `
          <li>
            <span style="${buildkiteStateStyle(job.data.state)}">
              ${job.data.state}
            </span>
            - <a href="#${jobNameUri}">${jobName}</a>
            - <i>${jobHumanTime}</i>
        `;
        if (artifacts) {
          header += `
            <br>
            ${artifacts}
          `;
        }
        header += `
          </li>
        `;
        body += `
          <hr><h3><a name="${jobNameUri}">${jobName}</a></h3>
          <b>State:</b>
            <span style="${buildkiteStateStyle(job.data.state)}">
              ${job.data.state}
            </span>
            - <i>${jobHumanTime}</i>
          <br/>
          <b>Buildkite Log:</b> <a href="${job.data.web_url}"/>link</a></br>
        `;
      }
      if (artifacts) {
        body += `
          <b>Artifacts:</b>
          ${artifacts}
        `;
      }
      body += `
        <b>Command:</b> <code>${job.command}</code></br>
        ${jobLog}
      `;
    }
  }

  log.info('Emitting log for', url);
  res.send(header + body + footer);
}

async function onBuildKitePublicArtifactRequest(req, res) {
  const queryIndex = req.originalUrl.indexOf('?');
  const url = (queryIndex >= 0) ? req.originalUrl.slice(queryIndex + 1) : '';

  const buildInfo = isBuildkitePublicArtifactUrl(url);
  if (!buildInfo) {
    log.warn(`Invalid public artifact url:`, url);
    res.status(400).send('');
    return;
  }
  if (!pipelineInPublicLogWhitelist(buildInfo.pipeline)) {
    log.warn(`Pipeline is not in whitelist:`, buildInfo.pipeline);
    res.status(400).send('');
    return;
  }

  const pipeline = await buildkiteOrg.getPipelineAsync(buildInfo.pipeline);
  pipeline.getBuildAsync = promisify(pipeline.getBuild);

  const build = await pipeline.getBuildAsync(buildInfo.buildNumber);
  build.getArtifactAsync = promisify(build.getArtifact);

  const job = build.jobs.find(j => j.id === buildInfo.jobId);

  job.listArtifactsAsync = promisify(job.listArtifacts);
  const jobArtifacts = await job.listArtifactsAsync();

  const artifact = jobArtifacts.find(a => a.id === buildInfo.artifactId);
  artifact.getDownloadUrlAsync = promisify(artifact.getDownloadUrl);

  const artifactUrl = await artifact.getDownloadUrlAsync();

  log.info('Emitting artifact for', url);
  res.writeHead(302, {
    'Location': artifactUrl
  });
  res.end();
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
    app.get('/buildkite_public_artifact', onBuildKitePublicArtifactRequest);

    app.listen(envconst.PORT, () => log.info(`Listening on ${envconst.PORT}`));
  } catch (err) {
    log.error(err);
    process.exit(1);
  }
}

main();
