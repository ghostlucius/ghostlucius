import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const USERNAME = process.env.PROFILE_USERNAME || "ghostlucius";
const MODE = process.env.PROFILE_UPDATE_MODE || "all";
const ROOT = process.cwd();
const README_PATH = path.join(ROOT, "README.md");
const ASSETS_DIR = path.join(ROOT, "assets");
const ACTIVITY_GRAPH_PATH = path.join(ASSETS_DIR, "activity-graph.svg");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const SECTION_MARKERS = {
  latestArticles: ["<!-- START:latest-articles -->", "<!-- END:latest-articles -->"],
  statistics: ["<!-- START:statistics -->", "<!-- END:statistics -->"],
  recentActivity: ["<!-- START:recent-activity -->", "<!-- END:recent-activity -->"],
  latestRepos: ["<!-- START:latest-repos -->", "<!-- END:latest-repos -->"],
};

const FEATURED_REPOS = new Set([
  "Governance-Risk-Compliance-Toolbox",
  "cf7-international-phone-prefix",
  "VideoFixer",
  "ghostlucius",
]);

async function main() {
  const readme = await readFile(README_PATH, "utf8");
  let nextReadme = readme;

  if (MODE === "all") {
    const githubData = await fetchGitHubProfileData();
    const latestArticles = await buildLatestArticlesSection();
    await mkdir(ASSETS_DIR, { recursive: true });
    await writeFile(
      ACTIVITY_GRAPH_PATH,
      buildActivityGraphSvg(githubData.user.contributionsCollection.contributionCalendar),
      "utf8",
    );

    if (latestArticles) {
      nextReadme = replaceSection(nextReadme, "latestArticles", latestArticles);
    }
    nextReadme = replaceSection(nextReadme, "statistics", buildStatisticsSection(githubData.user));
    nextReadme = replaceSection(nextReadme, "recentActivity", await buildRecentActivitySection());
    nextReadme = replaceSection(nextReadme, "latestRepos", buildLatestRepositoriesSection(githubData.user.repositories.nodes));
  } else {
    throw new Error(`Unsupported PROFILE_UPDATE_MODE: ${MODE}`);
  }

  if (nextReadme !== readme) {
    await writeFile(README_PATH, nextReadme, "utf8");
  }
}

function replaceSection(content, key, replacement) {
  const [startMarker, endMarker] = SECTION_MARKERS[key];
  const pattern = new RegExp(`${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`, "m");
  const block = `${startMarker}\n${replacement}\n${endMarker}`;
  return content.replace(pattern, block);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fetchGitHubProfileData() {
  if (!GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN is required for PROFILE_UPDATE_MODE=all");
  }

  const query = `
    query ProfileData($login: String!) {
      user(login: $login) {
        createdAt
        followers { totalCount }
        following { totalCount }
        repositories(
          first: 100
          ownerAffiliations: OWNER
          privacy: PUBLIC
          isFork: false
          orderBy: { field: UPDATED_AT, direction: DESC }
        ) {
          totalCount
          nodes {
            name
            url
            description
            pushedAt
            stargazerCount
            primaryLanguage {
              name
            }
          }
        }
        contributionsCollection {
          contributionCalendar {
            totalContributions
            months {
              name
              firstDay
              totalWeeks
            }
            weeks {
              firstDay
              contributionDays {
                contributionCount
                date
                weekday
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": `${USERNAME}-profile-updater`,
    },
    body: JSON.stringify({
      query,
      variables: { login: USERNAME },
    }),
  });

  const payload = await response.json();
  if (!response.ok || payload.errors) {
    throw new Error(`GitHub GraphQL request failed: ${JSON.stringify(payload.errors || payload)}`);
  }

  return payload.data;
}

function buildStatisticsSection(user) {
  const languages = countLanguages(user.repositories.nodes);
  const topLanguages = languages
    .slice(0, 5)
    .map(([name, count]) => `${name} (${count})`)
    .join(", ");

  const createdAt = new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "long",
  }).format(new Date(user.createdAt));

  return [
    `- Public repositories: ${user.repositories.totalCount}`,
    `- Followers: ${user.followers.totalCount}`,
    `- Following: ${user.following.totalCount}`,
    `- Account created: ${createdAt}`,
    `- Top public repository languages by repository count: ${topLanguages || "No primary language data yet"}`,
    "",
    "![Contribution activity graph](./assets/activity-graph.svg)",
  ].join("\n");
}

function countLanguages(repositories) {
  const counts = new Map();
  for (const repo of repositories) {
    const language = repo.primaryLanguage?.name;
    if (!language) continue;
    counts.set(language, (counts.get(language) || 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

async function buildRecentActivitySection() {
  if (!GITHUB_TOKEN) {
    return "- GitHub activity is not available because `GITHUB_TOKEN` is missing.";
  }

  const response = await fetch(`https://api.github.com/users/${USERNAME}/events/public?per_page=100`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": `${USERNAME}-profile-updater`,
    },
  });

  const events = await response.json();
  if (!response.ok || !Array.isArray(events)) {
    return "- Recent public activity is temporarily unavailable.";
  }

  const lines = events
    .map(formatEvent)
    .filter(Boolean)
    .slice(0, 5);

  return lines.length > 0
    ? lines.join("\n")
    : "- No recent public activity available right now.";
}

