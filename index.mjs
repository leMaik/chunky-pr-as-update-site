import express from "express";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import yauzl from "yauzl";

const SNAPSHOT = /2\.5\.0-(DEV|SNAPSHOT)/;
const SNAPSHOT_BRANCH = "master";

const STABLE_SNAPSHOT = /2\.4\.\d+-(DEV|SNAPSHOT)/;
const STABLE_SNAPSHOT_BRANCH = "chunky-2.4.x";

const NO_PR_HOSTNAME = process.env.NO_PR_HOSTNAME ?? "chunkyupdate.lemaik.de";
const STATIC_UPSTREAM =
  process.env.STATIC_UPSTREAM ?? "https://chunkyfiles.lemaik.de";

const RUN_ARTIFACTS_PATH = process.env.RUN_ARTIFACTS_PATH ?? "./run_artifacts";

const token = process.env.GH_TOKEN;
if (!token) {
  console.error("GH_TOKEN not specified!");
  process.exit(1);
}
const headers = new Headers();
headers.append("Authorization", `token ${token}`);

const getWorkflowRunsForPullRequest = async (pullNumber) => {
  const pull = await fetch(
    `https://api.github.com/repos/chunky-dev/chunky/pulls/${pullNumber}`,
    { headers }
  ).then((res) => res.json());

  if (!pull.head) {
    // PR not found
    return null;
  }

  const workflows = await fetch(
    `https://api.github.com/repos/chunky-dev/chunky/actions/runs?event=pull_request&head_sha=${pull.head.sha}`,
    { headers }
  ).then((res) => res.json());

  return workflows.workflow_runs.find(
    (run) => run.status === "completed" && run.conclusion === "success"
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
  fetch("https://api.github.com/repos/chunky-dev/chunky/pulls?state=open", {
    headers,
  }).then((res) => res.json());

const getPullRequest = (number) =>
  fetch(`https://api.github.com/repos/chunky-dev/chunky/pulls/${number}`, {
    headers,
  }).then((res) => res.json());

async function getChunkyCoreJar(run) {
  const artifactCachePath = join(RUN_ARTIFACTS_PATH, `${run.id}.zip`);
  let zipBuffer;
  let fromCache = false;
  try {
    const cachedZipFile = await readFile(artifactCachePath);
    zipBuffer = cachedZipFile;
    fromCache = true;
  } catch {}

  if (!zipBuffer) {
    const artifacts = await fetch(run.artifacts_url, { headers }).then((res) =>
      res.json()
    );
    const chunkyBuild = artifacts.artifacts.find(
      (a) => a.name === "Chunky Core"
    );
    if (!chunkyBuild) {
      return {};
    }

    const res = await fetch(chunkyBuild.archive_download_url, { headers });
    if (!res.ok) {
      return {};
    }
    const body = await res.arrayBuffer();
    zipBuffer = Buffer.from(body, "binary");
  }

  /**
   * @type yauzl.ZipFile
   */
  const zipFile = await new Promise((resolve, reject) =>
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (err, zipFile) => {
      if (err) {
        reject(err);
      } else {
        resolve(zipFile);
      }
    })
  );
  zipFile.readEntry();
  return new Promise((resolve) =>
    zipFile.on("entry", (entry) => {
      if (!fromCache) {
        writeFileAtomic(artifactCachePath, zipBuffer, { mode: 0o444 }).catch(
          (e) => {
            console.error(`caching artifacts of run ${run.id} failed`, e);
          }
        );
      }
      resolve({ zipFile, entry, run: run[0] });
    })
  );
}

async function serveJsonForWorkflowRun(run, template, req, res) {
  res.header("Last-Modified", new Date(run.created_at).toUTCString());
  if (new Date(req.header("If-Modified-Since")) >= new Date(run.created_at)) {
    return res.status(304).end();
  }

  const { entry, zipFile } = await getChunkyCoreJar(run);
  if (zipFile == null) {
    return res
      .status(404)
      .json({
        status: 404,
        message: "chunky-core artifact not found in workflow run",
      })
      .end();
  }

  const [md5Digest, sha256Digest] = await Promise.all([
    new Promise((resolve) => {
      zipFile.openReadStream(entry, (err, stream) => {
        const hash = crypto.createHash("md5");
        hash.setEncoding("hex");
        stream.on("finish", () => resolve(hash.read().toUpperCase()));
        stream.pipe(hash);
      });
    }),
    new Promise((resolve) => {
      zipFile.openReadStream(entry, (err, stream) => {
        const hash = crypto.createHash("sha256");
        hash.setEncoding("hex");
        stream.on("finish", () => resolve(hash.read().toUpperCase()));
        stream.pipe(hash);
      });
    }),
  ]);
  return res
    .json({
      ...template,
      name: entry.fileName.replace(/\.jar$/, ""),
      timestamp: run.created_at,
      libraries: [
        {
          name: entry.fileName,
          md5: md5Digest,
          sha256: sha256Digest,
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
    return res
      .status(404)
      .json({
        status: 404,
        message: "chunky-core artifact not found in workflow run",
      })
      .end();
  }

  zipFile.openReadStream(entry, (err, stream) => {
    if (err) {
      return res
        .status(500)
        .json({ code: 500, message: "failed to read artifact zip file" })
        .end();
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
        return res
          .status(400)
          .json({ code: 400, message: "invalid pr number" })
          .end();
      }
      const run = await getWorkflowRunsForPullRequest(number);
      if (run == null) {
        return res
          .status(404)
          .json({ code: 404, message: "workflow run not found" })
          .end();
      }
      return serveChunkyCoreJar(run, req, res);
    } else if (SNAPSHOT.test(req.params.filename)) {
      const run = await getWorkflowRunsForBranch(SNAPSHOT_BRANCH);
      if (run == null) {
        return res
          .status(404)
          .json({ code: 404, message: "workflow run not found" })
          .end();
      }
      return serveChunkyCoreJar(run, req, res);
    } else if (STABLE_SNAPSHOT.test(req.params.filename)) {
      const run = await getWorkflowRunsForBranch(STABLE_SNAPSHOT_BRANCH);
      if (run == null) {
        return res
          .status(404)
          .json({ code: 404, message: "workflow run not found" })
          .end();
      }
      return serveChunkyCoreJar(run, req, res);
    } else {
      // we use a cdn, so fetching libs from github (instead of redirecting) should be fine
      const match = /chunky-core-(.+?)\.jar/.exec(req.params.filename);
      if (match) {
        const version = match[1];
        const upstreamRes = await fetch(
          `https://github.com/chunky-dev/chunky/releases/download/${version}/chunky-core-${version}.jar`
        );
        if (!upstreamRes.ok) {
          return res
            .status(500)
            .json({
              code: 500,
              message: "release artifact could not be fetched",
            })
            .end();
        }
        ["content-type", "last-modified", "etag", "content-length"].forEach(
          (header) => res.setHeader(header, upstreamRes.headers.get(header))
        );
        return pipeReadableStreamToResponse(upstreamRes.body, res);
      } else {
        res
          .status(400)
          .json({ code: 400, message: "unexpected chunky-core filename" })
          .end();
      }
    }
  } else {
    // we use a cdn, so fetching libs from github (instead of redirecting) should be fine
    const upstreamRes = await fetch(
      `https://raw.githubusercontent.com/chunky-dev/chunky/master/chunky/lib/${req.params.filename}`
    );
    if (!upstreamRes.ok) {
      return res
        .status(500)
        .json({
          code: 500,
          message: "library could not be fetched",
        })
        .end();
    }
    ["content-type", "last-modified", "etag", "content-length"].forEach(
      (header) => res.setHeader(header, upstreamRes.headers.get(header))
    );
    return pipeReadableStreamToResponse(upstreamRes.body, res);
  }
});
app.get("/:number/pr.json", async (req, res) => {
  const number = req.params.number;
  if (isNaN(parseInt(number, 10))) {
    return res
      .status(400)
      .json({ code: 400, message: "invalid pr number" })
      .end();
  }

  const pr = await getPullRequest(number);
  if (!pr) {
    return res
      .status(404)
      .json({ code: 404, message: "pull request not found" })
      .end();
  }

  const run = await getWorkflowRunsForPullRequest(number);
  if (run == null) {
    return res
      .status(404)
      .json({ code: 404, message: "workflow run not found" })
      .end();
  }

  return serveJsonForWorkflowRun(
    run,
    {
      notes: `${pr.title}\nAuthor: ${pr.user.login}\n\nTo see what's new in this build and provide feedback, please look at \nhttps://github.com/chunky-dev/chunky/pull/${number}`,
      libraries: [
        {
          name: "lz4-java-1.8.0.jar",
          md5: "936A927700AA8FC3B75D21D7571171F6",
          sha256:
            "D74A3334FB35195009B338A951F918203D6BBCA3D1D359033DC33EDD1CADC9EF",
          size: 682804,
        },
        {
          name: "commons-math3-3.2.jar",
          md5: "AAA32530C0F744813570FF73DB018698",
          sha256:
            "6268A9A0EA3E769FC493A21446664C0EF668E48C93D126791F6F3F757978FEE2",
          size: 1692782,
        },
        {
          name: "gson-2.9.0.jar",
          md5: "53FA3E6753E90D931D62CB89580FDE2F",
          sha256:
            "C96D60551331A196DAC54B745AA642CD078EF89B6F267146B705F2C2CBEF052D",
          size: 249277,
        },
        {
          name: "fastutil-8.4.4.jar",
          md5: "7D189AD790C996B2C9A7AD076524586C",
          sha256:
            "3D7981B838C8FE8D8F1EF93C9EE4EBF6BD1091CC1C5847FE41DB22D1648081E3",
          size: 19870806,
        },
      ],
    },
    req,
    res
  );
});
app.get("/:number/launcher.json", async (req, res) => {
  const upstream = await fetch(`${STATIC_UPSTREAM}/launcher.json`).then((res) =>
    res.json()
  );
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
  res.redirect(301, `${STATIC_UPSTREAM}/${req.params.filename}`);
});
app.get("/launcher.json", async (req, res) => {
  const upstream = await fetch(`${STATIC_UPSTREAM}/launcher.json`).then((res) =>
    res.json()
  );

  if (req.hostname === NO_PR_HOSTNAME) {
    res.json(upstream);
    return;
  }

  const prs = await getOpenPRs();
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
          name: "lz4-java-1.8.0.jar",
          md5: "936A927700AA8FC3B75D21D7571171F6",
          sha256:
            "D74A3334FB35195009B338A951F918203D6BBCA3D1D359033DC33EDD1CADC9EF",
          size: 682804,
        },
        {
          name: "commons-math3-3.2.jar",
          md5: "AAA32530C0F744813570FF73DB018698",
          sha256:
            "6268A9A0EA3E769FC493A21446664C0EF668E48C93D126791F6F3F757978FEE2",
          size: 1692782,
        },
        {
          name: "gson-2.9.0.jar",
          md5: "53FA3E6753E90D931D62CB89580FDE2F",
          sha256:
            "C96D60551331A196DAC54B745AA642CD078EF89B6F267146B705F2C2CBEF052D",
          size: 249277,
        },
        {
          name: "fastutil-8.4.4.jar",
          md5: "7D189AD790C996B2C9A7AD076524586C",
          sha256:
            "3D7981B838C8FE8D8F1EF93C9EE4EBF6BD1091CC1C5847FE41DB22D1648081E3",
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
          sha256:
            "6268A9A0EA3E769FC493A21446664C0EF668E48C93D126791F6F3F757978FEE2",
          size: 1692782,
        },
        {
          name: "fastutil-8.4.4.jar",
          md5: "7D189AD790C996B2C9A7AD076524586C",
          sha256:
            "3D7981B838C8FE8D8F1EF93C9EE4EBF6BD1091CC1C5847FE41DB22D1648081E3",
          size: 19870806,
        },
      ],
    },
    req,
    res
  );
});
app.get(["/latest.json", "/javafx.json", "/ChunkyLauncher.jar"], (req, res) => {
  res.redirect(307, `${STATIC_UPSTREAM}/${req.path}`);
});
if (process.env.REDIRECT_ROOT) {
  app.get("/", (req, res) => {
    res.redirect(301, process.env.REDIRECT_ROOT);
  });
}
app.listen(3000);

async function pipeReadableStreamToResponse(readableStream, res) {
  const reader = readableStream.getReader();
  for await (const chunk of readChunks(reader)) {
    res.write(chunk);
  }
  res.end();
}

async function* readChunks(reader) {
  let readResult = await reader.read();
  while (!readResult.done) {
    yield readResult.value;
    readResult = await reader.read();
  }
}
