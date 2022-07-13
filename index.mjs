import express from "express";
import yauzl from "yauzl";
import crypto from "node:crypto";
import https from "https";

const SNAPSHOT = /2\.5\.0-DEV/;
const SNAPSHOT_BRANCH = "master";

const STABLE_SNAPSHOT = /2\.4\.\d+-DEV/;
const STABLE_SNAPSHOT_BRANCH = "chunky-2.4.x";

const token = process.env.GH_TOKEN;
const headers = new Headers();
headers.append("Authorization", `token ${token}`);

const getWorkflowRunsForPullRequest = async (pullNumber) => {
  const [pull, workflows] = await Promise.all([
    fetch(
      `https://api.github.com/repos/chunky-dev/chunky/pulls/${pullNumber}`,
      { headers }
    ).then((res) => res.json()),
    fetch(
      "https://api.github.com/repos/chunky-dev/chunky/actions/runs?event=pull_request",
      { headers }
    ).then((res) => res.json()),
  ]);
  if (!pull.head) {
    // PR not found
    return null;
  }
  return workflows.workflow_runs.find(
    (run) =>
      run.head_sha === pull.head.sha &&
      run.status === "completed" &&
      run.conclusion === "success"
  );
};

const getWorkflowRunsForBranch = async (branch) => {
  const workflows = await fetch(
    `https://api.github.com/repos/chunky-dev/chunky/actions/runs?event=push&branch=${branch}`,
    { headers }
  ).then((res) => res.json());
  return workflows.workflow_runs.find(
    (run) => run.status === "completed" && run.conclusion === "success"
  );
};

const getOpenPRs = () =>
  fetch("https://api.github.com/repos/chunky-dev/chunky/pulls?state=open").then(
    (res) => res.json()
  );

async function getChunkyCoreJar(run) {
  const artifacts = await (await fetch(run.artifacts_url, { headers })).json();
  const chunkyBuild = artifacts.artifacts.find((a) => a.name === "Chunky Core");
  if (!chunkyBuild) {
    return {};
  }

  const body = await fetch(chunkyBuild.archive_download_url, { headers }).then(
    (res) => res.arrayBuffer()
  );

  /**
   * @type yauzl.ZipFile
   */
  const zipFile = await new Promise((resolve, reject) =>
    yauzl.fromBuffer(
      Buffer.from(body, "binary"),
      { lazyEntries: true },
      (err, zipFile) => {
        if (err) {
          reject(err);
        } else {
          resolve(zipFile);
        }
      }
    )
  );
  zipFile.readEntry();
  return new Promise((resolve) =>
    zipFile.on("entry", (entry) =>
      resolve({ zipFile, entry, run: run[0], artifact: chunkyBuild })
    )
  );
}

async function serveJsonForWorkflowRun(run, template, req, res) {
  res.header("Last-Modified", new Date(run.created_at).toUTCString());
  if (new Date(req.header("If-Modified-Since")) >= new Date(run.created_at)) {
    return res.status(304).end();
  }

  const { entry, zipFile } = await getChunkyCoreJar(run);
  if (zipFile == null) {
    return res.status(404).end();
  }

  const digest = await new Promise((resolve) => {
    zipFile.openReadStream(entry, (err, stream) => {
      const hash = crypto.createHash("md5");
      hash.setEncoding("hex");
      stream.on("finish", () => resolve(hash.read().toUpperCase()));
      stream.pipe(hash);
    });
  });
  return res
    .json({
      ...template,
      name: entry.fileName.replace(/\.jar$/, ""),
      timestamp: run.created_at,
      libraries: [
        {
          name: entry.fileName,
          md5: digest,
          size: entry.uncompressedSize,
        },
        ...template.libraries,
      ],
    })
    .end();
}

async function serveChunkyCoreJar(run, req, res) {
  const { entry, zipFile } = await getChunkyCoreJar(run);
  if (zipFile == null) {
    return res.status(404).end();
  }

  zipFile.openReadStream(entry, (err, stream) => {
    if (err) {
      return res.status(500).end();
    }
    res.header("Content-Length", entry.uncompressedSize);
    res.header("Content-Type", "application/octet-stream");
    res.header("Content-Disposition", `attachment; filename=${entry.fileName}`);
    stream.pipe(res);
  });
}