function formatEvent(event) {
  const repoName = event.repo?.name;
  const repoUrl = repoName ? `https://github.com/${repoName}` : null;
  const createdAt = formatDate(event.created_at);
  const isProfileRepo = repoName === `${USERNAME}/${USERNAME}`;

  switch (event.type) {
    case "PushEvent": {
      if (isProfileRepo) return null;
      const commits = event.payload?.commits?.length || 0;
      if (commits === 0) return null;
      if (!repoName || !repoUrl) return null;
      return `- ${createdAt}: Pushed ${commits} commit${commits === 1 ? "" : "s"} to [${repoName}](${repoUrl}).`;
    }
    case "PullRequestEvent": {
      if (isProfileRepo) return null;
      const action = event.payload?.action;
      const pr = event.payload?.pull_request;
      if (!pr?.html_url || !repoName) return null;
      return `- ${createdAt}: ${capitalize(action)} pull request [#${pr.number}](${pr.html_url}) in [${repoName}](${repoUrl}).`;
    }
    case "IssuesEvent": {
      if (isProfileRepo) return null;
      const action = event.payload?.action;
      const issue = event.payload?.issue;
      if (!issue?.html_url || !repoName) return null;
      return `- ${createdAt}: ${capitalize(action)} issue [#${issue.number}](${issue.html_url}) in [${repoName}](${repoUrl}).`;
    }
    case "CreateEvent": {
      return null;
    }
    case "ReleaseEvent": {
      if (isProfileRepo) return null;
      const release = event.payload?.release;
      if (!release?.html_url || !repoName) return null;
      return `- ${createdAt}: Published release [${release.tag_name}](${release.html_url}) for [${repoName}](${repoUrl}).`;
    }
    case "WatchEvent": {
      if (!repoName || !repoUrl) return null;
      return `- ${createdAt}: Starred [${repoName}](${repoUrl}).`;
    }
    default:
      return null;
  }
}

function capitalize(value) {
  if (!value) return "Updated";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatDate(dateString) {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(dateString));
}

function buildLatestRepositoriesSection(repositories) {
  const latest = repositories
    .filter((repo) => !FEATURED_REPOS.has(repo.name))
    .sort((a, b) => new Date(b.pushedAt) - new Date(a.pushedAt))
    .slice(0, 5);

  if (latest.length === 0) {
    return "- No additional public repositories available yet.";
  }

  return latest
    .map((repo) => {
      const language = repo.primaryLanguage?.name ? ` · ${repo.primaryLanguage.name}` : "";
      const description = repo.description?.trim() || "No description yet.";
      return `- [${repo.name}](${repo.url})${language} — ${description}`;
    })
    .join("\n");
}

