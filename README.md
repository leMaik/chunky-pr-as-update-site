# Serve Chunky PRs as update sites

Installing PR builds is tricky for inexperienced users and plain impossible for non-GitHub users who can't download the artifacts. This project makes this very simple by providing dynamic update sites for [Chunky PRs](https://github.com/chunky-dev/chunky/pulls).

0. Make sure you're using Chunky Launcher v1.13.2 or later
1. Enter `http://pr.chunky.lemaik.de/PR_NUMBER` as update site URL (replace PR_NUMBER by the PR number, eg. `http://pr.chunky.lemaik.de/1276`)
2. Reload the release stages
3. Select the PR #PR_NUMBER stage
4. Check for updates as long as the PR is open and just install them

All other stages are proxied from my "official" update server (chunkyupdate.lemaik.de) so you don't have to switch the update site to get stable releases.

## Known caveats

- This will download anything that builds on a PR in Chunky, so use with cautions. Don't install stuff from people you don't trust. I have to manually allow running GitHub Actions once per PR author though, so there is _some_ form of validation.
- I broke SSL for pr.chunky.lemaik.de, sorry. It will be back soon!

## License

This project is licensed under the MIT license.