const app = express();
app.get(["/:number/lib/:filename", "/lib/:filename"], async (req, res) => {
  const number =
    req.params.number || req.params.filename.match(/PR\.(\d+)/)?.[1];
  if (req.params.filename.startsWith(`chunky-core-`)) {
    if (req.params.filename.includes(`PR.${number}.`)) {
      if (isNaN(parseInt(number, 10))) {
        return res.status(400).send("Invalid PR number");
      }
      const run = await getWorkflowRunsForPullRequest(number);
      if (run == null) {
        return res.status(404).end();
      }
      return serveChunkyCoreJar(run, req, res);
    } else if (SNAPSHOT.test(req.params.filename)) {
      const run = await getWorkflowRunsForBranch(SNAPSHOT_BRANCH);
      if (run == null) {
        return res.status(404).end();
      }
      return serveChunkyCoreJar(run, req, res);
    } else if (STABLE_SNAPSHOT.test(req.params.filename)) {
      const run = await getWorkflowRunsForBranch(STABLE_SNAPSHOT_BRANCH);
      if (run == null) {
        return res.status(404).end();
      }
      return serveChunkyCoreJar(run, req, res);
    }
  } else {
    // we use a cdn, so fetching libs from github (instead of redirecting) should be fine
    https.get(
      {
        path: `/chunky-dev/chunky/master/chunky/lib/${req.params.filename}`,
        hostname: "raw.githubusercontent.com",
        port: 443,
      },
      (upstreamRes) => {
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Length", upstreamRes.headers["content-length"]);
        upstreamRes.on("error", (err) => {
          console.error("Could not download library", err);
          res.status(500).end();
        });
        upstreamRes.pipe(res);
      }
    );
  }
});
app.get("/:number/pr.json", async (req, res) => {
  const number = req.params.number;
  if (isNaN(parseInt(number, 10))) {
    return res.status(400).send("Invalid PR number");
  }

  const run = await getWorkflowRunsForPullRequest(number);
  if (run == null) {
    return res.status(404).end();
  }

  return serveJsonForWorkflowRun(
    run,
    {
      notes: `To see what's new in this build, please look at \nhttps://github.com/chunky-dev/chunky/pull/${number}/commits`,
      libraries: [
        {
          name: "commons-math3-3.2.jar",
          md5: "AAA32530C0F744813570FF73DB018698",
          size: 1692782,
        },
        {
          name: "gson-2.9.0.jar",
          md5: "53FA3E6753E90D931D62CB89580FDE2F",
          size: 249277,
        },
        {
          name: "fastutil-8.4.4.jar",
          md5: "7D189AD790C996B2C9A7AD076524586C",
          size: 19870806,
        },
      ],
    },
    req,
    res
  );
});
app.get("/:number/launcher.json", async (req, res) => {
  const upstream = await fetch(
    "https://chunkyupdate.lemaik.de/launcher.json"
  ).then((res) => res.json());
  res.header("Last-Modified", new Date(upstream.timestamp));
  res.json({
    ...upstream,
    channels: [
      {
        id: "pr",
        name: `PR #${req.params.number}`,
        path: "pr.json",
        notes: `Latest successful build of PR #${req.params.number}.`,
      },
      ...upstream.channels,
    ],
  });
});
app.get("/:number/:filename", (req, res) => {
  res.redirect(301, `https://chunkyupdate.lemaik.de/${req.params.filename}`);
});
app.get("/launcher.json", async (req, res) => {
  const prs = await getOpenPRs();
  const upstream = await fetch(
    "https://chunkyupdate.lemaik.de/launcher.json"
  ).then((res) => res.json());
  res.json({
    ...upstream,
    channels: [
      ...upstream.channels,
      ...prs.map((pr) => ({
        id: `pr-${pr.number}`,
        name: `PR #${pr.number}`,
        path: `${pr.number}/pr.json`,
        notes: pr.title,
      })),
    ],
  });
});
app.get("/snapshot.json", async (req, res) => {
  const run = await getWorkflowRunsForBranch(SNAPSHOT_BRANCH);
  return serveJsonForWorkflowRun(
    run,
    {
      notes: `To see what's new in this build, please look at\nhttps://github.com/chunky-dev/chunky/commits/${SNAPSHOT_BRANCH}`,
      libraries: [
        {
          name: "commons-math3-3.2.jar",
          md5: "AAA32530C0F744813570FF73DB018698",
          size: 1692782,
        },
        {
          name: "gson-2.9.0.jar",
          md5: "53FA3E6753E90D931D62CB89580FDE2F",
          size: 249277,
        },
        {
          name: "fastutil-8.4.4.jar",
          md5: "7D189AD790C996B2C9A7AD076524586C",
          size: 19870806,
        },
      ],
    },
    req,
    res
  );
});
app.get("/snapshot-stable.json", async (req, res) => {
  const run = await getWorkflowRunsForBranch(STABLE_SNAPSHOT_BRANCH);
  return serveJsonForWorkflowRun(
    run,
    {
      notes: `To see what's new in this build, please look at\nhttps://github.com/chunky-dev/chunky/commits/${STABLE_SNAPSHOT_BRANCH}`,
      libraries: [
        {
          name: "commons-math3-3.2.jar",
          md5: "AAA32530C0F744813570FF73DB018698",
          size: 1692782,
        },
        {
          name: "fastutil-8.4.4.jar",
          md5: "7D189AD790C996B2C9A7AD076524586C",
          size: 19870806,
        },
      ],
    },
    req,
    res
  );
});
app.get(["/latest.json", "/ChunkyLauncher.jar"], (req, res) => {
  res.redirect(307, `https://chunkyupdate.lemaik.de${req.path}`);
});
app.listen(3000);