async function buildLatestArticlesSection() {
  try {
    const response = await fetch("https://privacyevolution.substack.com/feed", {
      headers: {
        "User-Agent": `${USERNAME}-profile-updater`,
      },
    });

    const feed = await response.text();
    if (!response.ok) {
      return null;
    }

    const items = [...feed.matchAll(/<item>([\s\S]*?)<\/item>/g)]
      .slice(0, 2)
      .map((match) => match[1]);

    if (items.length === 0) {
      return null;
    }

    return items
      .map((item) => {
        const title = decodeXmlText(extractFeedTag(item, "title"));
        const link = decodeXmlText(extractFeedTag(item, "link"));
        const pubDate = formatDate(extractFeedTag(item, "pubDate"));
        if (!title || !link) {
          return null;
        }
        return `- [${title}](${link})${pubDate ? ` · ${pubDate}` : ""}`;
      })
      .filter(Boolean)
      .join("\n") || null;
  } catch {
    return null;
  }
}

function extractFeedTag(item, tagName) {
  const cdataMatch = item.match(new RegExp(`<${tagName}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tagName}>`, "i"));
  if (cdataMatch) {
    return cdataMatch[1].trim();
  }

  const plainMatch = item.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return plainMatch ? plainMatch[1].trim() : "";
}

function decodeXmlText(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function buildActivityGraphSvg(calendar) {
  const cellSize = 10;
  const gap = 3;
  const leftPad = 42;
  const topPad = 26;
  const chartWidth = calendar.weeks.length * (cellSize + gap);
  const chartHeight = 7 * (cellSize + gap);
  const width = leftPad + chartWidth + 16;
  const height = topPad + chartHeight + 28;

  const labels = ["Mon", "Wed", "Fri"];
  const labelRows = [1, 3, 5];
  const monthLabels = calendar.months
    .map((month) => {
      const weekIndex = calendar.weeks.findIndex((week) => week.firstDay === month.firstDay);
      if (weekIndex < 0) return "";
      const x = leftPad + weekIndex * (cellSize + gap);
      return `<text x="${x}" y="16" font-size="10" fill="#64748b">${month.name.slice(0, 3)}</text>`;
    })
    .join("");

  const yLabels = labels
    .map((label, index) => {
      const y = topPad + labelRows[index] * (cellSize + gap) + 8;
      return `<text x="0" y="${y}" font-size="10" fill="#64748b">${label}</text>`;
    })
    .join("");

  const allCounts = calendar.weeks.flatMap((week) => week.contributionDays.map((day) => day.contributionCount));
  const maxCount = Math.max(...allCounts, 1);
  const cells = calendar.weeks
    .map((week, weekIndex) =>
      week.contributionDays
        .map((day) => {
          const x = leftPad + weekIndex * (cellSize + gap);
          const y = topPad + day.weekday * (cellSize + gap);
          const fill = colorForContributions(day.contributionCount, maxCount);
          const title = `${day.date}: ${day.contributionCount} contribution${day.contributionCount === 1 ? "" : "s"}`;
          return `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" ry="2" fill="${fill}"><title>${title}</title></rect>`;
        })
        .join(""),
    )
    .join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
    `<title id="title">${USERNAME} contribution activity graph</title>`,
    `<desc id="desc">Daily public GitHub contributions over the last year.</desc>`,
    `<rect width="100%" height="100%" fill="transparent" />`,
    `<text x="0" y="12" font-size="11" font-weight="600" fill="#93c5fd">Public contribution activity</text>`,
    monthLabels,
    yLabels,
    cells,
    `</svg>`,
  ].join("");
}

function colorForContributions(count, maxCount) {
  if (count === 0) return "#0f172a";
  const ratio = count / maxCount;
  if (ratio < 0.25) return "#1d4ed8";
  if (ratio < 0.5) return "#2563eb";
  if (ratio < 0.75) return "#3b82f6";
  return "#60a5fa";
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
