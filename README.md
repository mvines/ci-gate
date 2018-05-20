[![Build Status](https://travis-ci.org/mvines/ci-gate.svg?branch=master)](https://travis-ci.org/mvines/ci-gate)

Gates access to the CI system for Github pull requests.  Authorized users get
immediate CI service.  Pull Requests from 3rd party users only enter CI once the
"CI" label is added to their Pull Request by a member of the project.

## Setup

If you'd like to use ci-gate for your github project:

### Github Project Config
1. Go to the webhooks section of your project settings and create a new webhook
   as follows:
    1. **Payload URL** = https://ci-gate.herokuapp.com/github
    2. **Content Type** = application/json
    3. **Secret** = *contents of the GITHUB_WEBHOOK_SECRET environment variable*
    4. **Which events ...** = "Send me **everything**"
2. Check ci-gate server log file to ensure a github "ping" event was received,
   indicating the webhook was successfully created

### Heroku Config

TODO...see env vars in index.js
