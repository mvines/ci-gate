[![Build Status](https://travis-ci.org/mvines/ci-gate.svg?branch=master)](https://travis-ci.org/mvines/ci-gate)

Gates access to the CI system for Github pull requests.  Authorized users get
immediate CI service.  Pull Requests from 3rd party users only enter CI once the
`CI` label is added to their Pull Request by a member of the project.

Suppress CI on a particular Pull Request by applying the 'noCI' label.  To
resume CI service on the Pull Request:
1. Remove the 'noCI' label
2. Add new commit, close/re-open, or add the 'CI' label

## Setup

If you'd like to use ci-gate for your github project:

### Github Project Config
1. Create the following labels in your github project:
  * `CI` - Pull Requests from 3rd party users only enter CI once this label is attached
  * `automerge` - Pull requests with this label attached will be automatically
     merged once status checks pass
2. Go to the webhooks section of your project settings and create a new webhook
   as follows:
    1. **Payload URL** = https://ci-gate.herokuapp.com/github
    2. **Content Type** = application/json
    3. **Secret** = *contents of the GITHUB_WEBHOOK_SECRET environment variable*
    4. **Which events ...** = "Send me **everything**" for simplicity
3. Check ci-gate server log file to ensure a github "ping" event was received,
   indicating the webhook was successfully created

### Buildkite Configuration

Ensure the following is added to `/etc/buildkite-agent/hooks/environment` for
each build agent:
```sh
if [[ $BUILDKITE_BRANCH =~ pull/* ]]; then
  export BUILDKITE_REFSPEC="+$BUILDKITE_BRANCH:refs/remotes/origin/$BUILDKITE_BRANCH"
  echo $BUILDKITE_REFSPEC
fi
```
This workaround is necessary to enable the buildkite API to successfully create
a new pipeline from a pull request branch (`pull/123/head`).

#### `affected_files` meta data for Pull Requests

From within a job use `buildkite-agent meta-data get affected_files` to
obtain a colon-delimited list of files that were added/removed/modified by this
Pull Request.

### Heroku Config

The following config variables should be set in Heroku.  See the code comments
in `index.js` for details on each:
* `BUILDKITE_TOKEN`
* `BUILDKITE_ORG_SLUG`
* `BUILDKITE_PIPELINE_PUBLIC_LOG_WHITELIST`
* `GITHUB_TOKEN`
* `GITHUB_WEBHOOK_SECRET`
* `PUBLIC_URL_ROOT`

Optional:
* To increase verbosity of logs add `SILK_DEBUG=silk-*`
* Set `TZ` to your desired timezone (`America/Los_Angeles`)

