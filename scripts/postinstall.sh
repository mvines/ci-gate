#!/bin/bash -e

cd $(dirname $0)/..
LOCAL_PATH=$PWD

node_modules/.bin/babel-node version-check.js

for patch in $(cd patch/; find . -name \*.patch); do
  echo == Applying $patch
  (
    set -x
    cd $(dirname $patch)
    if [[ ! -f .$(basename $patch) ]]; then
      patch --forward -p1 < $LOCAL_PATH/patch/$patch
      touch .$(basename $patch)
    fi
  )
done

if [[  -r public_html/terminal.css ]]; then
  wget -O public_html/terminal.css \
    https://raw.githubusercontent.com/buildkite/terminal/v3.1.0/assets/terminal.css
fi

exit 0
